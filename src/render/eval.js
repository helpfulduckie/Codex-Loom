'use strict';

const { normalizeVarKey } = require('../util');
const { CODES } = require('../diag');
const { FUNCTION_NAMES } = require('./parse');



function resolveField(ref, data) {
  const path = ref.startsWith('$') ? ref.slice(1) : ref;
  const parts = path.split('.');
  if (parts.length > 0) parts[0] = normalizeVarKey(parts[0]);

  let value = data;
  for (const part of parts) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') return null;

    const lower = part.toLowerCase();
    const actualKey = Object.keys(value).find(k => k.toLowerCase() === lower);
    if (actualKey === undefined) {
      if (value === data && data.itemMap) {
        const sourceItem = data.itemMap.get(lower);
        if (sourceItem) {
          value = sourceItem;
          continue;
        }
      }
      return null;
    }
    value = value[actualKey];
  }

  return normalizeValue(value);
}

function normalizeValue(value, preserveScalar = false) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    const kept = value.map(member => normalizeValue(member, true)).filter(member => member !== null);
    return kept.length > 0 ? kept : null;
  }
  if (typeof value === 'object') {
    const kept = Object.fromEntries(
      Object.entries(value)
        .map(([key, member]) => [key, normalizeValue(member, true)])
        .filter(([, member]) => member !== null),
    );
    return Object.keys(kept).length > 0 ? kept : null;
  }

  const str = String(value);
  return str.trim() === '' ? null : (preserveScalar ? value : str.trim());
}

function isTruthy(ref, data) {
  const val = resolveField(ref, data);
  if (val === null) return false;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object') return Object.keys(val).length > 0;
  if (String(val).toLowerCase() === 'false') return false;
  if (val === '0') return false;
  return true;
}

function renderScalar(val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return val.join('; ');
  if (typeof val === 'object') return '';
  return String(val);
}


