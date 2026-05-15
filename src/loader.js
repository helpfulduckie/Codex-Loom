'use strict';

const fs = require('fs');
const path = require('path');
const { findFiles, loadYaml } = require('./util');

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
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        cards.push({ ...entry, _source: file });
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
 * Resolve a sequence field (cards, templates) to an array of absolute paths.
 * Accepts: string, or array of strings. Normalises scalar → [scalar].
 */
function resolveSequence(raw, base) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(p => path.resolve(base, String(p)));
}

/**
 * Resolve a mapping field (canon, component dirs) to a Map<name, absolutePath>.
 * Accepts: an object whose values are path strings.
 */
function resolveMapping(raw, base) {
  const result = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [name, p] of Object.entries(raw)) {
    result.set(name, path.resolve(base, String(p)));
  }
  return result;
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
 *   protagonist:
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

  const resolvedCards     = resolveSequence(input.cards, base);
  const resolvedCanon     = resolveMapping(input.canon, base);
  const resolvedTemplates = resolveSequence(input.templates, base);

  const componentTypes = ['aiInstructions', 'opening', 'openingChoice', 'plotEssential', 'authorsNote', 'scripts'];
  const resolvedComponents = {};
  for (const type of componentTypes) {
    resolvedComponents[type] = resolveMapping(components[type], base);
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
    _resolvedCards: resolvedCards,
    _resolvedCanon: resolvedCanon,
    _resolvedTemplates: resolvedTemplates,
    _resolvedComponents: resolvedComponents,
    protagonist: config.protagonist || null,
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

module.exports = {
  findFiles,
  loadYaml,
  loadCardsFromDir,
  loadNamedFiles,
  loadTemplates,
  loadCompileConfig,
  buildRegistry,
  mergeRegistries,
};
