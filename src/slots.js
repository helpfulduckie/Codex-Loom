'use strict';

const fs = require('fs');
const { normalizeComponent, applySectionSelector, slotsForBranch } = require('./model/component');
const { busWarner, CODES: DIAG_CODES } = require('./diag');
const {
  SLOTTED_COMPONENTS, isPassthrough, readPassthrough, renderSectionedComponent,
} = require('./emit/components');
const { renderCard } = require('./emit/vl');

function selectComponentSections(component, variant, entrySections, onUnknownSection) {
  let raw = (component && component.rawSections) || {};

  if (Array.isArray(entrySections) && entrySections.length > 0) {
    const want = new Set(entrySections.map((s) => String(s).toLowerCase()));
    const picked = {};
    const got = new Set();
    for (const [name, def] of Object.entries(raw)) {
      if (want.has(name.toLowerCase())) { picked[name] = def; got.add(name.toLowerCase()); }
    }
    for (const s of entrySections) {
      if (!got.has(String(s).toLowerCase()) && onUnknownSection) onUnknownSection(s);
    }
    raw = picked;
  }

  if (typeof variant === 'string' && variant.trim() !== '') {
    raw = applySectionSelector(raw, variant.trim()).sections;
  }

  return normalizeComponent({ sections: raw, branches: component && component.branches }, {});
}

function renderComponentStoryCards(component, descriptor, branchPath, filled, grouped, options) {
  const {
    variables = {}, registry, branchProtagonist, roles = null, onRoleUsed = null,
    diagnostics, questions = null, storyCardType = null, spec, branchLabel = '(root)',
    cardTypeAudit = null,
  } = options;

  const entries = component && component.render && Array.isArray(component.render.storyCards)
    ? component.render.storyCards : [];
  if (entries.length === 0) return;

  const loc = { file: String(spec) };
  const projectType = (storyCardType && typeof storyCardType === 'object')
    ? storyCardType[descriptor.key] : null;

  const takenByType = new Map();
  for (const [type, cards] of grouped) {
    takenByType.set(type, new Set(cards.map((c) => c.name)));
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (title === '') {
      diagnostics.error(
        DIAG_CODES.STORY_CARD_ENTRY_NO_TITLE,
        `a render.storyCards entry on component "${descriptor.label}" declares no title: — `
        + 'the title is the card\'s AID name and its place in the frontier index.',
        loc,
      );
      continue;
    }

    const rawCardType = (typeof entry.type === 'string' && entry.type.trim() !== '' && entry.type.trim())
      || (typeof projectType === 'string' && projectType.trim() !== '' && projectType.trim())
      || descriptor.label;
    const cardType = cardTypeAudit ? cardTypeAudit.resolve(rawCardType, loc) : rawCardType;

    const sub = selectComponentSections(
      component,
      typeof entry.variant === 'string' ? entry.variant : null,
      entry.sections,
      (name) => diagnostics.warn(
        DIAG_CODES.STORY_CARD_ENTRY_UNKNOWN_SECTION,
        `render.storyCards entry "${title}" names section "${name}", which component `
        + `"${descriptor.label}" does not declare — it is dropped from this entry.`,
        loc,
      ),
    );

    const { text: notesText } = renderSectionedComponent(sub, branchPath, filled, {
      defaultHeadingLevel: descriptor.defaultHeadingLevel,
      variables, registry, branchProtagonist, roles, onRoleUsed,
      onWarn: busWarner(diagnostics, loc), diagnostics, file: loc.file,
    });

    if (!notesText || notesText.trim() === '') {
      diagnostics.warn(
        DIAG_CODES.STORY_CARD_ENTRY_RENDERS_NOTHING,
        `render.storyCards entry "${title}" renders no text on branch "${branchLabel}" — `
        + 'its variant:/sections: selectors left nothing. No card is written.',
        loc,
      );
      continue;
    }

    if (!takenByType.has(cardType)) takenByType.set(cardType, new Set());
    if (takenByType.get(cardType).has(title)) {
      diagnostics.error(
        DIAG_CODES.CARD_NAME_COLLISION,
        `story cards named "${title}" collide on branch "${branchLabel}" (both as ${cardType}). `
        + 'Velvet Lattice merges story cards by name, so only one survives to AID. '
        + 'Give them distinct names.',
        loc,
      );
      continue;
    }
    takenByType.get(cardType).add(title);

    const body = `${title} — copy the description field below into your scenario's ${descriptor.label}.`;
    const synthetic = { kind: 'reference', name: title, aid: { type: cardType, title } };
    const rendered = renderCard({
      item: synthetic, bodyText: body, notesText, diagnostics, loc, questions,
    }).text;

    if (!grouped.has(cardType)) grouped.set(cardType, []);
    grouped.get(cardType).push({
      sortKey: title.toLowerCase(), rendered, id: null, name: title,
    });
  }
}

