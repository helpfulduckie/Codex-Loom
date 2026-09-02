'use strict';

const fs = require('fs');
const { normalizeComponent, applySectionSelector, slotsForBranch } = require('./model/component');
const { busWarner, CODES: DIAG_CODES } = require('./diag');
const {
  SLOTTED_COMPONENTS, isPassthrough, readPassthrough, renderSectionedComponent,
} = require('./emit/components');
const { renderCard } = require('./emit/vl');

/**
 * The sections one `render.storyCards` entry (or `render.component`) renders (§7.8).
 *
 * Selection is a `sections:` subset (a plain key-filter over `rawSections`) then a `variant:`
 * fan-out (`applySectionSelector`, the same one `imports:` uses). The result is re-normalized
 * into a component the section renderer can take. The re-normalization runs `normalizeSection`
 * again, so its `onWarn` is a no-op here: load-time normalization already reported the base
 * sections' structure, and a selector only edits `text:`/`heading:`/`render:` — it cannot
 * introduce the slot/text conflict or the render-nothing case those checks catch. A `variant:`
 * that empties a section shows up instead as CL0625 on the entry, raised by the caller.
 *
 * `entrySections` is the entry's `sections:` list, or null for `render.component`.
 */
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

/**
 * §7.8 — a component's `render.storyCards` entries, rendered for one leaf.
 *
 * Each entry renders the component again — a `variant:` selector, a `sections:` subset, or
 * both, with the leaf's slot occupants in place — and is emitted as a trigger-less
 * `kind: reference` story card: the rendered component text as the `notes:` payload, a
 * one-line orienting string as the body. The cards are appended to `grouped` (the leaf's
 * `renderBranchItems` card map) so Phase 11 frontier placement writes them like any other
 * card, keyed on `(type, name)`.
 *
 * The card's AID `type` resolves on §7.8's three-rung ladder: the entry's own `type:`, then
 * `storyCardType[<component key>]` from compile.yaml, then the component's display label.
 *
 * `CL0622` is checked here rather than inherited from `renderBranchItems`: these cards are
 * built after that function returns, so its `seenNames` set never sees them. The check reads
 * the names already in `grouped` (the real cards) plus the entries emitted so far.
 */
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

  // Names already taken on this leaf, per type — the real cards, then each entry as it lands.
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
    // §7.8's cards land in the same `Story Cards/{type}/` tree as every other card, so they
    // take the same normalization — otherwise a component declaring `type: Character` would
    // reopen the collision this closes everywhere else.
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

/**
 * Resolve every sectioned component declared for this leaf, ahead of the items.
 *
 * Returns one entry per component that loaded, in `SLOTTED_COMPONENTS` order. A component
 * that cannot be found is recorded as a gap and omitted — the gap report already says a
 * requested component produced no file, and adding a placement ERROR for every item that
 * named one of its slots would bury that one fact under a per-item pile.
 */
function resolveSectionedComponents(compileContext, label, { loadSectioned, recordGap }) {
  const resolved = [];
  for (const descriptor of SLOTTED_COMPONENTS) {
    const spec = compileContext.componentRefs[descriptor.key];
    if (!spec) continue;
    // A surviving `{%…}` is a compile variable that named a path and did not resolve — the
    // spec was meant to be a file. It is caught here rather than written as content. A
    // `{$…}` token is *not* caught: it belongs to the leaf token pass (`applyTokenPass` in
    // the leaf loop for an `inlineProse` component, the CL0430 output sweep otherwise), and
    // guarding on the bare brace made a role reference in an inline opening a fatal CL0634.
    if (typeof spec === 'string' && /\{%/.test(spec)) {
      recordGap(label, descriptor.label, spec, 'unexpanded compile variable {%…} — the spec named a path that did not resolve');
      continue;
    }

    // An opening is routinely a sentence rather than a path — `opening: "Who are you?"` —
    // and `resolveComponentSpec` hands back the raw string when nothing on disk matches.
    // Only the rows that declare `inlineProse` take that reading: for every other component
    // a spec naming no file is a broken path, and treating it as content would write the
    // path into the output instead of reporting it.
    if (descriptor.inlineProse && !(typeof spec === 'string' && fs.existsSync(spec))) {
      // Already variable-expanded by `resolveComponentSpec`; only trimmed here.
      const text = String(spec).trimEnd();
      if (!text) {
        recordGap(label, descriptor.label, spec, 'inline text is empty');
        continue;
      }
      resolved.push({ descriptor, spec, component: null, passthrough: text });
      continue;
    }

    // Prose copied verbatim, not a document to compile. It declares no sections and so no
    // slots, which is a fact the slot index needs — an item targeting a slot in a `.md`
    // component would otherwise be dropped in silence.
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

/**
 * What a render target on this branch is allowed to name.
 *
 * Three sets, because §7.4 asks three different questions of a target's `slot:` and gives
 * three different answers. `slots` is what this branch will actually place into.
 * `documentSlots` is every slot the document declares, branch gating ignored — a slot
 * gated off on this branch is correctly spelled and must not be reported as a typo, which
 * is the whole content of §7.4's third and fifth rows. `sections` is every name in the
 * document, so naming a text section can be told apart from naming nothing at all. All
 * three are keyed lowercased, matching how `renderSectionedComponent` looks occupants up.
 *
 * A component key absent from this index is one that failed to load. Targets naming it are
 * left alone: the gap report owns that failure.
 */
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

/**
 * Check one render target against the branch's slot set (§7.4).
 *
 * Returns true when the target may be placed. The three refusals are all ERRORs and all
 * name the item, because each is a typo class that otherwise ends as silence: v3 filed an
 * occupant under a slot key no section matched and dropped it, which made a misspelled
 * `slot:` and a deliberately excluded item indistinguishable in the output.
 *
 * A slot the component declares but this branch gates off is *not* one of them — §7.4's
 * third and fifth rows keep component-level gating legitimate, and the consequence of
 * gating it away is caught by the no-output invariant instead.
 */
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
  // Active on this branch, or declared and gated off on it. The second places nothing and
  // says nothing — the name is right, and whether losing the placement matters is the
  // no-output invariant's question rather than this one's.
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

/**
 * A declared slot that no item filled on this branch (§7.4) — a WARN, not an error.
 *
 * An empty cast is a legitimate branch. The warning exists because an empty slot and a
 * slot whose occupants all mis-typed their `slot:` look identical in the output file, and
 * the second is worth a line on the way past.
 */
function warnEmptySlots(descriptor, slotIndex, filled, label, diagnostics, file) {
  const known = slotIndex.get(descriptor.key);
  if (!known) return;
  for (const name of known.slots.keys()) {
    const placed = filled.get(name);
    if (placed && placed.length > 0) continue;
    // Located at the component that declared the slot, not at the item that failed to
    // fill it — there is no such item, which is the whole finding. §4.4's "every
    // diagnostic names a file" otherwise has one exception, and an author reading
    // "slot X has no items" with no path has to guess which component declared X.
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
