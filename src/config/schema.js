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
 * `protagonist` is the one exception, and deliberately not gone yet — see the comments
 * on the `protagonist:` keys below. It becomes `roles.protagonist` in Phase 8, once
 * `roles:` is an implemented feature rather than a declared-but-inert key; migrating the
 * spelling before then would leave every branch without a protagonist.
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
    // `protagonist:` becomes `roles.protagonist` in Phase 8, not here. §14.2 lists that
    // transformation, but roles are Phase 8 work — migrating the key before the feature
    // exists would leave every branch without a protagonist.
    protagonist: STRING,
    branches: null, // patched below — a node cannot reference itself during construction
  },
};

const BRANCHES = { type: TYPES.RECORD, of: BRANCH_NODE };
BRANCH_NODE.keys.branches = BRANCHES;


const CONFIG_SCHEMA = {
  type: TYPES.MAP,
  keys: {
    version: { type: TYPES.NUMBER, required: true },
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
            canon: STRING_RECORD,
            vault: { type: TYPES.STRING, note: 'Phase 7' },

          },
        },
        output: { type: TYPES.STRING, required: true },
        reports: STRING,
      },
    },

    variables: STRING_RECORD,
    roles: { type: TYPES.RECORD, of: STRING, note: 'Phase 8' },
    placeholders: { type: TYPES.RECORD, of: STRING, note: 'Phase 4' },
    scripts: SCRIPTS,
    lint: LINT,
    components: COMPONENTS,
    branches: BRANCHES,
    // See BRANCH_NODE: this moves to `roles.protagonist` in Phase 8, with the feature.
    protagonist: STRING,
  },
};

module.exports = { CONFIG_SCHEMA, BRANCH_NODE, COMPONENTS, SCRIPTS };
