'use strict';

/**
 * The component key surface (v4 spec §7.2, §7.3).
 *
 * A component is a named collection of sections. Some sections carry text; some are slots
 * that items route into. That is the whole model, and it replaces four file formats: PE's
 * anonymous ordered block list, AI Instructions' and Author's Note's named `sections:`
 * mapping, and Description's two-field format (§7.7).
 *
 * ── Why sections are a record and not a sequence ────────────────────────────
 *
 * §7.2 makes naming load-bearing rather than cosmetic. §7.6 lets a component import
 * another, and imports merge *by name*: an anonymous block cannot be overridden,
 * repositioned, or deleted with `~` by the importing project. v3's PE blocks are
 * anonymous, which is exactly why they could never have been importable. A record keyed by
 * section name is what makes Phase 6 possible at all, so the shape is chosen now even
 * though nothing imports yet.
 *
 * ── What this surface deliberately does not declare ─────────────────────────
 *
 * `blocks:` — v3's nested grouping — is absent, so a v3 PE file validated against this
 * schema reports it as an unknown key. That is the intended migration signal: a group of
 * blocks under a heading becomes a slot with a heading, and the items inside it move to
 * their own definitions with a `render.plotEssential` target.
 *
 * Sections do not nest (§7.4), so there is no `sections:` key inside a section either.
 */

const { TYPES } = require('../schema');

const STRING = { type: TYPES.STRING };
const NUMBER = { type: TYPES.NUMBER };
const BOOLEAN = { type: TYPES.BOOLEAN };
const ANY = { type: TYPES.ANY };

/**
 * `render:` on a section — how the section lays itself out, not what it contains.
 *
 * `wrap` is the one key with no v3 ancestor. v3 wraps a standalone PE block on its own and
 * wraps a `blocks:` group once around the join, and both behaviors are in live use: The
 * Institute's cast is four separately-bracketed blocks, Coinflip Company's party is one
 * bracketed directory. §7.4's "a slot owns the wrapping" describes the second only, so the
 * choice becomes explicit here rather than silently collapsing the first into the second.
 */
const SECTION_RENDER = {
  type: TYPES.MAP,
  keys: {
    position: NUMBER,
    wrapper: STRING,
    /** `each` wraps every occupant, `all` wraps the joined collection. Default `each`. */
    wrap: STRING,
    /** Suppress the blank line between the heading and what follows. */
    compact: BOOLEAN,
    /** Render each line of `text:` as a list item. */
    bullet: BOOLEAN,
  },
};

/**
 * One section.
 *
 * `text:` accepts a string or a mapping of named lines, which is AI Instructions' existing
 * shape — the names are what let a variant replace or delete one rule without restating
 * the block.
 */
const SECTION = {
  type: TYPES.MAP,
  keys: {
    /** `true` marks a section items can route into (§7.2). */
    slot: BOOLEAN,
    text: { type: [TYPES.STRING, TYPES.RECORD], of: STRING },
    heading: STRING,
    headingLevel: NUMBER,
    render: SECTION_RENDER,

    // Open namespaces, for the same reason `body:` is one on an item: a branch dispatch
    // tree and a variant delta are the author's own vocabulary, and validating them would
    // report every branch name as an unknown key.
    branches: ANY,
    variants: ANY,
  },
};

const COMPONENT_SCHEMA = {
  type: TYPES.MAP,
  keys: {
    sections: { type: TYPES.RECORD, of: SECTION },

    // Document-level dispatch and deltas, carried forward from the AI Instructions format.
    branches: ANY,
    variants: ANY,

    // §7.6 and §7.8, both Phase 6. Declared so writing one is a clear "not yet" rather
    // than a confusing unknown-key ERROR — the same courtesy the item surface extends to
    // the render targets.
    imports: { type: TYPES.SEQ, of: ANY, note: 'Phase 6' },
    render: { type: TYPES.MAP, keys: { component: ANY, storyCards: ANY }, note: 'Phase 6' },

    // v3's AI Instructions story card (§7.8). Superseded by `render.storyCards` when
    // Phase 6 lands; declared as an open namespace until then, because its key surface is
    // the story-card surface and pinning a copy of it here would be a second declaration
    // to keep in step with the first.
    card: { type: TYPES.ANY, note: 'Phase 6' },
  },
};

module.exports = { COMPONENT_SCHEMA, SECTION, SECTION_RENDER };
