'use strict';


const path = require('path');

const { findFiles, isPlainObject } = require('../util');
const { loadYamlDocument } = require('./yaml');
const { entryName } = require('../render/parse');
const { levenshtein, validate } = require('../schema');
const { FIELD_TABLE_SCHEMA } = require('./field-table-schema');
const { CODES } = require('../diag');

const FIELD_TABLE_BASENAMES = Object.freeze(['fields.cl.yaml', 'fields.cl.yml']);

const SOURCE_PRECEDENCE = Object.freeze(['try', 'parts', 'from']);

function joinKeys(keys) {
  if (keys.length <= 1) return keys.map((k) => `${k}:`).join('');
  if (keys.length === 2) return `${keys[0]}: and ${keys[1]}:`;
  return `${keys.slice(0, -1).map((k) => `${k}:`).join(', ')} and ${keys[keys.length - 1]}:`;
}

function checkSourceConflict(decl, label, currentPath, sourceMap, diagnostics) {
  if (!isPlainObject(decl)) return;
  const present = ['from', 'parts', 'try'].filter((k) => decl[k] !== undefined);
  if (present.length > 1) {
    const winner = SOURCE_PRECEDENCE.find((k) => present.includes(k));
    const losers = present.filter((k) => k !== winner);
    const both = present.length === 2 ? 'declares both ' : 'declares ';
    diagnostics.error(CODES.FIELD_SOURCE_CONFLICT,
      `${label} ${both}${joinKeys(present)}. Each of these says where the field's text comes `
      + 'from, so a declaration may give only one — from: reads a single body path, parts: '
      + 'joins several pieces into one field, try: uses the first path that exists. Until this '
      + `is fixed, ${joinKeys([winner])} is used and ${joinKeys(losers)} is ignored; the ignored source remains ineffective.`,
      sourceMap.nearest(currentPath),
      { hint: 'Keep the one you meant and delete the other.' });
  }
  if (Array.isArray(decl.parts)) {
    decl.parts.forEach((entry, i) => {
      if (isPlainObject(entry)) {
        checkSourceConflict(entry, `A nested part of ${label}`,
          [...currentPath, 'parts', String(i)], sourceMap, diagnostics);
      }
    });
  }
  if (Array.isArray(decl.try)) {
    decl.try.forEach((entry, i) => {
      if (isPlainObject(entry)) {
        checkSourceConflict(entry, `A nested try source of ${label}`,
          [...currentPath, 'try', String(i)], sourceMap, diagnostics);
      }
    });
  }
}

function foldDocument(doc, file, sourceMap, acc, diagnostics) {
  if (doc === undefined || doc === null) return;
  if (!isPlainObject(doc)) {
    diagnostics.error(CODES.FIELD_TABLE_UNUSABLE,
      'This field table could not be read, so none of the fields, groups or templates it '
      + 'declares are available; affected entries render nothing until the file is repaired.',
      sourceMap.nearest([]),
      { hint: 'A field table must be a mapping with fields:, groups: and/or templates: at the top level.' });
    return;
  }

  validate(doc, FIELD_TABLE_SCHEMA, { diagnostics, sourceMap, context: path.basename(file) });

  const fields = doc.fields;
  if (fields !== undefined && fields !== null && isPlainObject(fields)) {
    for (const [name, decl] of Object.entries(fields)) {
      if (decl === null) { acc.fields[name] = null; continue; } // `~` unbinds an inherited field
      if (!isPlainObject(decl)) continue;
      checkSourceConflict(decl, `Field "${name}"`, ['fields', name], sourceMap, diagnostics);
      acc.fields[name] = decl; // replace-per-entry (Decision 5), not deep
    }
  }

  const groups = doc.groups;
  if (groups !== undefined && groups !== null && isPlainObject(groups)) {
    for (const [name, members] of Object.entries(groups)) {
      if (members === null) { acc.groups[name] = null; continue; }
      if (!Array.isArray(members)) continue;
      acc.groups[name] = members;
    }
  }

  const templates = doc.templates;
  if (templates !== undefined && templates !== null && isPlainObject(templates)) {
    for (const [name, list] of Object.entries(templates)) {
      if (list === null) { acc.templates[name] = null; continue; }
      if (!Array.isArray(list)) continue;
      acc.templates[name] = list;
    }
  }
}

function checkReferences(table, diagnostics) {
  const knownField = (n) => Object.prototype.hasOwnProperty.call(table.fields, n) && table.fields[n] !== null;
  const knownGroup = (n) => Object.prototype.hasOwnProperty.call(table.groups, n) && table.groups[n] !== null;

  for (const [name, members] of Object.entries(table.groups)) {
    if (members === null) continue;
    for (const m of members) {
      const ref = entryName(m);
      if (ref && !knownField(ref)) {
        diagnostics.warn(CODES.FIELD_TABLE_BAD_REF,
          `Group "${name}" names "${ref}", which is not a declared field, so the entry contributes nothing; declare or correct the name, and the missing entry remains empty until fixed.`,
          { file: table._sources[0] || null });
      }
    }
  }

  for (const [name, list] of Object.entries(table.templates)) {
    if (list === null) continue;
    for (const e of list) {
      const ref = entryName(e);
      if (ref && !knownField(ref) && !knownGroup(ref)) {
        diagnostics.warn(CODES.FIELD_TABLE_BAD_REF,
          `Template "${name}" names "${ref}", which is not a declared field or group, so the entry contributes nothing; declare or correct the name, and the missing entry remains empty until fixed.`,
          { file: table._sources[0] || null });
      }
    }
  }
}

function loadFieldTable(dirs, options = {}) {
  if (!Array.isArray(dirs)) dirs = [dirs];
  const { diagnostics } = options;
  const acc = { fields: {}, groups: {}, templates: {}, _sources: [] };

  for (const dir of dirs) {
    for (const file of findFiles(dir, ['.cl.yaml', '.cl.yml'])) {
      const base = path.basename(file).toLowerCase();
      if (!FIELD_TABLE_BASENAMES.includes(base)) {
        const stem = base.replace(/\.cl\.ya?ml$/, '');
        if (stem !== 'fields' && levenshtein(stem, 'fields') <= 2) {
          diagnostics.warn(CODES.FIELD_TABLE_STRAY_FILE,
            `"${path.basename(file)}" looks like a misspelled "fields.cl.yaml" and will be `
            + 'ignored, so its declarations are unavailable; rename it, or if it is a '
            + 'templateFor slot file the near-miss is coincidental.',
            { file });
        }
        continue;
      }
      let doc;
      let sourceMap;
      try {
        ({ value: doc, sourceMap } = loadYamlDocument(file));
      } catch (err) {
        diagnostics.error(CODES.FIELD_TABLE_UNUSABLE,
          'This field table could not be read, so none of the fields, groups or templates it '
          + 'declares are available; affected entries render nothing until the file is repaired.',
          { file },
          { hint: `YAML error: ${(err.cause && err.cause.message) || err.message}` });
        continue;
      }
      foldDocument(doc, file, sourceMap, acc, diagnostics);
      acc._sources.push(file);
    }
  }

  checkReferences(acc, diagnostics);
  return acc;
}

module.exports = { loadFieldTable };
