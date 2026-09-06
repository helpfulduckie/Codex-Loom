'use strict';


const { deepClone, findKey } = require('../util');
const { CODES } = require('../diag');

function resolveBranchSpec(spec, branchPath, onWarn = null) {
  if (!spec || typeof spec !== 'object') return [];
  if (onWarn) warnWildcardUnbind(spec, onWarn);

  const variantNames = [];
  let activeSpecs = [spec];

  for (const branch of branchPath) {
    const nextSpecs = [];
    const branchLower = branch.toLowerCase();

    for (const currentSpec of activeSpecs) {
      if (!currentSpec || typeof currentSpec !== 'object') continue;

      const exactKey = Object.keys(currentSpec).find(k => k !== '*' && k !== '_' && k.toLowerCase() === branchLower);
      if (exactKey !== undefined) {
        const exactVal = currentSpec[exactKey];
        if (exactVal === null || exactVal === undefined) {
          return null;
        }
      }

      if ('*' in currentSpec && currentSpec['*'] !== null) {
        const wildcardVal = currentSpec['*'];
        variantNames.push(...extractApplyList(wildcardVal));
        const wildcardSub = extractSubBranches(wildcardVal);
        if (wildcardSub) nextSpecs.push(wildcardSub);
      }

      if (exactKey !== undefined) {
        const exactVal = currentSpec[exactKey];
        variantNames.push(...extractApplyList(exactVal));
        const exactSub = extractSubBranches(exactVal);
        if (exactSub) nextSpecs.push(exactSub);
      }

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

const WARNED_WILDCARD_UNBIND = new WeakSet();

function hasWildcardUnbind(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  for (const [key, val] of Object.entries(map)) {
    if (key === '*' && (val === null || val === undefined)) return true;
    if (val && typeof val === 'object' && !Array.isArray(val) && hasWildcardUnbind(val.branches)) {
      return true;
    }
  }
  return false;
}

function warnWildcardUnbind(spec, onWarn) {
  if (WARNED_WILDCARD_UNBIND.has(spec) || !hasWildcardUnbind(spec)) return;
  WARNED_WILDCARD_UNBIND.add(spec);
  onWarn(CODES.BRANCH_WILDCARD_UNBIND,
    "branch spec maps '*' to ~ (a null wildcard). Read literally that excludes the item "
    + 'from every branch, which is never what anyone means, so the walker skips it and the '
    + 'item stays included everywhere — the opposite of how it reads. Use \'_: ~\' as the '
    + 'catch-all to drop the branches you did not name.');
}

function extractApplyList(val) {
  if (val === null || val === undefined) return [];
  if (typeof val === 'string') return val ? [val] : [];
  if (Array.isArray(val)) return val.filter(v => typeof v === 'string' && v);
  if (typeof val === 'object') {
    const apply = val.apply;
    if (apply === undefined) return [];
    if (typeof apply === 'string') return apply ? [apply] : [];
    if (Array.isArray(apply)) return apply.filter(v => typeof v === 'string' && v);
    return [];
  }
  return [];
}

function extractSubBranches(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object' && !Array.isArray(val) && val.branches) {
    return val.branches;
  }
  return null;
}

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

function walkBranchChain(branches, branchPath, options = {}) {
  const {
    rootPlaceholders = null, rootVariables = null, rootRoles = null, rootLint = null,
    onWarn = null,
  } = options;
  const result = {
    nodes: [],
    folderPath: [],
    variables: Object.assign({}, rootVariables || {}),
    roles: Object.assign({}, rootRoles || {}),
    rolesDeclared: !!(rootRoles && Object.keys(rootRoles).length),
    components: {},
    render: {},
    placeholders: Object.assign({}, rootPlaceholders || {}),
    lint: { packs: Object.assign({}, (rootLint && rootLint.packs) || {}), level: null },
    node: null,
  };

  let currentMap = branches;
  for (const segment of (branchPath || [])) {
    const actualKey = currentMap && typeof currentMap === 'object'
      ? findKey(currentMap, String(segment))
      : null;

    if (!actualKey) {
      result.folderPath.push(String(segment));
      currentMap = null;
      continue;
    }

    const node = currentMap[actualKey];
    result.folderPath.push(actualKey);
    result.nodes.push(node);
    result.node = node || null;

    if (node && typeof node === 'object') {
      result.variables = mergeUnbindable(result.variables, node.variables, {
        code: CODES.VARIABLE_UNBIND_UNKNOWN, kind: 'variable', onWarn,
      });
      if (node.roles) result.rolesDeclared = true;
      result.roles = mergeUnbindable(result.roles, node.roles, {
        code: CODES.ROLE_UNBIND_UNKNOWN, kind: 'role', onWarn,
      });
      if (node.components) Object.assign(result.components, node.components);
      if (node.render) Object.assign(result.render, node.render);
      result.placeholders = mergePlaceholders(result.placeholders, node, onWarn);
      if (node.scripts !== undefined) result.scripts = node.scripts;
      if (node.lint && typeof node.lint === 'object') {
        result.lint.packs = mergeUnbindable(result.lint.packs, node.lint.packs, {
          code: CODES.PACK_UNBIND_UNKNOWN, kind: 'convention pack', onWarn,
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

function localRoleKeysOf(node) {
  const local = node && node.roles;
  if (!local || typeof local !== 'object') return [];
  return Object.keys(local).filter((k) => local[k] !== null && local[k] !== undefined);
}

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

function walkBranchNodes(branches, visit, state, path) {
  if (!branches || typeof branches !== 'object') return;
  for (const [name, node] of Object.entries(branches)) {
    const childPath = [...path, name];
    const isLeaf = isLeafNode(node);
    const next = visit({ name, node, path: childPath, isLeaf, isRoot: false, state });
    if (!isLeaf) walkBranchNodes(node.branches, visit, next === undefined ? state : next, childPath);
  }
}

function isLeafNode(node) {
  const sub = node && node.branches;
  return !sub || typeof sub !== 'object' || Object.keys(sub).length === 0;
}

function branchTreeDeclares(branches, predicate) {
  if (!branches || typeof branches !== 'object') return false;
  for (const node of Object.values(branches)) {
    if (!node || typeof node !== 'object') continue;
    if (predicate(node)) return true;
    if (branchTreeDeclares(node.branches, predicate)) return true;
  }
  return false;
}

module.exports = {
  resolveBranchSpec, enumerateLeaves,
  walkBranchChain, walkBranchTree, mergePlaceholders, mergeUnbindable, localRoleKeysOf,
  branchTreeDeclares,
};
