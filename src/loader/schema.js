'use strict';


const { TYPES, STRING, ANY } = require('../schema');

const AID = {
  type: TYPES.MAP,
  keys: {
    type: STRING,
    title: STRING,
    triggers: { type: [TYPES.SEQ, TYPES.STRING], of: STRING },

  },
};

const NAME = {
  type: [TYPES.STRING, TYPES.MAP],
  keys: {
    display: STRING,
    full: STRING,
  },
};

const RENDER_TARGET_KEYS = {
  slot: STRING,
  order: { type: TYPES.NUMBER },
  template: STRING,
};

const target = (note, noteFinal) => ({
  type: [TYPES.MAP, TYPES.BOOLEAN], keys: RENDER_TARGET_KEYS, note, noteFinal,
});

const RENDER = {
  type: TYPES.MAP,
  keys: {
    template: STRING,
    wrapper: STRING,
    notesTemplate: STRING,
    storyCard: { type: TYPES.BOOLEAN },

    plotEssential: target(),
    summary: target(),
    aiInstructions: target(),
    authorsNote: target(),
    adventureDescription: target(),
    opening: target(),
    branchFraming: target('branch framing sits at an interior node, where no items resolve', true),
  },
};

const ITEM_SCHEMA = {
  type: TYPES.MAP,
  keys: {
    id: STRING,
    name: NAME,
    aid: AID,
    render: RENDER,

    body: ANY,
    v: ANY,
    pronouns: ANY,
    notes: ANY,
    description: ANY,

    meta: ANY,

    variants: ANY,
    branches: ANY,
    import: STRING,
    importVariants: { type: [TYPES.SEQ, TYPES.STRING], of: STRING },
    include: STRING,

    kind: { type: TYPES.STRING, values: ['story', 'reference'] },
  },
};

for (const alias of ['var', 'vars', 'variable', 'variables']) {
  ITEM_SCHEMA.keys[alias] = ANY;
}

module.exports = { ITEM_SCHEMA };
