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
const { splitRef, normalizeRef } = require('../model/refs');
const { collectVariantDeltas, parseVariantsList } = require('../model/item');

const CODES = Object.freeze({
  EMPTY_FILE: 'CL0103',
  NULL_DOCUMENT: 'CL0104',
  INCLUDE_NOT_FOUND: 'CL0130',
  DOUBLE_INCLUDE: 'CL0131',
  ITEM_WITHOUT_IDENTITY: 'CL0140',
  DUPLICATE_ITEM_ID: 'CL0141',
  MULTIPLE_VAR_ALIASES: 'CL0142',
  ID_CONTAINS_COLON: 'CL0144',
});

/**
 * The merged item registry (§17.2).
 *
 * A `Map` first and foremost: plain lowercase id → item, exactly as before, so every
 * consumer that does `registry.get(id)` is untouched. Two sidecars carry what multi-set
 * canon added:
 *
 *   `qualified`  `set:id` → item, for every canon item, so `grimwood:magic` always resolves
 *   `ambiguous`  plain id → the rival items, for ids more than one canon set defines
 *   `sources`    the declared canon set names, so an unknown qualifier is distinguishable
 *                from a known set that simply lacks the id
 *
 * An id claimed by two sets is deliberately absent from the plain keys. That is what makes
 * §17.3 work: the unqualified lookup misses, and `resolveItemRef` reaches the sidecar to
 * explain why rather than silently picking whichever set was declared last.
 */
class ItemRegistry extends Map {
  constructor(entries) {
    super(entries || []);
    this.qualified = new Map();
    this.ambiguous = new Map();
    this.sources = new Set();
  }

  /** Items known, counting the ambiguous ones the plain keys omit. */
  get itemCount() {
    let extra = 0;
    for (const rivals of this.ambiguous.values()) extra += rivals.length;
    return this.size + extra;
  }
}

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

        // A library entry may point at a mixed-purpose directory — §11.1's own example
        // pairs an item source with a `components:` one. A component document (top-level
        // `sections:`, no `id`/`name`) is expected content there, not an authoring mistake,
        // so it is skipped silently rather than warned or made to crash in `buildRegistry`.
        // Narrow on purpose: a genuinely broken item file (wrong shape, still missing
        // identity, no `sections:`) still falls through to the hard error below.
        if (
          !Array.isArray(entry) && typeof entry === 'object'
          && entry.sections && typeof entry.sections === 'object'
          && entry.id === undefined
          && (entry.name === undefined || typeof entry.name !== 'string')
        ) {
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

        // `:` separates a canon set from an id in a reference (§17.2), so an id containing
        // one would make every reference to it ambiguous. Rejected at load, where the
        // position is still known, rather than at the confusing far end.
        if (typeof entry.id === 'string' && entry.id.includes(':')) {
          const message = `item id "${entry.id}" contains ":", which separates a canon set from an id`;
          if (diagnostics) diagnostics.error(CODES.ID_CONTAINS_COLON, message, { file });
          else throw new Error(`${message} (source: ${file})`);
        }

        items.push({ ...normalizeItemVarField(entry, (code, message) => warn(code, message)), _source: file });
      });
    }
  }

  return items;
}

/**
 * Build an id-keyed registry. Ids are lowercased; `include` defs are skipped because they
 * carry no identity of their own, and so are bare `import:` defs — they *are* the item they
 * name, with local deltas.
 *
 * An import def carrying its own `id:` is the exception, and registers under that local id
 * (§17.4). That is rename-on-import: `id: dragon` over `import: wyvern` is a second copy of
 * a canon item, not an override of the original.
 */
function buildRegistry(items, context) {
  const registry = new Map();
  for (const item of items.filter((c) => !c.include && (!c.import || c.id))) {
    const id = (item.id || (typeof item.name === 'string' ? item.name : null) || '').toLowerCase();
    if (!id) {
      throw new Error(`Item in ${context} is missing both id and name fields (source: ${item._source})`);
    }
    if (registry.has(id)) {
      throw new Error(
        `Duplicate item ID "${id}" in ${context}:\n  ${registry.get(id)._source}\n  ${item._source}`
      );
    }
    registry.set(id, { ...item, id: item.id || item.name });
  }
  return registry;
}

/**
 * Merge canon and project registries, erroring on any id collision between them.
 *
 * This stays a load-time ERROR while the cross-canon case became a reference-time one
 * (§17.3), and the asymmetry is deliberate: there is exactly one project and its author owns
 * both sides of the clash, so renaming the local item is the available fix. A canon id that
 * *is* ambiguous holds no plain key, so a project item of that name simply takes it — an
 * explicit local definition is a clear enough answer to "which magic did you mean".
 */
