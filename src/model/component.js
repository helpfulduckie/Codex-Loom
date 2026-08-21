'use strict';

/**
 * The component model (v4 spec §7.2, §7.3).
 *
 * A component document becomes an ordered list of sections, each either text or a slot.
 * This module is the one place that knows what a section *is*; `emit/components.js` knows
 * how to write one, and `model/item.js` knows which items land in which slot. Keeping the
 * three apart is what stops v3's second-resolver problem from reappearing at the component
 * layer — nothing here resolves an item, and nothing here touches the filesystem.
 *
 * ── What this module does not decide ────────────────────────────────────────
 *
 * `headingLevel` is carried through exactly as written, never defaulted. v3's two formats
 * disagree — Plot Essentials treats a bare heading as level 0 and AI Instructions treats it
 * as level 2 — and both are correct for their own output. The default therefore belongs to
 * the component descriptor in `emit/components.js`, where the component is known, rather
 * than here, where it is not. Defaulting it in this module would silently restyle every
 * existing heading in one of the two formats.
 *
 * `position` is defaulted, because both formats already agree it is 5.
 */

const { resolveBranchSpec } = require('./branches');
const { applyFieldOp } = require('./fieldops');
const { findKey, setCI } = require('../util');
const { CODES } = require('../diag');

/** How a slot's `wrapper:` applies to what lands in it. */
const WRAP = Object.freeze({
  /** Wrap every occupant on its own — The Institute's cast, four bracketed blocks. */
  EACH: 'each',
  /** Wrap the joined collection once — Coinflip Company's party, one bracketed directory. */
  ALL: 'all',
});

const DEFAULT_POSITION = 5;

/**
 * Normalize one parsed component document.
 *
 * Returns `{ sections, slots }` — `sections` ordered for output, `slots` indexed by name
 * so a render target naming a slot can be checked without re-scanning.
 *
 * @param {object|null} doc      parsed component document
 * @param {object}      options  `{ onWarn }` — `(code, message)`, severity from the code
 */
function normalizeComponent(doc, options = {}) {
  const { onWarn = () => {} } = options;

  const rawSections = (doc && doc.sections) || {};
  const sections = Object.entries(rawSections)
    .filter(([, def]) => def !== null && def !== undefined)
    .map(([name, def], index) => normalizeSection(name, def, index, onWarn));

  sections.sort((a, b) => (a.position - b.position) || (a.index - b.index));

  const slots = new Map();
  for (const section of sections) {
    if (section.isSlot) slots.set(section.name, section);
  }

  // `card:` is §7.8 and belongs to Phase 6. It is carried through opaque rather than
  // normalized or dropped: dropping it would silently lose an author's declaration, and
  // normalizing it would mean pinning a copy of the story-card key surface here, a second
  // declaration to keep in step with the first.
  return { sections, slots, card: (doc && doc.card) || null };
}

/**
 * One section, with its render options flattened onto it.
 *
 * Declaration order is kept as `index` and used as the sort tiebreak, so sections with no
 * `position:` come out in the order they were written. That is the intuitive reading of a
 * component file and it is what v3 does today — a stable sort over the document's own
 * order — so preserving it is a compatibility property, not only a preference.
 *
 * One caveat that belongs with the sort rather than in the docs: a section named with a
 * bare integer (`1:`) is reordered by JavaScript's own object key rules before this code
 * ever sees it. Section names are free-form strings (§7.4) and nothing forbids `1`, but a
 * numeric name will not sort where it was written. Names that are not bare integers —
 * every name in the corpora — are unaffected.
 */
