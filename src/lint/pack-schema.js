'use strict';

const { TYPES } = require('../schema');

const string = { type: TYPES.STRING };
const regex = { ...string, packRegex: true };
const number = { type: TYPES.NUMBER };
const strings = { type: TYPES.SEQ, of: string };
const bounds = { type: TYPES.MAP, keys: { min: number, max: number } };
const fieldBounds = { type: TYPES.MAP, keys: { ...bounds.keys, words: bounds } };

const predicate = { type: TYPES.MAP, keys: {} };
Object.assign(predicate.keys, {
  all: { type: TYPES.SEQ, of: predicate },
  any: { type: TYPES.SEQ, of: predicate },
  not: predicate,
  notes: predicate,
  hasKey: string,
  equals: { type: TYPES.MAP, keys: {
    key: { ...string, required: true },
    value: { type: TYPES.ANY, required: true },
  } },
  notesMatch: regex, bodyMatch: regex, match: regex, titleMatch: regex,
});

const descriptor = { type: TYPES.MAP, keys: {} };
Object.assign(descriptor.keys, {
  // Type names already accept capitalization; union members keep that same grammar.
  type: { type: [TYPES.STRING, TYPES.SEQ], of: string, required: true, packType: true },
  keys: { type: TYPES.RECORD, of: descriptor, caseInsensitiveKeys: true },
  of: descriptor,
  keyPattern: regex,
  required: { type: TYPES.BOOLEAN },
  values: { type: TYPES.SEQ, of: { type: TYPES.ANY } },
  min: number, max: number, pattern: regex,
});

const RULE_SCHEMA = { type: TYPES.MAP, keys: {
  id: { type: [TYPES.STRING, TYPES.NUMBER] },
  severity: { ...string, values: ['warn', 'error'] },
  message: string,
  appliesTo: predicate,
  forbid: { ...predicate, packCheck: true },
  require: { ...predicate, packCheck: true },
  requireCard: { ...predicate, packCheck: true },
  schema: { ...descriptor, packCheck: true },
  over: { ...string, values: ['notes', 'body', 'meta'] },
  budget: { type: TYPES.RECORD, of: number, caseInsensitiveKeys: true, packCheck: true },
  count: { type: TYPES.MAP, packCheck: true, keys: {
    fields: { type: TYPES.RECORD, of: fieldBounds, caseInsensitiveKeys: true },
    default: fieldBounds,
  } },
  mutexHint: { type: TYPES.MAP, packCheck: true, keys: { fields: strings, max: number, message: string } },
} };

const PACK_SCHEMA = { type: TYPES.MAP, keys: {
  name: string,
  rules: { type: TYPES.SEQ, of: RULE_SCHEMA },
} };

module.exports = { PACK_SCHEMA };
