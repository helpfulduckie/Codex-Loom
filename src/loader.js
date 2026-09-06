'use strict';

const fs = require('fs');
const path = require('path');
const { findFiles } = require('./util');
const { loadFieldTable } = require('./loader/field-table');
const { CODES } = require('./diag');

function loadNamedFiles(dirs, ext) {
  if (!Array.isArray(dirs)) dirs = [dirs];
  const result = new Map();
  for (const dir of dirs) {
    const dirEntries = new Map();
    for (const file of findFiles(dir, ext)) {
      const name = path.basename(file, ext).toLowerCase();
      if (dirEntries.has(name)) {
        const err = new Error(
          `${CODES.DUPLICATE_NAMED_FILE}: Duplicate ${ext} name "${name}" found in ${dir}:`
          + `\n  ${dirEntries.get(name)._source}\n  ${file}`
        );
        err.code = CODES.DUPLICATE_NAMED_FILE;
        throw err;
      }
      dirEntries.set(name, { content: fs.readFileSync(file, 'utf8'), _source: file });
    }
    for (const [name, entry] of dirEntries) {
      result.set(name, entry);
    }
  }
  return result;
}

function checkNoFences(files, ext, diagnostics) {
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

function loadTemplates(dirs, options = {}) {
  const templates = loadNamedFiles(dirs, '.template');
  const partials = loadNamedFiles(dirs, '.partial');
  checkNoFences(templates, '.template', options.diagnostics);
  checkNoFences(partials, '.partial', options.diagnostics);
  const fieldTable = loadFieldTable(dirs, options);
  return { templates, partials, fieldTable };
}


module.exports = {
  loadNamedFiles,
  loadTemplates,
};
