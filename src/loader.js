'use strict';

const fs = require('fs');
const path = require('path');
const { findFiles, loadYaml } = require('./util');
const { loadCompileConfig } = require('./config/load');
const {
  loadItemsFromDir, buildRegistry, mergeRegistries, buildOverlays,
} = require('./loader/registry');

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

// What remains here is template loading. Config loading moved to config/load.js, and
// item loading, registries and overlays to loader/registry.js (§3.2). The names below
// are re-exported so call sites move when compile.js is decomposed, rather than in the
// middle of a step that is already changing how items are validated.

module.exports = {
  findFiles,
  loadYaml,
  loadItemsFromDir,
  loadNamedFiles,
  loadTemplates,
  loadCompileConfig,
  buildRegistry,
  mergeRegistries,
  buildOverlays,
};
