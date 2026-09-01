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
 */

const path = require('path');

const { findFiles } = require('../util');
const { loadYaml } = require('./yaml');
const { FUNCTION_NAMES, entryName } = require('../render/parse');
const { levenshtein } = require('../schema');
const { CODES } = require('../diag');

/** The exact basenames a field table is read from — the `.cl.yaml` config pair (§4.6). */
const FIELD_TABLE_BASENAMES = Object.freeze(['fields.cl.yaml', 'fields.cl.yml']);

/**
 * Keys a `fields:` entry may carry (§13.2). `field`/`name` are template-list overrides only.
 * `allowExtra` is *not* here: it opts a whole template out of the §13.6 unread-field audit
 * and rides in the template's list as a `{ allowExtra: true }` marker (Decision 4).
 */
const FIELD_KEYS = Object.freeze([
  'label', 'render', 'join', 'wrap', 'wrapLabel', 'block', 'from', 'always', 'labelWhen',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate one parsed `fields.cl.yaml` document, folding its three namespaces into the
 * accumulators. Structural problems report and the offending entry is skipped; the load
 * does not abort, because a field table that a later directory overrides entirely should
 * not fail the compile on a stanza nothing reads.
 */
function foldDocument(doc, file, acc, diagnostics) {
  const report = (code, message) => {
    if (diagnostics) diagnostics.error(code, message, { file });
  };

  if (doc === undefined || doc === null) return;
  if (!isPlainObject(doc)) {
    report(CODES.FIELD_TABLE_MALFORMED, `${path.basename(file)} must be a mapping of fields:/groups:/templates:.`);
    return;
  }

  for (const key of Object.keys(doc)) {
    if (!['fields', 'groups', 'templates'].includes(key)) {
      report(CODES.FIELD_TABLE_UNKNOWN_KEY,
        `Unknown top-level key "${key}" in ${path.basename(file)} — expected fields:, groups: or templates:.`);
    }
  }

  const fields = doc.fields;
  if (fields !== undefined && fields !== null) {
    if (!isPlainObject(fields)) {
      report(CODES.FIELD_TABLE_MALFORMED, `"fields:" in ${path.basename(file)} must be a mapping.`);
    } else {
      for (const [name, decl] of Object.entries(fields)) {
        if (decl === null) { acc.fields[name] = null; continue; } // `~` unbinds an inherited field
        if (!isPlainObject(decl)) {
          report(CODES.FIELD_TABLE_MALFORMED, `Field "${name}" in ${path.basename(file)} must be a mapping.`);
          continue;
        }
        for (const k of Object.keys(decl)) {
          if (!FIELD_KEYS.includes(k)) {
            report(CODES.FIELD_TABLE_UNKNOWN_KEY,
              `Unknown key "${k}" on field "${name}" in ${path.basename(file)}.`);
          }
        }
        if (decl.render !== undefined && decl.render !== null
          && !FUNCTION_NAMES.includes(decl.render) && decl.render !== 'bare') {
          report(CODES.FIELD_TABLE_UNKNOWN_KEY,
            `Field "${name}" declares render: "${decl.render}", not one of ${FUNCTION_NAMES.join(', ')}.`);
        }
        acc.fields[name] = decl; // replace-per-entry (Decision 5), not deep
      }
    }
  }

  const groups = doc.groups;
  if (groups !== undefined && groups !== null) {
    if (!isPlainObject(groups)) {
      report(CODES.FIELD_TABLE_MALFORMED, `"groups:" in ${path.basename(file)} must be a mapping.`);
    } else {
      for (const [name, members] of Object.entries(groups)) {
        if (members === null) { acc.groups[name] = null; continue; }
        if (!Array.isArray(members)) {
          report(CODES.FIELD_TABLE_MALFORMED, `Group "${name}" in ${path.basename(file)} must be a sequence.`);
          continue;
        }
        acc.groups[name] = members;
      }
    }
  }

  const templates = doc.templates;
  if (templates !== undefined && templates !== null) {
    if (!isPlainObject(templates)) {
      report(CODES.FIELD_TABLE_MALFORMED, `"templates:" in ${path.basename(file)} must be a mapping.`);
    } else {
      for (const [name, list] of Object.entries(templates)) {
        if (list === null) { acc.templates[name] = null; continue; }
        if (!Array.isArray(list)) {
          report(CODES.FIELD_TABLE_MALFORMED, `Template "${name}" in ${path.basename(file)} must be a sequence.`);
          continue;
        }
        acc.templates[name] = list;
      }
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
  if (!diagnostics) return;
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
        if (diagnostics && stem !== 'fields' && levenshtein(stem, 'fields') <= 2) {
          diagnostics.warn(CODES.FIELD_TABLE_STRAY_FILE,
            `"${path.basename(file)}" looks like a misspelled "fields.cl.yaml" and will be `
            + 'ignored. Rename it, or if it is a templateFor slot file the near-miss is '
            + 'coincidental.',
            { file });
        }
        continue;
      }
      let doc;
      try {
        doc = loadYaml(file);
      } catch (err) {
        if (diagnostics) {
          diagnostics.error(CODES.FIELD_TABLE_MALFORMED,
            `Could not parse field table ${path.basename(file)}: ${err.message}`, { file });
        }
        continue;
      }
      foldDocument(doc, file, acc, diagnostics);
      acc._sources.push(file);
    }
  }

  checkReferences(acc, diagnostics);
  return acc;
}

module.exports = { CODES, FIELD_TABLE_BASENAMES, loadFieldTable };
