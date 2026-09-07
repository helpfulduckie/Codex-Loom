'use strict';


const fs = require('fs');
const path = require('path');

const { findFiles, deepClone, resolveVariables, VAR_ALIASES, YAML_SUFFIXES, RESERVED_LIBRARY_BASENAMES } = require('../util');
const { loadYamlDocument, YamlLoadError } = require('./yaml');
const { validate } = require('../schema');
const { ITEM_SCHEMA } = require('./schema');
const { CODES } = require('../diag');
const { splitRef } = require('../model/refs');
const { collectVariantDeltas, parseVariantsList } = require('../model/item');

class ItemRegistry extends Map {
  constructor(entries) {
    super(entries || []);
    this.qualified = new Map();
    this.ambiguous = new Map();
    this.sources = new Set();
  }

  get itemCount() {
    let extra = 0;
    for (const rivals of this.ambiguous.values()) extra += rivals.length;
    return this.size + extra;
  }
}

function normalizeItemVarField(entry, onWarn) {
  const aliasKeys = Object.keys(entry).filter((k) => VAR_ALIASES.has(k.toLowerCase()));
  if (aliasKeys.length === 0) return entry;

  if (aliasKeys.length > 1 && onWarn) {
    const id = entry.id || (typeof entry.name === 'string' ? entry.name : '(unknown)');
    onWarn(
      CODES.MULTIPLE_VAR_ALIASES,
      `Item "${id}" has multiple variable-block aliases (${aliasKeys.map((k) => `"${k}"`).join(', ')}). `
      + 'Merging — subfield conflicts resolve last-writer-wins.'
    );
  }

  const merged = {};
  for (const key of aliasKeys) {
    const value = entry[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(merged, deepClone(value));
    else Object.assign(merged, deepClone(value) || {});
  }

  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (VAR_ALIASES.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  out.v = merged;
  return out;
}

function loadItemsFromDir(dirs, options = {}) {
  const { diagnostics } = options;
  const dirList = Array.isArray(dirs) ? dirs : [dirs];
  const items = [];

  for (const dir of dirList) {
    for (const file of findFiles(dir, YAML_SUFFIXES)) {
      if (RESERVED_LIBRARY_BASENAMES.includes(path.basename(file).toLowerCase())) continue;

      let data; let sourceMap;
      try {
        ({ value: data, sourceMap } = loadYamlDocument(file));
      } catch (err) {
        if (!(err instanceof YamlLoadError)) throw err;
        diagnostics.error(err.code, err.message, { file });
        continue;
      }

      const warn = (code, message, at) => {
        diagnostics.warn(code, message, at || { file });
      };

      if (data === null || data === undefined) {
        warn(CODES.YAML_EMPTY_FILE, `Empty file skipped: ${file}; add YAML content or remove the file.`);
        continue;
      }

      const entries = Array.isArray(data) ? data : [data];
      entries.forEach((entry, index) => {
        if (entry === null || entry === undefined) {
          warn(CODES.YAML_NULL_DOCUMENT, `Null document in "${file}" — it contributes no items; add content or remove the empty document.`);
          return;
        }

        if (
          !Array.isArray(entry) && typeof entry === 'object'
          && entry.sections && typeof entry.sections === 'object'
          && entry.id === undefined
          && (entry.name === undefined || typeof entry.name !== 'string')
        ) {
          return;
        }

        const at = Array.isArray(data) ? [String(index)] : [];
        const label = entry.id || (typeof entry.name === 'string' ? entry.name : null);
        validate(entry, ITEM_SCHEMA, {
          diagnostics,
          sourceMap,
          path: at,
          displayOffset: at.length,
          context: label ? `item "${label}"` : `item ${index + 1} of ${path.basename(file)}`,
        });

        if (typeof entry.id === 'string' && entry.id.includes(':')) {
          const message = `Item id "${entry.id}" contains ":", so it cannot be referenced unambiguously with library-qualified ids; remove the colon.`;
          diagnostics.error(CODES.ID_CONTAINS_COLON, message, { file });
        }

        items.push({ ...normalizeItemVarField(entry, (code, message) => warn(code, message)), _source: file });
      });
    }
  }

  return items;
}

function buildRegistry(items, context, { diagnostics } = {}) {
  const registry = new Map();
  for (const item of items.filter((c) => !c.include && (!c.import || c.id))) {
    const id = (item.id || (typeof item.name === 'string' ? item.name : null) || '').toLowerCase();
    if (!id) {
      const message = `Item in ${context} is missing both id and name fields (source: ${item._source}), so it cannot enter the registry; add id or name.`;
      diagnostics.error(CODES.ITEM_WITHOUT_IDENTITY, message, { file: item._source });
      continue;
    }
    if (registry.has(id)) {
      const message = `Duplicate item ID "${id}" in ${context}; the later definition is skipped. Sources:\n  ${registry.get(id)._source}\n  ${item._source}`;
      diagnostics.error(CODES.DUPLICATE_ITEM_ID, message, { file: item._source });
      continue; // first definition wins — the newcomer is skipped
    }
    registry.set(id, { ...item, id: item.id || item.name });
  }
  return registry;
}

function mergeRegistries(canonRegistry, projectRegistry, { diagnostics } = {}) {
  const merged = new ItemRegistry(canonRegistry);
  if (canonRegistry instanceof ItemRegistry) {
    merged.qualified = new Map(canonRegistry.qualified);
    merged.ambiguous = new Map(canonRegistry.ambiguous);
    merged.sources = new Set(canonRegistry.sources);
  }
  for (const [id, item] of projectRegistry) {
    if (merged.has(id)) {
      const message = `Item ID "${id}" exists in both a library set and the project; the project definition is skipped and the library item wins. Sources:\n  Library: ${merged.get(id)._source}\n  Project: ${item._source}`;
      diagnostics.error(CODES.DUPLICATE_ITEM_ID, message, { file: item._source });
      continue; // the library item wins — the project copy is skipped
    }
    merged.set(id, item);
  }
  return merged;
}

function buildCanonRegistry(resolvedCanon, options = {}) {
  const registry = new ItemRegistry();
  if (!resolvedCanon) return registry;

  const claims = new Map(); // plain id → every library set's copy of it

  for (const [name, canonPath] of resolvedCanon) {
    if (!fs.existsSync(canonPath)) {
      const message = `Library path not found for "${name}": ${canonPath}; this library contributes no items. Create the path or correct structure.input.library.`;
      options.diagnostics.warn(CODES.YAML_FILE_UNREADABLE, message);
      continue;
    }
    registry.sources.add(String(name).toLowerCase());

    const items = loadItemsFromDir([canonPath], options);
    for (const [id, item] of buildRegistry(items, `library:${name}`, { diagnostics: options.diagnostics })) {
      const stamped = { ...item, _canonSource: name };
      registry.qualified.set(`${String(name).toLowerCase()}:${id}`, stamped);
      if (!claims.has(id)) claims.set(id, []);
      claims.get(id).push(stamped);
    }
  }

  for (const [id, rivals] of claims) {
    if (rivals.length === 1) registry.set(id, rivals[0]);
    else registry.ambiguous.set(id, rivals);
  }

  return registry;
}

function resolveIncludes(itemDefs, canonRegistry, config, options = {}) {
  const { diagnostics } = options;
  const explicitIds = new Set();
  const includeDefs = [];

  for (const def of itemDefs) {
    if (def.include) {
      includeDefs.push(def);
    } else if (def.import) {
      explicitIds.add(def.id ? String(def.id).toLowerCase() : splitRef(def.import).id);
    } else if (def.id || def.name) {
      explicitIds.add(((def.id || (typeof def.name === 'string' ? def.name : '')) || '').toLowerCase());
    }
  }

  if (includeDefs.length === 0) return [];

  const included = [];
  const seenFiles = new Map();

  for (const def of includeDefs) {
    let includePath = resolveVariables(
      String(def.include), config._variables || config.variables || null,
      { diagnostics, file: def._source },
    );
    includePath = path.normalize(includePath);

    const fullPath = path.isAbsolute(includePath) ? includePath : path.resolve(config._base, includePath);
    if (!fs.existsSync(fullPath)) {
      const message = `Include path not found: ${fullPath}; included items are skipped. Create the file or correct the include path.`;
      diagnostics.warn(CODES.INCLUDE_NOT_FOUND, message, { file: def._source });
      continue;
    }

    const importerSource = def._source || '(unknown)';
    if (seenFiles.has(fullPath)) {
      seenFiles.get(fullPath).push(importerSource);
      diagnostics.error(
        CODES.DOUBLE_INCLUDE,
        `File included more than once: ${fullPath}; the repeated include is skipped. Keep one include.\nIncluded by:\n`
        + seenFiles.get(fullPath).map((s) => `  ${s}`).join('\n'),
        { file: importerSource },
      );
      continue;
    }
    seenFiles.set(fullPath, [importerSource]);

    let raw;
    try {
      ({ value: raw } = loadYamlDocument(fullPath));
    } catch (err) {
      if (!(err instanceof YamlLoadError)) throw err;
      diagnostics.error(err.code, err.message, { file: fullPath });
      continue;
    }
    const fromThisInclude = [];
    for (const item of (Array.isArray(raw) ? raw : [raw])) {
      const id = ((item.id || (typeof item.name === 'string' ? item.name : '')) || '').toLowerCase();
      if (explicitIds.has(id)) continue; // an explicit import wins

      const stamped = { ...item, _source: fullPath };
      if (def.importVariants) stamped._include_variants = def.importVariants;
      if (def.branches) stamped._include_branch_spec = def.branches;
      included.push(stamped);
      fromThisInclude.push(stamped);
    }

    reportUnmatchedSelectors(def, fromThisInclude, includePath, diagnostics);
  }

  return included;
}

function reportUnmatchedSelectors(def, items, includePath, diagnostics) {
  if (!def.importVariants || items.length === 0) return;

  for (const vPath of parseVariantsList(def.importVariants)) {
    const matched = items.filter((item) => {
      const deltas = collectVariantDeltas(item, vPath, null);
      return deltas === null || deltas.length > 0;
    }).length;
    if (matched > 0) continue;

    const message = `importVariants selector "${vPath}" matched none of the `
      + `${items.length} item${items.length === 1 ? '' : 's'} included from `
      + `${path.basename(includePath)}. `
      + 'A selector aimed at every item in a file is silent where an item does not define '
      + 'the name (§7.6.2a), so a misspelling applies to nothing and changes nothing — this '
      + 'is the only report it produces.';
    diagnostics.warn(CODES.SELECTOR_MATCHED_NOTHING, message, { file: def._source });
  }
}

function findConfigEntry(dir, basenames) {
  const candidates = basenames.filter((name) => fs.existsSync(path.join(dir, name)));
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      `More than one compile config in ${dir}:\n${candidates.map((c) => `  ${c}`).join('\n')}\n`
      + 'Keep one; the others would be silently ignored.'
    );
  }
  return path.join(dir, candidates[0]);
}

module.exports = {
  ItemRegistry,
  loadItemsFromDir,
  buildRegistry,
  mergeRegistries,
  buildCanonRegistry,
  resolveIncludes,
  findConfigEntry,
};
