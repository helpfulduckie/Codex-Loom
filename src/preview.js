'use strict';

/**
 * A whole compile run in memory, returned as plain data. See "Preview API" in the dev guide
 * for the result layout and the limits.
 */

const path = require('path');
const crypto = require('crypto');
const { compile } = require('./compile');
const { Diagnostics } = require('./diag');
const { nearestOrigin } = require('./origin');
const { ITEM_TOP_LEVEL_FIELDS, isPlainObject, findKey, pathId, pathStartsWith } = require('./util');
const { buildBranchOutputDir } = require('./outputPaths');
const { memorySource, resolveAt } = require('./compiledTree');
const { buildBranchTree, buildContext, buildLibraries, buildInputRoots } = require('./previewRecords');
const { usageOf, serializeUsage: describeUses } = require('./usage');

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

function isPrefix(prefix, parts) {
  return pathStartsWith(parts, prefix);
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

// Where a value was authored, as a field's `origin` is written.
function describeOrigin(record, libraries, fileIndex) {
  if (!record) return null;
  return {
    file: fileIndex(record.file),
    line: typeof record.line === 'number' ? record.line : null,
    col: typeof record.col === 'number' ? record.col : null,
    authoredPath: record.path || null,
    library: libraryOf(record.file, libraries),
  };
}

// A position with the library that holds it, for a record that is not a field.
function describeLocation(at, libraries, fileIndex) {
  if (!at || !at.file) return null;
  return {
    file: fileIndex(at.file),
    line: typeof at.line === 'number' ? at.line : null,
    col: typeof at.col === 'number' ? at.col : null,
    library: libraryOf(at.file, libraries),
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
      beforeAbsent: !!entry.beforeAbsent,
      beforeOrigin: describeOrigin(entry.beforeOrigin, libraries, fileIndex),
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
      origin: describeOrigin(record, libraries, fileIndex),
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

const relativeTo = (root, file) => path.relative(root, file).replace(/\\/g, '/');

// What a leaf reads is whatever the compiled tree would give it, so the captured output is
// resolved by the same rule as a tree on disk. One resolution is kept per leaf, since every
// component and card of the leaf reads from it.
const resolutions = new WeakMap();

function resolveLeaf(leaf, run) {
  if (!resolutions.has(run)) resolutions.set(run, { source: memorySource(run.captured), byLeaf: new Map() });
  const cache = resolutions.get(run);
  if (!cache.byLeaf.has(leaf)) {
    const leafDir = path.resolve(buildBranchOutputDir(run.config._resolvedOutput, leaf.folderPath));
    cache.byLeaf.set(leaf, resolveAt(leafDir, cache.source));
  }
  return cache.byLeaf.get(leaf);
}

// A leaf's component is the nearest copy on its path, so the owner is the deepest node at
// or above the leaf that the compile wrote the file to. A file outside Components/ is read
// from the leaf's own folder alone.
function componentOutput(detail, leaf, run) {
  const root = run.config._resolvedOutput;
  const { descriptor } = detail;
  const { chain } = resolveLeaf(leaf, run);
  let depth = -1;
  if (descriptor.dir === 'Components') {
    const name = path.basename(descriptor.file, '.md');
    for (let i = chain.length - 1; i >= 0 && depth < 0; i -= 1) {
      if (chain[i].own.components[name] !== undefined) depth = i;
    }
  } else if (descriptor.dir === undefined) {
    const last = chain.length - 1;
    if (run.captured.has(path.resolve(chain[last].dir, descriptor.file))) depth = last;
  }
  if (depth < 0) return null;
  const dir = chain[depth].dir;
  const file = path.join(descriptor.dir ? path.join(dir, descriptor.dir) : dir, descriptor.file);
  return { path: relativeTo(root, file), branchPath: leaf.branchPath.slice(0, depth) };
}

// A section setting's layer has the shape of an item field's, so one display reads both.
function sectionLayer(entry, describe) {
  const at = describe(entry.origin);
  const before = describe(entry.beforeOrigin);
  return {
    kind: entry.layer.kind,
    name: entry.layer.name === undefined ? null : entry.layer.name,
    library: at ? at.library : null,
    op: plain(entry.op),
    file: at ? at.file : null,
    line: at ? at.line : null,
    col: at ? at.col : null,
    before: plain(entry.before),
    beforeAbsent: !!entry.beforeAbsent,
    beforeOrigin: before ? { ...before, authoredPath: [...entry.path] } : null,
    after: entry.deleted ? null : plain(entry.after),
    deleted: !!entry.deleted,
  };
}

function describeSectionRecords(sections, describe, table) {
  if (!sections) return null;
  return sections.map((section) => table.indexOf({
    ...section,
    uses: describeUses(section.uses),
    source: describe(section.source),
    settings: section.settings.map((setting) => ({
      path: setting.path,
      value: plain(setting.value),
      origin: describe(setting.origin),
      layers: setting.layers.map((entry) => sectionLayer(entry, describe)),
    })),
  }));
}

function buildComponents(components, details, fileIndex, { leaf, run, describe, tables }) {
  const out = {};
  for (const [key, segments] of Object.entries(components || {})) {
    const list = (segments || []).map((s) => ({ key: s.key, text: s.text }));
    const detail = details.get(key);
    const at = detail && detail.source ? detail.source : null;
    const output = detail ? componentOutput(detail, leaf, run) : null;
    out[key] = {
      selectedAt: detail ? describe(detail.selectedAt) : null,
      selectedOn: detail ? [...detail.selectedOn] : [],
      output: output ? tables.outputs.indexOf(output) : null,
      sections: detail ? describeSectionRecords(detail.sections, describe, tables.sections) : null,
      uses: detail ? describeUses(detail.uses) : null,
      pathVariables: detail ? [...detail.pathVariables].sort((a, b) => a.localeCompare(b)) : [],
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
  const describe = (at) => describeLocation(at, libraries, fileIndex);
  return run.deferredCardLeaves.map((leaf) => {
    const label = leaf.branchPath.length > 0 ? leaf.branchPath.join('/') : '(root)';
    const data = dataByLabel.get(label);
    const cards = buildCards(leaf.grouped, tables.cards);
    const context = plain(buildContext(
      run.config, leaf.branchPath, leaf.variables, data ? data.roles : null, describe,
    ));
    return {
      label,
      branchPath: [...leaf.branchPath],
      folderPath: plain(leaf.folderPath),
      roles: plain(data ? data.roles : {}),
      context: {
        variables: context.variables.map((row) => tables.bindings.indexOf(row)),
        roles: context.roles.map((row) => tables.bindings.indexOf(row)),
      },
      items: leaf.resolvedItems.map((item) => tables.items.indexOf({
        id: item.id === undefined ? null : item.id,
        source: fileIndex(item._source),
        ...describeDefinition(item, describe),
        uses: describeUses(usageOf(item)),
        fields: buildFields(item, libraries, fileIndex),
        removedFields: buildRemovedFields(item, libraries, fileIndex),
      })),
      excluded: (leaf.excludedItems || []).map((entry) => ({
        id: excludedId(entry.itemDef),
        source: fileIndex(entry.itemDef._source),
        reason: entry.reason,
        variant: entry.variant || null,
        at: describe(entry.loc),
      })),
      cards,
      cardFiles: cards.map(
        (index) => tables.outputs.indexOf(cardFile(tables.cards.values[index], leaf, run)),
      ),
      components: buildComponents(
        data && data.components, detailsByLabel.get(label) || new Map(), fileIndex,
        { leaf, run, describe, tables },
      ),
      slots: plain(slotsByLabel.get(label) || null),
    };
  });
}

// Where an item's base definition is authored, and the project entry that imports it.
function describeDefinition(item, describe) {
  const trace = item._definition;
  if (!trace) return { definition: null, importedAt: null, included: false };
  const definition = describe(trace.definedAt);
  if (definition && trace.library) definition.library = trace.library;
  return { definition, importedAt: describe(trace.importedAt), included: trace.included };
}

function excludedId(itemDef) {
  if (typeof itemDef.id === 'string' && itemDef.id) return itemDef.id;
  if (typeof itemDef.import === 'string') return itemDef.import.split(':').pop();
  return typeof itemDef.name === 'string' ? itemDef.name : null;
}

// The file a leaf reads a card from: the nearest ancestor copy of the name. A card whose
// name another type also uses on the leaf (CL0622) is looked up by type as well, since the
// merge by name keeps only one of the two.
function cardFile(card, leaf, run) {
  const root = run.config._resolvedOutput;
  const { resolved, chain } = resolveLeaf(leaf, run);
  let found = resolved.cards.find((c) => c.title === card.name && c.type === card.type);
  if (!found) {
    for (let i = chain.length - 1; i >= 0 && !found; i -= 1) {
      found = chain[i].own.cards.find((c) => c.title === card.name && c.type === card.type);
    }
  }
  if (!found) {
    // A single-leaf compile places nothing by name, so the card is in the leaf's own folder.
    const dir = buildBranchOutputDir(root, leaf.folderPath);
    return {
      path: relativeTo(root, path.join(dir, 'Story Cards', card.type, `${card.type}.md`)),
      branchPath: [...leaf.branchPath],
    };
  }
  const depth = chain.findIndex((c) => c.own.cards.includes(found));
  return { path: relativeTo(root, found.file), branchPath: leaf.branchPath.slice(0, depth) };
}

function buildFiles(captured, outputDir) {
  return [...captured].map(([file, content]) => ({
    path: path.relative(outputDir, file).replace(/\\/g, '/'),
    content,
  })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(({ path: p, content }) => (
    typeof content === 'string'
      ? { path: p, content }
      : {
        path: p, binary: true, bytes: content.length,
        digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
      }
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
      project: null,
      sourceFiles: [], items: [], cards: [], sections: [], bindings: [], outputs: [],
      branches: [], libraries: [], leaves: [], files: [],
    };
  }

  const libraries = run.config._resolvedLibrary instanceof Map
    ? [...run.config._resolvedLibrary] : [];
  // Items and cards are equal when they serialize the same; a file is equal by its path.
  const tables = {
    sourceFiles: createTable(),
    items: createTable(JSON.stringify),
    cards: createTable(JSON.stringify),
    sections: createTable(JSON.stringify),
    bindings: createTable(JSON.stringify),
    outputs: createTable(JSON.stringify),
  };
  const leaves = buildLeaves(run, libraries, tables);
  const libraryRecords = buildLibraries(run, (file) => tables.sourceFiles.indexOf(file));
  return {
    status: 'ok',
    droppedKeys: run.droppedKeys,
    diagnostics: describeDiagnostics(diagnostics),
    project: {
      config: path.resolve(configPath),
      title: run.config.title,
      base: run.config._base,
      items: [...run.config._resolvedItems],
      templates: [...run.config._resolvedTemplates],
      inputRoots: buildInputRoots(run.config),
      output: run.config._resolvedOutput,
      reports: run.config._resolvedReports || null,
      snapshot: run.config._resolvedSnapshot || null,
    },
    sourceFiles: tables.sourceFiles.values,
    items: tables.items.values,
    cards: tables.cards.values,
    sections: tables.sections.values,
    bindings: tables.bindings.values,
    outputs: tables.outputs.values,
    branches: buildBranchTree(run.config.branches),
    libraries: libraryRecords,
    leaves,
    files: buildFiles(run.captured, run.config._resolvedOutput),
  };
}

module.exports = { preview };
