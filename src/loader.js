'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Recursively find all files with a given extension under a directory.
 */
function findFiles(dir, ext) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, ext));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Load and parse a YAML file.
 */
function loadYaml(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return yaml.load(raw);
  } catch (err) {
    throw new Error(`Failed to load YAML at ${filePath}: ${err.message}`);
  }
}

/**
 * Load all YAML card files from a directory recursively.
 * Returns flat array of card objects with source path attached.
 */
function loadCardsFromDir(dir) {
  const files = findFiles(dir, '.yaml');
  const cards = [];
  for (const file of files) {
    const data = loadYaml(file);
    const entries = Array.isArray(data) ? data : [data];
    for (const entry of entries) {
      cards.push({ ...entry, _source: file });
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
      dirEntries.set(name, {
        content: fs.readFileSync(file, 'utf8'),
        _source: file,
      });
    }
    for (const [name, entry] of dirEntries) {
      result.set(name, entry);
    }
  }
  return result;
}

/**
 * Load all templates and partials from one or more directories recursively.
 * Returns { templates: Map, partials: Map } where each Map is lowercase name → { content, _source }.
 * Errors on duplicate names within the same directory.
 * When multiple directories are given, later directories override earlier ones.
 */
function loadTemplates(dirs) {
  return {
    templates: loadNamedFiles(dirs, '.template'),
    partials: loadNamedFiles(dirs, '.partial'),
  };
}

/**
 * Load compile.yaml and resolve all paths relative to it.
 *
 * output: accepts three forms:
 *   - Plain string:  "./mod set 1"
 *   - Array of strings: ["./mod set 1", "./mod set 2"]
 *   - Array of objects: [{ path: "./mod set 1", label: "modset1" }, ...]
 *
 * _resolvedOutputs is always an array of { path: string, label: string|null }.
 */
function loadCompileConfig(configPath) {
  const config = loadYaml(configPath);
  const base = path.dirname(path.resolve(configPath));

  const rawOutputs = Array.isArray(config.output) ? config.output : [config.output];
  const resolvedOutputs = rawOutputs.map(o => {
    if (o && typeof o === 'object' && o.path) {
      return { path: path.resolve(base, o.path), label: o.label || null };
    }
    return { path: path.resolve(base, String(o)), label: null };
  });

  return {
    ...config,
    _base: base,
    _resolvedCanon: config.canon ? path.resolve(base, config.canon) : null,
    _resolvedOutputs: resolvedOutputs,
    _resolvedTemplates: Array.isArray(config.templates)
      ? config.templates.map(t => path.resolve(base, t))
      : path.resolve(base, config.templates),
    _resolvedCards: path.resolve(base, config.cards),
  };
}

/**
 * Build a card registry from an array of cards.
 * Keys are lowercase card IDs. Errors on collision.
 * @param {object[]} cards
 * @param {string} context - label for error messages ('canon', 'project', etc.)
 */
function buildRegistry(cards, context) {
  // Filter out import definitions — they are compile instructions, not registry entries
  cards = cards.filter(c => !c.import && !c.include);
  const registry = new Map();
  for (const card of cards) {
    const id = (card.id || card.name || '').toLowerCase();
    if (!id) {
      throw new Error(`Card in ${context} is missing both id and name fields (source: ${card._source})`);
    }
    if (registry.has(id)) {
      const existing = registry.get(id);
      throw new Error(
        `Duplicate card ID "${id}" in ${context}:\n  ${existing._source}\n  ${card._source}`
      );
    }
    // Normalize: ensure id field is always present
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
        `Card ID "${id}" exists in both canon and project:\n  Canon: ${existing._source}\n  Project: ${card._source}\n  Use a different id if these are genuinely different entities.`
      );
    }
    merged.set(id, card);
  }
  return merged;
}

module.exports = {
  findFiles,
  loadYaml,
  loadCardsFromDir,
  loadTemplates,
  loadCompileConfig,
  buildRegistry,
  mergeRegistries,
};