'use strict';

/**
 * Branch specs and branch-tree traversal (v4 spec §3.2, §3.3).
 *
 * Branch-spec resolution has no knowledge of item content, which is the seam this
 * module was split along. It also owns every traversal of the branch tree: §3.3
 * requires one walker, and `walkBranchChain` below is it.
 *
 * Pure by contract (§3.3): no `fs`, no `console`.
 */

const { deepClone, findKey } = require('../util');

/**
 * Deep-merge two branch specs (override layered over base), with branch-spec
 * semantics rather than field-op semantics.
 *
 * Branch specs are dispatch trees, not field-delta data, so the merge must NOT
 * route values through applyFieldOp:
 *   - A leaf in `override` (array — including `[]` — scalar, or null/`~`) replaces
 *     the base value outright. Crucially `[]` ("include, no variants") survives
 *     instead of evaporating, and `~` is preserved as an explicit exclude rather
 *     than deleting the key.
 *   - A mapping in `override` recurses, merging into the matching base mapping.
 * Keys present only in `base` are kept.
 *
 * @param {object} base     - the lower-priority branches mapping (e.g. item/overlay)
 * @param {object} override - the higher-priority branches mapping (e.g. PE block)
 * @returns {object} merged branches mapping
 */
function mergeBranchSpecs(base, override) {
  if (override === undefined) return base;
  if (override === null) return override; // explicit exclusion wins
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  if (base === null || base === undefined || typeof base !== 'object' || Array.isArray(base)) {
    return deepClone(override);
  }

  const result = deepClone(base);
  for (const [key, overrideVal] of Object.entries(override)) {
    const baseKey = Object.keys(result).find(k => k.toLowerCase() === key.toLowerCase());
    const baseVal = baseKey !== undefined ? result[baseKey] : undefined;
    const targetKey = baseKey !== undefined ? baseKey : key;

    if (overrideVal === null || overrideVal === undefined) {
      // Explicit exclusion (or override omits this key) — override wins.
      result[targetKey] = overrideVal;
    } else if (typeof overrideVal === 'object' && !Array.isArray(overrideVal) &&
        baseVal !== null && typeof baseVal === 'object' && !Array.isArray(baseVal)) {
      result[targetKey] = mergeBranchSpecs(baseVal, overrideVal);
    } else if (baseVal !== null && baseVal !== undefined) {
      // Leaf override (array/scalar/apply-only mapping) stacked on a present base value:
      // compose apply lists and keep descending into the base's sub-branches unless the
      // override supplies its own — a block-level visibility override like `[]` must not
      // silently discard the item's nested route-variant tree.
      const baseApply = extractApplyList(baseVal);
      const overrideApply = extractApplyList(overrideVal);
      const mergedApply = [...baseApply, ...overrideApply];
      const mergedSub = extractSubBranches(overrideVal) || extractSubBranches(baseVal);
      result[targetKey] = mergedSub ? { apply: mergedApply, branches: mergedSub } : mergedApply;
    } else {
      // No base value at this key — override replaces outright.
      result[targetKey] = deepClone(overrideVal);
    }
  }
  return result;
}

/**
 * Resolve the branch spec for an item/block, walking the branch path.
 *
 * Returns:
 *   null             → item is excluded from this branch (explicit ~ on the key)
 *   string[]         → variant names to apply (may be empty)
 *
 * Resolution at each depth level:
 *   1. If the exact key maps to null (~) → return null immediately (no wildcard)
 *   2. Collect '*' wildcard variants as baseline
 *   3. Collect exact key match variants (stacked on top of wildcard)
 *   4. If mapping form: descend via 'branches' sub-key for next depth
 *
 * Both '*' and an explicit key can match at the same level; explicit adds to wildcard.
 *
 * @param {object|null} spec - the branches: mapping on an item def
 * @param {string[]} branchPath - leaf branch path e.g. ['A', 'X']
 * @returns {null | string[]}
 */
