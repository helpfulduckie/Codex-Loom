'use strict';


const { CODES: DIAG_CODES } = require('./diag');
const { ITEM_CONTEXT_KEYS, normalizeVarKey } = require('./util');
const { FUNCTION_NAMES } = require('./render/parse');
const { applyFieldRenderFunctions } = require('./template');

const ITEM_CONTEXT_KEY_SET = new Set(ITEM_CONTEXT_KEYS);

const RENDER_FN_PREFIXES = FUNCTION_NAMES.map((n) => n + '(');

function scanCrossItemRefs(body, resolvedById, selfId) {
  const refs = [];
  const scanString = (str, fieldPath) => {
    str.replace(/\{([^{}]+)\}/g, (match, inner) => {
      inner = inner.trim();
      if (!RENDER_FN_PREFIXES.some((prefix) => inner.startsWith(prefix))) return match;
      const tokens = inner.match(/\$[A-Za-z0-9_-]+/g) || [];
      for (const token of tokens) {
        const first = normalizeVarKey(token.slice(1)).toLowerCase();
        if (ITEM_CONTEXT_KEY_SET.has(first)) continue;
        if (first === selfId) continue;
        if (!resolvedById.has(first)) continue;
        refs.push({ target: first, field: fieldPath });
      }
      return match;
    });
  };
  const walk = (obj, fieldPath) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const nextPath = fieldPath ? `${fieldPath}.${key}` : key;
      if (typeof val === 'string') {
        scanString(val, nextPath);
      } else if (Array.isArray(val)) {
        for (const entry of val) {
          if (typeof entry === 'string') scanString(entry, nextPath);
        }
      } else if (typeof val === 'object' && val !== null) {
        walk(val, nextPath);
      }
    }
  };
  walk(body, '');
  return refs;
}

function findCycles(graph) {
  let counter = 0;
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const groups = [];

  const strongconnect = (v) => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) || []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const group = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) groups.push(group);
    }
  };

  for (const v of graph.keys()) {
    if (!index.has(v)) strongconnect(v);
  }
  return groups;
}

function topoOrder(graph) {
  const state = new Map();
  const order = [];
  const visit = (node) => {
    if (state.has(node)) return;
    state.set(node, 1);
    for (const dep of graph.get(node) || []) {
      visit(dep);
    }
    state.set(node, 2);
    order.push(node);
  };
  for (const node of graph.keys()) visit(node);
  return order;
}

function reportCycle(group, edgeFields, resolvedById, diagnostics) {
  const groupSet = new Set(group);
  const parts = [];
  for (const from of group) {
    for (const to of groupSet) {
      const key = `${from}->${to}`;
      const fields = edgeFields.get(key);
      if (!fields) continue;
      const fromItem = resolvedById.get(from);
      const toItem = resolvedById.get(to);
      for (const field of fields) {
        parts.push(`"${fromItem.id}".${field} → "${toItem.id}"`);
      }
    }
  }
  diagnostics.error(
    DIAG_CODES.CROSS_ITEM_CYCLE,
    `Circular cross-item render dependency: ${parts.join(', ')}; break the cycle, and cyclic references remain unresolved until fixed.`,
  );
}

function resolveCrossItemRenderFunctions(resolvedItems, resolvedById, diagnostics) {
  const graph = new Map();
  const edgeFields = new Map();

  for (const item of resolvedItems) {
    const idLower = (item.id || '').toLowerCase();
    if (!idLower) continue;
    const deps = graph.get(idLower) || new Set();
    graph.set(idLower, deps);
    if (!item.body) continue;
    for (const { target, field } of scanCrossItemRefs(item.body, resolvedById, idLower)) {
      deps.add(target);
      const key = `${idLower}->${target}`;
      if (!edgeFields.has(key)) edgeFields.set(key, new Set());
      edgeFields.get(key).add(field);
    }
  }

  const cyclic = new Set();
  for (const group of findCycles(graph)) {
    for (const id of group) cyclic.add(id);
    reportCycle(group, edgeFields, resolvedById, diagnostics);
  }

  for (const id of topoOrder(graph)) {
    if (cyclic.has(id)) continue;
    const item = resolvedById.get(id);
    applyFieldRenderFunctions(item, resolvedById, { diagnostics, file: item._source });
  }
}

module.exports = {
  findCycles,
  resolveCrossItemRenderFunctions,
};