function normalizeSection(name, def, index, onWarn) {
  const raw = (def && typeof def === 'object' && !Array.isArray(def)) ? def : {};
  const render = (raw.render && typeof raw.render === 'object') ? raw.render : {};

  const isSlot = raw.slot === true;
  const hasText = raw.text !== undefined && raw.text !== null && raw.text !== '';
  const hasHeading = typeof raw.heading === 'string' && raw.heading !== '';

  // A section is text or a slot, never both. The ambiguity is real — where would the text
  // sit relative to the occupants, and does the slot's wrapper enclose it? — and a
  // preamble is expressible as its own text section positioned ahead of the slot. Refusing
  // it now keeps the option of allowing it later; allowing it now would not.
  if (isSlot && hasText) {
    onWarn(CODES.SECTION_TEXT_AND_SLOT,
      `section "${name}" declares both "text:" and "slot: true" — a section is one or the other. `
      + 'Move the text into its own section positioned ahead of the slot.');
  }

  // Nothing to render and nothing to fill: the section is a no-op the author did not mean
  // to write. A heading alone still renders, so it does not count as empty.
  if (!isSlot && !hasText && !hasHeading) {
    onWarn(CODES.SECTION_RENDERS_NOTHING,
      `section "${name}" has no text, no heading and is not a slot, so it renders nothing.`);
  }

  let wrap = render.wrap === undefined ? WRAP.EACH : String(render.wrap).toLowerCase();
  if (wrap !== WRAP.EACH && wrap !== WRAP.ALL) {
    onWarn(CODES.SECTION_WRAP_UNKNOWN,
      `section "${name}" sets wrap: "${render.wrap}", which is neither "each" nor "all" — using "each".`);
    wrap = WRAP.EACH;
  }

  return {
    name,
    index,
    isSlot,
    text: raw.text === undefined ? null : raw.text,
    heading: hasHeading ? raw.heading : null,
    // Deliberately undefined when unwritten — see the module comment.
    headingLevel: raw.headingLevel,
    position: typeof render.position === 'number' ? render.position : DEFAULT_POSITION,
    wrapper: render.wrapper || 'none',
    wrap,
    compact: render.compact === true,
    bullet: render.bullet === true,
    branches: raw.branches || null,
    variants: raw.variants || null,
  };
}

/**
 * Layer one section variant's delta over a normalized section.
 *
 * Returns a new section; the input is never mutated, because the same normalized document
 * is shared by every leaf and a variant applied on one branch must not be visible on the
 * next. That sharing is the point of normalizing once per file rather than once per leaf.
 *
 * The delta shape is v3's, carried across unchanged so that a component file written for
 * v3's AI Instructions still means what it meant. The one translation is `render:` — the
 * normalized section has its render options flattened onto it, so a delta's `render:`
 * mapping is merged key by key rather than replacing an object.
 *
 * `text:` takes three forms, which is where the shape earns its complexity:
 *   null      drop the section's text entirely
 *   string    a field op against the section's text — a plain string replaces it
 *   mapping   treat the section's text as a keyed collection and apply a field op per key,
 *             so a variant can add, replace or delete one line without restating the rest
 *
 * The string arm goes through `applyFieldOp` rather than assigning, which is what makes
 * `dark: {text: '+{ Do not soften outcomes. }'}` — §7.6.2's own worked example — append
 * rather than replace the section with the literal characters `+{ … }`. A string that is
 * not an operation still replaces, because that is what `applyFieldOp` does with one: the
 * op vocabulary is a superset of assignment, not a separate mode. Routing it here is also
 * what keeps one vocabulary across the two positions a section variant is reached from —
 * a branch dispatch through this function, and an import selector through
 * `applySectionSelector` — rather than two that agree on plain strings and diverge on ops.
 */
function applySectionVariant(section, delta) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return section;
  const result = { ...section };

  if (delta.text !== undefined) {
    if (delta.text === null) {
      result.text = null;
    } else if (typeof delta.text === 'string') {
      const next = applyFieldOp(result.text, delta.text);
      result.text = next === '__DELETE__' ? null : next;
    } else if (typeof delta.text === 'object') {
      const base = (result.text && typeof result.text === 'object' && !Array.isArray(result.text))
        ? { ...result.text } : {};
      for (const [key, op] of Object.entries(delta.text)) {
        if (op === null) { delete base[key]; continue; }
        const next = applyFieldOp(base[key], op);
        if (next === '__DELETE__') delete base[key]; else base[key] = next;
      }
      result.text = base;
    }
  }

  if (delta.heading !== undefined) result.heading = delta.heading;
  if (delta.headingLevel !== undefined) result.headingLevel = delta.headingLevel;

  const render = (delta.render && typeof delta.render === 'object') ? delta.render : null;
  if (render) {
    if (render.position !== undefined) result.position = render.position;
    if (render.wrapper !== undefined) result.wrapper = render.wrapper;
    if (render.wrap !== undefined) result.wrap = String(render.wrap).toLowerCase();
    if (render.compact !== undefined) result.compact = render.compact === true;
    if (render.bullet !== undefined) result.bullet = render.bullet === true;
  }

  return result;
}

