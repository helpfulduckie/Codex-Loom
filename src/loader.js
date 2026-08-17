'use strict';

const fs = require('fs');
const path = require('path');
const { findFiles, loadYaml } = require('./util');
const { loadCompileConfig } = require('./config/load');
const {
  loadItemsFromDir, buildRegistry, mergeRegistries,
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

/** Codes this module reports. CL04xx is the render/template band (§4.4). */
const CODES = {
  TEMPLATE_CONTAINS_FENCE: 'CL0410',
};

/**
 * Reject any template or partial that still writes a VL fence (§8.3).
 *
 * After the Phase 2 flip the envelope is `emit/vl.js`'s alone, so a `~~~` left in a
 * template produces a card with two of them — the emitter's, then the template's, with
 * the second one's keys landing in the body where VL will never read them. That output
 * is not obviously wrong on inspection, which is why this is a load-time refusal rather
 * than a lint finding: a half-migrated project should name the files that remain rather
 * than compile into something subtly broken.
 */
function checkNoFences(files, ext, diagnostics) {
  if (!diagnostics) return;
  for (const [name, entry] of files) {
    if (!entry.content.includes('~~~')) continue;
    diagnostics.error(
      CODES.TEMPLATE_CONTAINS_FENCE,
      `Template "${name}" still contains a ~~~ fence.`,
      { file: entry._source },
      {
        hint: 'The story-card envelope (## heading, ~~~ fence, triggers/encapsulate/notes '
          + 'keys) is emitted by Codex Loom now; a template renders the body alone. Delete '
          + `everything above and including the last ~~~ line in this ${ext} file.`,
      },
    );
  }
}

/**
 * Load all templates and partials from one or more directories.
 */
function loadTemplates(dirs, options = {}) {
  const templates = loadNamedFiles(dirs, '.template');
  const partials = loadNamedFiles(dirs, '.partial');
  checkNoFences(templates, '.template', options.diagnostics);
  checkNoFences(partials, '.partial', options.diagnostics);
  return { templates, partials };
}

// What remains here is template loading. Config loading moved to config/load.js, and
// item loading, registries and overlays to loader/registry.js (§3.2). The names below
// are re-exported so call sites move when compile.js is decomposed, rather than in the
// middle of a step that is already changing how items are validated.

module.exports = {
  CODES,
  findFiles,
  loadYaml,
  loadItemsFromDir,
  loadNamedFiles,
  loadTemplates,
  loadCompileConfig,
  buildRegistry,
  mergeRegistries,
};
