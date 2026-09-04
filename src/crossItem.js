'use strict';

/**
 * Cross-item render-function resolution (v4 spec §13).
 *
 * Build the dependency graph the corpus's cross-item render functions imply, evaluate it in
 * one topological pass, and report a genuine cycle by name.
 */

const { CODES: DIAG_CODES } = require('./diag');
const { ITEM_CONTEXT_KEYS, normalizeVarKey } = require('./util');
const { FUNCTION_NAMES } = require('./render/parse');
const { applyFieldRenderFunctions } = require('./template');

/**
 * The fixed keys `itemContext` (`util.js`) attaches to every item's render context, from
 * util.js's own `ITEM_CONTEXT_KEYS` rather than a hand-restated copy. A render function's
 * first path segment matching one of these resolves against the *current* item —
 * `resolveField`'s (`render/eval.js`) itemMap pivot only fires when the segment matches
 * neither this set nor the current item, so the dependency graph below must exclude them the
 * same way or it would draw an edge for every plain `$body.x` reference.
 */
const ITEM_CONTEXT_KEY_SET = new Set(ITEM_CONTEXT_KEYS);

/**
 * The render-function call syntax `processFieldRenderFunctions` (`template.js`) dispatches on.
 * Derived from the canonical `FUNCTION_NAMES` (`render/parse.js`) so a new render function
 * is registered in exactly one place.
 */
const RENDER_FN_PREFIXES = FUNCTION_NAMES.map((n) => n + '(');

/**
 * Scan one item's body for cross-item render-function references.
 *
 * An edge exists only when a render function's *first* path segment names another item —
 * exactly the case `resolveField`'s itemMap pivot resolves — so this scan has to mirror that
 * pivot's rule precisely rather than approximate it, or the graph would draw edges the
 * evaluator never actually chases (or miss ones it does). Plain `{$Other.body.X}` field
 * substitutions are `applyCrossItemRefs`'s pass, a different token family already resolved
 * before this runs, and are not scanned here.
 *
 * Returns `[{ target, field }]` — `target` the referenced item's lowercase id, `field` the
 * dotted body path the reference was found in, for `CL0418`'s message.
 */
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

/**
 * Tarjan's SCC over the cross-item dependency graph. Returns only the multi-node groups —
 * every genuine cycle — because a single-node SCC is acyclic by construction once self-loops
 * are excluded from the graph (self-reference is tolerated, not a cycle, and
 * `scanCrossItemRefs` never records one).
 */
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

/**
 * Post-order DFS topological order: a dependency is pushed onto `order` before the item that
 * depends on it, because it is fully visited (recursed into) first. Safe to run on a graph
 * that contains cycles — a node already on the current stack (`state === 1`) is skipped
 * rather than re-entered, so every node still resolves to exactly one position in `order`.
 * The caller excludes cyclic nodes from evaluation; their position in this order is otherwise
 * unused.
 */
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

/** `CL0418`, naming every item and field on the cycle's edges rather than the uncoded warning it replaces. */
function reportCycle(group, edgeFields, resolvedById, diagnostics) {
  if (!diagnostics) return;
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
    `Circular cross-item render dependency: ${parts.join(', ')}`,
  );
}

/**
 * Dependency-ordered cross-item render-function resolution (v4 spec §13).
 *
 * Evaluate in topological order rather than iterating a fixpoint loop to convergence: build
 * the dependency graph the corpus's cross-item render functions imply, evaluate it in one
 * topological pass, and report a genuine cycle by name instead of an uncoded warning after
 * N passes.
 *
 * A render function that migrates from item `B` into item `A` is evaluated in `B`'s context —
 * where the author wrote it — because `B` is resolved (and its body mutated in place) before
 * `A` ever reads it. This is the one place in the phase whose compiled output may
 * legitimately move.
 */
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
    // Left unexpanded: the item's leaked render-function text is caught downstream by the
    // output sweep's CL0432 LEAKED_RENDER_FUNCTION — two reports, both correct, rather than
    // a guess at which side of the cycle to break.
    if (cyclic.has(id)) continue;
    const item = resolvedById.get(id);
    applyFieldRenderFunctions(item, resolvedById, { diagnostics, file: item._source });
  }
}

module.exports = {
  findCycles,
  resolveCrossItemRenderFunctions,
};
