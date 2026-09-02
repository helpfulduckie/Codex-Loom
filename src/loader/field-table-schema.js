'use strict';

/**
 * The `fields.cl.yaml` key surface (v4 spec §13.2–§13.5).
 *
 * `loader/field-table.js` validates a field table procedurally as it folds each document
 * into the merge accumulator — it has to, because the three namespaces merge key-wise and
 * a later directory may replace an entry the schema would otherwise have rejected. This
 * descriptor is the *declarative* view of the same surface, for the two callers that want
 * one: `scripts`/`__tests__` checking the doc examples against a real schema, and
 * `buildKeyIndex`, which needs `fields:` / `groups:` / `templates:` in its cross-level key
 * index so a stray `label:` at compile-yaml top level is told where it belongs.
 *
 * The two must not drift. `field-table.test.js` binds them: `FIELD_KEYS` (the procedural
 * allow-list) and the declared keys of `FIELD_DECL` are asserted equal, and the render
 * function set is shared from `render/parse` rather than restated.
 */

const { TYPES } = require('../schema');
const { FUNCTION_NAMES } = require('../render/parse');

const STRING = { type: TYPES.STRING };
const BOOLEAN = { type: TYPES.BOOLEAN };

/** `render:` names one of the seven functions or the no-op `bare` (§13.2). */
const RENDER_FUNCTIONS = Object.freeze([...FUNCTION_NAMES, 'bare']);

/**
 * One `fields:` entry (§13.2). Keys mirror `FIELD_KEYS` in `field-table.js` exactly;
 * `field-table.test.js` asserts the two lists stay identical.
 *
 *   from       a body path or a list of them
 *   labelWhen  a conditional label — `{ originalAppearance: Current Appearance }`
 */
const FIELD_DECL = {
  type: TYPES.MAP,
  keys: {
    label: STRING,
    render: { type: TYPES.STRING, values: RENDER_FUNCTIONS },
    join: STRING,
    wrap: STRING,
    wrapLabel: BOOLEAN,
    block: BOOLEAN,
    from: { type: [TYPES.STRING, TYPES.SEQ], of: STRING },
    always: BOOLEAN,
    labelWhen: { type: TYPES.RECORD, of: STRING },
  },
};

/**
 * A `templates:` list entry (§13.3, §13.5). A bare string names a field or group; a
 * mapping is one of the escape forms — an inline override (`field:` plus any `FIELD_DECL`
 * key), a `.partial` drop-in (`include:`), a literal line (`raw:`), or the whole-template
 * audit opt-out (`allowExtra:`).
 */
const TEMPLATE_ENTRY = {
  type: [TYPES.STRING, TYPES.MAP],
  keys: {
    ...FIELD_DECL.keys,
    field: STRING,
    name: STRING,
    include: STRING,
    raw: STRING,
    allowExtra: BOOLEAN,
  },
};

/** A `groups:` entry — a flat list of declared field names (§13.3, no nesting). */
const GROUP_LIST = { type: TYPES.SEQ, of: STRING };

const TEMPLATE_LIST = { type: TYPES.SEQ, of: TEMPLATE_ENTRY };

const FIELD_TABLE_SCHEMA = {
  type: TYPES.MAP,
  keys: {
    fields: { type: TYPES.RECORD, of: FIELD_DECL },
    groups: { type: TYPES.RECORD, of: GROUP_LIST },
    templates: { type: TYPES.RECORD, of: TEMPLATE_LIST },
  },
};

module.exports = {
  FIELD_TABLE_SCHEMA, FIELD_DECL, TEMPLATE_ENTRY, GROUP_LIST, TEMPLATE_LIST, RENDER_FUNCTIONS,
};
