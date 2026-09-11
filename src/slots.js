'use strict';

const fs = require('fs');
const { normalizeComponent, applySectionSelector, slotsForBranch } = require('./model/component');
const { originWarner, CODES: DIAG_CODES } = require('./diag');
const { copyOrigins, originLocation } = require('./origin');
const {
  SLOTTED_COMPONENTS, isPassthrough, readPassthrough, renderSectionedComponent,
} = require('./emit/components');
const { renderCard } = require('./emit/vl');
const { resolveVariables } = require('./util');
const { validateCardTypeValue } = require('./cardType');

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

  return copyOrigins(component,
    normalizeComponent({ sections: raw, branches: component && component.branches }, {}));
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

  const takenNames = new Map();
  for (const [type, cards] of grouped) {
    for (const card of cards) takenNames.set(card.name, type);
  }

  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const entryAt = (...parts) => originLocation(
      component, ['render', 'storyCards', String(index), ...parts], loc,
    );

    const title = typeof entry.title === 'string'
      ? resolveVariables(entry.title, variables, { diagnostics, location: entryAt('title') }).trim() : '';
    if (title === '') {
      diagnostics.error(
        DIAG_CODES.STORY_CARD_ENTRY_NO_TITLE,
        `a render.storyCards entry on component "${descriptor.label}" declares no title: — `
        + 'the title is the card\'s AID name and its place in the frontier index. Add title:.',
        entryAt('title'),
      );
      return;
    }

    const entryType = typeof entry.type === 'string'
      ? resolveVariables(entry.type, variables, { diagnostics, location: entryAt('type') }) : entry.type;
    const ownType = typeof entryType === 'string' && entryType.trim() !== '' && entryType.trim();
    const rawCardType = ownType
      || (typeof projectType === 'string' && projectType.trim() !== '' && projectType.trim())
      || descriptor.label;
    const typeLoc = ownType ? entryAt('type') : loc;
    validateCardTypeValue(rawCardType, {
      diagnostics, name: title || '(unknown)', file: loc.file, loc: typeLoc, field: 'story-card type',
    });
    const cardType = cardTypeAudit ? cardTypeAudit.resolve(rawCardType, typeLoc) : rawCardType;

    const sub = selectComponentSections(
      component,
      typeof entry.variant === 'string' ? entry.variant : null,
      entry.sections,
      (name) => diagnostics.warn(
        DIAG_CODES.STORY_CARD_ENTRY_UNKNOWN_SECTION,
        `render.storyCards entry "${title}" names section "${name}", which component `
        + `"${descriptor.label}" does not declare — it is dropped from this entry. Correct sections: or declare the section.`,
        entryAt('sections', String(entry.sections.indexOf(name))),
      ),
    );

    const { text: notesText } = renderSectionedComponent(sub, branchPath, filled, {
      defaultHeadingLevel: descriptor.defaultHeadingLevel,
      variables, registry, branchProtagonist, roles, onRoleUsed,
      onWarn: originWarner(diagnostics, loc), diagnostics, file: loc.file,
    });

    if (!notesText || notesText.trim() === '') {
      diagnostics.warn(
        DIAG_CODES.STORY_CARD_ENTRY_RENDERS_NOTHING,
        `render.storyCards entry "${title}" renders no text on branch "${branchLabel}" — `
        + 'its variant:/sections: selectors left nothing. No card is written; correct the selectors or add content.',
        entryAt(),
      );
      return;
    }

    if (takenNames.has(title)) {
      const existingType = takenNames.get(title);
      const where = existingType === cardType
        ? `both as ${cardType}` : `${existingType} and ${cardType}`;
      diagnostics.error(
        DIAG_CODES.CARD_NAME_COLLISION,
        `story cards named "${title}" collide on branch "${branchLabel}" (${where}). `
        + 'Velvet Lattice merges story cards by name, so only one survives to AID. '
        + 'Give them distinct names.',
        entryAt('title'),
      );
      return;
    }
    takenNames.set(title, cardType);

    const body = `${title} — copy the description field below into your scenario's ${descriptor.label}.`;
    const synthetic = { kind: 'reference', name: title, aid: { type: cardType, title } };
    const rendered = renderCard({
      item: synthetic, bodyText: body, notesText, diagnostics, loc: entryAt(), questions,
    }).text;

    if (!grouped.has(cardType)) grouped.set(cardType, []);
    grouped.get(cardType).push({
      sortKey: title.toLowerCase(), rendered, id: null, name: title,
    });
  });
}

