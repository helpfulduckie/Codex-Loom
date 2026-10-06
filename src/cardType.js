'use strict';


const { CODES: DIAG_CODES } = require('./diag');
const { PATH_UNSAFE_CHARS } = require('./util');
const { originLocation } = require('./origin');

const INVALID_TYPE_CHARS = new RegExp('[' + PATH_UNSAFE_CHARS + '\\x00-\\x1f]');

function validateCardTypeValue(type, {
  diagnostics, name = '(unknown)', source = null, file = null, field = 'aid.type', loc = null,
}) {
  if (typeof type !== 'string' || type === '') return;
  const trimmed = type.trim();
  const src = source ? ` (${source})` : '';
  let reason = null;
  if (trimmed === '') reason = 'is empty/whitespace';
  else if (INVALID_TYPE_CHARS.test(type)) reason = 'contains an illegal path character (one of < > : " / \\ | ? *)';
  else if (trimmed === '.' || trimmed === '..') reason = 'is "." or ".."';
  else if (/[ .]$/.test(type)) reason = 'ends with a space or period';
  if (!reason) return;
  const message = `Invalid ${field} "${type}" for item "${name}"${src}: ${reason}. The card type becomes a folder/file name and must be a legal path segment; use a nonempty legal type without illegal characters, . / .. or trailing space/period.`;
  diagnostics.error(DIAG_CODES.CARD_TYPE_INVALID, message, loc || { file: file || source });
}

function validateCardType(item, { diagnostics, branch }) {
  validateCardTypeValue(item.aid && item.aid.type, {
    diagnostics,
    name: item.id || (typeof item.name === 'string' ? item.name : '(unknown)'),
    source: item._source,
    loc: originLocation(item, ['aid', 'type'], { branch }),
  });
}

const AID_BUILTIN_TYPES = new Set(['character', 'class', 'race', 'location', 'faction']);

function normalizeCardType(raw) {
  if (typeof raw !== 'string' || raw === '') return { type: raw, trimmed: false };
  const trimmedText = raw.replace(/^\s+/, '');
  const lower = trimmedText.toLowerCase();
  const folded = AID_BUILTIN_TYPES.has(lower) && trimmedText !== lower;
  return { type: folded ? lower : trimmedText, trimmed: trimmedText !== raw };
}

function buildCardTypeAudit() {
  const trimmedValues = new Map();
  const originOf = new Map();

  function resolve(raw, loc = {}) {
    const { type, trimmed } = normalizeCardType(raw);
    if (typeof type !== 'string' || type === '') return type;
    if (trimmed && !trimmedValues.has(raw)) trimmedValues.set(raw, { to: type, loc: { ...loc } });
    if (!originOf.has(type)) originOf.set(type, { ...loc });
    return type;
  }

  function finish(diagnostics) {
    for (const [authored, { to, loc }] of trimmedValues) {
      diagnostics.warn(
        DIAG_CODES.CARD_TYPE_LEADING_SPACE,
        `aid.type "${authored}" has leading whitespace; writing it as "${to}". Remove the whitespace.`,
        loc,
        {
          hint: 'A leading space survives in a directory name, so the type would reach AI '
            + 'Dungeon as a category whose name differs from the obvious one by an '
            + 'invisible character.',
        },
      );
    }


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
        + 'and are written to the same file on a case-insensitive filesystem. Rename one type.',
        originOf.get(variants[variants.length - 1]),
        {
          related: variants.slice(0, -1).map(type => ({ label: 'earlier type', ...originOf.get(type) })),
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
  validateCardTypeValue,
  normalizeCardType,
  buildCardTypeAudit,
};
