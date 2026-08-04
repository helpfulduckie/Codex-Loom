'use strict';

const fs = require('fs');
const path = require('path');
const { findFiles, loadYaml, VAR_ALIASES, deepClone } = require('./util');
const { loadCompileConfig } = require('./config/load');

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

// Config loading moved to config/load.js (§3.2). `loadCompileConfig` is re-exported
// below so compile.js and the existing tests keep their import path while the rest of
// this module is decomposed in Step 4.

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
