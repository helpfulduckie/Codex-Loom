'use strict';


const fs = require('fs');
const path = require('path');

const { findFiles, deepClone, resolveVariables, isPlainObject, VAR_ALIASES, YAML_SUFFIXES, RESERVED_LIBRARY_BASENAMES } = require('../util');
const { loadYamlDocument, YamlLoadError } = require('./yaml');
const { attachOrigins, copyOrigins, transferOrigins, originLocation } = require('../origin');
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
      + 'Merging — subfield conflicts resolve last-writer-wins.',
      originLocation(entry, [aliasKeys[aliasKeys.length - 1]])
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
  copyOrigins(entry, out);
  for (const key of aliasKeys) {
    transferOrigins(entry, out, [key], ['v'], { replace: false, descendants: false });
    for (const sub of Object.keys(entry[key] || {})) {
      transferOrigins(entry, out, [key, sub], ['v', sub]);
    }
  }
  return out;
}

/** A component document shares item directories and is loaded by the component loader. */
function isComponentDocument(entry) {
  return !Array.isArray(entry) && typeof entry === 'object'
    && entry.sections && typeof entry.sections === 'object'
    && entry.id === undefined
    && (entry.name === undefined || typeof entry.name !== 'string');
}

function prepareItem(entry, { file, index, path: entryPath, sourceMap, diagnostics }) {
  const label = entry && (entry.id || (typeof entry.name === 'string' ? entry.name : null));
  validate(entry, ITEM_SCHEMA, {
    diagnostics,
    sourceMap,
    path: entryPath,
    displayOffset: entryPath.length,
    context: label ? `item "${label}"` : `item ${index + 1} of ${path.basename(file)}`,
  });

  if (!isPlainObject(entry)) return null;

  attachOrigins(entry, sourceMap.exportOrigins(entryPath));
  if (typeof entry.id === 'string' && entry.id.includes(':')) {
    const message = `Item id "${entry.id}" contains ":", so it cannot be referenced unambiguously with library-qualified ids; remove the colon.`;
    diagnostics.error(CODES.ID_CONTAINS_COLON, message, originLocation(entry, ['id'], { file }));
  }

  const warn = (code, message, at) => diagnostics.warn(code, message, at || { file });
  const normalized = normalizeItemVarField(entry, warn);
  return copyOrigins(normalized, { ...normalized, _source: file });
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

      if (data === null || data === undefined) {
        diagnostics.warn(CODES.YAML_EMPTY_FILE, `Empty file skipped: ${file}; add YAML content or remove the file.`, { file });
        continue;
      }

      const entries = Array.isArray(data) ? data : [data];
      entries.forEach((entry, index) => {
        if (entry === null || entry === undefined) {
          diagnostics.warn(CODES.YAML_NULL_DOCUMENT, `Null document in "${file}" — it contributes no items; add content or remove the empty document.`, { file });
          return;
        }

        if (isComponentDocument(entry)) return;

        const entryPath = Array.isArray(data) ? [String(index)] : [];
        const loaded = prepareItem(entry, { file, index, path: entryPath, sourceMap, diagnostics });
        if (loaded) items.push(loaded);
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
      diagnostics.error(CODES.ITEM_WITHOUT_IDENTITY, message, originLocation(item));
      continue;
    }
    if (registry.has(id)) {
      const message = `Duplicate item ID "${id}" in ${context}; the later definition is skipped. Sources:\n  ${registry.get(id)._source}\n  ${item._source}`;
      diagnostics.error(CODES.DUPLICATE_ITEM_ID, message, originLocation(item, [item.id ? 'id' : 'name']), {
        related: [{ label: 'first definition', ...originLocation(registry.get(id), ['id']) }],
      });
      continue; // first definition wins — the newcomer is skipped
    }
    const registered = copyOrigins(item, { ...item, id: item.id || item.name });
    if (!item.id) transferOrigins(item, registered, ['name'], ['id']);
    registry.set(id, registered);
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
      diagnostics.error(CODES.DUPLICATE_ITEM_ID, message, originLocation(item, ['id']), {
        related: [{ label: 'library definition', ...originLocation(merged.get(id), ['id']) }],
      });
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
      const stamped = copyOrigins(item, { ...item, _canonSource: name });
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
      explicitIds.add(typeof def.id === 'string' && def.id
        ? def.id.toLowerCase() : splitRef(def.import).id);
    } else {
      const identity = typeof def.id === 'string' && def.id ? def.id
        : (typeof def.name === 'string' ? def.name : null);
      if (identity !== null) explicitIds.add(identity.toLowerCase());
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

    const isDir = fs.statSync(fullPath).isDirectory();
    const files = isDir
      ? findFiles(fullPath, YAML_SUFFIXES, { sort: true })
        .filter((f) => !RESERVED_LIBRARY_BASENAMES.includes(path.basename(f).toLowerCase()))
      : [fullPath];
    if (files.length === 0) {
      const message = `Include directory holds no YAML files: ${fullPath}; nothing is included. Add item files or correct the include path.`;
      diagnostics.warn(CODES.INCLUDE_NOT_FOUND, message, { file: def._source });
      continue;
    }

    // CL0326 counts matches across the whole directive, so a directory include reports a
    // selector only when no file under it defines the name.
    const fromThisInclude = [];
    for (const file of files) {
      fromThisInclude.push(...includeFile(file, def, fullPath, { seenFiles, explicitIds, diagnostics }));
    }
    included.push(...fromThisInclude);

    reportUnmatchedSelectors(def, fromThisInclude, isDir ? `${path.basename(fullPath)}/` : path.basename(fullPath), diagnostics);
  }

  return included;
}

