'use strict';

const { resolveVariables, walkItemTextFields, walkTextRecursive, itemContext } = require('./util');
const { CODES } = require('./diag');
const { tokenize, parse, FUNCTION_NAMES } = require('./render/parse');
const evalMod = require('./render/eval');
const {
  resolveField, isTruthy, renderScalar, applyWrapper,
  FUNCTIONS,
  renderProgram,
} = evalMod;

/**
 * Template engine for Codex Loom v4 (v4 spec §13).
 *
 * This module is the façade over `render/parse.js` (lexer + AST) and `render/eval.js`
 * (the evaluation walk) — see the Phase 9 plan for why the engine moved. Five exports cross
 * the module boundary for real (`compile.js` and `emit/components.js`); the rest are
 * semantic helpers and post-passes re-exported here because `template.test.js` reaches them
 * directly.
 *
 * Interpolation syntax:
 *   {$field}                     - top-level card field
 *   {$body.FieldName}            - body field (case-insensitive)
 *   {$body.FieldName.subfield}   - nested body subfield
 *   {$otherid.body.FieldName}    - cross-card reference (second-pass, left as-is here)
 *   {%variable}                  - branch variable (expanded at render step 0) *
 * Render functions:
 *   {inline($name)}              - space-join all subfields of a mapping
 *   {join("sep", $f1, $f2)}      - join present values with separator
 *   {list($body.items)}          - "- item" lines
 *   {and($body.keywords)}        - "a, b, and c"
 *   {prose($body.section)}       - each element as a sentence (capitalize + period)
 *   {block($body.section)}       - one item per line, no prefix
 *   {keys($body.mapping)}        - "key: value" lines
 *
 * Block syntax:
 *   {wrapper}...{/wrapper}        - wraps content per card's render.wrapper
 *   {if $body.field}...{/if}     - conditional
 *   {include PartialName}        - partial inclusion
 *   {preserve}...{/preserve}     - protect inner whitespace from normalization
 *
 * Literal escapes:
 *   {{ → {    }} → }
 */

/**
 * Normalize whitespace in rendered output.
 *
 * Steps (in order):
 * 1. Extract {preserve}...{/preserve} blocks — inner content is shielded from all normalization
 * 2. Strip tabs outside preserved blocks
 * 3. Trim leading/trailing whitespace from every line
 * 4. Collapse 2+ consecutive spaces → single space (cleans up {if} block boundaries)
 * 5. Collapse 2+ consecutive newlines → \n (removes all blank lines)
 * 6. Trim leading/trailing whitespace from whole document
 * 7. Restore preserved block contents
 *
 * `preserved`, when passed, is the list of already-evaluated `{preserve}` bodies the AST
 * walk collected — `render()` has already replaced their source spans with
 * `\x00PRESERVE_n\x00` sentinels, so step 1's own regex extraction is skipped and step 7
 * restores from this list instead. Called with one argument, this function still finds and
 * protects `{preserve}` blocks by regex over `str` itself — the original v3 behavior, kept
 * for callers (and tests) that use it standalone rather than through `render()`.
 */
function normalizeWhitespace(str, preserved) {
  let working = str;

  if (preserved === undefined) {
    // Step 1: Extract {preserve}...{/preserve} blocks
    preserved = [];
    working = str.replace(/\{preserve\}([\s\S]*?)\{\/preserve\}/g, (match, content) => {
      const idx = preserved.length;
      // Trim one leading/trailing newline so tags on their own lines don't double up
      preserved.push(content.replace(/^\n/, '').replace(/\n$/, ''));
      return `\x00PRESERVE_${idx}\x00`;
    });
  }

  // Step 2: Strip tabs
  working = working.replace(/\t/g, '');

  // Step 3: Trim leading/trailing whitespace from every line
  working = working.split('\n').map(line => line.trim()).join('\n');

  // Step 4: Collapse multiple consecutive spaces to one (handles {if} boundary whitespace)
  working = working.replace(/ {2,}/g, ' ');

  // Step 5: Remove all blank lines — collapse any run of 2+ newlines to one
  working = working.replace(/\n{2,}/g, '\n');

  // Step 6: Trim document edges
  working = working.trim();

  // Step 7: Restore preserved blocks
  working = working.replace(/\x00PRESERVE_(\d+)\x00/g, (_, idx) => preserved[Number(idx)]);

  return working;
}

