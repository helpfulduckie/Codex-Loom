'use strict';

/**
 * v3 `description.yaml` → a v4 component document (v4 spec §7.7, §14.2).
 *
 * v3 gave the description its own two-field file format: `body:` naming prose to include,
 * `script:` naming a JavaScript file whose leading comment block was appended, and
 * `stripTrailingInstructions:` tuning how much of that block survived. §7.7 deletes the
 * format rather than porting it — `body:` is a section with `file:` and `script:` is a
 * section with `from: {script:, extract: scriptBanner}`, which is why more than one banner
 * became expressible in the same move that removed the third file format.
 *
 * This is the first migration stage that rewrites a *component* document rather than the
 * config or an item, which is why it is its own file rather than another block in `v3.js`.
 */

const fs = require('fs');
const YAML = require('yaml');

const NL = '\n';
const SPLIT_LINES = /\r?\n/;

/**
 * Convert one parsed v3 description into the v4 `sections:` record.
 *
 * Returns `{ sections, notes }`, or `null` when the document is not a v3 description —
 * anything already carrying `sections:`, and anything with neither `body:` nor `script:`.
 * Returning `null` rather than an empty conversion is what lets the caller tell "already
 * migrated" apart from "migrated to nothing".
 */
function convertDescription(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (doc.sections) return null;
  if (!doc.body && !doc.script) return null;

  const sections = {};
  const notes = [];

  if (doc.body) sections.body = { file: String(doc.body) };
  if (doc.script) {
    sections.modBanner = {
      from: { script: String(doc.script), extract: 'scriptBanner' },
    };
  }

  // The flag is gone and the extractor always strips (§7.7). `true` is therefore a silent
  // no-op and needs no note; `false` is a behavior change the author has to see, because
  // the trailing comment group they were keeping will stop appearing in the description.
  if (doc.stripTrailingInstructions === false && doc.script) {
    notes.push(
      'stripTrailingInstructions: false is gone — the scriptBanner extractor always drops a '
      + 'trailing comment group with no list items when an earlier group has them. Check the '
      + 'compiled Description.md: if the final line of the banner mattered, move it into a '
      + 'text: section of its own.',
    );
  }

  return { sections, notes };
}

/**
 * Migrate the description document one project's config points at.
 *
 * The path comes from `buildCompileContext` rather than from the raw config, so an alias
 * or a `{%variable}` resolves the way the compiler resolves it — the same reason the Plot
 * Essentials stage reaches for the compiler's own loader instead of a private copy.
 */
function migrateDescriptionFiles(configPath, options = {}) {
  const { loadCompileConfig } = require('../loader');
  const { buildCompileContext } = require('../compile');

  const saved = { log: console.log, warn: console.warn, error: console.error };
  let config;
  try {
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    config = loadCompileConfig(configPath);
  } finally {
    Object.assign(console, saved);
  }

  const specPath = buildCompileContext(config, []).componentRefs.description;
  if (!specPath || !fs.existsSync(String(specPath))) {
    return { notes: ['no description file to migrate.'], touched: [] };
  }
  // A `.md` description is prose copied verbatim and always was; the passthrough path
  // carries it into v4 untouched, so there is nothing here to convert.
  if (!/\.ya?ml$/i.test(String(specPath))) {
    return { notes: ['the description is prose, not a document — nothing to migrate.'], touched: [] };
  }

  const source = fs.readFileSync(String(specPath), 'utf8');
  const converted = convertDescription(YAML.parse(source));
  if (!converted) {
    return { notes: ['the description is already a sections: document — nothing to migrate.'], touched: [] };
  }

  // The author's own leading comments survive, as they do in the Plot Essentials stage:
  // they name the project rather than the two keys being replaced, and a migration that
  // discards a banner is one that cannot be audited afterward.
  const banner = source.split(SPLIT_LINES).filter((line) => line.trim().startsWith('#')).join(NL);
  const text = (banner ? banner + NL : '')
    + YAML.stringify({ sections: converted.sections }, { lineWidth: 0 });
  if (!options.dryRun) fs.writeFileSync(String(specPath), text, 'utf8');

  return {
    notes: [
      'description.yaml became a component document: body: is a section with file:, and '
      + 'script: is one with from: {script:, extract: scriptBanner}.',
      ...converted.notes,
    ],
    touched: [String(specPath)],
  };
}

module.exports = { convertDescription, migrateDescriptionFiles };
