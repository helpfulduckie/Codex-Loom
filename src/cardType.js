'use strict';

/**
 * `aid.type` validation and normalization for emit (v4 spec §4.4).
 *
 * `aid.type` becomes both a folder and a filename — `Story Cards/{type}/{type}.md` — so it
 * must be a legal path segment, and a built-in AID category has to be folded to the casing
 * AID stores or the cards land in a custom category beside the real one.
 */

const { CODES: DIAG_CODES } = require('./diag');
const { PATH_UNSAFE_CHARS } = require('./util');

// Characters illegal in a Windows/Unix path segment, plus control chars — built on
// util.js's PATH_UNSAFE_CHARS, the single definition it shares with overview.js's
// sanitizeFilename. aid.type becomes both a folder and a filename, so it must be safe.
const INVALID_TYPE_CHARS = new RegExp('[' + PATH_UNSAFE_CHARS + '\\x00-\\x1f]');

/**
 * Validate an item's aid.type after variable expansion. aid.type is written to disk
 * as Story Cards/{type}/{type}.md, so it must be a legal path segment. No-op when the
 * item has no aid.type (that case is already warned about during item resolution).
 *
 * Without `options.diagnostics`, throws (aborts the compile) on an invalid type — the
 * behavior every caller outside the leaf loop still wants. With `options.diagnostics`,
 * raises `CARD_TYPE_INVALID` on the bus and returns instead, so the leaf loop that calls
 * it can continue to the next item and report every bad type in one run.
 */
function validateCardType(item, { diagnostics } = {}) {
  const type = item.aid && item.aid.type;
  if (typeof type !== 'string' || type === '') return;
  const trimmed = type.trim();
  const name = item.id || (typeof item.name === 'string' ? item.name : '(unknown)');
  const src = item._source ? ` (${item._source})` : '';
  let reason = null;
  if (trimmed === '') reason = 'is empty/whitespace';
  else if (INVALID_TYPE_CHARS.test(type)) reason = 'contains an illegal path character (one of < > : " / \\ | ? *)';
  else if (trimmed === '.' || trimmed === '..') reason = 'is "." or ".."';
  else if (/[ .]$/.test(type)) reason = 'ends with a space or period';
  if (!reason) return;
  const message = `Invalid aid.type "${type}" for item "${name}"${src}: ${reason}. aid.type becomes a folder/file name and must be a legal path segment.`;
  if (diagnostics) {
    diagnostics.error(DIAG_CODES.CARD_TYPE_INVALID, message, { file: item._source });
    return;
  }
  throw new Error(message);
}

/**
 * AI Dungeon's five built-in story-card categories, in the casing AID itself stores.
 *
 * Confirmed against the platform rather than inherited from Velvet Lattice's old list: a
 * card pushed as `Race` comes back as `Race` and does not group with `race` in the editor,
 * so AID stores the string verbatim and matches it exactly. Anything not in this set is a
 * custom category and keeps whatever casing the author gave it — `Character - Dalor` and
 * `Spell - Ice` are deliberate groupings, not misspellings of a built-in.
 */
const AID_BUILTIN_TYPES = new Set(['character', 'class', 'race', 'location', 'faction']);

/**
 * Normalize one `aid.type` for emit: trim leading space, fold a built-in to lowercase.
 *
 * Pure, and separate from `validateCardType` because the two answer different questions —
 * that one asks whether the string can be a path at all and throws when it cannot, this one
 * asks what should actually be written. Trailing space and period never reach here; they
 * are fatal above, since Windows strips them and the type would silently become another.
 *
 * @returns {{ type: string, trimmed: boolean }}
 */
function normalizeCardType(raw) {
  if (typeof raw !== 'string' || raw === '') return { type: raw, trimmed: false };
  const trimmedText = raw.replace(/^\s+/, '');
  const lower = trimmedText.toLowerCase();
  const folded = AID_BUILTIN_TYPES.has(lower) && trimmedText !== lower;
  return { type: folded ? lower : trimmedText, trimmed: trimmedText !== raw };
}

/**
 * Compile-wide accumulator for `aid.type` normalization and collisions (CL0626–CL0628).
 *
 * Shaped like `buildFieldAudit`: record as the compile walks branches, report once at the
 * end. Both halves need that shape for the same reason — a type is resolved per item per
 * branch, so per-site reporting would print one line per card per branch for a single
 * authoring decision, and the collision check cannot run until every branch's types are in.
 */
function buildCardTypeAudit() {
  // authored value → { to, file }. Keyed on the authored string so one warning covers
  // every card that spells the type that way.
  const trimmedValues = new Map();
  // final type → the first source file that produced it, for the collision message.
  const originOf = new Map();

  function resolve(raw, loc = {}) {
    const { type, trimmed } = normalizeCardType(raw);
    if (typeof type !== 'string' || type === '') return type;
    const file = loc.file || null;
    if (trimmed && !trimmedValues.has(raw)) trimmedValues.set(raw, { to: type, file });
    if (!originOf.has(type)) originOf.set(type, file);
    return type;
  }

  function finish(diagnostics) {
    if (!diagnostics) return;

    for (const [authored, { to, file }] of trimmedValues) {
      diagnostics.warn(
        DIAG_CODES.CARD_TYPE_LEADING_SPACE,
        `aid.type "${authored}" has leading whitespace; writing it as "${to}".`,
        { file },
        {
          hint: 'A leading space survives in a directory name, so the type would reach AI '
            + 'Dungeon as a category whose name differs from the obvious one by an '
            + 'invisible character.',
        },
      );
    }

    // The built-in fold itself is not reported. It is a correct, unconditional rewrite an
    // author cannot act on — capitalizing `Character` is the natural spelling, since it
    // matches a field table's `templates:` keys — so a per-compile line about it was noise
    // on a handled situation. The fold still happens; see `normalizeCardType`.

    // Collision is checked on the *normalized* values: a pair that folded to one built-in
    // has already been merged on purpose, and only a pair that still differs still collides.
    const byPath = new Map();
    for (const type of originOf.keys()) {
      const key = type.trim().toLowerCase();
      if (!byPath.has(key)) byPath.set(key, []);
      byPath.get(key).push(type);
    }
    for (const [, variants] of byPath) {
      if (variants.length < 2) continue;
      const sorted = variants.slice().sort();
      diagnostics.error(
        DIAG_CODES.CARD_TYPE_CASE_COLLISION,
        `aid.type values ${sorted.map((v) => `"${v}"`).join(' and ')} differ only by case, `
        + 'and are written to the same file on a case-insensitive filesystem.',
        { file: originOf.get(sorted[0]) },
        {
          hint: 'Story Cards/{type}/{type}.md is one path for all of them on Windows and '
            + 'macOS, so the group written last overwrites the others and their cards never '
            + 'reach AI Dungeon. Pick one spelling.',
        },
      );
    }
  }

  return { resolve, finish };
}

module.exports = {
  validateCardType,
  normalizeCardType,
  buildCardTypeAudit,
};
