'use strict';

/**
 * The parts of a preview that describe the project around its items: the branch tree, each
 * leaf's variables and roles, and the libraries. See "Preview API" in the dev guide.
 */

const crypto = require('crypto');
const { Diagnostics } = require('./diag');
const { originLocation } = require('./origin');
const { resolveItemRef } = require('./model/refs');
const { findKey, isPlainObject, resolveVariables } = require('./util');

function isLeaf(node) {
  const sub = node && node.branches;
  return !isPlainObject(sub) || Object.keys(sub).length === 0;
}

function buildBranchTree(branches, prefix = []) {
  if (!isPlainObject(branches)) return [];
  return Object.entries(branches).map(([name, node]) => {
    const branchPath = [...prefix, name];
    return {
      name,
      branchPath,
      leaf: isLeaf(node),
      children: isLeaf(node) ? [] : buildBranchTree(node.branches, branchPath),
    };
  });
}

// Every binding of one kind (`variables` or `roles`) on the way from the root to a leaf, in
// the order they apply. Names fold case, as the merge that resolves them does.
function bindingRows(config, branchPath, kind, describe) {
  const rows = new Map();
  const visit = (local, nodeBranch, nodePath) => {
    if (!isPlainObject(local)) return;
    for (const [key, value] of Object.entries(local)) {
      const lower = key.toLowerCase();
      const removed = value === null || value === undefined;
      if (!rows.has(lower)) {
        // Unbinding a name that was never bound removes nothing; the compiler warns about it.
        if (removed) continue;
        rows.set(lower, { name: key, bound: false, value: null, layers: [] });
      }
      const row = rows.get(lower);
      row.layers.push({
        branchPath: nodeBranch,
        removed,
        before: row.bound ? row.value : null,
        after: removed ? null : value,
        at: describe(originLocation(config, [...nodePath, kind, key])),
      });
      row.bound = !removed;
      row.value = removed ? null : value;
    }
  };

  visit(config[kind], [], []);
  let map = config.branches;
  const walked = [];
  const nodePath = [];
  for (const segment of branchPath) {
    const actual = isPlainObject(map) ? findKey(map, String(segment)) : null;
    if (!actual) break;
    const node = map[actual];
    walked.push(actual);
    nodePath.push('branches', actual);
    if (isPlainObject(node)) visit(node[kind], [...walked], [...nodePath]);
    map = node && node.branches;
  }
  return [...rows.values()];
}

function buildContext(config, branchPath, leafVariables, leafRoles, describe) {
  const variables = bindingRows(config, branchPath, 'variables', describe);
  const authored = new Set(variables.map((row) => row.name.toLowerCase()));
  // The compiler adds a variable per library, holding the path that library resolved to.
  for (const name of Object.keys(leafVariables || {})) {
    if (!authored.has(name.toLowerCase())) {
      variables.push({ name, bound: true, value: leafVariables[name], layers: [], derived: true });
    }
  }
  const quiet = { diagnostics: new Diagnostics() };
  for (const row of variables) {
    row.derived = !!row.derived;
    row.resolved = row.bound && typeof row.value === 'string'
      ? resolveVariables(row.value, leafVariables || {}, quiet) : row.value;
  }

  const roles = bindingRows(config, branchPath, 'roles', describe);
  for (const row of roles) {
    const key = isPlainObject(leafRoles) ? findKey(leafRoles, row.name) : null;
    row.resolved = row.bound && key !== null ? leafRoles[key] : null;
  }
  return { variables, roles };
}

function digestOf(item) {
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (!isPlainObject(value)) return value === undefined ? null : value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (!key.startsWith('_')) out[key] = strip(value[key]);
    }
    return out;
  };
  return crypto.createHash('sha1').update(JSON.stringify(strip(item))).digest('hex').slice(0, 16);
}

function nameOf(item) {
  if (typeof item.name === 'string') return item.name;
  if (isPlainObject(item.name)) return item.name.full || item.name.display || null;
  return null;
}

function buildLibraries(run, fileIndex) {
  const { config, canonRegistry, registry, allItemDefs } = run;
  const identity = (file, id) => `${String(file)}\u0000${String(id).toLowerCase()}`;
  const used = new Set();
  for (const def of allItemDefs) {
    if (def.import) {
      const found = resolveItemRef(registry, def.import).item;
      if (found && found._canonSource) used.add(identity(found._source, found.id));
    } else if (def._include_key) {
      used.add(identity(def._source, def.id || def.name));
    }
  }

  const byLibrary = new Map();
  for (const item of canonRegistry.qualified.values()) {
    const library = String(item._canonSource);
    if (!byLibrary.has(library)) byLibrary.set(library, new Map());
    const files = byLibrary.get(library);
    if (!files.has(item._source)) files.set(item._source, []);
    const at = originLocation(item, []);
    files.get(item._source).push({
      id: item.id,
      name: nameOf(item),
      line: typeof at.line === 'number' ? at.line : null,
      col: typeof at.col === 'number' ? at.col : null,
      imported: used.has(identity(item._source, item.id)),
      digest: digestOf(item),
    });
  }

  const sources = config._resolvedLibrarySource instanceof Map ? config._resolvedLibrarySource : new Map();
  const active = config._resolvedLibrary instanceof Map ? config._resolvedLibrary : new Map();
  return [...active].map(([name, dir]) => {
    const files = byLibrary.get(String(name)) || new Map();
    return {
      name,
      path: dir,
      sourcePath: sources.get(name) || dir,
      frozen: sources.has(name) && sources.get(name) !== dir,
      files: [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, items]) => ({
        file: fileIndex(file),
        items: items.sort((a, b) => (a.line || 0) - (b.line || 0)),
      })),
    };
  });
}

module.exports = { buildBranchTree, buildContext, buildLibraries };