function evaluateInline(inner, data) {
  const refMatch = inner.match(/^inline\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed inline(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  if (typeof val === 'object' && !Array.isArray(val)) {
    return Object.values(val).filter(v => v != null).join(' ');
  }
  if (Array.isArray(val)) return val.join(' ');
  return String(val);
}

function evaluateJoin(inner, data) {
  const sepMatch = inner.match(/^join\(\s*(["'`])([^"'`]*)\1\s*,(.+)\)$/s);
  if (!sepMatch) throw new Error('Malformed join(): ' + inner);
  const separator = sepMatch[2];
  const refs = sepMatch[3].split(',').map(s => s.trim()).filter(Boolean);
  const values = refs
    .map(ref => resolveField(ref, data))
    .filter(v => v !== null)
    .flatMap(v => Array.isArray(v) ? v : (typeof v === 'object' ? Object.values(v).filter(x => x != null) : [v]));
  return values.join(separator);
}

function evaluateList(inner, data) {
  const refMatch = inner.match(/^list\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed list(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  if (Array.isArray(val)) {
    if (val.length === 1) return String(val[0]);
    return '\n' + val.map(item => '- ' + item).join('\n');
  }
  if (typeof val === 'object') {
    const entries = Object.values(val).filter(v => v != null);
    if (entries.length === 0) return '';
    if (entries.length === 1) return String(entries[0]);
    return '\n' + entries.map(v => '- ' + v).join('\n');
  }
  return renderScalar(val);
}

function evaluateAnd(inner, data) {
  const refMatch = inner.match(/^and\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed and(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  const arr = Array.isArray(val) ? val : [String(val)];
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return arr[0] + ' and ' + arr[1];
  return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
}

function evaluateProse(inner, data) {
  const refMatch = inner.match(/^prose\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed prose(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  const arr = Array.isArray(val) ? val : [String(val)];
  return arr.map(item => {
    let s = String(item).trim();
    if (!s) return '';
    s = s[0].toUpperCase() + s.slice(1);
    s = s.replace(/[.!?]+$/, '') + '.';
    return s;
  }).filter(Boolean).join(' ');
}

function evaluateBlock(inner, data) {
  const refMatch = inner.match(/^block\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed block(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  if (Array.isArray(val)) return val.join('\n');
  return renderScalar(val);
}

function evaluateKeys(inner, data) {
  const refMatch = inner.match(/^keys\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed keys(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  if (typeof val === 'object' && !Array.isArray(val)) {
    return Object.entries(val)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
  }
  return renderScalar(val);
}

const FUNCTIONS = {
  inline: evaluateInline,
  join: evaluateJoin,
  list: evaluateList,
  and: evaluateAnd,
  prose: evaluateProse,
  block: evaluateBlock,
  keys: evaluateKeys,
};

if (Object.keys(FUNCTIONS).sort().join() !== [...FUNCTION_NAMES].sort().join()) {
  throw new Error('FUNCTIONS keys and FUNCTION_NAMES disagree');
}


function renderProgram(program, data, ctx) {
  return program.children.map(node => renderNode(node, data, ctx)).join('');
}

function renderNode(node, data, ctx) {
  switch (node.type) {
    case 'Text':
      return node.value;
    case 'FieldRef':
      return renderFieldRef(node, data);
    case 'FuncCall':
      return renderFuncCall(node, data, ctx);
    case 'If':
      return renderIf(node, data, ctx);
    case 'Wrapper':
      return renderWrapper(node, data, ctx);
    case 'Preserve':
      return renderPreserve(node, data, ctx);
    default:
      return '';
  }
}

function renderFieldRef(node, data) {
  const val = resolveField(node.ref, data);
  if (val === null) return '';
  if (Array.isArray(val)) {
    if (val.length === 1) return String(val[0]);
    return '\n' + val.map(item => '- ' + item).join('\n');
  }
  if (typeof val === 'object') {
    if (val.full != null) return String(val.full);
    const entries = Object.values(val).filter(v => v != null);
    if (entries.length === 0) return '';
    if (entries.length === 1) return String(entries[0]);
    return '\n' + entries.map(v => '- ' + v).join('\n');
  }
  return renderScalar(val);
}

function renderFuncCall(node, data, ctx) {
  const fn = FUNCTIONS[node.name];
  try {
    return fn(node.inner, data);
  } catch (e) {
    if (ctx.report) {
      ctx.report(CODES.TEMPLATE_PARSE_FAILED, `Malformed ${node.name}() call in ${ctx.name || 'template'}: ${e.message}; correct the call syntax, and the malformed call remains literal.`, node);
    }
    return '';
  }
}

function renderIf(node, data, ctx) {
  const truthy = isTruthy(node.cond, data);
  const branch = truthy ? node.then : (node.else || []);
  return branch.map(child => renderNode(child, data, ctx)).join('');
}

function renderWrapper(node, data, ctx) {
  ctx.flags.wrapperUsed = true;
  const content = node.children.map(child => renderNode(child, data, ctx)).join('');
  const wrapper = (data.render && data.render.wrapper) || 'none';
  return applyWrapper(content.trim(), wrapper);
}

function applyWrapper(text, wrapper) {
  const w = (wrapper || 'none').toLowerCase();
  if (w === 'square') return `[\n${text}\n]`;
  if (w === 'curly') return `{\n${text}\n}`;
  return text;
}

function renderPreserve(node, data, ctx) {
  const raw = node.children.map(child => renderNode(child, data, ctx)).join('');
  const trimmed = raw.replace(/^\n/, '').replace(/\n$/, '');
  const idx = ctx.preserved.length;
  ctx.preserved.push(trimmed);
  return `\x00PRESERVE_${idx}\x00`;
}

module.exports = {
  resolveField,
  isTruthy,
  renderScalar,
  evaluateInline,
  evaluateJoin,
  evaluateList,
  evaluateAnd,
  evaluateProse,
  evaluateBlock,
  evaluateKeys,
  FUNCTIONS,
  renderProgram,
  applyWrapper,
};
