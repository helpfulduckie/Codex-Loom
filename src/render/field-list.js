'use strict';

/**
 * The declaration-driven emitter (v4 spec §13.2–§13.3, Phase 12 Step 1).
 *
 * A field-list template is an ordered list of field and group names (§13.3). This module
 * turns that list, plus the field declarations it names, into rendered body text.
 *
 * ── How it renders ──────────────────────────────────────────────────────────
 *
 * It does not re-implement conditionals, render functions, `{wrapper}` or whitespace
 * normalization. It *generates* the `.template` source each declaration is shorthand for —
 * `{if $body.x}\nLabel: {join("; ", $body.x)}\n{/if}` — concatenates the stanzas, and hands
 * the result to `render()`. So a field list and the hand-written `.template` it replaces go
 * through one identical code path, which is what makes byte-identity between the two a real
 * property rather than a coincidence of two emitters agreeing (Verified claim 10: the
 * renderer already normalizes indentation and blank lines, so the emitter only has to
 * produce the un-normalized equivalent, not imitate a partial's exact formatting).
 */

const { render } = require('../template');
const { FUNCTION_NAMES, entryName } = require('./parse');

/** Bracket pairs `wrap:` understands. A two-character string is taken as open+close. */
function wrapChars(wrap) {
  const w = String(wrap);
  if (w === '[]') return ['[', ']'];
  if (w === '{}') return ['{', '}'];
  if (w === '()') return ['(', ')'];
  if (w.length === 2) return [w[0], w[1]];
  return [w, w];
}

/**
 * A `from:` path (relative to the ref root) or the field's own name → a `$root.…` reference.
 * The root is `body` for a story-card body template and `notes` for a `templateFor.notes`
 * list, matching §4.5's rule that a notes template reads `$notes` rather than `$body`.
 */
function bodyRef(pathOrName, root) {
  const p = String(pathOrName);
  return p.startsWith('$') ? p : `$${root || 'body'}.${p}`;
}

/**
 * Expand a template list into a flat sequence of `{ name, decl }`, resolving group names
 * to their members and merging inline overrides over the base declaration (§13.3).
 *
 * Groups do not nest (§13.3); a group named inside a group is expanded one level and no
 * further, matching the settled non-nesting of item `include:`.
 */
function expandList(list, table) {
  const out = [];
  const pushEntry = (entry, allowGroup) => {
    // Escape hatches for the parts §13.6 keeps as text: `{ include: name }` drops an
    // `{include}` for a partial (the un-declarable name line, the cardHeader/cardFooter
    // wrapper), and `{ raw: "…" }` drops a literal fragment. Both interleave with field
    // names so a mostly-declared template can still carry its one irregular line.
    if (entry && typeof entry === 'object' && (entry.include !== undefined || entry.raw !== undefined)) {
      out.push({ name: null, decl: { __passthrough: entry.include !== undefined ? `{include ${entry.include}}` : String(entry.raw) } });
      return;
    }
    // `{ allowExtra: true }` is a template-level marker for the unread-field audit
    // (§13.6, Decision 4) — it carries no rendered content.
    if (entry && typeof entry === 'object' && entry.allowExtra !== undefined
      && entry.field === undefined && entry.name === undefined) {
      return;
    }
    if (typeof entry === 'string') {
      if (allowGroup && table.groups && Array.isArray(table.groups[entry])) {
        for (const member of table.groups[entry]) pushEntry(member, false);
        return;
      }
      out.push({ name: entry, decl: (table.fields && table.fields[entry]) || {} });
      return;
    }
    if (entry && typeof entry === 'object') {
      const name = entryName(entry);
      const base = (name && table.fields && table.fields[name]) || {};
      const { field: _f, name: _n, ...override } = entry;
      out.push({ name, decl: { ...base, ...override } });
    }
  };
  for (const entry of list || []) pushEntry(entry, true);
  return out;
}

