'use strict';

/**
 * A whole compile run in memory, returned as plain data. See "Preview API" in the dev guide
 * for the result layout and the limits.
 */

const path = require('path');
const { compile } = require('./compile');
const { Diagnostics } = require('./diag');
const { nearestOrigin } = require('./origin');
const { ITEM_TOP_LEVEL_FIELDS, isPlainObject, findKey } = require('./util');

const FIELD_ROOTS = [...ITEM_TOP_LEVEL_FIELDS, 'body'];

// JSON has no undefined, and an array holding one would come back from a round trip as null.
function plain(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Set) return [...value].map(plain);
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([k, v]) => [String(k), plain(v)]));
  }
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (inner !== undefined) out[key] = plain(inner);
    }
    return out;
  }
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  return value;
}

const normalizePath = (p) => String(p).replace(/\\/g, '/').toLowerCase();

// The library whose directory holds `file`; the longest match wins when libraries nest.
function libraryOf(file, libraries) {
  if (!file) return null;
  const target = normalizePath(file);
  let best = null;
  let bestLength = -1;
  for (const [name, dir] of libraries) {
    const root = normalizePath(dir).replace(/\/+$/, '');
    if ((target === root || target.startsWith(`${root}/`)) && root.length > bestLength) {
      best = name;
      bestLength = root.length;
    }
  }
  return best;
}

// Field keys match without regard to case, so a path is identified the same way: a field
// deleted as `A` and set again as `a` is one field with one history.
const pathId = (parts) => JSON.stringify(parts.map((part) => String(part).toLowerCase()));

function isPrefix(prefix, parts) {
  return prefix.length <= parts.length
    && pathId(prefix) === pathId(parts.slice(0, prefix.length));
}

function leafPaths(value, prefix, out) {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const key of Object.keys(value)) {
      if (key.startsWith('_') || value[key] === undefined) continue;
      leafPaths(value[key], [...prefix, key], out);
    }
  } else if (value !== undefined) {
    out.push({ path: prefix, value });
  }
}

// A value kept once and referred to by position. Most items resolve the same on most
// leaves and every field names its source file, so repeating either in full makes the
// result grow with items times leaves.
function createTable(keyOf = (value) => value) {
  const index = new Map();
  const values = [];
  return {
    values,
    indexOf(value) {
      const key = keyOf(value);
      if (!index.has(key)) {
        index.set(key, values.length);
        values.push(value);
      }
      return index.get(key);
    },
  };
}

function layersAt(item, fieldPath, libraries, fileIndex) {
  const layers = Array.isArray(item._layers) ? item._layers : [];
  return layers.filter((entry) => isPrefix(entry.path || [], fieldPath)).map((entry) => {
    const at = entry.origin || null;
    return {
      kind: entry.layer.kind,
      name: entry.layer.name === undefined ? null : entry.layer.name,
      library: entry.layer.library || libraryOf(at && at.file, libraries),
      op: plain(entry.op),
      file: fileIndex(at && at.file),
      line: at && typeof at.line === 'number' ? at.line : null,
      col: at && typeof at.col === 'number' ? at.col : null,
      before: plain(entry.before),
      after: entry.deleted ? null : plain(entry.after),
      deleted: !!entry.deleted,
    };
  });
}

function buildFields(item, libraries, fileIndex) {
  const found = [];
  for (const key of FIELD_ROOTS) {
    if (key.startsWith('_') || item[key] === undefined) continue;
    leafPaths(item[key], [key], found);
  }
  return found.map(({ path: fieldPath, value }) => {
    const record = nearestOrigin(item, fieldPath);
    return {
      path: fieldPath,
      value: plain(value),
      origin: record ? {
        file: fileIndex(record.file),
        line: typeof record.line === 'number' ? record.line : null,
        col: typeof record.col === 'number' ? record.col : null,
        authoredPath: record.path || null,
        library: libraryOf(record.file, libraries),
      } : null,
      layers: layersAt(item, fieldPath, libraries, fileIndex),
    };
  });
}

function presentAt(item, fieldPath) {
  let node = item;
  for (const part of fieldPath) {
    const actual = findKey(node, String(part));
    if (actual === null || node[actual] === undefined) return false;
    node = node[actual];
  }
  return true;
}

// A deleted field has no entry in `fields`, so the layer that removed it is reported here.
function buildRemovedFields(item, libraries, fileIndex) {
  const layers = Array.isArray(item._layers) ? item._layers : [];
  const seen = new Set();
  const removed = [];
  for (const entry of layers) {
    if (!entry.deleted) continue;
    const fieldPath = entry.path || [];
    const key = pathId(fieldPath);
    if (seen.has(key)) continue;
    seen.add(key);
    if (presentAt(item, fieldPath)) continue;
    removed.push({ path: [...fieldPath], layers: layersAt(item, fieldPath, libraries, fileIndex) });
  }
  return removed;
}

