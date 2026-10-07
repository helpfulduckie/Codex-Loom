'use strict';


const { TYPES, STRING, NUMBER, BOOLEAN, ANY } = require('../schema');
const { checkDispatchKeys, checkSectionKeys } = require('../keyIdentity');

const SECTION_RENDER = {
  type: TYPES.MAP,
  keys: {
    position: NUMBER,
    wrapper: STRING,
    wrap: STRING,
    compact: BOOLEAN,
    bullet: BOOLEAN,
  },
};

const SECTION_FROM = {
  type: TYPES.MAP,
  keys: {
    script: STRING,
    extract: STRING,
  },
};

const SECTION = {
  type: TYPES.MAP,
  checkKeys: checkSectionKeys,
  keys: {
    slot: BOOLEAN,
    text: { type: [TYPES.STRING, TYPES.RECORD], caseInsensitiveKeys: true, of: STRING },

    file: STRING,
    from: SECTION_FROM,

    heading: STRING,
    headingLevel: NUMBER,
    render: SECTION_RENDER,

    branches: ANY,
    variants: ANY,
  },
};

const DISPATCH = { type: TYPES.RECORD, of: { type: TYPES.MAP, keys: {} } };
DISPATCH.of.keys.branches = DISPATCH;
SECTION.keys.branches = { ...ANY, normalizeAs: DISPATCH };
SECTION.keys.variants = { ...ANY, normalizeAs: { type: TYPES.RECORD, of: SECTION } };

const COMPONENT_SCHEMA = {
  type: TYPES.MAP,
  keys: {
    sections: { type: TYPES.RECORD, caseInsensitiveKeys: true, of: SECTION },

    branches: { ...ANY, checkKeys: checkDispatchKeys, normalizeAs: DISPATCH },

    metadata: ANY,


    imports: {
      type: TYPES.SEQ,
      of: { type: TYPES.MAP, keys: { from: STRING, importVariants: ANY } },
    },

    render: {
      type: TYPES.MAP,
      keys: {
        component: { type: TYPES.MAP, keys: { variant: STRING } },
        storyCards: {
          type: TYPES.SEQ,
          of: {
            type: TYPES.MAP,
            keys: {
              title: STRING,
              variant: STRING,
              sections: { type: TYPES.SEQ, of: STRING },
              type: STRING,
            },
          },
        },
      },
    },
  },
};

module.exports = { COMPONENT_SCHEMA };
