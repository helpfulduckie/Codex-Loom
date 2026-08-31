'use strict';

/**
 * The `compile.cl.yaml` key surface (v4 spec §6).
 *
 * Everything not declared here is an unknown-key ERROR. The surface is declared in full
 * from Phase 1, including keys whose behavior lands in later phases: those carry a
 * `note`, are recognized, and produce a "not yet implemented" WARN rather than either an
 * unknown-key ERROR or silent acceptance. Writing the schema once beats editing it in
 * every phase, and an author who writes ahead of the tool gets told so plainly.
 *
 * The v3 spellings this file carried through Phase 1 — `cards`, `overview`,
 * `structure.input.components`, `openingChoice`, `components.scripts` — are gone as of
 * the config break (§14.1). There is no compatibility mode: `version: 4` is required, and
 * its absence is what tells a v3 project to run `--migrate` rather than producing a
 * cascade of unknown-key errors.
 *
 * `protagonist:` was the one exception through Phase 7 — see `v4 Phase 8 plan.md` — and is
 * gone as of Phase 8: it is `roles.protagonist` now, an ordinary entry in `roles:` (§9.2),
 * because `roles:` is an implemented feature rather than a declared-but-inert key.
 */

const { TYPES } = require('../schema');

const STRING = { type: TYPES.STRING };
const STRING_SEQ = { type: TYPES.SEQ, of: STRING };
const STRING_RECORD = { type: TYPES.RECORD, of: STRING };

/** `scripts:` is either a directory or a mapping of the four VL hook names (§6.3). */
const SCRIPTS = {
  type: [TYPES.STRING, TYPES.MAP],
  keys: {
    input: STRING,
    output: STRING,
    context: STRING,
    library: STRING,
  },
};

/** The component specs, per the §7.3 descriptor table. */
const COMPONENTS = {
  type: TYPES.MAP,
  keys: {
    aiInstructions: STRING,
    authorsNote: STRING,
    /** The scenario blurb. Root only, written once to the output root (§7.7). */
    description: STRING,
    /**
     * The description a leaf carries, which AID applies to the adventure started there.
     * Inherited down the tree like any other component, and separate from `description:`
     * because inheriting the scenario blurb would copy it into every leaf.
     */
    adventureDescription: STRING,
    plotEssential: STRING,
    opening: STRING,
    branchFraming: STRING,
    summary: STRING,

  },
};

/**
 * `render:` — project- and branch-level rendering defaults (§4.5).
 *
 * One key so far, and it is here rather than only on the item because the thing it
 * expresses is a property of the branch, not of the card: which mods a branch loads
 * decides whether a marker like `[e]` means anything there. A branch that ships without
 * the mod sets `notesTemplate: ~` and every card in it stops emitting the control,
 * without touching a single item.
 */
const RENDER = {
  type: TYPES.MAP,
  keys: {
    notesTemplate: STRING,
  },
};

/**
 * `storyCardType:` — the AID story-card `type` a component's `render.storyCards` entries
 * land under, one per component (§7.8).
 *
 * A `render.storyCards` entry has no `aid.type` of its own — it is not an item — so its
 * category is resolved on a three-rung ladder: the entry's own `type:`, then this map keyed
 * by component, then the component's display label (`AI Instructions`, `Plot Essentials`).
 * This rung exists so a project can steer where the alternates sort in the player's card
 * list (a `zz_` prefix, say) without that opinion being authored into Codex Loom's default
 * or into a shared component file.
 *
 * Root only, and a closed map rather than an open record: unlike `templateFor:` — whose
 * keys are genuinely open (`base`, `notes`, any component) — the only meaningful keys here
 * are the component names, so a typo is worth a `CL0201` rather than silent inertness. It
 * is not branch-addressable: which category a reference card sorts under is a whole-scenario
 * decision, and nothing about it varies per branch.
 */
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

/**
 * `templateFor:` — a template-selection file per rendering role, branch-addressable (§13.4).
 *
 * An open record: `base`, `notes`, and one key per component (`plotEssential`, …), each
 * naming one `.cl.yaml` file — or a list of them, merged left to right — that carries a
 * `templates:` namespace. What merges down the branch chain is the type-to-template map
 * those files produce, key-wise, exactly as `components:` does (`src/model/branches.js`).
 * It lives here rather than inside `render:` because `render:` merges with a shallow
 * `Object.assign`, so a map nested one level deeper would be replaced wholesale by any
 * branch that touched one role.
 */
const TEMPLATE_FOR = {
  type: TYPES.RECORD,
  of: { type: [TYPES.STRING, TYPES.SEQ], of: STRING },
};

/**
 * `lint:` — the opinion layer's controls (§12.5).
 *
 * `level:` is a closed set, so a typo is a `CL0206` naming the three legal values rather
 * than a silently-ignored string. It names **the one severity the opinion layer is allowed
 * to speak at**: `off` silences it, `error` keeps opinion ERRORs and drops the prose
 * heuristics, `warn` demotes opinion ERRORs so nothing in the layer can fail a build.
 * Absent is not a level — an unset key leaves every opinion at the severity it was raised
 * with, which is what keeps a pack ERROR able to fail a build by default.
 *
 * It reaches only the opinion layer. Facts — unknown keys, undeclared roles, platform caps,
 * a leaked `{$she}` — are not silenceable at any level, and that is the property that makes
 * `off` a safe thing for an author to write.
 *
 * `packs:` went live in Phase 14 (§8.2.2). An entry is a mapping: `{}` names a bundled
 * pack, `{ source: <path> }` a hosted one, and either may carry a per-pack `level:`
 * ceiling. `~` unbinds an inherited pack on a branch.
 */
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

/**
 * The branch-node spelling of `lint:`, and it differs from the root one in exactly one key.
 *
 * **Both `packs:` and `level:` are live on a branch as of Phase 14 (§8.2.2).** `lint.packs.*`
 * branch-merges key-wise — which packs validate a branch's `notes:` depends on which mods
 * that branch ships — and a branch-declared `level:` is a per-branch ceiling that names the
 * branch in any finding it clamps. The project-level `lint.level` still governs the whole
 * compile on top of both.
 */
const BRANCH_LINT = {
  type: TYPES.MAP,
  keys: {
    level: LINT_LEVEL,
    packs: LINT_PACKS,
  },
};

/**
 * A branch node. Recursive: `branches` holds more of the same.
 *
 * Everything here merges down the chain key-wise, which is why each is a mapping rather
 * than a list (§3.3) — child keys override parent keys, siblings are independent, and
 * `~` unbinds.
 */
const BRANCH_NODE = {
  type: TYPES.MAP,
  keys: {
    title: STRING,
    variables: STRING_RECORD,
    // The built-in `protagonist` role lives here as an ordinary entry (§9.2) rather than
    // as its own key — see the module header for why Phase 8 retires the separate key.
    roles: { type: TYPES.RECORD, of: STRING },
    placeholders: STRING_RECORD,
    scripts: SCRIPTS,
    lint: BRANCH_LINT,
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
    // Not `required` here: its absence is a v3 project, which `config/load.js` reports as
    // CL0209 with a "run --migrate" hint rather than a bare missing-key ERROR (§14.1).
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
  CONFIG_SCHEMA, BRANCH_NODE, COMPONENTS, SCRIPTS, RENDER, TEMPLATE_FOR, STORY_CARD_TYPE,
};
