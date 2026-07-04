'use strict';

const fs = require('fs');
const path = require('path');
const { findFiles, loadYaml, VAR_ALIASES, deepClone } = require('./util');
const { expandTokens } = require('./tokens');

/**
 * Normalize variable-block aliases (v/var/vars/variable/variables) to canonical 'v'.
 * If multiple aliases appear as sibling keys, warn and merge them (last-writer-wins per subfield).
 */
function normalizeCardVarField(entry) {
  const aliasKeys = Object.keys(entry).filter(k => VAR_ALIASES.has(k.toLowerCase()));
  if (aliasKeys.length === 0) return entry;

  if (aliasKeys.length > 1) {
    const cardId = entry.id || (typeof entry.name === 'string' ? entry.name : '(unknown)');
    console.warn(`  WARN: card "${cardId}" has multiple variable-block aliases (${aliasKeys.map(k => `"${k}"`).join(', ')}). Merging — subfield conflicts resolve last-writer-wins.`);
  }

  const merged = {};
  for (const k of aliasKeys) {
    const val = entry[k];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(merged, deepClone(val));
    } else {
      Object.assign(merged, deepClone(val) || {});
    }
  }

  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (VAR_ALIASES.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out.v = merged;
  return out;
}

/**
 * Load all YAML card files from one or more directories recursively.
 * Accepts a single path string or an array of path strings.
 * Returns flat array of card objects with source path attached.
 */
function loadCardsFromDir(dirs) {
  if (!Array.isArray(dirs)) dirs = [dirs];
  const cards = [];
  for (const dir of dirs) {
    for (const file of findFiles(dir, '.yaml')) {
      const data = loadYaml(file);
      if (data === null || data === undefined) {
        console.warn(`  WARN: empty file skipped: ${file}`);
        continue;
      }
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        if (entry === null || entry === undefined) {
          console.warn(`  WARN: null document in "${file}" — skipped`);
          continue;
        }
        cards.push({ ...normalizeCardVarField(entry), _source: file });
      }
    }
  }
  return cards;
}

/**
 * Load all files of a given extension from one or more directories recursively.
 * Returns a Map of lowercase name → { content, _source }.
 * Errors on duplicate names within the same directory.
 * When multiple directories are given, later directories override earlier ones.
 */
function loadNamedFiles(dirs, ext) {
  if (!Array.isArray(dirs)) dirs = [dirs];
  const result = new Map();
  for (const dir of dirs) {
    const dirEntries = new Map();
    for (const file of findFiles(dir, ext)) {
      const name = path.basename(file, ext).toLowerCase();
      if (dirEntries.has(name)) {
        throw new Error(
          `Duplicate ${ext} name "${name}" found in ${dir}:\n  ${dirEntries.get(name)._source}\n  ${file}`
        );
      }
      dirEntries.set(name, { content: fs.readFileSync(file, 'utf8'), _source: file });
    }
    for (const [name, entry] of dirEntries) {
      result.set(name, entry);
    }
  }
  return result;
}

/**
 * Load all templates and partials from one or more directories.
 */
function loadTemplates(dirs) {
  return {
    templates: loadNamedFiles(dirs, '.template'),
    partials:  loadNamedFiles(dirs, '.partial'),
  };
}

/**
 * Resolve a mapping field (canon, component dirs) to a Map<name, absolutePath>.
 * Accepts: an object whose values are path strings.
 * When lenient=true, stores the raw string for values that don't resolve to an existing file/dir
 * (used for openingChoice, where values may be literal question strings rather than paths).
 */
function resolveMapping(raw, base, lenient = false, variables = null, canon = null) {
  const result = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [name, p] of Object.entries(raw)) {
    const expanded = expandPathTokens(String(p), variables, canon);
    const resolved = path.resolve(base, expanded);
    result.set(name, (lenient && !fs.existsSync(resolved)) ? String(p) : resolved);
  }
  return result;
}

/**
 * Expand {%variable} and {@canonName} tokens in a path string.
 * variables: plain object (config.variables).
 * canonMap:  Map<name, absolutePath> (may be partially built for two-pass canon resolution).
 * Case-insensitive. Unresolved tokens are left as-is.
 *
 * Thin wrapper over the shared tokens.expandTokens (path mode). {@} resolves
 * against the canon map only here — components are not yet resolved during the
 * canon/template two-pass. warnMissing is suppressed so unresolved {@} tokens
 * pass through to trigger the standard missing-path warning instead.
 */
function expandPathTokens(str, variables, canonMap) {
  return expandTokens(String(str), { variables, canon: canonMap, mode: 'path', warnMissing: false });
}

/**
 * Load compile.yaml and resolve all paths relative to it.
 *
 * Expected structure:
 *   structure:
 *     input:
 *       cards:      # sequence of folder paths
 *       canon:      # mapping: name → folder path
 *       templates:  # sequence of folder paths
 *       components:
 *         aiInstructions: # mapping: name → folder path
 *         opening:
 *         openingChoice:
 *         plotEssential:
 *         authorsNote:
 *         scripts:
 *     output:       # single folder path
 *     overview:     # optional; where to write overview/leaf-review files (default: {output}/Overview)
 *   protagonist:
 *   title:          # optional; scenario title, written once to {output}/Label.md
 *   components:     # root component specs (file path | literal | {@Key})
 *   variables:      # mapping
 *   branches:       # branch tree
 *
 * Returns a CompileConfig object.
 */
