'use strict';

/**
 * YAML source preprocessing (v4 spec §4.1).
 *
 * `Tagline: {$Aness} is a healer` is a YAML parse error, because `{` opens a flow
 * mapping. That is the single most common value shape in the language, and v3 made
 * authors defensively quote it. v4 fixes the parser instead of the syntax.
 *
 * In a value position, if the value's first characters are `{$` or `{%`, this wraps it
 * in single quotes before the document is parsed. This is safe because no Codex Loom
 * schema uses a mapping key beginning with `$` or `%`, so those sequences in leading
 * value position are never a legitimate flow mapping.
 *
 * A leading `%key%` player placeholder (§12) is wrapped for the same reason and a
 * different one: `%` is YAML's directive indicator, so a plain scalar may not begin with
 * it at all. `opening: %heroName% woke up.` is not a subtly wrong parse but a hard error —
 * "Plain value cannot start with directive indicator character %" — naming neither
 * placeholders nor the fix. Phase 4 made that shape worth writing, so it is handled here
 * rather than left as a defensive quote every author has to learn.
 *
 * Only the `%key%` form is recognized, not a bare `%`. A value like `% nope` is still a
 * YAML error, which is right: it is not a placeholder and inventing a general rule for `%`
 * would quote things this module has no reason to have an opinion about.
 *
 * The transform only ever *inserts* quote characters within a line, so line numbers are
 * preserved exactly and diagnostics stay accurate. Columns after a wrap shift by one or
 * two characters.
 *
 * `findSwallowedTokens` is the other half, and the more important one. The flow-entry
 * case fails silently rather than loudly — `triggers: [{$name.display}]` is *valid*
 * YAML that parses to `[{"$name.display": null}]` — so a post-parse guard catches the
 * whole class regardless of what the preparser's position tracking missed.
 *
 * Known limitation: a plain scalar that begins with a token and continues onto a second
 * line is not handled. Such a document was already a parse error before this transform,
 * so nothing that used to work stops working; it merely fails with a different message.
 */

/** Sigils that mark a mapping key as a Codex Loom token the YAML parser swallowed. */
const SWALLOWED_SIGILS = new Set(['$', '%', '@']);

/** A block scalar header: `|`, `>`, with optional chomping and explicit indent. */
const BLOCK_SCALAR_RE = /^[|>][+-]?\d*[+-]?\s*(#.*)?$/;

/** A document separator or terminator, which resets all structural state. */
const DOC_MARKER_RE = /^(---|\.\.\.)(\s|$)/;

/**
 * The cheap test for "is there anything here to rescue at all".
 *
 * Matched against the whole document to skip the line scanner entirely, so it has to admit
 * every shape the scanner handles. The placeholder arm is a pattern rather than a bare `%`
 * because a percent sign is ordinary in prose — "up 5% this quarter" — and a substring test
 * would give up the fast path for most documents to catch a form none of them use.
 */
const PREPARSE_TRIGGER_RE = /\{\$|\{%|%\w+%/;

/**
 * A `%key%` placeholder at `i`, matching Velvet Lattice's own `%(\w+)%` pattern so what
 * the preparser rescues and what VL substitutes cannot drift apart.
 */
function isPlaceholderStart(line, i) {
  if (line[i] !== '%') return false;
  let j = i + 1;
  while (j < line.length && /\w/.test(line[j])) j++;
  return j > i + 1 && line[j] === '%';
}

function isTokenStart(line, i) {
  if (line[i] === '{' && (line[i + 1] === '$' || line[i + 1] === '%')) return true;
  return isPlaceholderStart(line, i);
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t';
}

/** Trim trailing whitespace from a [start, end) span. */
function trimEnd(line, start, end) {
  let e = end;
  while (e > start && isSpace(line[e - 1])) e--;
  return e;
}

/**
 * Where a block-position value ends: end of line, or the start of a trailing comment.
 * A `#` is only a comment when preceded by whitespace, so `{$a}#b` is one scalar.
 */
function blockValueEnd(line, start) {
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") { if (line[i + 1] === "'") i++; else inSingle = false; }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '#' && i > start && isSpace(line[i - 1])) return trimEnd(line, start, i);
  }
  return trimEnd(line, start, line.length);
}

/**
 * Where a flow-position value ends: the next `,` or closing bracket at the entry's own
 * depth. A token like `{$name.display}` reads as a nested flow mapping to this scan,
 * which is exactly right — its braces balance, so the terminator found is the one after
 * the token.
 */
function flowValueEnd(line, start) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") { if (line[i + 1] === "'") i++; else inSingle = false; }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ']' || ch === '}') {
      if (depth === 0) return trimEnd(line, start, i);
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) return trimEnd(line, start, i);
    if (ch === '#' && i > start && isSpace(line[i - 1])) return trimEnd(line, start, i);
  }
  return trimEnd(line, start, line.length);
}

