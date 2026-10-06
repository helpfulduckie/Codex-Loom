'use strict';


const { TYPES, STRING, BOOLEAN } = require('../schema');
const { FUNCTION_NAMES } = require('../render/parse');

const RENDER_FUNCTIONS = Object.freeze([...FUNCTION_NAMES, 'bare']);

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

const PART_ENTRY = { type: [TYPES.STRING, TYPES.MAP], keys: FIELD_DECL.keys };
const PARTS_LIST = { type: TYPES.SEQ, of: PART_ENTRY };
FIELD_DECL.keys.parts = PARTS_LIST;

const TRY_LIST = { type: TYPES.SEQ, of: PART_ENTRY };
FIELD_DECL.keys.try = TRY_LIST;

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

const GROUP_LIST = { type: TYPES.SEQ, of: TEMPLATE_ENTRY };

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
  PARTS_LIST, TRY_LIST,
};