function buildCards(grouped, cardTable) {
  const cards = [];
  for (const type of [...grouped.keys()].sort((a, b) => a.localeCompare(b))) {
    const entries = grouped.get(type).slice()
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.rendered.localeCompare(b.rendered));
    for (const entry of entries) {
      cards.push(cardTable.indexOf({
        type, name: entry.name, rendered: entry.rendered, itemId: entry.id || null,
      }));
    }
  }
  return cards;
}

function buildComponents(components, details, fileIndex) {
  const out = {};
  for (const [key, segments] of Object.entries(components || {})) {
    const list = (segments || []).map((s) => ({ key: s.key, text: s.text }));
    const detail = details.get(key);
    const at = detail && detail.source ? detail.source : null;
    out[key] = {
      text: list.map((s) => s.text).join('\n\n'),
      segments: list,
      source: at ? {
        file: fileIndex(at.file),
        line: typeof at.line === 'number' ? at.line : null,
        col: typeof at.col === 'number' ? at.col : null,
      } : null,
      inline: detail ? detail.inline : false,
      metadata: detail ? plain(detail.metadata) : null,
    };
  }
  return out;
}

function buildLeaves(run, libraries, tables) {
  const dataByLabel = new Map(run.leafData.map((d) => [d.label, d]));
  const slotsByLabel = new Map(run.inventoryData.map((d) => [d.label, d]));
  const detailsByLabel = new Map();
  for (const detail of run.componentDetails) {
    if (!detailsByLabel.has(detail.label)) detailsByLabel.set(detail.label, new Map());
    detailsByLabel.get(detail.label).set(detail.key, detail);
  }
  const fileIndex = (file) => (file ? tables.sourceFiles.indexOf(file) : null);
  return run.deferredCardLeaves.map((leaf) => {
    const label = leaf.branchPath.length > 0 ? leaf.branchPath.join('/') : '(root)';
    const data = dataByLabel.get(label);
    return {
      label,
      branchPath: [...leaf.branchPath],
      folderPath: plain(leaf.folderPath),
      roles: plain(data ? data.roles : {}),
      items: leaf.resolvedItems.map((item) => tables.items.indexOf({
        id: item.id === undefined ? null : item.id,
        source: fileIndex(item._source),
        fields: buildFields(item, libraries, fileIndex),
        removedFields: buildRemovedFields(item, libraries, fileIndex),
      })),
      cards: buildCards(leaf.grouped, tables.cards),
      components: buildComponents(
        data && data.components, detailsByLabel.get(label) || new Map(), fileIndex,
      ),
      slots: plain(slotsByLabel.get(label) || null),
    };
  });
}

function buildFiles(captured, outputDir) {
  return [...captured].map(([file, content]) => ({
    path: path.relative(outputDir, file).replace(/\\/g, '/'),
    content,
  })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(({ path: p, content }) => (
    typeof content === 'string'
      ? { path: p, content }
      : { path: p, binary: true, bytes: content.length }
  ));
}

function describeDiagnostics(bus) {
  return bus.all.map((d) => ({
    code: d.code,
    severity: d.severity,
    message: d.message,
    hint: d.hint,
    file: d.file,
    line: d.line,
    col: d.col,
    branch: d.branch,
    branches: d.branches ? [...d.branches] : null,
    allBranches: d.allBranches,
    related: d.related.map(({ label, file, line, col }) => ({ label, file, line, col })),
  }));
}

function preview(configPath, options = {}) {
  const diagnostics = new Diagnostics();
  const tolerant = options.tolerant === undefined ? true : options.tolerant;
  let run;
  try {
    run = compile(configPath, {
      capture: true,
      sources: options.sources,
      live: options.live,
      tolerant,
      lintLevel: options.lintLevel,
      diagnostics,
    });
  } catch (err) {
    const coded = err && typeof err.code === 'string' && err.code.startsWith('CL');
    if (!(err && err.loadAborted) && !coded) throw err;
    if (coded && !diagnostics.all.some((d) => d.code === err.code)) {
      diagnostics.error(err.code, err.message, {});
    }
    return {
      status: 'blocked', droppedKeys: 0, diagnostics: describeDiagnostics(diagnostics),
      sourceFiles: [], items: [], cards: [], leaves: [], files: [],
    };
  }

  const libraries = run.config._resolvedLibrary instanceof Map
    ? [...run.config._resolvedLibrary] : [];
  // Items and cards are equal when they serialize the same; a file is equal by its path.
  const tables = {
    sourceFiles: createTable(),
    items: createTable(JSON.stringify),
    cards: createTable(JSON.stringify),
  };
  const leaves = buildLeaves(run, libraries, tables);
  return {
    status: 'ok',
    droppedKeys: run.droppedKeys,
    diagnostics: describeDiagnostics(diagnostics),
    sourceFiles: tables.sourceFiles.values,
    items: tables.items.values,
    cards: tables.cards.values,
    leaves,
    files: buildFiles(run.captured, run.config._resolvedOutput),
  };
}

module.exports = { preview };