/**
 * Find the `:` that separates a mapping key from its value, or -1.
 *
 * Quote-aware, so a colon inside a quoted key is not mistaken for the separator, and
 * comment-aware so a colon inside a trailing comment is ignored.
 */
function findSeparator(line, start) {
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") { if (line[i + 1] === "'") i++; else inSingle = false; }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '#' && i > start && isSpace(line[i - 1])) return -1;
    if (ch === ':' && (i + 1 === line.length || isSpace(line[i + 1]))) return i;
  }
  return -1;
}

/**
 * Scan a flow collection, wrapping any entry or value that begins with a token.
 *
 * Only ever entered from a position already known to be inside flow context — either a
 * value that opened with `[`/`{`, or a collection still open from a previous line.
 * Updates `state.flowDepth` and `state.expectFlowEntry`, and returns the index where
 * the outermost collection closed, or the line length.
 */
function scanFlow(line, start, state, wraps) {
  let inSingle = false;
  let inDouble = false;
  let expectEntry = state.expectFlowEntry;

  for (let i = start; i < line.length; i++) {
    const ch = line[i];

    if (inSingle) {
      if (ch === "'") { if (line[i + 1] === "'") i++; else inSingle = false; }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '#' && i > start && isSpace(line[i - 1])) break;

    if (expectEntry && !isSpace(ch)) {
      expectEntry = false;
      if (isTokenStart(line, i)) {
        const end = flowValueEnd(line, i);
        wraps.push({ start: i, end });
        i = end - 1;
        continue;
      }
    }

    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }

    if (ch === '[' || ch === '{') {
      state.flowDepth++;
      expectEntry = ch === '[';
      continue;
    }
    if (ch === ']' || ch === '}') {
      state.flowDepth = Math.max(0, state.flowDepth - 1);
      expectEntry = false;
      if (state.flowDepth === 0) {
        state.expectFlowEntry = false;
        return i;
      }
      continue;
    }
    if (ch === ',') { expectEntry = true; continue; }

    if (ch === ':' && (i + 1 === line.length || isSpace(line[i + 1]) || line[i + 1] === ',' || line[i + 1] === ']' || line[i + 1] === '}')) {
      let v = i + 1;
      while (v < line.length && isSpace(line[v])) v++;
      if (v < line.length && isTokenStart(line, v)) {
        const end = flowValueEnd(line, v);
        wraps.push({ start: v, end });
        i = end - 1;
      }
      continue;
    }
  }

  state.expectFlowEntry = expectEntry;
  return line.length;
}

/** Apply collected spans right-to-left so earlier indices stay valid. */
function applyWraps(line, wraps) {
  let out = line;
  for (const w of wraps.slice().sort((a, b) => b.start - a.start)) {
    const value = out.slice(w.start, w.end);
    out = `${out.slice(0, w.start)}'${value.replace(/'/g, "''")}'${out.slice(w.end)}`;
  }
  return out;
}