function resolveSectionedComponents(compileContext, label, { loadSectioned, recordGap }) {
  const resolved = [];
  for (const descriptor of SLOTTED_COMPONENTS) {
    const spec = compileContext.componentRefs[descriptor.key];
    if (!spec) continue;
    if (typeof spec === 'string' && /\{%/.test(spec)) {
      recordGap(label, descriptor.label, spec, 'unexpanded compile variable {%…} — the spec named a path that did not resolve');
      continue;
    }

    if (descriptor.inlineProse && !(typeof spec === 'string' && fs.existsSync(spec))) {
      const text = String(spec).trimEnd();
      if (!text) {
        recordGap(label, descriptor.label, spec, 'inline text is empty');
        continue;
      }
      resolved.push({ descriptor, spec, component: null, passthrough: text });
      continue;
    }

    if (isPassthrough(spec)) {
      if (!fs.existsSync(spec)) {
        recordGap(label, descriptor.label, spec, 'source not found');
        continue;
      }
      const text = readPassthrough(spec);
      if (text === null) {
        recordGap(label, descriptor.label, spec, 'source is empty');
        continue;
      }
      resolved.push({ descriptor, spec, component: null, passthrough: text });
      continue;
    }

    const component = loadSectioned(spec, descriptor);
    if (!component) {
      recordGap(label, descriptor.label, spec, 'source declared no sections (missing or empty file)');
      continue;
    }
    resolved.push({ descriptor, spec, component, passthrough: null });
  }
  return resolved;
}

function buildSlotIndex(sectionedForLeaf, branchPath) {
  const index = new Map();
  for (const { descriptor, component, passthrough } of sectionedForLeaf) {
    if (passthrough !== null && passthrough !== undefined) {
      index.set(descriptor.key, {
        slots: new Map(), documentSlots: new Set(), sections: new Set(),
        label: descriptor.label, passthrough: true,
      });
      continue;
    }
    const slots = new Map();
    for (const [name, section] of slotsForBranch(component, branchPath)) {
      slots.set(name.toLowerCase(), section);
    }
    const documentSlots = new Set(
      component.sections.filter((s) => s.isSlot).map((s) => s.name.toLowerCase()),
    );
    const sections = new Set(component.sections.map((s) => s.name.toLowerCase()));
    index.set(descriptor.key, {
      slots, documentSlots, sections, label: descriptor.label, passthrough: false,
    });
  }
  return index;
}

function checkTargetSlot(target, itemId, slotIndex, label, diagnostics, file) {
  const known = slotIndex.get(target.component);
  if (!known) return true;

  if (known.passthrough) {
    diagnostics.error(
      DIAG_CODES.TARGET_UNDECLARED_SLOT,
      `item "${itemId}" targets slot "${target.slot || '(unnamed)'}" in ${known.label}, which is `
      + 'prose copied verbatim and declares no slots. Point the component at a YAML '
      + 'document with "sections:" to route items into it.',
      { file },
    );
    return false;
  }

  if (!target.slot) {
    diagnostics.error(
      DIAG_CODES.TARGET_NAMES_NO_SLOT,
      `item "${itemId}" renders into ${known.label} without naming a slot — `
      + `add "slot:" naming one of: ${[...known.documentSlots].join(', ') || '(the component declares none)'}.`,
      { file },
    );
    return false;
  }

  const key = target.slot.toLowerCase();
  if (known.documentSlots.has(key)) return true;

  if (known.sections.has(key)) {
    diagnostics.error(
      DIAG_CODES.TARGET_NOT_A_SLOT,
      `item "${itemId}" targets "${target.slot}" in ${known.label}, which is a section but `
      + 'not a slot — only a section declaring "slot: true" can hold items.',
      { file },
    );
    return false;
  }

  diagnostics.error(
    DIAG_CODES.TARGET_UNDECLARED_SLOT,
    `item "${itemId}" targets slot "${target.slot}" in ${known.label} on branch "${label}", `
    + `which declares no such slot. Declared here: ${[...known.documentSlots].join(', ') || '(none)'}.`,
    { file },
  );
  return false;
}

function warnEmptySlots(descriptor, slotIndex, filled, label, diagnostics, file) {
  const known = slotIndex.get(descriptor.key);
  if (!known) return;
  for (const name of known.slots.keys()) {
    const placed = filled.get(name);
    if (placed && placed.length > 0) continue;
    diagnostics.warn(
      DIAG_CODES.SLOT_EMPTY,
      `slot "${name}" in ${known.label} has no items on branch "${label}".`,
      { file: file == null ? undefined : String(file) },
    );
  }
}

module.exports = {
  selectComponentSections,
  renderComponentStoryCards,
  resolveSectionedComponents,
  buildSlotIndex,
  checkTargetSlot,
  warnEmptySlots,
};
