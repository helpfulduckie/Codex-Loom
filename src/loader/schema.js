'use strict';

/**
 * The item key surface (v4 spec §7, §4.3).
 *
 * Written against the surface the compiler actually reads, established by grepping every
 * property access in `src/` and by a census of all 335 item definitions in the fixture and
 * test corpora — not from the spec's prose, which describes the intended v4 end state and
 * is wrong in at least one place (§4.8 says `kind:` "survives the item rename"; there is no
 * `kind` anywhere in v3, so it is new).
 *
 * ── Why this schema exists ──────────────────────────────────────────────────
 *
 * The canonical §4.3 failure is an item key that is spelled correctly and placed wrongly:
 *
 *     - id: Wyvern
 *       aid:
 *         type: Race
 *       triggers: Wyvern        # ← reads as an item key; the emitter reads aid.triggers
 *
 * Nothing reads `triggers` there, so the item compiles with no triggers and never fires.
 * That defect lived in shared canon, inherited by every project importing it. The shared
 * engine's relocation check exists for exactly this, which is why the item and config
 * surfaces are validated by one engine rather than two.
 */

const { TYPES } = require('../schema');

const STRING = { type: TYPES.STRING };
const ANY = { type: TYPES.ANY };

/** `aid:` — the AI Dungeon Story Card fields. Meaningful only for a story-card target. */
const AID = {
  type: TYPES.MAP,
  keys: {
    type: STRING,
    title: STRING,
    triggers: { type: [TYPES.SEQ, TYPES.STRING], of: STRING },
    known: { type: TYPES.BOOLEAN },
    encapsulate: { type: TYPES.BOOLEAN },
  },
};

/** `name:` — either a bare string or a display/full pair. */
const NAME = {
  type: [TYPES.STRING, TYPES.MAP],
  keys: {
    display: STRING,
    full: STRING,
  },
};

const RENDER = {
  type: TYPES.MAP,
  keys: {
    template: STRING,
    wrapper: STRING,
    notesTemplate: { type: TYPES.STRING, note: 'Phase 2' },
    storyCard: { type: TYPES.BOOLEAN, note: 'Phase 3' },

    // Per-component render targets (§7.4). Declared now so writing one is a clear
    // "not yet" rather than a confusing unknown-key ERROR; implemented in Phase 3.
    plotEssential: { type: [TYPES.MAP, TYPES.BOOLEAN], note: 'Phase 3' },
    summary: { type: [TYPES.MAP, TYPES.BOOLEAN], note: 'Phase 3' },
    aiInstructions: { type: [TYPES.MAP, TYPES.BOOLEAN], note: 'Phase 3' },
    authorsNote: { type: [TYPES.MAP, TYPES.BOOLEAN], note: 'Phase 3' },
    description: { type: [TYPES.MAP, TYPES.BOOLEAN], note: 'Phase 3' },
    opening: { type: [TYPES.MAP, TYPES.BOOLEAN], note: 'Phase 3' },
  },
};

const ITEM_SCHEMA = {
  type: TYPES.MAP,
  keys: {
    id: STRING,
    name: NAME,
    aid: AID,
    render: RENDER,

    // Open namespaces (§4.3). Never validated, and never proposed as a relocation
    // destination — a block that accepts every key would match every typo.
    body: ANY,
    v: ANY,
    pronouns: ANY,

    // Composition.
    variants: ANY,
    branches: ANY,
    import: STRING,
    importVariants: { type: [TYPES.SEQ, TYPES.STRING], of: STRING },
    include: STRING,

    // v4 additions, declared so authors can write ahead of the implementation.
    kind: { type: TYPES.STRING, note: 'Phase 5' },
    notes: { type: TYPES.ANY, note: 'Phase 2' },
    description: { type: TYPES.ANY, note: 'Phase 2' },
  },
};

/**
 * The `v:` block aliases (§4.7). Declared separately from the schema because
 * `normalizeCardVarField` collapses them to `v` before validation ever runs; they are
 * listed here so the relocation index does not mistake them for unknown keys if
 * validation is ever moved ahead of normalization.
 */
for (const alias of ['var', 'vars', 'variable', 'variables']) {
  ITEM_SCHEMA.keys[alias] = ANY;
}

module.exports = { ITEM_SCHEMA, AID, NAME, RENDER };