function preparseLine(rawLine, state) {
  const hasCR = rawLine.endsWith('\r');
  const line = hasCR ? rawLine.slice(0, -1) : rawLine;
  const restore = (s) => (hasCR ? `${s}\r` : s);

  let indent = 0;
  while (indent < line.length && isSpace(line[indent])) indent++;
  const trimmed = line.slice(indent);

  // Inside a block scalar every line is literal content until the indentation drops
  // back to the introducing key's level. Blank lines belong to the block.
  if (state.blockScalarIndent !== null) {
    if (trimmed === '') return restore(line);
    if (indent > state.blockScalarIndent) return restore(line);
    state.blockScalarIndent = null;
  }

  if (trimmed === '' || trimmed.startsWith('#')) return restore(line);

  if (DOC_MARKER_RE.test(trimmed)) {
    state.flowDepth = 0;
    state.expectFlowEntry = false;
    state.blockScalarIndent = null;
    return restore(line);
  }

  const wraps = [];

  // A flow collection left open on an earlier line continues here.
  if (state.flowDepth > 0) {
    scanFlow(line, indent, state, wraps);
    return restore(wraps.length ? applyWraps(line, wraps) : line);
  }

  // ── Block context ──────────────────────────────────────────────────────────
  //
  // The critical rule: once a value is established as a plain scalar, the rest of the
  // line is literal text and must not be scanned further. Codex Loom's own field-op
  // syntax puts unbalanced-looking braces into ordinary prose —
  //
  //     - +{Before the Institute, {%li} was your secret lover, but ...}
  //
  // — and a scanner that keeps tracking brackets through that text will read the `+{`
  // as a flow mapping, treat the following comma as an entry separator, and wrap a
  // fragment of the sentence. That is not hypothetical: it is what the golden fixtures
  // caught on the first run of this module.

  let i = indent;

  // Leading block-sequence dashes, which may nest: `- - value`.
  while (line[i] === '-' && (i + 1 === line.length || isSpace(line[i + 1]))) {
    i++;
    while (i < line.length && isSpace(line[i])) i++;
  }

  if (i >= line.length) return restore(line);

  const sep = findSeparator(line, i);
  const valueStart = sep >= 0 ? (() => {
    let v = sep + 1;
    while (v < line.length && isSpace(line[v])) v++;
    return v;
  })() : i;

  if (valueStart >= line.length) return restore(line);

  // A token at the head of the value: wrap it, and the value runs to end of line.
  if (isTokenStart(line, valueStart)) {
    wraps.push({ start: valueStart, end: blockValueEnd(line, valueStart) });
    return restore(applyWraps(line, wraps));
  }

  // A genuine flow collection: scan inside it for token entries.
  if (line[valueStart] === '[' || line[valueStart] === '{') {
    scanFlow(line, valueStart, state, wraps);
    return restore(wraps.length ? applyWraps(line, wraps) : line);
  }

  // A block scalar header suppresses processing of the whole indented body.
  if (sep >= 0 && BLOCK_SCALAR_RE.test(line.slice(valueStart))) {
    state.blockScalarIndent = indent;
    return restore(line);
  }

  // Anything else is a plain scalar. Leave it entirely alone.
  return restore(line);
}

/**
 * Quote leading `{$…}` / `{%…}` values throughout a YAML document.
 *
 * Idempotent: a value already quoted no longer begins with `{`, so a second pass is a
 * no-op. Documents containing no tokens are returned untouched.
 */
function preparse(text) {
  if (typeof text !== 'string') return text;
  if (!PREPARSE_TRIGGER_RE.test(text)) return text;

  const state = { flowDepth: 0, expectFlowEntry: false, blockScalarIndent: null };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) lines[i] = preparseLine(lines[i], state);
  return lines.join('\n');
}

/**
 * Find Codex Loom tokens that the YAML parser absorbed as mapping keys.
 *
 * This is the safety net for the case that fails silently. `triggers: [{$name}]` is
 * valid YAML — a flow sequence holding a single-key flow mapping — so it parses to
 * `[{"$name": null}]` and produces a wrong-typed value that surfaces far downstream.
 * Any mapping whose sole key begins with `$`, `%` or `@` is one of these, whatever
 * position it was written in.
 *
 * Returns `[{ path, key, token }]`, where `path` addresses the offending mapping's
 * parent so a `SourceMap` can locate it.
 *
 * Of the three sigils, only `$` is reachable by parsing: `%` and `@` are reserved
 * indicators in YAML, so an unquoted `{%role}` or `{@pe}` is a hard parse error and
 * never reaches here. They are covered anyway because a mapping of that shape can
 * arrive from somewhere other than a plain parse, and because the cost is one character
 * in a set membership test.
 */
function findSwallowedTokens(value) {
  const found = [];

  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, String(index)]));
      return;
    }
    if (!node || typeof node !== 'object') return;

    const keys = Object.keys(node);
    if (keys.length === 1 && keys[0].length > 0 && SWALLOWED_SIGILS.has(keys[0][0])) {
      found.push({ path, key: keys[0], token: `{${keys[0]}}` });
    }
    for (const key of keys) walk(node[key], [...path, key]);
  };

  walk(value, []);
  return found;
}

module.exports = { preparse, findSwallowedTokens, SWALLOWED_SIGILS };
