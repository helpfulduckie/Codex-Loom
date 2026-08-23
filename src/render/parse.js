'use strict';

const { CODES } = require('../diag');

/**
 * The template lexer and parser (v4 spec §13, Phase 9 Step 1).
 *
 * Replaces the regex-and-sentinel engine `template.js` used through Phase 8. A template is
 * tokenized once, so escape handling (`{{`/`}}`) is a lexer concern rather than a
 * find-and-restore pass, and every tag carries a source span so a malformed template can
 * finally report a line.
 *
 * Grammar (informal): a document is a sequence of text and single-brace tags. Tags do not
 * nest inside one `{...}` pair — `[^{}]+` was the v3 regex's rule and stays the lexer's
 * rule, because no construct in this language ever needs a literal brace inside a tag body.
 * Block tags (`{if}`/`{/if}`, `{wrapper}`/`{/wrapper}`, `{preserve}`/`{/preserve}`) are
 * matched by the parser walking the token stream with real nesting, which is what lets
 * `{if}` blocks nest correctly without the old engine's repeat-to-fixpoint loop.
 *
 * `{include}` is not a node here — it is expanded textually, before tokenization, by
 * `expandIncludes` in `template.js`. A real template opens a block in one partial and
 * closes it in another (the golden corpus does this for `{wrapper}` via `cardHeader`/
 * `cardFooter`), so an `Include` AST node scoped to its own parse tree cannot represent
 * every template the v3 engine already rendered correctly. Expanding first, then
 * tokenizing the fully-assembled string once, is what makes cross-partial blocks and
 * `{{`/`}}` escapes inside partials both fall out of the same one-pass lexer for free.
 */

const FUNCTION_NAMES = ['inline', 'join', 'list', 'and', 'prose', 'block', 'keys'];

/**
 * Split `source` into a flat token stream. Each token carries `{line, column, length}` —
 * a 1-based source span, computed as the scan proceeds rather than reconstructed afterward.
 */
