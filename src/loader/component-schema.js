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

    /**
     * §7.6.2a — the fan-out. A selector over what the sections declare, never a
     * declaration site: a component has no variants of its own, so a name here is looked
     * up in each section's own `variants:` and applied wherever it is found. `~` at this
     * position excludes the whole component from the branch, which is what `~` means at
     * every other position in the language.
     *
     * An open namespace, like the section-level key, because a branch dispatch tree is the
     * author's own vocabulary and validating it would report every branch name as unknown.
     *
     * This is not v3's document layer returning. That layer brought a fourth branch walker,
     * `resolveAINBranches`, which disagreed with `resolveBranchSpec` on wildcard stacking,
     * on descent, and — sharpest — on `~`, where it meant "apply no variants" rather than
     * "exclude". This key runs on `resolveBranchSpec` like every other dispatch in the
     * language, so there is no second walker to disagree.
     */
    branches: ANY,

    // Document-level `variants:` stays deliberately absent, so a v3 AI Instructions file
    // carrying one reports a misplaced key — the migration signal `blocks:` gives a v3 Plot
    // Essentials file. A document variant's `apply:` fanned a section-variant name across
    // every section defining it, which is exactly what `branches:` above now does, and its
    // `sections: {x: ~}` removed a section, which the section's own dispatch already does
    // from the other end. The `ain:`/`cards:` split was a render-target concept wearing
    // dispatch clothing and becomes `render.storyCards` in Phase 12.

    /**
     * §7.6 — an ordered list of components to pull in before the local `sections:` layer.
     *
     * `importVariants:` is an open namespace because it is a *selector*, not a declaration:
     * the names are looked up in each imported section's own `variants:`, so validating
     * them here would report every variant name an author chose as an unknown key. The
     * spelling matches items exactly, and it means the same thing in both places — select
     * from the thing being pulled in, unconditionally, before any branch dispatch (§7.6.2).
     */
    imports: {
      type: TYPES.SEQ,
      of: { type: TYPES.MAP, keys: { from: STRING, importVariants: ANY } },
    },

    // §7.8, moved to Phase 12 on 2026-08-20 with the `--profile` build profile: two of its
    // three use cases are verbosity tiers, and a verbosity tier is undefined until something
    // says what one is. Declared so writing one is a clear "not yet" rather than a confusing
    // unknown-key ERROR — the same courtesy the item surface extends to the render targets.
    render: { type: TYPES.MAP, keys: { component: ANY, storyCards: ANY }, note: 'Phase 12' },

    // v3's AI Instructions story card (§7.8). Superseded by `render.storyCards` when
    // Phase 12 lands; declared as an open namespace until then, because its key surface is
    // the story-card surface and pinning a copy of it here would be a second declaration
    // to keep in step with the first.
    card: { type: TYPES.ANY, note: 'Phase 12' },
  },
};

module.exports = { COMPONENT_SCHEMA, SECTION, SECTION_RENDER };