/**
 * `parts:` (Decisions 1, 2, 4, 9, 10 — 2026-09-03 handoff). A `$`-prefixed string is a ref;
 * any other string is template source, emitted verbatim (the same contract `raw:` already
 * has); a mapping is a nested declaration, recursively — `declBody` below is what makes the
 * recursion general rather than one level.
 */
function isRefEntry(entry) {
  return typeof entry === 'string' && entry.startsWith('$');
}

/**
 * An inline "any of `refs` present" guard, with no forced newlines — unlike `guardedStanza`
 * below (which wraps a whole stanza and is allowed to add `\n` around it), a `parts:` literal
 * or nested declaration sits mid-line, so wrapping it in a block-style `{if}\n...\n{/if}`
 * would split one rendered line into several once `normalizeWhitespace` trims each line on
 * its own. Composing two calls — `inlineGuard(leftRefs, inlineGuard(rightRefs, body))` — is
 * how a middle literal's "both neighbors present" (Decision 9) is built from two "any ref in
 * this list present" ORs: the outer `{if}` only reaches `body` through the inner one, so the
 * pair is an AND of the two neighbor tests.
 */
function inlineGuard(refs, body) {
  if (!refs || refs.length === 0) return body;
  const [first, ...rest] = refs;
  if (rest.length === 0) return `{if ${first}}${body}{/if}`;
  return `{if ${first}}${body}{else}${inlineGuard(rest, body)}{/if}`;
}

/** One `parts:` list entry → `{ kind, source|text, refs }`. */
function buildPartNode(entry, refRoot) {
  if (isRefEntry(entry)) {
    return { kind: 'ref', source: `{${entry}}`, refs: [entry] };
  }
  if (typeof entry === 'string') {
    return { kind: 'literal', text: entry };
  }
  if (entry && typeof entry === 'object') {
    const { body, refs } = declBody(undefined, entry, refRoot);
    const source = (entry.always || refs.length === 0) ? body : inlineGuard(refs, body);
    return { kind: 'decl', source, refs };
  }
  return { kind: 'literal', text: '' };
}

/**
 * Assemble an already-built node list (`{ kind, source|text, refs }`) into `{ source, refs }`.
 * `refs` is every ref at every depth, flattened — a `decl`-kind node already carries its own
 * recursively flattened refs, so concatenating one level here is enough (Decision 5's "nested
 * refs included" guard, and the audit's read set, both read off this).
 *
 * Literal drop (Decision 9): a literal renders iff every *adjacent* non-literal neighbor is
 * present. A neighbor that is itself a literal contributes no ref test — `[A, "-", "-", B]`
 * is not a shape the corpus or the handoff specifies, so an interior run of literals is left
 * unconstrained on the side it touches another literal, rather than reaching past it.
 *
 * Split out of `buildParts` so a caller that already has nodes in hand can drive the same
 * adjacency-and-collection logic without re-parsing string entries through `buildPartNode` —
 * `declBody`'s label/wrap lowering below needs this shape but, per `concatParts`'s comment,
 * uses the plain join instead for its own reasons; `assembleParts` remains `buildParts`'s path
 * and is available to any future caller that does want adjacency on pre-built nodes.
 */
function assembleParts(nodes) {
  const pieces = nodes.map((node, i) => {
    if (node.kind !== 'literal') return node.source;
    let text = node.text;
    const left = i > 0 ? nodes[i - 1] : null;
    const right = i < nodes.length - 1 ? nodes[i + 1] : null;
    if (left && left.kind !== 'literal') text = inlineGuard(left.refs, text);
    if (right && right.kind !== 'literal') text = inlineGuard(right.refs, text);
    return text;
  });
  const refs = nodes.filter((n) => n.kind !== 'literal').flatMap((n) => n.refs);
  return { source: pieces.join(''), refs };
}

function buildParts(list, refRoot) {
  const nodes = (list || []).map((e) => buildPartNode(e, refRoot));
  return assembleParts(nodes);
}