function resolveBranchSpec(spec, branchPath) {
  if (!spec || typeof spec !== 'object') return [];

  const variantNames = [];
  let activeSpecs = [spec];

  for (const branch of branchPath) {
    const nextSpecs = [];
    const branchLower = branch.toLowerCase();

    for (const currentSpec of activeSpecs) {
      if (!currentSpec || typeof currentSpec !== 'object') continue;

      // Check explicit key for null (exclude entire item)
      const exactKey = Object.keys(currentSpec).find(k => k !== '*' && k !== '_' && k.toLowerCase() === branchLower);
      if (exactKey !== undefined) {
        const exactVal = currentSpec[exactKey];
        if (exactVal === null || exactVal === undefined) {
          return null;
        }
      }

      // Collect wildcard baseline
      if ('*' in currentSpec && currentSpec['*'] !== null) {
        const wildcardVal = currentSpec['*'];
        variantNames.push(...extractApplyList(wildcardVal));
        const wildcardSub = extractSubBranches(wildcardVal);
        if (wildcardSub) nextSpecs.push(wildcardSub);
      }

      // Collect exact key variants (stacked on top of wildcard)
      if (exactKey !== undefined) {
        const exactVal = currentSpec[exactKey];
        variantNames.push(...extractApplyList(exactVal));
        const exactSub = extractSubBranches(exactVal);
        if (exactSub) nextSpecs.push(exactSub);
      }

      // Collect fallback variants (only for branches with no exact key match)
      if (exactKey === undefined && '_' in currentSpec) {
        const fallbackVal = currentSpec['_'];
        if (fallbackVal === null || fallbackVal === undefined) {
          return null;
        }
        variantNames.push(...extractApplyList(fallbackVal));
        const fallbackSub = extractSubBranches(fallbackVal);
        if (fallbackSub) nextSpecs.push(fallbackSub);
      }
    }

    activeSpecs = nextSpecs;
  }

  return variantNames;
}

/**
 * Extract the list of variant names to apply from a branch spec value.
 * Value forms:
 *   scalar string → [string]
 *   array         → array
 *   mapping with apply: → apply value (scalar or array)
 *   mapping without apply: → []
 */
function extractApplyList(val) {
  if (val === null || val === undefined) return [];
  if (typeof val === 'string') return val ? [val] : [];
  if (Array.isArray(val)) return val.filter(v => typeof v === 'string' && v);
  if (typeof val === 'object') {
    // Mapping form: may have apply: key
    const apply = val.apply;
    if (apply === undefined) return [];
    if (typeof apply === 'string') return apply ? [apply] : [];
    if (Array.isArray(apply)) return apply.filter(v => typeof v === 'string' && v);
    return [];
  }
  return [];
}

/**
 * Extract the sub-branches mapping from a branch spec value for deeper descent.
 */
function extractSubBranches(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object' && !Array.isArray(val) && val.branches) {
    return val.branches;
  }
  return null;
}

/**
 * Enumerate all leaf branch paths from a branch tree.
 * Returns array of arrays of strings: e.g. [['A','X'], ['A','Y'], ['B']]
 * If no branches defined, returns [[]] (one root leaf).
 */
function enumerateLeaves(branches, prefix) {
  if (!prefix) prefix = [];
  if (!branches || typeof branches !== 'object' || Object.keys(branches).length === 0) {
    return [prefix];
  }
  const leaves = [];
  for (const [key, value] of Object.entries(branches)) {
    const childBranches = value && value.branches ? value.branches : null;
    leaves.push(...enumerateLeaves(childBranches, [...prefix, key]));
  }
  return leaves;
}

/**
 * Get branch config for a given path.
 * Returns the branch config object at that path, or {} if not found.
 */
function getBranchConfig(branches, branchPath) {
  let currentMap = branches;
  let currentNode = null;
  for (const part of branchPath) {
    if (!currentMap || typeof currentMap !== 'object') return {};
    const actualKey = Object.keys(currentMap).find(k => k.toLowerCase() === part.toLowerCase());
    if (!actualKey) return {};
    currentNode = currentMap[actualKey];
    currentMap = currentNode && currentNode.branches ? currentNode.branches : null;
  }
  return currentNode || {};
}