function mergeRegistries(canonRegistry, projectRegistry) {
  const merged = new ItemRegistry(canonRegistry);
  if (canonRegistry instanceof ItemRegistry) {
    merged.qualified = new Map(canonRegistry.qualified);
    merged.ambiguous = new Map(canonRegistry.ambiguous);
    merged.sources = new Set(canonRegistry.sources);
  }
  for (const [id, item] of projectRegistry) {
    if (merged.has(id)) {
      throw new Error(
        `Item ID "${id}" exists in both canon and project:\n  Canon: ${merged.get(id)._source}\n  Project: ${item._source}`
      );
    }
    merged.set(id, item);
  }
  return merged;
}

/**
 * Load every named canon directory into one registry (§17.2).
 *
 * A duplicate id *within* one set is still an error, raised by `buildRegistry` — one set
 * owning an id twice is a mistake in that set, and no reference could disambiguate it.
 * A duplicate *across* sets is not an error here: both copies are kept, reachable by their
 * qualified names, and only an unqualified reference that cannot choose between them fails
 * (§17.3, `resolveItemRef`).
 */
function buildCanonRegistry(resolvedCanon, options = {}) {
  const registry = new ItemRegistry();
  if (!resolvedCanon) return registry;

  const claims = new Map(); // plain id → every canon set's copy of it

  for (const [name, canonPath] of resolvedCanon) {
    if (!fs.existsSync(canonPath)) {
      const message = `canon path not found for "${name}": ${canonPath}`;
      if (options.diagnostics) options.diagnostics.warn(DIAG_CODES.YAML_FILE_UNREADABLE, message);
      else console.warn(`  WARN: ${message}`);
      continue;
    }
    registry.sources.add(String(name).toLowerCase());

    const items = loadItemsFromDir([canonPath], options);
    for (const [id, item] of buildRegistry(items, `canon:${name}`)) {
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
      // A rename claims its local id and leaves the imported one free — an include may
      // still supply `wyvern` alongside a project `dragon` that copies it (§17.4).
      explicitIds.add(def.id ? String(def.id).toLowerCase() : splitRef(def.import).id);
    } else if (def.id || def.name) {
      explicitIds.add(((def.id || (typeof def.name === 'string' ? def.name : '')) || '').toLowerCase());
    }
  }

  if (includeDefs.length === 0) return [];

  const included = [];
  const seenFiles = new Map();

  for (const def of includeDefs) {
    // Root variables only: includes resolve once, before branches are enumerated (§5.1).
    // Root variables only: includes resolve once, before branches are enumerated
    // (§5.1). Canon names are among those variables as of §6.1.
    let includePath = expandTokens(String(def.include), { variables: config._variables || config.variables || null });
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
    // The items this one directive contributed — the target set its selectors were aimed
    // at, and therefore the set CL0326 counts against. `included` accumulates across every
    // directive, so counting there would let one include's matches cover another's typo.
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

/**
 * CL0326 for an include's `importVariants:` — the guard that makes arity-N silence safe.
 *
 * **Here rather than in the per-branch resolve loop, because `importVariants:` does not
 * depend on the branch.** §7.6.2a's two axes decide where each half of this check lives:
 * `importVariants:` selects from the imported source unconditionally, so it is asked and
 * answered once per compile; an include's `branches:` dispatches per leaf and its own
 * CL0326 belongs in `resolveBranchItems`, where a branch path exists. Asking this half per
 * leaf as well would repeat one typo warning across all 32 of The Institute's leaves.
 *
 * A target counts as matched when `collectVariantDeltas` returns a non-empty list *or*
 * `null`, because `null` is the `~` exclusion — the variant was found and it said to drop
 * the item. A partial path counts too: `human/noble` with `noble` missing returns `[human]`,
 * which is the apply-where-defined rule and a match on the segment that resolved.
 */
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
    if (diagnostics) diagnostics.warn(DIAG_CODES.SELECTOR_MATCHED_NOTHING, message, { file: def._source });
    else console.warn(`  WARN: ${message}`);
  }
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
  ItemRegistry,
  loadItemsFromDir,
  normalizeItemVarField,
  buildRegistry,
  mergeRegistries,
  buildCanonRegistry,
  resolveIncludes,
  findConfigEntry,
  CODES,
};
