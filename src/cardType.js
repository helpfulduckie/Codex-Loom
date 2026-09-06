'use strict';


const { CODES: DIAG_CODES } = require('./diag');
const { PATH_UNSAFE_CHARS } = require('./util');

const INVALID_TYPE_CHARS = new RegExp('[' + PATH_UNSAFE_CHARS + '\\x00-\\x1f]');

function validateCardType(item, { diagnostics }) {
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
  diagnostics.error(DIAG_CODES.CARD_TYPE_INVALID, message, { file: item._source });
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
    const file = loc.file || null;
    if (trimmed && !trimmedValues.has(raw)) trimmedValues.set(raw, { to: type, file });
    if (!originOf.has(type)) originOf.set(type, file);
    return type;
  }

  function finish(diagnostics) {
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
