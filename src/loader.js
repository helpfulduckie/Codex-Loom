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
 * Load all templates from one or more directories recursively.
 * Returns a map of lowercase template name → template string.
 * Errors on duplicate template names within the same directory.
 * When multiple directories are given, later directories override earlier ones.
 */
function loadTemplates(dirs) {
  if (!Array.isArray(dirs)) dirs = [dirs];
  const templates = new Map();
  for (const dir of dirs) {
    const dirTemplates = new Map();
    for (const file of findFiles(dir, '.template')) {
      const name = path.basename(file, '.template').toLowerCase();
      if (dirTemplates.has(name)) {
        throw new Error(
          `Duplicate template name "${name}" found in ${dir}:\n  ${dirTemplates.get(name)._source}\n  ${file}`
        );
      }
      dirTemplates.set(name, {
        content: fs.readFileSync(file, 'utf8'),
        _source: file,
      });
    }
    for (const [name, tpl] of dirTemplates) {
      templates.set(name, tpl);
    }
  }
  return templates;
}

/**
 * Load compile.yaml and resolve all paths relative to it.
 */
function loadCompileConfig(configPath) {
  const config = loadYaml(configPath);
  const base = path.dirname(path.resolve(configPath));

  return {
    ...config,
    _base: base,
    _resolvedCanon: config.canon ? path.resolve(base, config.canon) : null,
    _resolvedOutput: path.resolve(base, config.output),
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
