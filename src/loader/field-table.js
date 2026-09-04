'use strict';

/**
 * The field-declaration table (v4 spec §13.2–§13.5, Phase 12 Step 0).
 *
 * `fields.cl.yaml` replaces the stanza that a `.partial` file repeats: one entry per field,
 * carrying its label and render function, plus `groups:` (named sub-lists) and `templates:`
 * (ordered field/group lists — what a `.template` file is today). Three namespaces, one file
 * per templates directory, discovered anywhere in the tree by `findFiles`.
 *
 * ── Why not `loadNamedFiles` ────────────────────────────────────────────────
 *
 * `loadNamedFiles` merges per *file* — a project's `Character.template` replaces the
 * library's wholesale, which is right for templates. A field table is a map of ~50 fields,
 * so file-level replacement means a project overriding one label restates all fifty — the
 * duplication §13 removes, reintroduced through the loader. This loader merges **key-wise,
 * later winning per entry** (Decision 5), across all three namespaces, and the replace is
 * per entry rather than deep: a project adding `labelWhen` restates `label` and `join`
 * beside it.
 *
 * The load inherits snapshot freezing for free — it reads the same
 * `config._resolvedTemplates` directories `loadTemplates` does, which `config/load.js` has
 * already redirected through `snapshot/manifest.json` where one exists.
 *
 * ── Shape checking ──────────────────────────────────────────────────────────
 *
 * The key surface (which keys a `fields:`/`templates:` entry may carry, what type each
 * takes, the closed `render:` set) is checked once, declaratively, by `FIELD_TABLE_SCHEMA`
 * (`field-table-schema.js`) via the shared `validate` engine — the same machinery
 * `config/load.js` and `loader/schema.js` use, so an unknown key, a wrong type or a bad
 * `render:` name all raise the same codes (`CL0201`/`CL0202`/`CL0206`) an author sees
 * elsewhere in the compiler. What `validate` cannot express stays here: `checkSourceConflict`
 * (a cross-key constraint — `from:`/`parts:`/`try:` mutual exclusion) and the fold itself,
 * which merges three namespaces key-wise and must skip a malformed entry without aborting
 * the whole file, since a later directory may override the very entry that is broken here.
 */

const path = require('path');

const { findFiles, isPlainObject } = require('../util');
const { loadYamlDocument } = require('./yaml');
const { entryName } = require('../render/parse');
const { levenshtein, validate } = require('../schema');
const { FIELD_TABLE_SCHEMA } = require('./field-table-schema');
const { CODES } = require('../diag');

/** The exact basenames a field table is read from — the `.cl.yaml` config pair (§4.6). */
const FIELD_TABLE_BASENAMES = Object.freeze(['fields.cl.yaml', 'fields.cl.yml']);

/** `try:` resolves first, then `parts:`, then `from:` (`render/field-list.js:319-333`,
 * `render/field-audit.js:163-168`) — the order `checkSourceConflict` names as the winner
 * when a declaration gives more than one. */
const SOURCE_PRECEDENCE = Object.freeze(['try', 'parts', 'from']);

/** Join `from:`, `parts:`, `try:` (in whatever subset and order they were given) into prose:
 * one key alone, two as `a: and b:`, three as `a:, b: and c:`. */
function joinKeys(keys) {
  if (keys.length <= 1) return keys.map((k) => `${k}:`).join('');
  if (keys.length === 2) return `${keys[0]}: and ${keys[1]}:`;
  return `${keys.slice(0, -1).map((k) => `${k}:`).join(', ')} and ${keys[keys.length - 1]}:`;
}

