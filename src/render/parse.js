'use strict';

const { CODES } = require('../diag');


const FUNCTION_NAMES = ['inline', 'join', 'list', 'and', 'prose', 'block', 'keys'];

function entryName(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    return entry.field || entry.name || null;
  }
  return null;
}

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

function parse(tokens, report) {
  let pos = 0;
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

module.exports = { tokenize, parse, FUNCTION_NAMES, entryName };
