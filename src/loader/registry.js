'use strict';

/**
 * Item loading and registry construction (v4 spec §3.2).
 *
 * Gathers what v3 split between `loader.js` (file loading, registry building, overlays)
 * and `compile.js` (canon registry, include resolution) — the two halves of one job,
 * separated only by which file happened to grow first.
 *
 * Items are validated against `loader/schema.js` as they load, so an unknown or
 * misplaced key is reported once, at its source position, rather than surfacing later as
 * output that is quietly missing something.
 */

const fs = require('fs');
const path = require('path');

const { findFiles, deepClone, VAR_ALIASES, YAML_SUFFIXES } = require('../util');
const { loadYamlDocument } = require('./yaml');
const { validate } = require('../schema');
const { ITEM_SCHEMA } = require('./schema');
const { expandTokens } = require('../tokens');
const { CODES: DIAG_CODES } = require('../diag');

const CODES = Object.freeze({
  EMPTY_FILE: 'CL0103',
  NULL_DOCUMENT: 'CL0104',
  INCLUDE_NOT_FOUND: 'CL0130',
  DOUBLE_INCLUDE: 'CL0131',
  ITEM_WITHOUT_IDENTITY: 'CL0140',
  DUPLICATE_ITEM_ID: 'CL0141',
  MULTIPLE_VAR_ALIASES: 'CL0142',
  DUPLICATE_OVERLAY: 'CL0143',
});

/**
 * Collapse the `v`/`var`/`vars`/`variable`/`variables` aliases to canonical `v` (§4.7).
 * Sibling aliases are merged last-writer-wins, with a warning.
 */
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

/**
 * Load every item file under one or more directories.
 *
 * `diagnostics` is optional. Without it the loader falls back to the v3 console warnings,
 * which keeps the many existing call sites working unchanged while the bus is threaded
 * through the compiler over the remaining steps.
 */
function loadItemsFromDir(dirs, options = {}) {
  const { diagnostics } = options;
  const dirList = Array.isArray(dirs) ? dirs : [dirs];
  const items = [];

  for (const dir of dirList) {
    for (const file of findFiles(dir, YAML_SUFFIXES)) {
      const { value: data, sourceMap } = loadYamlDocument(file);

      const warn = (code, message, at) => {
        if (diagnostics) diagnostics.warn(code, message, at || { file });
        else console.warn(`  WARN: ${message}`);
      };

      if (data === null || data === undefined) {
        warn(CODES.EMPTY_FILE, `empty file skipped: ${file}`);
        continue;
      }

      const entries = Array.isArray(data) ? data : [data];
      entries.forEach((entry, index) => {
        if (entry === null || entry === undefined) {
          warn(CODES.NULL_DOCUMENT, `null document in "${file}" — skipped`);
          return;
        }

        // Validate before normalization and before `_source` is stamped, so positions
        // address the document as written.
        if (diagnostics) {
          const at = Array.isArray(data) ? [String(index)] : [];
          const label = entry.id || (typeof entry.name === 'string' ? entry.name : null);
          validate(entry, ITEM_SCHEMA, {
            diagnostics,
            sourceMap,
            path: at,
            displayOffset: at.length,
            context: label ? `item "${label}"` : `item ${index + 1} of ${path.basename(file)}`,
          });
        }

        items.push({ ...normalizeItemVarField(entry, (code, message) => warn(code, message)), _source: file });
      });
    }
  }

  return items;
}

/**
 * Build an id-keyed registry. Ids are lowercased; `import`/`include` defs are skipped
 * because they carry no identity of their own.
 */
function buildRegistry(items, context) {
  const registry = new Map();
  for (const item of items.filter((c) => !c.import && !c.include)) {
    const id = (item.id || (typeof item.name === 'string' ? item.name : null) || '').toLowerCase();
    if (!id) {
      throw new Error(`Card in ${context} is missing both id and name fields (source: ${item._source})`);
    }
    if (registry.has(id)) {
      throw new Error(
        `Duplicate card ID "${id}" in ${context}:\n  ${registry.get(id)._source}\n  ${item._source}`
      );
    }
    registry.set(id, { ...item, id: item.id || item.name });
  }
  return registry;
}

/** Merge canon and project registries, erroring on any id collision between them. */
function mergeRegistries(canonRegistry, projectRegistry) {
  const merged = new Map(canonRegistry);
  for (const [id, item] of projectRegistry) {
    if (merged.has(id)) {
      throw new Error(
        `Card ID "${id}" exists in both canon and project:\n  Canon: ${merged.get(id)._source}\n  Project: ${item._source}`
      );
    }
    merged.set(id, item);
  }
  return merged;
}