// ── Component imports (§7.6) ─────────────────────────────────────────────────
//
// Everything below layers *raw section definitions*, before normalization, and that choice
// is the whole design of `imports:`.
//
// A component may import a house-style base, then a world layer, then declare its own
// deltas — three sources for one section, each written as ordinary section syntax. Merging
// them raw means one layering rule applied three times and `normalizeSection` running once,
// at the end, on the finished section. Merging them normalized would mean a second layering
// rule for the normalized shape (`isSlot` where the author wrote `slot:`, render options
// flattened onto the section), and it would run `normalizeSection`'s checks on each partial
// override — reporting "renders nothing" for a project delta that supplies only a
// `branches:` dispatch, which §7.6.2's own worked example does.
//
// Two layering vocabularies for one grammar is the disagreement §7.1 names as this
// project's largest bug category, and this is the position where it would reappear.

/**
 * Layer one raw section definition over another (§7.6.3).
 *
 * `text:` goes through `applyFieldOp`, which is what makes `+{}`, `-{}` and `/{}/{}` mean
 * the same thing here as anywhere else — including the mapping form, where AI Instructions'
 * named lines let an override edit one rule without restating the block. A plain string
 * replaces, because `applyFieldOp` on a non-op string replaces; the op vocabulary is a
 * superset of assignment rather than a separate mode.
 *
 * `render:` merges key by key so an override can move a section without restating its
 * wrapper. `variants:` merges by name, and `branches:` replaces. That asymmetry is what
 * §7.6.2's worked example needs: a project overrides `narrativeTone` with nothing but a
 * `branches:` dispatch to `lighthearted`, and `lighthearted` is defined in the *imported*
 * section — a replacing `variants:` would delete the variant the dispatch just named.
 *
 * **The `variants:` merge is case-insensitive with the base spelling winning**, which every
 * other name in this language already is and which a plain `Object.assign` is not.
 * `variants:` is an open namespace — the schema cannot validate names an author invents —
 * so an imported `Dark:` and a local `dark:` both pass validation, and merging them by
 * exact key would leave two entries. `sectionsForBranch` then resolves the dispatch with a
 * case-insensitive `find`, taking whichever comes first in key order: the imported one. The
 * project's override would be discarded with nothing reported.
 */