/**
 * `try:` (Decision 7 — 2026-09-03 handoff). An ordered list of sources; the first that
 * resolves renders and the rest are never reached — `from: [a, b]` renders both, joined,
 * which is a different operation and is unaffected by this one. Every entry is a source
 * (unlike `parts:`, where a non-`$` string is a literal): a bare string follows `from:`'s
 * root-relative rule (`bodyRef` below), a `$`-prefixed string is absolute, and a mapping is
 * a nested declaration — the same recursion `parts:`'s nested-declaration branch gets from
 * `declBody`, so a `try:` entry may itself carry `from:`/`parts:`/`try:` with no extra code.
 * `render:`/`join:` on the *outer* declaration apply to each plain-ref source in turn, the
 * same way they apply to a single-path `from:`; a nested-declaration source supplies its own.
 */
function buildTryNode(entry, decl, refRoot) {
  if (entry && typeof entry === 'object') {
    return declBody(undefined, entry, refRoot); // { body, refs }
  }
  const refs = [bodyRef(entry, refRoot)];
  return { body: valueExpr(decl, refs), refs };
}

/**
 * Chain built `try:` sources into "first that resolves": every source but the last is
 * guarded on its own refs with the *next* source as the `{else}` fallback; the last source is
 * the unconditional fallback (nothing left to fall back to). For a two-source, single-ref-each
 * `try:` this reproduces `Directory`'s hand-written `raw:` shape exactly —
 * `{if $body.content}{list($body.content)}{else}{list($body.entries)}{/if}` — with no extra
 * wrapping. The stanza-level "any source present" guard (Decision 5's rule) still comes from
 * the ordinary `refs.length === 0` / `guardedStanza` path in `declBody`/`stanzaSource`: `refs`
 * below is every source's refs flattened, reaching that guard the same way a multi-path
 * `from:`'s do, which is what the handoff means by "falls out naturally".
 */
function tryChain(nodes) {
  if (nodes.length === 0) return '';
  const build = (i) => {
    const { body, refs } = nodes[i];
    if (i === nodes.length - 1 || refs.length === 0) return body;
    const fallback = build(i + 1);
    const orGuard = (rs) => {
      const [first, ...rest] = rs;
      if (rest.length === 0) return `{if ${first}}${body}{else}${fallback}{/if}`;
      return `{if ${first}}${body}{else}${orGuard(rest)}{/if}`;
    };
    return orGuard(refs);
  };
  return build(0);
}

function buildTry(list, decl, refRoot) {
  const nodes = (list || []).map((entry) => buildTryNode(entry, decl, refRoot));
  return { source: tryChain(nodes), refs: nodes.flatMap((n) => n.refs) };
}

/** A literal node holding raw template source (Decision 10) — text, not a ref. */
function litNode(text) {
  return { kind: 'literal', text };
}

/**
 * A pre-built value node carrying already-computed source and refs — used by the
 * `label:`/`wrap:` lowering below, which computes `value`/`refs` itself (it needs the
 * declaring field's own `name` for the implied `from:` source, which a generic `parts:`
 * entry does not carry — `buildPartNode`'s nested-declaration branch always resolves with
 * `name` undefined). Bypassing `buildPartNode` here is what keeps the implied-name case
 * working; `assembleParts` treats it exactly like a `ref`/`decl` node for adjacency and for
 * the flattened `refs` collection.
 */
function valueNode(source, refs) {
  return { kind: 'ref', source, refs };
}

/**
 * Concatenate a node list plainly, with no Decision 9 adjacency guarding — the label/wrap
 * lowering's join, not `assembleParts`'s. The two differ because adjacency is *not* inert
 * here in one case the handoff's caveat missed: `decl.always` skips the outer `guardedStanza`
 * entirely, so a guard on the `": "` separator would be the only guard in the whole
 * declaration and would suppress it whenever `value`'s refs are absent — visibly changing
 * output for an `always:` field (`Triple:` → `Triple`, the render-function's own "renders
 * empty on absent refs" behavior silently overridden). Every other case is guarded
 * identically either way (the caller's `guardedStanza`/`inlineGuard` already conditions the
 * whole stanza on these same refs), so plain concatenation is both the safe choice and the
 * one that reproduces the pre-lowering source byte-for-byte.
 */
