'use strict';


const { TYPES, STRING, NUMBER, BOOLEAN, ANY } = require('../schema');

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
  keys: {
    slot: BOOLEAN,
    text: { type: [TYPES.STRING, TYPES.RECORD], of: STRING },

    file: STRING,
    from: SECTION_FROM,

    heading: STRING,
    headingLevel: NUMBER,
    render: SECTION_RENDER,

    branches: ANY,
    variants: ANY,
  },
};

const COMPONENT_SCHEMA = {
  type: TYPES.MAP,
  keys: {
    sections: { type: TYPES.RECORD, of: SECTION },

    branches: ANY,

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