function loadCompileConfig(configPath) {
  const config = loadYaml(configPath);
  const base = path.dirname(path.resolve(configPath));

  const structure = config.structure || {};
  const input = structure.input || {};
  const components = input.components || {};

  const resolvedOutput = structure.output
    ? path.resolve(base, String(structure.output))
    : path.resolve(base, 'output');

  const resolvedOverview = structure.overview
    ? path.resolve(base, String(structure.overview))
    : null;

  // Canon: two-pass resolution so entries can reference {%variables} and sibling {@canonName} entries.
  // Pass 1: expand {%variables}, then resolve entries with no remaining {@ tokens.
  // Pass 2: expand {%variables} + {@canonName} in the remainder using pass-1 results.
  const canonRaw = (input.canon && typeof input.canon === 'object' && !Array.isArray(input.canon))
    ? input.canon : {};
  const variables = config.variables || null;
  const resolvedCanon = new Map();

  for (const [name, p] of Object.entries(canonRaw)) {
    const afterVars = expandPathTokens(String(p), variables, resolvedCanon);
    if (!afterVars.includes('{@')) {
      resolvedCanon.set(name, path.resolve(base, afterVars));
    }
  }
  for (const [name, p] of Object.entries(canonRaw)) {
    if (!resolvedCanon.has(name)) {
      const expanded = expandPathTokens(String(p), variables, resolvedCanon);
      resolvedCanon.set(name, path.resolve(base, expanded));
    }
  }

  config._canonRaw = canonRaw;

  // Templates: expand {%variables} and {@canonName} before resolving paths.
  const templatesRaw = input.templates
    ? (Array.isArray(input.templates) ? input.templates : [input.templates])
    : [];
  const resolvedTemplates = templatesRaw.map(p => {
    const expanded = expandPathTokens(String(p), variables, resolvedCanon);
    return path.resolve(base, expanded);
  });

  // Cards: same token expansion as templates ({%variables} + {@canonName}) before resolving paths.
  const cardsRaw = input.cards
    ? (Array.isArray(input.cards) ? input.cards : [input.cards])
    : [];
  const resolvedCards = cardsRaw.map(p => {
    const expanded = expandPathTokens(String(p), variables, resolvedCanon);
    return path.resolve(base, expanded);
  });

  const componentTypes = ['aiInstructions', 'opening', 'openingChoice', 'plotEssential', 'authorsNote', 'scripts', 'description'];
  const resolvedComponents = {};
  for (const type of componentTypes) {
    resolvedComponents[type] = resolveMapping(components[type], base, type === 'openingChoice', variables, resolvedCanon);
  }

  // Warn on missing declared paths
  for (const p of resolvedCards) {
    if (!fs.existsSync(p)) console.warn(`  WARN: cards path not found: ${p}`);
  }
  for (const [name, p] of resolvedCanon) {
    if (!fs.existsSync(p)) console.warn(`  WARN: canon "${name}" path not found: ${p}`);
  }
  for (const p of resolvedTemplates) {
    if (!fs.existsSync(p)) console.warn(`  WARN: templates path not found: ${p}`);
  }

  return {
    _base: base,
    _resolvedOutput: resolvedOutput,
    _resolvedOverview: resolvedOverview,
    _resolvedCards: resolvedCards,
    _resolvedCanon: resolvedCanon,
    _resolvedTemplates: resolvedTemplates,
    _resolvedComponents: resolvedComponents,
    protagonist: config.protagonist || null,
    title:       config.title       || null,
    components:  config.components  || null,
    variables:   config.variables   || null,
    branches:    config.branches    || null,
    _structure:  structure,
  };
}

/**
 * Build a card registry from an array of cards.
 * Keys are lowercase card IDs. Errors on collision.
 */
function buildRegistry(cards, context) {
  cards = cards.filter(c => !c.import && !c.include);
  const registry = new Map();
  for (const card of cards) {
    const id = (card.id || (typeof card.name === 'string' ? card.name : null) || '').toLowerCase();
    if (!id) {
      throw new Error(`Card in ${context} is missing both id and name fields (source: ${card._source})`);
    }
    if (registry.has(id)) {
      const existing = registry.get(id);
      throw new Error(
        `Duplicate card ID "${id}" in ${context}:\n  ${existing._source}\n  ${card._source}`
      );
    }
    registry.set(id, { ...card, id: card.id || card.name });
  }
  return registry;
}

/**
 * Merge canon and project registries, erroring on any ID collision between them.
 */
function mergeRegistries(canonRegistry, projectRegistry) {
  const merged = new Map(canonRegistry);
  for (const [id, card] of projectRegistry) {
    if (merged.has(id)) {
      const existing = merged.get(id);
      throw new Error(
        `Card ID "${id}" exists in both canon and project:\n  Canon: ${existing._source}\n  Project: ${card._source}`
      );
    }
    merged.set(id, card);
  }
  return merged;
}

/**
 * Build a map of Codex overlays from import-only project card definitions.
 * These are Codex cards that have `import:` but no `id:`, making them invisible
 * to buildRegistry. The overlays map lets PE blocks pick up the Codex-level
 * importVariants, variants, branches, and body without re-defining them.
 *
 * Keyed by lowercase import target id. Warns and skips on duplicate overlays.
 */
function buildOverlays(cards) {
  const overlays = new Map();
  for (const card of cards) {
    if (!card.import) continue;
    const key = String(card.import).toLowerCase();
    if (overlays.has(key)) {
      console.warn(`  WARN: duplicate Codex overlay for "${card.import}" in ${card._source}; keeping first`);
      continue;
    }
    overlays.set(key, card);
  }
  return overlays;
}

module.exports = {
  findFiles,
  loadYaml,
  loadCardsFromDir,
  loadNamedFiles,
  loadTemplates,
  loadCompileConfig,
  buildRegistry,
  mergeRegistries,
  buildOverlays,
};
