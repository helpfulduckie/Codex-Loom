'use strict';

const { normalizeVarKey } = require('../util');
const { CODES } = require('../diag');
const { FUNCTION_NAMES } = require('./parse');

/**
 * The evaluation walk (v4 spec §13, Phase 9 Step 1).
 *
 * Semantics moved here essentially intact from `template.js`: field resolution, truthiness,
 * and the seven render functions read the same way they did under the regex engine (Decision
 * 1 of the Phase 9 plan). What changed is the tree they walk and what a malformed call does —
 * it reports a diagnostic instead of throwing into a `console.warn`.
 */

// ── Field resolution ──────────────────────────────────────────────────────────

/**
 * Case-insensitive deep field resolver.
 * Resolves paths like "body.Physical Traits.gender" against card data.
 *
 * Returns the value or null. Arrays and objects are returned as-is for render functions.
 * Plain scalars are returned as trimmed strings.
 */
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
      // Cross-item ref fallback: if we're still at the root context and an itemMap is
      // available, treat the unresolved segment as an item ID and pivot to that item.
      // e.g. $Aness.body.magic.affinity → find 'aness' in itemMap, then navigate body.magic.affinity
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

  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // Return arrays and objects as-is so render functions can work with them
  if (Array.isArray(value)) return value.length > 0 ? value : null;
  if (typeof value === 'object') return value;

  const str = String(value).trim();
  return str === '' ? null : str;
}

/** Evaluate boolean truthiness of a field reference. */
function isTruthy(ref, data) {
  const val = resolveField(ref, data);
  if (val === null) return false;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object') return Object.keys(val).length > 0;
  if (String(val).toLowerCase() === 'false') return false;
  if (val === '0') return false;
  return true;
}

/**
 * Render a value as a string for inline output.
 * Arrays → elements joined with "; ".
 * Objects → not directly renderable, returns "".
 */
function renderScalar(val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return val.join('; ');
  if (typeof val === 'object') return '';
  return String(val);
}

// ── Render functions ──────────────────────────────────────────────────────────

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
    // Remove trailing punctuation then add period
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

// Kept as an explicit literal — a hand-audited row per render function reads better than
// a generated map. The assert below is the drift guard: every name in `FUNCTION_NAMES`
// (`./parse`, the one canonical list) must have a row here and vice versa.
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

// ── Tree walk ──────────────────────────────────────────────────────────────────

/**
 * Render one parsed document against `data`.
 *
 * `ctx` carries what the walk needs beyond the current node: `report(code, message, span)`
 * for diagnostics, and two shared mutable containers — `preserved` (evaluated `{preserve}`
 * bodies, as `\x00PRESERVE_n\x00` sentinels for `normalizeWhitespace` to restore) and
 * `flags.wrapperUsed`. `{include}` is expanded before this walk ever runs (see `parse.js`'s
 * header on why), so there is no `Include` node and no include-stack to carry here.
 */
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
      ctx.report(CODES.TEMPLATE_PARSE_FAILED, `Malformed ${node.name}() call in ${ctx.name || 'template'}: ${e.message}`, node);
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
  // Marks that a {wrapper} block actually fired during this walk — including one nested
  // inside a taken {if} branch or an included partial — so `render()` knows not to apply
  // the post-render auto-wrap fallback. A top-level-only check would miss that nested
  // case; this one matches the old regex-over-the-post-conditional-string check exactly,
  // because an untaken {if} branch never contributes its text (or its nested {wrapper})
  // either way. `flags` is a shared object (not a plain ctx property) so the mutation is
  // visible through the shallow copy `renderInclude` makes for its nested context.
  ctx.flags.wrapperUsed = true;
  const content = node.children.map(child => renderNode(child, data, ctx)).join('');
  const wrapper = (data.render && data.render.wrapper) || 'none';
  return applyWrapper(content.trim(), wrapper);
}

/** Apply wrapper to a string of content. */
function applyWrapper(text, wrapper) {
  const w = (wrapper || 'none').toLowerCase();
  if (w === 'square') return `[\n${text}\n]`;
  if (w === 'curly') return `{\n${text}\n}`;
  return text;
}

/**
 * Evaluate a `{preserve}` block's children, then hand `normalizeWhitespace` a sentinel
 * instead of re-inserting the literal tags. Re-inserting the tags and letting
 * `normalizeWhitespace` re-discover them by regex was tried and rejected: if the evaluated
 * content contains the literal text "{/preserve}" — which can arrive from data, e.g.
 * `{preserve}{$body.text}{/preserve}` — the regex would close on that text instead of the
 * source's real closing tag, which is the exact bug Decision 2 exists to retire. Finding the
 * boundary here, from the parsed source, is what keeps the fix real.
 */
function renderPreserve(node, data, ctx) {
  const raw = node.children.map(child => renderNode(child, data, ctx)).join('');
  // Trim one leading/trailing newline so tags on their own lines don't double up — the same
  // trim `normalizeWhitespace` applied to its regex-captured group.
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
