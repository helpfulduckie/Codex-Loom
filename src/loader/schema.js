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

    // `known:` and `encapsulate:` are both gone, and both left with the envelope.
    //
    // §8.4 makes `encapsulate: false` unconditional — all four sites in the VL source
    // default it to true — so there is nothing for an author to decide. `known:` existed
    // only so `{if $aid.known}notes: '[e]'{/if}` could fire in a template, and §8.2.1
    // forbids the compiler from knowing what `[e]` means; the marker is `notes:` text
    // now, which the compiler carries without reading. Both are dropped by the migrator
    // (§14.2), so a project that still declares one gets an unknown-key ERROR naming it
    // rather than a key that is quietly read by nothing.
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

/**
 * One per-component render target (§7.2, §7.4) — where an item lands in a component.
 *
 * ── Why there is no `wrapper:` here ─────────────────────────────────────────
 *
 * §7.4 gives the slot ownership of wrapping everything placed in it, precisely so an item
 * with `wrapper: curly` in a curly slot cannot ship double-braced. A per-target wrapper
 * would be read by nothing, and a declared key that nothing reads is the §4.3 defect this
 * schema exists to catch — so the key is absent and writing one is an unknown-key ERROR
 * pointing at `render.wrapper`, which does still govern story-card output.
 *
 * `slot:` is not `required:`. A variant may override a single target key while inheriting
 * the slot from the item's base `render:`, and the schema validates one document node
 * without that merged view. A target that names no slot after merging is step 7's ERROR,
 * raised where the answer is actually known.
 */
const RENDER_TARGET_KEYS = {
  slot: STRING,
  order: { type: TYPES.NUMBER },
  template: STRING,
};

/**
 * A target accepts the mapping above or a boolean, and the boolean arm is narrower than it
 * looks: `false` is a meaningful "not here", while `true` names no slot and cannot resolve.
 * The engine cannot express "boolean, but only false", so `true` is accepted here and
 * rejected in step 7 alongside the undeclared-slot ERROR — one place that reports on
 * targets rather than two that disagree.
 */
const target = (note) => ({ type: [TYPES.MAP, TYPES.BOOLEAN], keys: RENDER_TARGET_KEYS, note });

const RENDER = {
  type: TYPES.MAP,
  keys: {
    template: STRING,
    wrapper: STRING,
    notesTemplate: STRING,
    storyCard: { type: TYPES.BOOLEAN, note: 'Phase 3' },

    // Per-component render targets (§7.4), one key per row of §7.3's component table.
    // The `note` stays until the phase that reads the key: Phase 3 builds the item/slot
    // model for the four components that get sections, and §7.7's description-as-a-
    // component and the opening pair keep their own pipelines until Phase 6.
    plotEssential: target('Phase 3'),
    summary: target('Phase 3'),
    aiInstructions: target('Phase 3'),
    authorsNote: target('Phase 3'),
    description: target('Phase 6'),
    opening: target('Phase 6'),
    branchFraming: target('Phase 6'),
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
    //
    // `notes:` is one of them, and `description:` is its accepted alias — collapsed to
    // `notes` by `model/item.js` so nothing downstream sees which arrived. Declaring both
    // on one item is an ERROR (CL0323), not a merge.
    body: ANY,
    v: ANY,
    pronouns: ANY,
    notes: ANY,
    description: ANY,

    // Composition.
    variants: ANY,
    branches: ANY,
    import: STRING,
    importVariants: { type: [TYPES.SEQ, TYPES.STRING], of: STRING },
    include: STRING,

    // v4 additions, declared so authors can write ahead of the implementation.
    kind: { type: TYPES.STRING, note: 'Phase 5' },
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