function includeFile(file, def, includeKey, { seenFiles, explicitIds, diagnostics }) {
  const importerSource = def._source || '(unknown)';
  if (seenFiles.has(file)) {
    seenFiles.get(file).push(importerSource);
    diagnostics.error(
      CODES.DOUBLE_INCLUDE,
      `File included more than once: ${file}; the repeated include is skipped. Keep one include.\nIncluded by:\n`
      + seenFiles.get(file).map((s) => `  ${s}`).join('\n'),
      { file: importerSource },
    );
    return [];
  }
  seenFiles.set(file, [importerSource]);

  let raw; let sourceMap;
  try {
    ({ value: raw, sourceMap } = loadYamlDocument(file));
  } catch (err) {
    if (!(err instanceof YamlLoadError)) throw err;
    diagnostics.error(err.code, err.message, { file });
    return [];
  }
  if (raw === null || raw === undefined) {
    diagnostics.warn(CODES.YAML_EMPTY_FILE, `Empty file skipped: ${file}; add YAML content or remove the file.`, { file });
    return [];
  }

  const out = [];
  for (const [index, item] of (Array.isArray(raw) ? raw : [raw]).entries()) {
    if (item === null || item === undefined) {
      diagnostics.warn(CODES.YAML_NULL_DOCUMENT, `Null document in "${file}" — it contributes no items; add content or remove the empty document.`, { file });
      continue;
    }
    if (isComponentDocument(item)) continue;
    const id = typeof item.id === 'string' && item.id ? item.id.toLowerCase()
      : (typeof item.name === 'string' ? item.name.toLowerCase() : '');
    if (explicitIds.has(id)) continue; // an explicit import wins

    const entryPath = Array.isArray(raw) ? [String(index)] : [];
    const prepared = prepareItem(item, { file, index, path: entryPath, sourceMap, diagnostics });
    if (!prepared) continue;

    // `_include_key` names the directive, which for a directory include spans many files;
    // the per-branch CL0326 check groups on it rather than on `_source`.
    const stamped = copyOrigins(prepared, { ...prepared, _include_key: includeKey });
    if (def.importVariants) {
      stamped._include_variants = def.importVariants;
      transferOrigins(def, stamped, ['importVariants'], ['_include_variants']);
    }
    if (def.branches) {
      stamped._include_branch_spec = def.branches;
      transferOrigins(def, stamped, ['branches'], ['_include_branch_spec']);
    }
    out.push(stamped);
  }
  return out;
}

function reportUnmatchedSelectors(def, items, includeLabel, diagnostics) {
  if (!def.importVariants || items.length === 0) return;

  for (const [index, vPath] of parseVariantsList(def.importVariants).entries()) {
    const matched = items.filter((item) => {
      const deltas = collectVariantDeltas(item, vPath, null);
      return deltas === null || deltas.length > 0;
    }).length;
    if (matched > 0) continue;

    const message = `importVariants selector "${vPath}" matched none of the `
      + `${items.length} item${items.length === 1 ? '' : 's'} included from `
      + `${includeLabel}. `
      + 'No item defines that variant, so the selector changes nothing; check the spelling '
      + 'or add the variant to an included item.';
    diagnostics.warn(CODES.SELECTOR_MATCHED_NOTHING, message, originLocation(def,
      Array.isArray(def.importVariants) ? ['importVariants', String(index)] : ['importVariants']));
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