/**
 * `from:`, `parts:` and `try:` are mutually exclusive on one declaration (2026-09-03 handoff,
 * composition primitive steps 3a/4) — from: reads a single body path, parts: joins several
 * pieces into one field, try: uses the first path that exists, and a declaration naming more
 * than one is an author error rather than settings that combine. No schema descriptor can
 * express this — it is a constraint across sibling keys, not a shape any one of them has —
 * so it is checked here, as `CL0423`. The message names which key wins, because the
 * precedence (`SOURCE_PRECEDENCE`) is real and invisible from outside; it recurses into
 * `parts:` and `try:` themselves, so a nested declaration carrying more than one source key
 * is caught the same way, at whatever depth.
 */
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
      + `is fixed, ${joinKeys([winner])} is used and ${joinKeys(losers)} is ignored.`,
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

/**
 * Validate one parsed `fields.cl.yaml` document, folding its three namespaces into the
 * accumulators. `validate` reports the shape problems (unknown keys, wrong types, a bad
 * `render:`) but does not remove the offending entry from the document, so the fold below
 * still has to skip a malformed entry rather than folding it into the accumulator — the load
 * does not abort, because a field table that a later directory overrides entirely should not
 * fail the compile on a stanza nothing reads.
 */
function foldDocument(doc, file, sourceMap, acc, diagnostics) {
  if (doc === undefined || doc === null) return;
  if (!isPlainObject(doc)) {
    diagnostics.error(CODES.FIELD_TABLE_UNUSABLE,
      'This field table could not be read, so none of the fields, groups or templates it '
      + 'declares are available. Any template entry naming one of them renders nothing, with '
      + 'no further error.',
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

/**
 * After the merge, every name a group or template names must resolve to a declared field
 * or (for template lists) a group. An unresolved name is content going nowhere, so it
 * reports — but as a load-time WARN, since a shared library table may legitimately carry a
 * group a downstream project has not populated.
 */
function checkReferences(table, diagnostics) {
  const knownField = (n) => Object.prototype.hasOwnProperty.call(table.fields, n) && table.fields[n] !== null;
  const knownGroup = (n) => Object.prototype.hasOwnProperty.call(table.groups, n) && table.groups[n] !== null;

  for (const [name, members] of Object.entries(table.groups)) {
    if (members === null) continue;
    for (const m of members) {
      const ref = entryName(m);
      if (ref && !knownField(ref)) {
        diagnostics.warn(CODES.FIELD_TABLE_BAD_REF,
          `Group "${name}" names "${ref}", which is not a declared field.`,
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
          `Template "${name}" names "${ref}", which is not a declared field or group.`,
          { file: table._sources[0] || null });
      }
    }
  }
}

/**
 * Load and merge the field table across a templates search path.
 *
 * @param {string|string[]} dirs  the resolved templates directories (`config._resolvedTemplates`)
 * @param {object} [options]       `{ diagnostics }`
 * @returns {{ fields: object, groups: object, templates: object, _sources: string[] }}
 */
function loadFieldTable(dirs, options = {}) {
  if (!Array.isArray(dirs)) dirs = [dirs];
  const { diagnostics } = options;
  const acc = { fields: {}, groups: {}, templates: {}, _sources: [] };

  for (const dir of dirs) {
    for (const file of findFiles(dir, ['.cl.yaml', '.cl.yml'])) {
      const base = path.basename(file).toLowerCase();
      if (!FIELD_TABLE_BASENAMES.includes(base)) {
        // A templates directory legitimately holds other `.cl.yaml` files — the
        // `templateFor` slot files of §13.4 (`terse.cl.yaml`, `notes.cl.yaml`, …). So the
        // only stray file worth flagging is one that looks like a *mistyped* `fields.cl.yaml`
        // — a near miss on the stem, which would otherwise leave the field table silently
        // empty.
        const stem = base.replace(/\.cl\.ya?ml$/, '');
        if (stem !== 'fields' && levenshtein(stem, 'fields') <= 2) {
          diagnostics.warn(CODES.FIELD_TABLE_STRAY_FILE,
            `"${path.basename(file)}" looks like a misspelled "fields.cl.yaml" and will be `
            + 'ignored. Rename it, or if it is a templateFor slot file the near-miss is '
            + 'coincidental.',
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
          + 'declares are available. Any template entry naming one of them renders nothing, '
          + 'with no further error.',
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