function tokenize(source) {
  const tokens = [];
  let i = 0;
  const len = source.length;
  let line = 1;
  let col = 1;

  function advance(text) {
    for (let k = 0; k < text.length; k++) {
      if (text[k] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
  }

  let textBuf = '';
  let textLine = line;
  let textCol = col;

  function flushText() {
    if (textBuf) {
      tokens.push({ type: 'TEXT', value: textBuf, line: textLine, column: textCol, length: textBuf.length });
      textBuf = '';
    }
    textLine = line;
    textCol = col;
  }

  while (i < len) {
    const ch = source[i];

    if (ch === '{' && source[i + 1] === '{') {
      flushText();
      tokens.push({ type: 'ESC_LBRACE', line, column: col, length: 2 });
      advance('{{');
      i += 2;
      textLine = line;
      textCol = col;
      continue;
    }
    if (ch === '}' && source[i + 1] === '}') {
      flushText();
      tokens.push({ type: 'ESC_RBRACE', line, column: col, length: 2 });
      advance('}}');
      i += 2;
      textLine = line;
      textCol = col;
      continue;
    }
    if (ch === '{') {
      const closeIdx = source.indexOf('}', i + 1);
      const nextOpen = source.indexOf('{', i + 1);
      const validTag = closeIdx !== -1 && (nextOpen === -1 || nextOpen > closeIdx) && closeIdx > i + 1;
      if (!validTag) {
        textBuf += ch;
        advance(ch);
        i++;
        continue;
      }
      flushText();
      const tagLine = line;
      const tagCol = col;
      const raw = source.slice(i, closeIdx + 1);
      const inner = source.slice(i + 1, closeIdx);
      tokens.push(classifyTag(inner, raw, tagLine, tagCol));
      advance(raw);
      i = closeIdx + 1;
      textLine = line;
      textCol = col;
      continue;
    }
    textBuf += ch;
    advance(ch);
    i++;
  }
  flushText();
  return tokens;
}

/** One brace-delimited tag → a typed token. `raw` is the untrimmed original text, kept for
 * the literal fallback an unmatched or unknown tag renders as. */
function classifyTag(inner, raw, line, column) {
  const base = { raw, line, column, length: raw.length };
  const trimmed = inner.trim();

  if (inner.startsWith('if ')) {
    return { ...base, type: 'IF_OPEN', cond: inner.slice(3).trim() };
  }
  if (trimmed === 'else') return { ...base, type: 'ELSE' };
  if (trimmed === '/if') return { ...base, type: 'IF_CLOSE' };
  if (trimmed === 'wrapper') return { ...base, type: 'WRAPPER_OPEN' };
  if (trimmed === '/wrapper') return { ...base, type: 'WRAPPER_CLOSE' };
  if (trimmed === 'preserve') return { ...base, type: 'PRESERVE_OPEN' };
  if (trimmed === '/preserve') return { ...base, type: 'PRESERVE_CLOSE' };

  const callMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\(/);
  if (callMatch) {
    if (FUNCTION_NAMES.includes(callMatch[1])) {
      return { ...base, type: 'FUNC_CALL', name: callMatch[1], inner: trimmed };
    }
    return { ...base, type: 'UNKNOWN_FUNCTION', name: callMatch[1] };
  }

  if (trimmed.startsWith('$')) return { ...base, type: 'FIELD_REF', ref: trimmed };

  return { ...base, type: 'UNKNOWN' };
}

/**
 * Parse a token stream into a document tree.
 *
 * Block tags nest for real: an `{if}` inside an `{if}` is matched to its own `{/if}` by a
 * stack, not by a repeat-until-fixpoint string pass. A block whose closing tag never
 * arrives is not swallowed — the parser backtracks, emits the open tag as literal text
 * (matching the v3 engine's fallback, since an unmatched regex left the tag untouched), and
 * reports `CL0415` naming the block. Every node it builds carries the opening tag's span.
 *
 * `report(code, message, span)` is a diagnostics callback rather than a bus reference, so
 * this module never has to know what a `Diagnostics` instance looks like.
 */
function parse(tokens, report) {
  let pos = 0;
  // An unclosed block is discovered once per real attempt but re-walked whenever an
  // enclosing block also fails to close and backtracks over it — dedupe on the open
  // token's identity so a nested miss is reported once, not once per backtrack.
  const reportedUnclosed = new Set();

  function reportUnclosedOnce(openTok, code, message) {
    if (reportedUnclosed.has(openTok)) return;
    reportedUnclosed.add(openTok);
    report(code, message, openTok);
  }

  function peek() {
    return tokens[pos];
  }

  function parseSequence(stopTypes) {
    const nodes = [];
    while (pos < tokens.length) {
      const tok = peek();
      if (stopTypes && stopTypes.includes(tok.type)) break;
      nodes.push(parseOne());
    }
    return nodes;
  }

  function literal(tok) {
    return { type: 'Text', value: tok.raw, line: tok.line, column: tok.column };
  }

  function parseOne() {
    const tok = peek();
    switch (tok.type) {
      case 'TEXT':
        pos++;
        return { type: 'Text', value: tok.value, line: tok.line, column: tok.column };
      case 'ESC_LBRACE':
        pos++;
        return { type: 'Text', value: '{', line: tok.line, column: tok.column };
      case 'ESC_RBRACE':
        pos++;
        return { type: 'Text', value: '}', line: tok.line, column: tok.column };
      case 'FIELD_REF':
        pos++;
        return { type: 'FieldRef', ref: tok.ref, line: tok.line, column: tok.column };
      case 'FUNC_CALL':
        pos++;
        return { type: 'FuncCall', name: tok.name, inner: tok.inner, line: tok.line, column: tok.column };
      case 'UNKNOWN_FUNCTION': {
        pos++;
        report(CODES.TEMPLATE_UNKNOWN_FUNCTION, `Unknown template function "${tok.name}()".`, tok);
        return literal(tok);
      }
      case 'IF_OPEN':
        return parseIf(tok);
      case 'WRAPPER_OPEN':
        return parseWrapper(tok);
      case 'PRESERVE_OPEN':
        return parsePreserve(tok);
      // Stray closers/else with no matching opener — the v3 engine's regexes never
      // matched these either, so they render as the literal tag text.
      case 'ELSE':
      case 'IF_CLOSE':
      case 'WRAPPER_CLOSE':
      case 'PRESERVE_CLOSE':
      case 'UNKNOWN':
        pos++;
        return literal(tok);
      default:
        pos++;
        return literal(tok);
    }
  }

  function parseIf(openTok) {
    const start = pos;
    pos++; // consume IF_OPEN
    const thenNodes = parseSequence(['ELSE', 'IF_CLOSE']);
    let elseNodes = null;
    if (peek() && peek().type === 'ELSE') {
      pos++; // consume ELSE
      elseNodes = parseSequence(['IF_CLOSE']);
    }
    if (peek() && peek().type === 'IF_CLOSE') {
      pos++; // consume IF_CLOSE
      return {
        type: 'If', cond: openTok.cond, then: thenNodes, else: elseNodes,
        line: openTok.line, column: openTok.column,
      };
    }
    // No matching {/if} anywhere in the remaining stream: back out to just past the open
    // tag and let it and everything after it be reparsed as ordinary content.
    reportUnclosedOnce(openTok, CODES.TEMPLATE_UNCLOSED_BLOCK, `Unclosed {if ${openTok.cond}} block.`);
    pos = start + 1;
    return literal(openTok);
  }

  function parseWrapper(openTok) {
    const start = pos;
    pos++; // consume WRAPPER_OPEN
    const children = parseSequence(['WRAPPER_CLOSE']);
    if (peek() && peek().type === 'WRAPPER_CLOSE') {
      pos++;
      return { type: 'Wrapper', children, line: openTok.line, column: openTok.column };
    }
    reportUnclosedOnce(openTok, CODES.TEMPLATE_UNCLOSED_BLOCK, 'Unclosed {wrapper} block.');
    pos = start + 1;
    return literal(openTok);
  }

  function parsePreserve(openTok) {
    const start = pos;
    pos++; // consume PRESERVE_OPEN
    const children = parseSequence(['PRESERVE_CLOSE']);
    if (peek() && peek().type === 'PRESERVE_CLOSE') {
      pos++;
      return { type: 'Preserve', children, line: openTok.line, column: openTok.column };
    }
    reportUnclosedOnce(openTok, CODES.TEMPLATE_UNCLOSED_BLOCK, 'Unclosed {preserve} block.');
    pos = start + 1;
    return literal(openTok);
  }

  const children = parseSequence(null);
  return { type: 'Program', children };
}

module.exports = { tokenize, parse, FUNCTION_NAMES };
