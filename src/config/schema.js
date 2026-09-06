'use strict';


const { TYPES, STRING } = require('../schema');

const STRING_SEQ = { type: TYPES.SEQ, of: STRING };
const STRING_RECORD = { type: TYPES.RECORD, of: STRING };

const SCRIPTS = {
  type: [TYPES.STRING, TYPES.MAP],
  keys: {
    input: STRING,
    output: STRING,
    context: STRING,
    library: STRING,
  },
};

const COMPONENTS = {
  type: TYPES.MAP,
  keys: {
    aiInstructions: STRING,
    authorsNote: STRING,
    description: STRING,
    adventureDescription: STRING,
    plotEssential: STRING,
    opening: STRING,
    branchFraming: STRING,
    summary: STRING,

  },
};

const RENDER = {
  type: TYPES.MAP,
  keys: {
    notesTemplate: STRING,
  },
};

const STORY_CARD_TYPE = {
  type: TYPES.MAP,
  keys: {
    plotEssential: STRING,
    summary: STRING,
    aiInstructions: STRING,
    authorsNote: STRING,
    adventureDescription: STRING,
    opening: STRING,
  },
};

const TEMPLATE_FOR = {
  type: TYPES.RECORD,
  of: { type: [TYPES.STRING, TYPES.SEQ], of: STRING },
};

const LINT_LEVEL = { type: TYPES.STRING, values: ['off', 'error', 'warn'] };

const LINT_PACK_ENTRY = {
  type: TYPES.MAP,
  keys: {
    source: STRING,
    level: LINT_LEVEL,
  },
};

const LINT_PACKS = {
  type: TYPES.RECORD,
  of: LINT_PACK_ENTRY,
};

const LINT = {
  type: TYPES.MAP,
  keys: {
    level: LINT_LEVEL,
    packs: LINT_PACKS,
  },
};

const BRANCH_NODE = {
  type: TYPES.MAP,
  keys: {
    title: STRING,
    variables: STRING_RECORD,
    roles: { type: TYPES.RECORD, of: STRING },
    placeholders: STRING_RECORD,
    scripts: SCRIPTS,
    lint: LINT,
    components: COMPONENTS,
    render: RENDER,
    templateFor: TEMPLATE_FOR,
    branches: null, // patched below — a node cannot reference itself during construction
  },
};

const BRANCHES = { type: TYPES.RECORD, of: BRANCH_NODE };
BRANCH_NODE.keys.branches = BRANCHES;


const CONFIG_SCHEMA = {
  type: TYPES.MAP,
  keys: {
    version: { type: TYPES.NUMBER },
    title: STRING,

    structure: {
      type: TYPES.MAP,
      required: true,
      keys: {
        input: {
          type: TYPES.MAP,
          keys: {
            items: STRING_SEQ,
            templates: STRING_SEQ,
            library: STRING_RECORD,
            snapshot: STRING,

          },
        },
        output: { type: TYPES.STRING, required: true },
        reports: STRING,
      },
    },

    variables: STRING_RECORD,
    roles: { type: TYPES.RECORD, of: STRING },
    placeholders: STRING_RECORD,
    scripts: SCRIPTS,
    lint: LINT,
    components: COMPONENTS,
    render: RENDER,
    templateFor: TEMPLATE_FOR,
    storyCardType: STORY_CARD_TYPE,
    branches: BRANCHES,
  },
};

module.exports = {
  CONFIG_SCHEMA, COMPONENTS, SCRIPTS, RENDER,
};
