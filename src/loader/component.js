'use strict';

/**
 * Loading a component document (v4 spec §7.2).
 *
 * One function, and it is deliberately thin: read the file, validate it against
 * `COMPONENT_SCHEMA`, hand the result to `model/component.js`. Everything about *what a
 * section is* lives in the model and everything about *how one is written* lives in the
 * schema; this only joins them to a path on disk.
 *
 * ── Why validation happens here and not in the model ────────────────────────
 *
 * `model/` is pure (§3.3) — no `fs`, no `console` — and validation needs a source map to
 * say where an unknown key was written, which only the loader has. Splitting it this way
 * is what lets a component document report `unknown key "blocks"` with a line number,
 * which is the migration signal §7.2 relies on: a v3 Plot Essentials file validated
 * against this schema names the key that has to change rather than failing obscurely
 * later.
 */

const fs = require('fs');

const { loadYamlDocument } = require('./yaml');
const { validate } = require('../schema');
const { COMPONENT_SCHEMA } = require('./component-schema');
const { normalizeComponent } = require('../model/component');
const { CODES, busWarner } = require('../diag');

/**
 * Load one component document from a resolved path.
 *
 * Returns the normalized `{ sections, slots }`, or `null` when there is nothing to load —
 * an absent spec, a missing file, or a document with no sections. `null` is the caller's
 * cue to record a component gap; it never means "an empty component rendered nothing",
 * which is a different fact and reported differently.
 *
 * A v3 sequence is rejected with a message that names the shape, not the parse error.
 * That file *is* valid YAML, so the parser has no complaint to make, and "must be a
 * mapping" without saying which mapping is the least useful thing that could be said to
 * someone holding a file that worked yesterday.
 */
function loadComponentDocument(spec, options = {}) {
  const { diagnostics, label = 'component' } = options;

  if (!spec || typeof spec !== 'string') return null;
  if (!fs.existsSync(spec)) {
    const message = `${label} file not found: ${spec}`;
    if (diagnostics) diagnostics.warn(CODES.YAML_FILE_UNREADABLE, message, { file: spec });
    else console.warn(`  WARN: ${message}`);
    return null;
  }

  const { value: doc, sourceMap } = loadYamlDocument(spec);
  if (doc === null || doc === undefined) return null;

  if (Array.isArray(doc)) {
    throw new Error(
      `${label} file "${spec}" is a YAML sequence. A component is a mapping with a `
      + '`sections:` record (§7.2); v3\'s ordered block list has no equivalent here, '
      + 'because the items that used to be blocks now declare their own placement.'
    );
  }
  if (typeof doc !== 'object') {
    throw new Error(`${label} file must be a YAML mapping: ${spec}`);
  }

  if (diagnostics) {
    validate(doc, COMPONENT_SCHEMA, { diagnostics, sourceMap, context: `the ${label} component` });
  }

  const onWarn = diagnostics
    ? busWarner(diagnostics, { file: spec })
    : (code, message) => console.warn(`  WARN [${code}]: ${message}`);

  const component = normalizeComponent(doc, { onWarn });
  return component.sections.length > 0 ? { ...component, source: spec } : null;
}

module.exports = { loadComponentDocument };
