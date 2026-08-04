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
 * ── Keys marked TRANSITIONAL ────────────────────────────────────────────────
 *
 * Phase 1 Step 8 makes the config break: `cards` → `items`, `overview` → `reports`,
 * `structure.input.components` and `{@}` deleted, `protagonist` → `roles.protagonist`,
 * `openingChoice` → `branchFraming`, `components.scripts` → top-level `scripts`. Until
 * that step lands, the golden fixtures still carry v3 sources and have to load, so the
 * superseded spellings are declared and accepted *silently* — not as `alias`, which
 * would warn, because a compile that is byte-for-byte correct should not be noisy about
 * a migration that has not happened yet.
 *
 * Every one is tagged TRANSITIONAL. They come out together in Step 8, at which point the
 * v4 spelling beside each is the only one left.
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
    description: STRING,
    plotEssential: STRING,
    opening: STRING,
    branchFraming: STRING,
    summary: { type: TYPES.STRING, note: 'Phase 6' },

    // TRANSITIONAL — v3 spellings, removed in Step 8.
    openingChoice: STRING,
    scripts: STRING,
  },
};

const LINT = {
  type: TYPES.MAP,
  note: 'Phase 5',
  keys: {
    level: STRING,
    packs: { type: TYPES.RECORD, of: { type: [TYPES.MAP, TYPES.ANY] } },
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
    roles: { type: TYPES.RECORD, of: STRING, note: 'Phase 8' },
    placeholders: { type: TYPES.RECORD, of: STRING, note: 'Phase 4' },
    scripts: SCRIPTS,
    lint: LINT,
    components: COMPONENTS,
    branches: null, // patched below — a node cannot reference itself during construction
  },
};

const BRANCHES = { type: TYPES.RECORD, of: BRANCH_NODE };
BRANCH_NODE.keys.branches = BRANCHES;

// TRANSITIONAL — v3 put `protagonist:` on a branch node; Step 8 folds it into roles.
BRANCH_NODE.keys.protagonist = STRING;
// TRANSITIONAL — v3 allowed component keys directly on a branch node.
BRANCH_NODE.keys.opening = STRING;
BRANCH_NODE.keys.openingChoice = STRING;

const CONFIG_SCHEMA = {
  type: TYPES.MAP,
  keys: {
    version: { type: TYPES.NUMBER },
    title: STRING,

    // TRANSITIONAL — `structure` becomes required in Step 8, alongside
    // `structure.output`. Both tightenings are deferred to the migration step so that
    // every required-key change lands in one reviewed commit rather than being spread
    // across the refactor, where a failure would be ambiguous between "the refactor
    // broke something" and "this config was always incomplete".
    structure: {
      type: TYPES.MAP,
      keys: {
        input: {
          type: TYPES.MAP,
          keys: {
            items: STRING_SEQ,
            templates: STRING_SEQ,
            canon: STRING_RECORD,
            vault: { type: TYPES.STRING, note: 'Phase 7' },

            // TRANSITIONAL — `cards` becomes `items` (sequence only) in Step 8; the
            // scalar-or-sequence leniency goes with it.
            cards: { type: [TYPES.SEQ, TYPES.STRING], of: STRING },
            // TRANSITIONAL — deleted outright in Step 8 (§6.1); most of it is inert
            // today, so it is accepted as an opaque block rather than described.
            components: { type: TYPES.ANY },
          },
        },
        // TRANSITIONAL — `output` becomes required in Step 8. v3 silently defaulted to
        // ./output, which wrote a tree somewhere the author was not looking; a missing
        // required key is the better failure. Not enforced yet only because the fixtures
        // and test configs have to keep loading until the migration step.
        output: STRING,
        reports: STRING,

        // TRANSITIONAL — `overview` becomes `reports` in Step 8.
        overview: STRING,
      },
    },

    variables: STRING_RECORD,
    roles: { type: TYPES.RECORD, of: STRING, note: 'Phase 8' },
    placeholders: { type: TYPES.RECORD, of: STRING, note: 'Phase 4' },
    scripts: SCRIPTS,
    lint: LINT,
    components: COMPONENTS,
    branches: BRANCHES,

    // TRANSITIONAL — becomes roles.protagonist in Step 8 (§9).
    protagonist: STRING,
  },
};

module.exports = { CONFIG_SCHEMA, BRANCH_NODE, COMPONENTS, SCRIPTS };