function resolveSectionedComponents(compileContext, label, { loadSectioned, recordGap }) {
  const resolved = [];
  const origins = compileContext.componentOrigins || {};
  for (const descriptor of SLOTTED_COMPONENTS) {
    const spec = compileContext.componentRefs[descriptor.key];
    if (!spec) continue;
    const origin = origins[descriptor.key] || null;
    if (typeof spec === 'string' && /\{%/.test(spec)) {
      recordGap(label, descriptor.label, spec, 'unexpanded compile variable {%…} — the spec named a path that did not resolve', origin);
      continue;
    }

    if (descriptor.inlineProse && !(typeof spec === 'string' && fs.existsSync(spec))) {
      const text = String(spec).trimEnd();
      if (!text) {
        recordGap(label, descriptor.label, spec, 'inline text is empty', origin);
        continue;
      }
      resolved.push({ descriptor, spec, component: null, passthrough: text, inline: true, origin });
      continue;
    }

    if (isPassthrough(spec)) {
      if (!fs.existsSync(spec)) {
        recordGap(label, descriptor.label, spec, 'source not found', origin);
        continue;
      }
      const text = readPassthrough(spec);
      if (text === null) {
        recordGap(label, descriptor.label, spec, 'source is empty', origin);
        continue;
      }
      resolved.push({ descriptor, spec, component: null, passthrough: text, origin });
      continue;
    }

    const component = loadSectioned(spec, descriptor, origin);
    if (!component) {
      recordGap(label, descriptor.label, spec, 'source declared no sections (missing or empty file)', origin);
      continue;
    }
    resolved.push({ descriptor, spec, component, passthrough: null, origin });
  }
  return resolved;
}

function buildSlotIndex(sectionedForLeaf, branchPath) {
  const index = new Map();
  for (const { descriptor, spec, component, passthrough, inline, origin } of sectionedForLeaf) {
    if (passthrough !== null && passthrough !== undefined) {
      index.set(descriptor.key, {
        slots: new Map(), documentSlots: new Set(), sections: new Map(),
        label: descriptor.label, passthrough: true,
        origin: inline ? origin : { file: String(spec) },
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
    const sections = new Map(component.sections.map((s) => [s.name.toLowerCase(), s]));
    index.set(descriptor.key, {
      slots, documentSlots, sections, label: descriptor.label, passthrough: false,
      origin: originLocation(component, ['sections'], { file: spec == null ? undefined : String(spec) }),
    });
  }
  return index;
}

// `at` is the item's placement origin; the component side of a mismatch is related.
function checkTargetSlot(target, itemId, slotIndex, label, diagnostics, at) {
  const known = slotIndex.get(target.component);
  if (!known) return true;
  const loc = typeof at === 'string' || at == null ? { file: at } : at;
  const related = (role, origin) => (origin && origin.file ? { related: [{ label: role, ...origin }] } : {});

  if (known.passthrough) {
    diagnostics.error(
      DIAG_CODES.TARGET_UNDECLARED_SLOT,
      `item "${itemId}" targets slot "${target.slot || '(unnamed)'}" in ${known.label}, which is `
      + 'prose copied verbatim and declares no slots. Point the component at a YAML '
        + 'document with "sections:" to route items into it.',
      loc,
      related(`${known.label} component`, known.origin),
    );
    return false;
  }

  if (!target.slot) {
    diagnostics.error(
      DIAG_CODES.TARGET_NAMES_NO_SLOT,
      `item "${itemId}" renders into ${known.label} without naming a slot — `
      + `add "slot:" naming one of: ${[...known.documentSlots].join(', ') || '(the component declares none)'}.`,
      loc,
    );
    return false;
  }

  const key = target.slot.toLowerCase();
  if (known.documentSlots.has(key)) return true;

  if (known.sections.has(key)) {
    diagnostics.error(
      DIAG_CODES.TARGET_NOT_A_SLOT,
      `item "${itemId}" targets "${target.slot}" in ${known.label}, which is a section but `
      + 'not a slot — only a section declaring "slot: true" can hold items. Add "slot: true" or target a real slot.',
      loc,
      related('section', originLocation(known.sections.get(key), [], known.origin || {})),
    );
    return false;
  }

  diagnostics.error(
    DIAG_CODES.TARGET_UNDECLARED_SLOT,
    `item "${itemId}" targets slot "${target.slot}" in ${known.label} on branch "${label}", `
    + `which declares no such slot. Declared here: ${[...known.documentSlots].join(', ') || '(none)'}. Correct slot: or declare it.`,
    loc,
    related(`${known.label} sections`, known.origin),
  );
  return false;
}

function warnEmptySlots(descriptor, slotIndex, filled, label, diagnostics, file) {
  const known = slotIndex.get(descriptor.key);
  if (!known) return;
  for (const [name, section] of known.slots) {
    const placed = filled.get(name);
    if (placed && placed.length > 0) continue;
    diagnostics.warn(
      DIAG_CODES.SLOT_EMPTY,
      `slot "${name}" in ${known.label} has no items on branch "${label}". Add or route an item.`,
      originLocation(section, [], { file: file == null ? undefined : String(file) }),
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