function concatParts(nodes) {
  return nodes.map((n) => (n.kind === 'literal' ? n.text : n.source)).join('');
}

/** The render-function expression for one field's value, e.g. `{join("; ", $body.magic)}`. */
function valueExpr(decl, refs) {
  let fn = decl.render;
  if (fn === 'bare') fn = undefined;
  if (!fn && decl.join !== undefined) fn = 'join';
  if (fn === 'join') {
    const sep = decl.join !== undefined ? String(decl.join) : '; ';
    return `{join("${sep}", ${refs.join(', ')})}`;
  }
  if (fn && FUNCTION_NAMES.includes(fn)) {
    return `{${fn}(${refs[0]})}`;
  }
  return `{${refs[0]}}`;
}

/** The label fragment — a plain string, or a `labelWhen` conditional (§13.2). */
function labelExpr(decl, refRoot) {
  if (decl.labelWhen && typeof decl.labelWhen === 'object') {
    const [whenKey, altLabel] = Object.entries(decl.labelWhen)[0] || [];
    if (whenKey) {
      return `{if ${bodyRef(whenKey, refRoot)}}${altLabel}{else}${decl.label || ''}{/if}`;
    }
  }
  return decl.label !== undefined && decl.label !== null ? String(decl.label) : null;
}

/**
 * The `label:` / `block:` / `wrap:` / `wrapLabel:` presentation keys, lowered internally to
 * the `parts:` node list they are shorthand for (Decision 6, 2026-09-03 handoff) —
 * `wrapLabel:` stops being a flag and becomes *where the open-bracket node sits in the list*.
 * `value` is a single pre-built node (`valueNode`, above); everything else is a literal.
 *
 *   label, no wrap                → [label, ": ", value]
 *   label, block                  → [label, ":\n", value]
 *   wrap, wrapLabel or no label   → [open, ...(the label/block form above), close]
 *   wrap, label, no wrapLabel     → [label, ": ", open, value, close]
 *   wrap, block, no wrapLabel     → [label, ":\n", open, value, close]
 *
 * The wrap-and-wrapLabel row applies the bracket around whatever the unwrapped form already
 * is, block included — which is what reproduces the original string-concatenation code's one
 * unlisted combination (`wrap:` + `wrapLabel:` + `block:`) rather than silently dropping it.
 */
function sugarPartsList(decl, label, value) {
  const bodyNodes = label === null
    ? [value]
    : decl.block
      ? [litNode(label), litNode(':\n'), value]
      : [litNode(label), litNode(': '), value];
  if (!decl.wrap) return bodyNodes;
  const [l, r] = wrapChars(decl.wrap);
  if (decl.wrapLabel || label === null) return [litNode(l), ...bodyNodes, litNode(r)];
  if (decl.block) return [litNode(label), litNode(':\n'), litNode(l), value, litNode(r)];
  return [litNode(label), litNode(': '), litNode(l), value, litNode(r)];
}

/**
 * A declaration's body and refs, before the outer guard is applied — shared by the top-level
 * `stanzaSource` and by a nested `parts:` entry (`buildPartNode`), which is what makes a
 * declaration's recursion general (Decision 4) rather than a single special-cased level.
 *
 * `name` is the field's own table name, used as the implied `from:` source when neither
 * `from:` nor `parts:` is given (Decision 3) — a nested `parts:` entry has no such name, so
 * it is `undefined` there and an entry with neither key resolves to no refs and an empty
 * value rather than crashing on `refs[0]`.
 */