/**
 * Apply field interpolation to all string values in a card's text sections
 * (body, aid, render, name). Handles dotted field refs ({$body.X}, {$v.X},
 * {$aid.X}, {$render.X}, {$name.X}) within field values.
 */
function applyFieldInterpolation(card) {
  const context = itemContext(card);

  walkItemTextFields(card, s => processFieldInterpolation(s, context));
}

function processFieldInterpolation(value, context) {
  if (typeof value !== 'string') return value;
  // Expand dotted field refs ({$body.X}, {$v.X} + aliases, {$aid.X}, {$render.X},
  // {$name.X}) within field values. The required dot keeps single-segment tokens —
  // pronoun tokens ({$she}) and {$Id} character refs — for the pronoun pass.
  return value.replace(/\{(\$(body|v|var|vars|variable|variables|aid|render|name)\.[^{}]+)\}/gi, function(match, ref) {
    const resolved = resolveField(ref.trim(), context);
    if (resolved === null) return '';
    return renderScalar(resolved);
  });
}

/**
 * Apply render function calls to all string values in card.body recursively.
 *
 * Runs in Phase B after cross-card refs are resolved but before pronoun passes,
 * so that {$Id.body.field} values are already substituted into body fields before
 * render functions like {join(...)} operate on them.
 *
 * Expands: {inline(...)}, {join(...)}, {list(...)}, {and(...)},
 *          {prose(...)}, {block(...)}, {keys(...)}
 * Leaves:  {$she}, {$Id}, {$Id.pronoun}, {%variable}, and all other {$...} tokens
 *          untouched so the pronoun pass can handle them.
 *
 * `options.diagnostics`/`options.file`, when given, turn a malformed call's
 * `console.warn` into a `CL0413` diagnostic naming the item instead. This is a field
 * value, not a template file, so the diagnostic carries no line — the same degradation
 * `Diagnostic#location` already handles.
 */
function applyFieldRenderFunctions(card, itemMap, options) {
  if (!card.body) return;

  const context = itemContext(card, itemMap ? { itemMap } : undefined);

  walkTextRecursive(card.body, (s) => processFieldRenderFunctions(s, context, options || {}));
}

function applyVariableInterpolation(card, variables, sink) {
  if (!variables) return;
  // card.name is normalized to {display, full, ...} by resolveItem before this runs
  if (card.name && typeof card.name === 'object' && !Array.isArray(card.name)) {
    walkTextRecursive(card.name, (s) => resolveVariables(s, variables, sink));
  } else if (typeof card.name === 'string') {
    card.name = resolveVariables(card.name, variables, sink);
  }
  if (typeof card.id === 'string') card.id = resolveVariables(card.id, variables, sink);
  if (card.body)   walkTextRecursive(card.body, (s) => resolveVariables(s, variables, sink));
  if (card.aid)    walkTextRecursive(card.aid, (s) => resolveVariables(s, variables, sink));
  if (card.render) walkTextRecursive(card.render, (s) => resolveVariables(s, variables, sink));
}

// `[prefix, implementation]` pairs, derived from the canonical `FUNCTION_NAMES`
// (`./render/parse`) so a new render function is registered in exactly one place.
const RENDER_FN_DISPATCH = FUNCTION_NAMES.map((n) => [n + '(', FUNCTIONS[n]]);

function processFieldRenderFunctions(value, context, options) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{([^{}]+)\}/g, function(match, inner) {
    inner = inner.trim();
    for (const [prefix, fn] of RENDER_FN_DISPATCH) {
      if (inner.startsWith(prefix)) {
        try {
          return fn(inner, context);
        } catch (e) {
          if (options && options.diagnostics) {
            options.diagnostics.error(
              CODES.TEMPLATE_PARSE_FAILED,
              `render function in field value: ${e.message}`,
              { file: options.file },
            );
          }
          return match;
        }
      }
    }
    // Not a render function — leave as-is (pronoun tokens, field refs, etc.)
    return match;
  });
}

