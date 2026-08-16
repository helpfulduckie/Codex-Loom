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

  return { sections, slots };
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
 * The sections that apply to one branch, in output order.
 *
 * A section excluded by its own `branches:` dispatch is dropped entirely — §7.2's
 * component-level visibility gating, which is how an author drops a whole slot's contents
 * from one branch without editing every item that routes into it. The variant names the
 * dispatch selected travel with each section; applying them is the caller's business.
 */
function sectionsForBranch(component, branchPath) {
  const applicable = [];
  for (const section of component.sections) {
    const variants = section.branches ? resolveBranchSpec(section.branches, branchPath) : [];
    if (variants === null) continue;
    applicable.push({ section, variants });
  }
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
  sectionsForBranch,
  slotsForBranch,
  WRAP,
  DEFAULT_POSITION,
};