function declBody(name, decl, refRoot) {
  let refs;
  let value;
  if (decl.try !== undefined) {
    // `try:`, `from:` and `parts:` are mutually exclusive (raised at load time, CL0422); if
    // more than one somehow reaches here, `try:` wins rather than crashing.
    const built = buildTry(decl.try, decl, refRoot);
    refs = built.refs;
    value = built.source;
  } else if (decl.parts !== undefined) {
    // `parts:` and `from:` are mutually exclusive (raised at load time, CL0422); if both
    // somehow reach here, `parts:` wins rather than crashing.
    const built = buildParts(decl.parts, refRoot);
    refs = built.refs;
    value = built.source;
  } else {
    const fromPaths = decl.from !== undefined
      ? (Array.isArray(decl.from) ? decl.from : [decl.from])
      : (name !== undefined ? [name] : []);
    refs = fromPaths.map((p) => bodyRef(p, refRoot));
    value = refs.length ? valueExpr(decl, refs) : '';
  }
  const label = labelExpr(decl, refRoot);

  // Every presentation key (label/block/wrap/wrapLabel) is sugar over a parts list built
  // from the already-computed `value`/`refs` (Decision 6) — one node list instead of five
  // string-concat branches, joined with `concatParts` rather than `assembleParts` (see that
  // function's comment for why adjacency guarding is not safe to reuse here). The value
  // node's own refs are exactly `refs` above, so the stanza guard this function's caller
  // applies is still computed from the value alone (§ handoff caveat 1) — the label and
  // bracket literals are template source (Decision 10) that contributes no ref.
  const body = concatParts(sugarPartsList(decl, label, valueNode(value, refs)));

  return { body, refs };
}

/** One field declaration → the `.template` stanza it is shorthand for. */
function stanzaSource({ name, decl }, refRoot) {
  if (decl && decl.__passthrough !== undefined) return decl.__passthrough;
  const { body, refs } = declBody(name, decl, refRoot);
  // `refs.length === 0` only arises from a `parts:` list of literals alone — nothing to
  // guard the stanza on, so it renders unconditionally rather than producing `{if undefined}`.
  if (decl.always || refs.length === 0) return body;
  return guardedStanza(refs, body);
}

/**
 * Wrap `body` in a stanza guard satisfied when any of `refs` resolves (Decision 5,
 * 2026-09-03 handoff — replaces the old "first ref only" guard, which silently dropped
 * every `from:` path after the first when it was absent). `{if}` tests exactly one ref
 * (`src/render/parse.js` `classifyTag`, `src/render/eval.js` `isTruthy`), so there is no
 * single-tag disjunction to reach for; the equivalent the renderer already supports is a
 * nested `{if}`/`{else}` chain trying each ref in turn, with `body` repeated per branch —
 * only one branch is ever taken, so the duplication does not change output. With one ref
 * this collapses to exactly the prior `{if refs[0]}...{/if}` form, so single-path
 * declarations (the overwhelming majority) are byte-identical.
 */
function guardedStanza(refs, body) {
  if (refs.length <= 1) return `{if ${refs[0]}}\n${body}\n{/if}`;
  return `{if ${refs[0]}}\n${body}\n{else}${guardedStanza(refs.slice(1), body)}{/if}`;
}

/**
 * Render a field-list template.
 *
 * @param {Array}  list      the ordered field/group list (a `templates:` entry, §13.3)
 * @param {object} table     the merged field table (`{ fields, groups }`)
 * @param {object} context   the item render context (`util.itemContext`)
 * @param {object} [options] `{ diagnostics, file, name, partials, variables, refRoot }` —
 *   the first five pass through to `render()`; `refRoot` ('body' by default, 'notes' for a
 *   `templateFor.notes` list) picks which namespace the field paths read.
 * @returns {string}
 */
function renderFieldList(list, table, context, options = {}) {
  const stanzas = expandList(list, table).map((f) => stanzaSource(f, options.refRoot));
  const source = stanzas.join('\n\n');
  return render(source, context, options.partials, options.variables, {
    diagnostics: options.diagnostics,
    file: options.file,
    name: options.name,
  });
}

module.exports = { renderFieldList, expandList, stanzaSource, buildParts, declBody };