/**
 * Collect Codex overlays: project defs carrying `import:` but no `id:`.
 *
 * These are invisible to `buildRegistry`, which is the point — they let a Plot Essentials
 * block pick up Codex-level importVariants, variants, branches and body without
 * re-declaring them.
 */
function buildOverlays(items, options = {}) {
  const { diagnostics } = options;
  const overlays = new Map();
  for (const item of items) {
    if (!item.import) continue;
    const key = String(item.import).toLowerCase();
    if (overlays.has(key)) {
      const message = `duplicate Codex overlay for "${item.import}" in ${item._source}; keeping first`;
      if (diagnostics) diagnostics.warn(CODES.DUPLICATE_OVERLAY, message, { file: item._source });
      else console.warn(`  WARN: ${message}`);
      continue;
    }
    overlays.set(key, item);
  }
  return overlays;
}

/** Load every named canon directory into one registry, erroring on cross-canon duplicates. */
function buildCanonRegistry(resolvedCanon, options = {}) {
  const registry = new Map();
  if (!resolvedCanon) return registry;

  for (const [name, canonPath] of resolvedCanon) {
    if (!fs.existsSync(canonPath)) {
      const message = `canon path not found for "${name}": ${canonPath}`;
      if (options.diagnostics) options.diagnostics.warn(DIAG_CODES.YAML_FILE_UNREADABLE, message);
      else console.warn(`  WARN: ${message}`);
      continue;
    }
    const items = loadItemsFromDir([canonPath], options);
    for (const [id, item] of buildRegistry(items, `canon:${name}`)) {
      if (registry.has(id)) {
        throw new Error(
          `Duplicate card ID "${id}" across canon sources:\n  ${registry.get(id)._source}\n  ${item._source}`
        );
      }
      registry.set(id, item);
    }
  }
  return registry;
}

/**
 * Expand `include:` directives into the item definitions they name.
 *
 * An id already declared explicitly in the project wins over the same id arriving through
 * an include, and including one file twice is an error rather than a silent merge.
 */
function resolveIncludes(itemDefs, canonRegistry, config, options = {}) {
  const { diagnostics } = options;
  const explicitIds = new Set();
  const includeDefs = [];

  for (const def of itemDefs) {
    if (def.include) {
      includeDefs.push(def);
    } else if (def.import) {
      explicitIds.add(String(def.import).toLowerCase());
    } else if (def.id || def.name) {
      explicitIds.add(((def.id || (typeof def.name === 'string' ? def.name : '')) || '').toLowerCase());
    }
  }

  if (includeDefs.length === 0) return [];

  const included = [];
  const seenFiles = new Map();

  for (const def of includeDefs) {
    // Root variables only: includes resolve once, before branches are enumerated (§5.1).
    let includePath = expandTokens(String(def.include), {
      variables: config.variables || null,
      components: config._resolvedComponents,
      canon: config._resolvedCanon,
      mode: 'path',
      warnMissing: false,
    });
    includePath = path.normalize(includePath);

    const fullPath = path.isAbsolute(includePath) ? includePath : path.resolve(config._base, includePath);
    if (!fs.existsSync(fullPath)) {
      const message = `include path not found: ${fullPath}`;
      if (diagnostics) diagnostics.warn(CODES.INCLUDE_NOT_FOUND, message, { file: def._source });
      else console.warn(`  WARN: ${message}`);
      continue;
    }

    const importerSource = def._source || '(unknown)';
    if (seenFiles.has(fullPath)) {
      seenFiles.get(fullPath).push(importerSource);
      throw new Error(
        `File included more than once: ${fullPath}\nIncluded by:\n`
        + seenFiles.get(fullPath).map((s) => `  ${s}`).join('\n')
      );
    }
    seenFiles.set(fullPath, [importerSource]);

    const { value: raw } = loadYamlDocument(fullPath);
    for (const item of (Array.isArray(raw) ? raw : [raw])) {
      const id = ((item.id || (typeof item.name === 'string' ? item.name : '')) || '').toLowerCase();
      if (explicitIds.has(id)) continue; // an explicit import wins

      const stamped = { ...item, _source: fullPath };
      if (def.importVariants) stamped._include_variants = def.importVariants;
      if (def.branches) stamped._include_branch_spec = def.branches;
      included.push(stamped);
    }
  }

  return included;
}

/**
 * Find the config entry point in a directory (§4.6).
 *
 * Searching in order and erroring when more than one exists beats silently preferring
 * whichever comes first: two config files in one directory means one of them is being
 * ignored, and the author has no way to tell which.
 */
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
  loadItemsFromDir,
  normalizeItemVarField,
  buildRegistry,
  mergeRegistries,
  buildOverlays,
  buildCanonRegistry,
  resolveIncludes,
  findConfigEntry,
  CODES,
};
