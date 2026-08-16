'use strict';

const { resolveVariables } = require('./util');

/**
 * The compile-time variable expander.
 *
 * v3 had two naming systems: `{%key}` for values and `{@key}` for named resources
 * declared under `structure.input.components` and `structure.input.canon`. `{@}` is
 * removed in v4 (§6.1), leaving one.
 *
 * Deleting it cost nothing, because most of what it did was already inert.
 * `lookupReference` searched every per-type component map in sequence and returned the
 * first name match, so `{@pe}` resolved identically whether it was declared under
 * `plotEssential:`, `authorsNote:` or `scripts:` — no project could have depended on the
 * grouping, because the grouping never worked. Its one behavioral difference, the
 * path-else-literal fallback for `openingChoice`, was already applied to every component
 * spec downstream. And the subtree duplicated `variables:`: both name a string for reuse.
 *
 * Canon names are auto-exposed as `{%}` variables instead, so `{%characters}/Aness.yaml`
 * works in an `include:` path exactly as `{@characters}/Aness.yaml` used to. That removes
 * the unanswerable question of whether a given name is a `{%}` thing or a `{@}` thing.
 *
 * This module now exists only so the call sites keep one shared entry point for token
 * expansion; it delegates straight to `util.resolveVariables`.
 *
 * Keeping the thin module was decided deliberately rather than left over: three call
 * sites import it (`compile.js`, `description.js`, `loader/registry.js`), the `{@}`
 * removal has a regression test that only makes sense against this entry point, and
 * this comment is the only written record of why `{@}` went away. Inlining the one
 * line would scatter all three. Not a candidate for removal.
 */
function expandTokens(text, opts = {}) {
  if (typeof text !== 'string') return text;
  return resolveVariables(text, opts.variables);
}

module.exports = { expandTokens };
