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
const { CODES } = require('../diag');

/**
 * Mirrors `config/load.js`'s `CODES.VARIABLE_UNBIND_UNKNOWN` — the code is declared there,
 * beside `CL0510`/`CL0511`, because it names a variable-band mistake even though this is
 * the module that raises it. Duplicated as a literal rather than imported: `config/load.js`
 * depends on `fs`, and `model/` is pure by contract (§3.3, enforced by
 * `model-branches.test.js`'s "uses neither fs nor console" check).
 */
const VARIABLE_UNBIND_UNKNOWN = 'CL0512';

/**
 * `lint.packs.<name>: ~` on a branch that never inherited that pack. Declared as a
 * literal for the same reason as `VARIABLE_UNBIND_UNKNOWN` above — `src/lint/packs.js`
 * owns the code (loading band, beside `CL0117`), and `model/` may not import a module
 * that touches `fs`.
 */
const PACK_UNBIND_UNKNOWN = 'CL0118';

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
  const {
    rootPlaceholders = null, rootVariables = null, rootRoles = null, rootLint = null,
    onWarn = null,
  } = options;
  const result = {
    nodes: [],
    folderPath: [],
    // Seeded with the root table and merged key-wise down the chain, `~` deleting rather
    // than overriding with null (§6.4, Decision 1) — the same contract `placeholders`
    // already had. `protagonist` is not a separate field: it is `roles.protagonist`,
    // an ordinary entry in this table (§9.2), so callers read `result.roles.protagonist`.
    variables: Object.assign({}, rootVariables || {}),
    roles: Object.assign({}, rootRoles || {}),
    // True once any node in the chain — including the root — declares a `roles:` key, even
    // if every binding it declared is later unbound to nothing. Distinct from `roles` being
    // non-empty: a branch that unbinds its only inherited role is still role-aware territory
    // for CL0540's gating (`model/pronouns.js`'s `resolveRole`), which is what makes "declare
    // then fully unbind" behave like "declare a role and mistype its name" rather than like a
    // project that never mentioned roles at all.
    rolesDeclared: !!(rootRoles && Object.keys(rootRoles).length),
    components: {},
    render: {},
    placeholders: Object.assign({}, rootPlaceholders || {}),
    // `lint.packs` merges key-wise down the chain exactly as `roles` does (§8.2.2): a
    // branch overrides one pack or unbinds it with `wtg: ~`, because which packs validate
    // a branch's `notes:` depends on which mods that branch ships. `level` seeds `null` —
    // the project-level `lint.level` is the compile bus's job — and a branch node that
    // declares its own `lint.level` sets it here, last-wins, so a per-branch ceiling can
    // name the branch that raised the finding.
    lint: { packs: Object.assign({}, (rootLint && rootLint.packs) || {}), level: null },
    scripts: undefined,
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
      // `variables:` and `roles:` merge key-wise with `~` deleting (§6.4, Decision 1 —
      // Phase 8 retrofits variables to match placeholders' existing unbind contract).
      // A present-but-null key left as a plain assign renders the literal string "null"
      // (`util.js`'s `resolveVariables`); deleting is what makes that impossible.
      result.variables = mergeUnbindable(result.variables, node.variables, {
        code: VARIABLE_UNBIND_UNKNOWN, kind: 'variable', onWarn,
      });
      if (node.roles) result.rolesDeclared = true;
      result.roles = mergeUnbindable(result.roles, node.roles, {
        code: CODES.ROLE_UNBIND_UNKNOWN, kind: 'role', onWarn,
      });
      if (node.components) Object.assign(result.components, node.components);
      // `render:` merges key-wise like `components:`, so a branch can replace one
      // rendering default and inherit the rest — and `notesTemplate: ~` unbinds it,
      // which is how a branch without the mod that reads the marker turns it off.
      if (node.render) Object.assign(result.render, node.render);
      // Placeholders merge key-wise, and `~` deletes rather than overriding with null
      // (§6.4). Velvet Lattice does the same merge with `{**parent, **local}`, so the
      // emitted table matches what VL would compute from the same declarations — including
      // the detail that an overriding key keeps the *parent's* position rather than moving
      // to the end, which is what `delete`-then-set below would otherwise change.
      result.placeholders = mergePlaceholders(result.placeholders, node, onWarn);
      // `scripts:` is top-level rather than a component (§6.3) but merges the same way,
      // so a branch can swap one hook bundle and inherit the rest.
      if (node.scripts !== undefined) result.scripts = node.scripts;
      // `lint.packs` merges key-wise with `~` deleting (§8.2.2); a branch-declared
      // `lint.level` is the per-branch ceiling, taken last-wins down the chain.
      if (node.lint && typeof node.lint === 'object') {
        result.lint.packs = mergeUnbindable(result.lint.packs, node.lint.packs, {
          code: PACK_UNBIND_UNKNOWN, kind: 'convention pack', onWarn,
        });
        if (node.lint.level !== undefined && node.lint.level !== null) {
          result.lint.level = node.lint.level;
        }
      }
    }

    currentMap = node && node.branches ? node.branches : null;
  }

  return result;
}

