'use strict';


const SWALLOWED_SIGILS = new Set(['$', '%']);

const BLOCK_SCALAR_RE = /^[|>][+-]?\d*[+-]?\s*(#.*)?$/;

const DOC_MARKER_RE = /^(---|\.\.\.)(\s|$)/;

const PREPARSE_TRIGGER_RE = /\{\$|\{%|%\w+%/;

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

function trimEnd(line, start, end) {
  let e = end;
  while (e > start && isSpace(line[e - 1])) e--;
  return e;
}

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

  if (state.flowDepth > 0) {
    scanFlow(line, indent, state, wraps);
    return restore(wraps.length ? applyWraps(line, wraps) : line);
  }


  let i = indent;

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

  if (isTokenStart(line, valueStart)) {
    wraps.push({ start: valueStart, end: blockValueEnd(line, valueStart) });
    return restore(applyWraps(line, wraps));
  }

  if (line[valueStart] === '[' || line[valueStart] === '{') {
    scanFlow(line, valueStart, state, wraps);
    return restore(wraps.length ? applyWraps(line, wraps) : line);
  }

  if (sep >= 0 && BLOCK_SCALAR_RE.test(line.slice(valueStart))) {
    state.blockScalarIndent = indent;
    return restore(line);
  }

  return restore(line);
}

function preparse(text) {
  if (typeof text !== 'string') return text;
  if (!PREPARSE_TRIGGER_RE.test(text)) return text;

  const state = { flowDepth: 0, expectFlowEntry: false, blockScalarIndent: null };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) lines[i] = preparseLine(lines[i], state);
  return lines.join('\n');
}

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

module.exports = { preparse, findSwallowedTokens };