function layerSectionDef(base, over) {
  const from = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
  const raw = (over && typeof over === 'object' && !Array.isArray(over)) ? over : {};
  const result = { ...from };

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'text') {
      if (value === null) { result.text = null; continue; }
      const next = applyFieldOp(from.text, value);
      result.text = next === '__DELETE__' ? null : next;
    } else if (key === 'render') {
      result.render = Object.assign({}, from.render || {}, value || {});
    } else if (key === 'variants') {
      const merged = { ...(from.variants || {}) };
      for (const [name, delta] of Object.entries(value || {})) {
        const existing = findKey(merged, name);
        if (existing !== null) merged[existing] = delta; else setCI(merged, name, delta);
      }
      result.variants = merged;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Merge one raw `sections:` record over another (§7.6.3).
 *
 * Three cases, and the third is the one with a diagnostic. A name the base provided is
 * layered. A name it did not is appended, in declaration order after everything inherited.
 * A name mapped to `~` deletes the inherited section — and deleting one nothing provided is
 * CL0608, on the same reasoning as CL0530: `~` removing something that was never there is
 * meaningless as written and reliably means the author expected an import to supply it.
 *
 * Key matching is case-insensitive and the *base's* spelling wins, matching how every other
 * name in this language resolves. The returned record is a fresh object; neither input is
 * mutated, because a cached imported document is shared by every project that imports it.
 */
function mergeSectionRecords(base, over, onWarn = () => {}) {
  const merged = {};
  const keyOf = new Map();
  for (const [name, def] of Object.entries(base || {})) {
    merged[name] = def;
    keyOf.set(name.toLowerCase(), name);
  }

  for (const [name, def] of Object.entries(over || {})) {
    const existing = keyOf.get(name.toLowerCase());

    if (def === null || def === undefined) {
      if (existing === undefined) {
        onWarn(CODES.IMPORT_DELETE_UNKNOWN,
          `section "${name}" is deleted with ~ but no import provided it — nothing was `
          + `removed. A bare "${name}:" with no body also parses as ~, which is usually `
          + 'the cause.');
      } else {
        delete merged[existing];
        keyOf.delete(name.toLowerCase());
      }
      continue;
    }

    if (existing !== undefined) {
      merged[existing] = layerSectionDef(merged[existing], def);
    } else {
      merged[name] = def;
      keyOf.set(name.toLowerCase(), name);
    }
  }

  return merged;
}

/**
 * Apply one import selector across every section that defines it (§7.6.2a).
 *
 * Returns the layered record and how many sections matched. Silent where a section does not
 * define the name, because an import's `importVariants:` names every section it pulled in —
 * the arity-N rule, the same one an `include:` over a lore file follows. The count is what
 * the caller needs for CL0326, which is the whole of what keeps that silence safe.
 *
 * The lookup is flat rather than slash-nested, matching `sectionsForBranch`: a component's
 * variants are one level deep, and nesting them here would be a second variant grammar.
 */
function applySectionSelector(sections, name) {
  const result = {};
  let matched = 0;

  for (const [sectionName, def] of Object.entries(sections || {})) {
    const variants = def && typeof def === 'object' ? def.variants : null;
    const key = variants
      ? Object.keys(variants).find((k) => k.toLowerCase() === String(name).toLowerCase())
      : undefined;
    if (key === undefined) {
      result[sectionName] = def;
      continue;
    }
    matched += 1;
    result[sectionName] = layerSectionDef(def, variants[key]);
  }

  return { sections: result, matched };
}

/**
 * The sections that apply to one branch, in output order, with their variants applied.
 *
 * A section excluded by its own `branches:` dispatch is dropped entirely — §7.2's
 * component-level visibility gating, which is how an author drops a whole slot's contents
 * from one branch without editing every item that routes into it.
 *
 * The variants the dispatch selected are applied here rather than handed back for the
 * caller to apply. Returning the names and trusting someone downstream to act on them is
 * how `variants:` came to be a declared key that nothing read, which is the §4.3 defect
 * the schema exists to catch. The names still travel alongside, for the reports.
 *
 * Re-sorting after applying is deliberate: a variant may set `render.position`, and a
 * section that moves has to move in the output too. The sort is the same one
 * `normalizeComponent` uses — position, then declaration order.
 */
function sectionsForBranch(component, branchPath, onWarn = () => {}) {
  const applicable = [];
  for (const section of component.sections) {
    const variants = section.branches ? resolveBranchSpec(section.branches, branchPath) : [];
    if (variants === null) continue;

    let resolved = section;
    for (const name of variants) {
      const key = section.variants
        ? Object.keys(section.variants).find((k) => k.toLowerCase() === String(name).toLowerCase())
        : undefined;
      if (key === undefined) {
        onWarn(CODES.SECTION_VARIANT_NOT_FOUND,
          `section "${section.name}" dispatches to variant "${name}", which it does not define.`);
        continue;
      }
      resolved = applySectionVariant(resolved, section.variants[key]);
    }
    applicable.push({ section: resolved, variants });
  }
  applicable.sort((a, b) => (a.section.position - b.section.position)
    || (a.section.index - b.section.index));
  return applicable;
}

/** The slots a branch actually declares — the set a render target may name (§7.4). */
function slotsForBranch(component, branchPath) {
  const slots = new Map();
  for (const { section } of sectionsForBranch(component, branchPath)) {
    if (section.isSlot) slots.set(section.name, section);
  }
  return slots;
}

module.exports = {
  normalizeComponent,
  applySectionVariant,
  layerSectionDef,
  mergeSectionRecords,
  applySectionSelector,
  sectionsForBranch,
  slotsForBranch,
  WRAP,
  DEFAULT_POSITION,
};
