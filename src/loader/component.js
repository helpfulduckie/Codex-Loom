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
const path = require('path');

const { loadYamlDocument } = require('./yaml');
const { validate } = require('../schema');
const { COMPONENT_SCHEMA } = require('./component-schema');
const { normalizeComponent, mergeSectionRecords, applySectionSelector } = require('../model/component');
const { expandTokens } = require('../tokens');
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
  const { diagnostics, label = 'component', variables = null, base = null, stack = [] } = options;

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

  // §7.6: imports first, in order, then the local `sections:` layered on top. Merging
  // happens on raw section definitions — see `model/component.js` for why — so what reaches
  // `normalizeComponent` is one finished record and its checks run once on the merged
  // result rather than once per partial override.
  const inherited = resolveImports(doc, spec, {
    diagnostics, label, variables, base, stack, onWarn,
  });
  const sections = inherited === null
    ? (doc.sections || {})
    : mergeSectionRecords(inherited, doc.sections || {}, onWarn);

  const component = normalizeComponent({ ...doc, sections }, { onWarn });
  // `rawSections` is what a *further* import layers over, and it has to be the merged
  // record rather than this file's own `sections:` — a three-deep chain (house style, world
  // layer, project) would otherwise see only the middle layer's own declarations and drop
  // everything the house style contributed.
  return component.sections.length > 0
    ? { ...component, rawSections: sections, source: spec }
    : null;
}

/**
 * Walk a document's `imports:` and return the raw sections they contribute (§7.6.3).
 *
 * Returns `null` when the document imports nothing, which the caller distinguishes from an
 * empty record: nothing to merge means the local `sections:` pass through untouched, and
 * `~` on a local section stays the plain "omit this" that `normalizeComponent` has always
 * treated it as, rather than becoming a CL0608 about an import that does not exist.
 *
 * ── Path resolution, and why root variables only ────────────────────────────
 *
 * `from:` expands through `expandTokens` — which is how `{%components}` reaches a canon
 * directory, since §6.1 makes canon names variables — and then resolves against the
 * **project base**, which is where `include:` and every `components:` entry already resolve.
 * Resolving against the importing file's own directory was the alternative and reads well
 * for a sibling (`./base.cl.yaml`), but it would make the base depend on whether the string
 * happened to contain a token: a `{%var}` is written relative to the project and a bare path
 * would be relative to the file, so one key would mean two things. One rule, and it is the
 * rule every other path in the language already follows.
 *
 * The variables are the root table, never the branch-merged one, for the same reason
 * `include:` uses root variables (`loader/registry.js`): the document is cached by resolved
 * path and shared across every leaf, so a `from:` that varied by branch would make one file
 * into two documents behind one cache key.
 *
 * ── Cycles ─────────────────────────────────────────────────────────────────
 *
 * `stack` carries the chain of paths currently being resolved. A `from:` already on it is
 * CL0607 and is skipped rather than followed, because the alternative is a stack overflow
 * whose message names neither file.
 */
function resolveImports(doc, spec, options) {
  const { diagnostics, label, variables, base, stack, onWarn } = options;
  const entries = Array.isArray(doc.imports) ? doc.imports : [];
  if (entries.length === 0) return null;

  const chain = [...stack, path.resolve(spec)];
  let sections = {};

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !entry.from) continue;

    const expanded = expandTokens(String(entry.from), { variables });
    const resolved = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(base || path.dirname(spec), expanded);

    if (chain.some((seen) => seen === resolved)) {
      report(diagnostics, 'error', CODES.IMPORT_CYCLE,
        `component import cycle: "${path.basename(resolved)}" is already being resolved `
        + `further up this chain (${chain.map((p) => path.basename(p)).join(' → ')}). `
        + 'The import is skipped; nothing from it is merged.',
        spec);
      continue;
    }

    if (!fs.existsSync(resolved)) {
      report(diagnostics, 'error', CODES.IMPORT_NOT_FOUND,
        `component import not found: ${entry.from}${expanded === String(entry.from) ? '' : ` (expanded to ${expanded})`}. `
        + 'A `from:` resolves against the project base unless it is absolute — the same '
        + 'base `include:` and every `components:` entry use.',
        spec);
      continue;
    }

    const imported = loadComponentDocument(resolved, {
      diagnostics, label, variables, base, stack: chain,
    });
    if (!imported) continue;

    let contributed = imported.rawSections;
    for (const name of parseSelectorList(entry.importVariants)) {
      const applied = applySectionSelector(contributed, name);
      contributed = applied.sections;
      if (applied.matched === 0) {
        report(diagnostics, 'warn', CODES.SELECTOR_MATCHED_NOTHING,
          `importVariants selector "${name}" matched none of the `
          + `${Object.keys(contributed).length} sections imported from `
          + `${path.basename(resolved)}. A selector aimed at every section in a component `
          + 'is silent where a section does not define the name (§7.6.2a), so a '
          + 'misspelling applies to nothing and changes nothing — this is the only report '
          + 'it produces.',
          spec);
      }
    }

    sections = mergeSectionRecords(sections, contributed, onWarn);
  }

  return sections;
}

/** `importVariants:` accepts a scalar or a list, exactly as it does on an item. */
function parseSelectorList(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v);
  return [];
}

/** Report to the bus, or to the console when there is no bus — the loader's standing shape. */
function report(diagnostics, severity, code, message, file) {
  if (diagnostics) diagnostics[severity](code, message, { file });
  else console.warn(`  ${severity.toUpperCase()} [${code}]: ${message}`);
}

module.exports = { loadComponentDocument };