/**
 * Fold one node's `placeholders:` into an inherited table (§6.4, §12.2).
 *
 * Returns a new table; the input is not mutated. Mutating in place would be enough for the
 * chain walk, which accumulates along one path, but the *tree* walk hands the same parent
 * table to every sibling — so a shared object would let one branch's declarations leak
 * into the next.
 *
 * The merge is key-wise and matches Velvet Lattice's `{**parent, **local}` exactly,
 * including that an overriding key keeps the parent's position rather than moving to the
 * end. `~` deletes, and unbinding something never inherited warns: a bare `heroName:` with
 * no question parses as null, so the most natural-looking way to declare a placeholder is
 * also the way to remove one.
 *
 * One rule, three callers — the chain walk, the emitter's tree walk, and the label and
 * opening walks that need the same table to check the text they write.
 */
function mergePlaceholders(table, node, onWarn = null) {
  const merged = Object.assign({}, table || {});
  const local = node && node.placeholders;
  if (!local || typeof local !== 'object') return merged;

  for (const [key, question] of Object.entries(local)) {
    if (question === null || question === undefined) {
      if (!(key in merged) && onWarn) {
        onWarn(
          CODES.PLACEHOLDER_UNBIND_UNKNOWN,
          `placeholder "${key}" is unbound with ~ but was never inherited here — `
          + 'nothing was removed. A bare "' + key + ':" with no question also parses '
          + 'as ~, which is usually the cause.',
        );
      }
      delete merged[key];
    } else {
      merged[key] = question;
    }
  }
  return merged;
}

/**
 * Fold one node's flat table into an inherited one, key-wise, `~` deleting rather than
 * setting null (§6.4). The generalized shape `mergePlaceholders` above hand-rolled first —
 * used for `roles:` and the `variables:` retrofit (Decision 1), which share the merge and
 * differ only in the code and the noun the warning names.
 */
function mergeUnbindable(table, local, { code, kind, onWarn = null }) {
  const merged = Object.assign({}, table || {});
  if (!local || typeof local !== 'object') return merged;

  for (const [key, value] of Object.entries(local)) {
    if (value === null || value === undefined) {
      if (!(key in merged) && onWarn) {
        onWarn(
          code,
          `${kind} "${key}" is unbound with ~ but was never inherited here — nothing was `
          + 'removed.',
        );
      }
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * The role names a node declares directly, minus unbinds — `roles:`'s counterpart to
 * `emit/placeholders.js`'s `localKeysOf`, for `CL0545`'s declared-but-unused check.
 */
function localRoleKeysOf(node) {
  const local = node && node.roles;
  if (!local || typeof local !== 'object') return [];
  return Object.keys(local).filter((k) => local[k] !== null && local[k] !== undefined);
}

/**
 * Visit every node of a config tree — **the project root included** — depth-first,
 * carrying state down.
 *
 * The counterpart to `walkBranchChain`, and a genuinely different operation: that one
 * looks up a known path and accumulates along it, this one enumerates. Enumeration needs
 * no case-insensitive matching because it visits every key and the key *is* the answer.
 *
 * `visit({ name, node, path, isLeaf, isRoot, state })` may return a new state for that
 * node's children; returning `undefined` passes the current state through unchanged. That
 * is what lets a caller merge variables down the tree without writing the recursion again.
 *
 * **The root is a node, not a flag** (Phase 11 Step 0, Decision 1). The walker used to
 * take a `branches:` map, which left the project root inexpressible — its own
 * `components:`, `placeholders:`, `roles:` and `variables:` live on the config object,
 * not inside any `branches:` — so every caller handled the root with its own hand-rolled
 * rung, and one of them got it wrong. Now the root is always the first visit,
 * `{ name: null, path: [], isRoot: true }`, the way `buildTree(rootDir)` on the output
 * side takes a root with no toggle. A config object is node-shaped for this walk, so
 * callers pass it directly.
 *
 * Each visitor keeps one `isRoot` conditional where the root genuinely differs — the
 * output path (a branch writes to `<parent>/Branches/<name>`, the root to the output
 * root) or a root-only rule, like `title:` meaning the scenario title rather than a
 * choice label. That asymmetry belongs to the callers; the model layer has no knowledge
 * of output directories (§3.3).
 */
function walkBranchTree(rootNode, visit, state = null) {
  if (!rootNode || typeof rootNode !== 'object') return;

  const isRootLeaf = isLeafNode(rootNode);
  const rootNext = visit({
    name: null, node: rootNode, path: [], isLeaf: isRootLeaf, isRoot: true, state,
  });
  if (!isRootLeaf) {
    walkBranchNodes(rootNode.branches, visit, rootNext === undefined ? state : rootNext, []);
  }
}

/** The branch enumeration the root visit in `walkBranchTree` recurses into. */
function walkBranchNodes(branches, visit, state, path) {
  if (!branches || typeof branches !== 'object') return;
  for (const [name, node] of Object.entries(branches)) {
    const childPath = [...path, name];
    const isLeaf = isLeafNode(node);
    const next = visit({ name, node, path: childPath, isLeaf, isRoot: false, state });
    if (!isLeaf) walkBranchNodes(node.branches, visit, next === undefined ? state : next, childPath);
  }
}

/** A node with no `branches:` (or an empty one) is a leaf — one rule at every level. */
function isLeafNode(node) {
  const sub = node && node.branches;
  return !sub || typeof sub !== 'object' || Object.keys(sub).length === 0;
}

module.exports = {
  resolveBranchSpec, enumerateLeaves,
  walkBranchChain, walkBranchTree, mergePlaceholders, mergeUnbindable, localRoleKeysOf,
};