/**
 * Render a template string with the given card data.
 *
 * Pipeline:
 *   0. Resolve {%variable} tokens (compile-time variables)
 *   1. Expand {include} directives textually, recursively (still a string pass — a real
 *      template opens a block in one partial and closes it in another, so an AST scoped to
 *      one partial's own parse tree cannot represent it; see parse.js's header)
 *   2. Tokenize + parse the fully-expanded string into an AST (escapes, conditionals,
 *      wrapper, preserve, render functions and field refs are all tags in one grammar now)
 *   3. Walk the AST against `data`
 *   4. normalizeWhitespace, restoring any {preserve} sentinels the walk collected
 *
 * @param {string} template
 * @param {object} data - card data; body fields accessed via {$body.X}
 * @param {Map} partials
 * @param {object} [variables] - compile.yaml variables for {%varName} expansion
 * @param {object} [options] - { diagnostics, file, name } (v4 spec §4.4 / Phase 9 Step 0).
 *   `file` and `name` identify the template being rendered so a parse or eval failure can
 *   finally name where it happened; `diagnostics` is the bus to report to. All optional —
 *   a caller with nothing to report to gets the old silent-degradation behavior.
 */
function render(template, data, partials, variables, options) {
  if (!partials) partials = new Map();
  const { diagnostics, file, name } = options || {};

  // Step 0: Resolve {%variable} tokens
  let source = template;
  if (variables) source = resolveVariables(source, variables, { diagnostics, file });

  const report = diagnostics
    ? (code, message, span) => {
        const loc = { file };
        if (span && typeof span.line === 'number') loc.line = span.line;
        if (span && typeof span.column === 'number') loc.col = span.column;
        diagnostics.error(code, message, loc);
      }
    : () => {};

  // Step 1: Expand {include} directives (see the doc comment above for why this stays a
  // text pass rather than an AST node).
  source = expandIncludes(source, partials, report);

  const preserved = [];
  const flags = { wrapperUsed: false };
  const ctx = { report, preserved, flags, name };

  const doc = parse(tokenize(source), report);
  let result = renderProgram(doc, data, ctx);

  result = normalizeWhitespace(result, preserved);

  // Post-render: if card has render.wrapper and template didn't use {wrapper} block, wrap entire output
  if (!flags.wrapperUsed && data.render && data.render.wrapper && data.render.wrapper !== 'none') {
    result = applyWrapper(result, data.render.wrapper);
  }

  return result;
}

/**
 * Expand `{include NAME}` directives, recursively, before anything is tokenized.
 *
 * `report`, when it actually reports (a `diagnostics` bus was given to `render()`), turns
 * an unknown or circular partial into `CL0417`/`CL0416` and the directive into empty text —
 * a graceful degrade, replacing the old engine's unconditional throw (which aborted the
 * whole item's render and surfaced as a generic `CL0421 RENDER_FAILED` at the compile.js
 * call site). Nothing in the golden corpus exercises either failure, so this is a real
 * behavior change confined to output no golden produces.
 */
function expandIncludes(source, partials, report, stack) {
  stack = stack || [];
  return source.replace(/\{include\s+(\S+)\}/g, function(match, includeName, offset, whole) {
    const key = includeName.toLowerCase();
    const line = whole.slice(0, offset).split('\n').length;
    if (stack.includes(key)) {
      report(CODES.PARTIAL_CYCLE, `Circular partial include: ${[...stack, key].join(' → ')}`, { line });
      return '';
    }
    const partial = partials.get(key);
    if (!partial) {
      report(CODES.PARTIAL_NOT_FOUND, `Unknown partial "${includeName}" (no .partial file found).`, { line });
      return '';
    }
    return expandIncludes(partial.content, partials, report, [...stack, key]);
  });
}

module.exports = {
  render,
  resolveField,
  applyFieldInterpolation,
  applyVariableInterpolation,
  applyFieldRenderFunctions,
  normalizeWhitespace,
  applyWrapper,
  isTruthy,
};