/**
 * Walk a branch chain, accumulating everything that merges down it.
 *
 * v3 hand-rolled this traversal four times — for variables and components, for folder
 * names, for the inherited protagonist, and to fetch a terminal node — each with the
 * same case-insensitive key match and `node.branches` descent, and each with different
 * behavior when a segment did not match. One of the four was dead: its result was
 * assigned and never read.
 *
 * Returns everything all four needed, so the callers differ in what they read rather
 * than in how they traverse:
 *
 *   nodes        every node along the chain, root-first
 *   folderPath   case-preserved YAML keys, for building output directories
 *   variables    merged root-to-leaf, child overriding parent
 *   components   merged the same way
 *   protagonist  the nearest ancestor that declares one
 *   node         the terminal node, or null
 *   complete     false when a segment did not match — the callers that used to `break`
 *                and the ones that used to push the raw id both need to know
 */
function walkBranchChain(branches, branchPath, options = {}) {
  const { rootProtagonist = null } = options;
  const result = {
    nodes: [],
    folderPath: [],
    variables: {},
    components: {},
    render: {},
    scripts: undefined,
    protagonist: rootProtagonist,
    node: null,
    complete: true,
  };

  let currentMap = branches;
  for (const segment of (branchPath || [])) {
    const actualKey = currentMap && typeof currentMap === 'object'
      ? findKey(currentMap, String(segment))
      : null;

    if (!actualKey) {
      // No match: the folder name falls back to the id as written, and everything
      // downstream of here is unknown.
      result.complete = false;
      result.folderPath.push(String(segment));
      currentMap = null;
      continue;
    }

    const node = currentMap[actualKey];
    result.folderPath.push(actualKey);
    result.nodes.push(node);
    result.node = node || null;

    if (node && typeof node === 'object') {
      if (node.variables) Object.assign(result.variables, node.variables);
      if (node.components) Object.assign(result.components, node.components);
      // `render:` merges key-wise like `components:`, so a branch can replace one
      // rendering default and inherit the rest — and `notesTemplate: ~` unbinds it,
      // which is how a branch without the mod that reads the marker turns it off.
      if (node.render) Object.assign(result.render, node.render);
      if (node.protagonist) result.protagonist = node.protagonist;
      // `scripts:` is top-level rather than a component (§6.3) but merges the same way,
      // so a branch can swap one hook bundle and inherit the rest.
      if (node.scripts !== undefined) result.scripts = node.scripts;
    }

    currentMap = node && node.branches ? node.branches : null;
  }

  return result;
}

/**
 * Visit every node in a branch tree, depth-first, carrying state down.
 *
 * The counterpart to `walkBranchChain`, and a genuinely different operation: that one
 * looks up a known path and accumulates along it, this one enumerates. Enumeration needs
 * no case-insensitive matching because it visits every key and the key *is* the answer.
 *
 * `visit({ name, node, path, isLeaf, state })` may return a new state for that node's
 * children; returning `undefined` passes the current state through unchanged. That is
 * what lets a caller merge variables down the tree without writing the recursion again.
 *
 * Two callers need this rather than `walkBranchChain`, and both write at nodes the leaf
 * loop never reaches: `branchFraming` belongs to the node whose children it frames, and
 * `Label.md` is written at every node.
 */
function walkBranchTree(branches, visit, state = null, path = []) {
  if (!branches || typeof branches !== 'object') return;
  for (const [name, node] of Object.entries(branches)) {
    const childPath = [...path, name];
    const sub = node && node.branches;
    const isLeaf = !sub || Object.keys(sub).length === 0;
    const next = visit({ name, node, path: childPath, isLeaf, state });
    if (!isLeaf) walkBranchTree(sub, visit, next === undefined ? state : next, childPath);
  }
}

module.exports = {
  mergeBranchSpecs, resolveBranchSpec, enumerateLeaves, getBranchConfig,
  walkBranchChain, walkBranchTree,
};
