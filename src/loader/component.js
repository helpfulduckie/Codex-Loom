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
const { runExtractor, readSource } = require('../extract');
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
  const {
    diagnostics, label = 'component', variables = null, base = null, stack = [],
    // Every resolved path this call (and everything it recurses into via `imports:`)
    // actually reads, for a caller that needs the *full* dependency set rather than just
    // the top-level spec — e.g. the dependency-coverage check (§11.2 Watch, Phase 7 Step
    // 4), which cannot tell a shared component reached through a plain variable from one
    // reached through a library entry by looking at `components:` alone, because the gap
    // it exists to catch is precisely a file `imports:` pulls in from outside both.
    dependencyLedger = null,
  } = options;

  if (!spec || typeof spec !== 'string') return null;
  if (!fs.existsSync(spec)) {
    const message = `${label} file not found: ${spec}`;
    if (diagnostics) diagnostics.warn(CODES.YAML_FILE_UNREADABLE, message, { file: spec });
    else console.warn(`  WARN: ${message}`);
    return null;
  }

  if (dependencyLedger) dependencyLedger.add(path.resolve(spec));

  const { value: doc, sourceMap } = loadYamlDocument(spec);
  if (doc === null || doc === undefined) return null;

  if (Array.isArray(doc)) {
    // v3 had two anonymous ordered block lists — Plot Essentials' and the Opening's — and
    // both become named sections, because §7.2 makes a name the thing that lets a section be
    // overridden, repositioned or deleted by an importing project. What each block *becomes*
    // differs: a Plot Essentials block was usually content and becomes an item with a render
    // target, while an Opening block was always prose and becomes a text section. Naming both
    // paths here rather than one keeps the message true for whichever file arrived.
    throw new Error(
      `${label} file "${spec}" is a YAML sequence. A component is a mapping with a `
      + '`sections:` record (§7.2), and v3\'s ordered block lists have no equivalent — a '
      + 'block had no name, so nothing could override or reposition it. An Opening block '
      + 'becomes a named text section; a Plot Essentials block becomes an item declaring its '
      + 'own placement. `migrateProjectFully()` in `src/migrate/index.js` converts both.'
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
    diagnostics, label, variables, base, stack, onWarn, dependencyLedger,
  });
  const sections = inherited === null
    ? (doc.sections || {})
    : mergeSectionRecords(inherited, doc.sections || {}, onWarn);

  // §7.7's `file:` and `from:` become `text:` here — after the merge, so an override that
  // replaces an imported section's source wins, and before normalization, so everything
  // downstream sees one kind of section content. Reading them here rather than at render
  // time is the same decision `imports:` made for the same reason: this runs once per
  // component file, and a missing path reported per leaf is 32 reports for The Institute.
  const sourced = resolveSectionSources(sections, {
    spec, base, variables, diagnostics,
  });

  const component = normalizeComponent({ ...doc, sections: sourced }, { onWarn });
  // `rawSections` is what a *further* import layers over, and it has to be the merged
  // record rather than this file's own `sections:` — a three-deep chain (house style, world
  // layer, project) would otherwise see only the middle layer's own declarations and drop
  // everything the house style contributed.
  // `rawSections` is the *source-resolved* record, which is what a further import layers
  // over. Handing back the unresolved one would mean an importing project's `+{…}` against
  // an inherited `file:` section applied to nothing, because the file's contents would not
  // be known yet at the moment the field op ran. Resolving first makes the op see the text.
  return component.sections.length > 0
    ? { ...component, rawSections: sourced, source: spec }
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
  const { diagnostics, label, variables, base, stack, onWarn, dependencyLedger } = options;
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
      diagnostics, label, variables, base, stack: chain, dependencyLedger,
    });
    if (!imported) continue;

    let contributed = tagSectionOrigins(imported.rawSections, path.basename(resolved));
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

/**
 * Mark every raw section def with the basename of the file it was imported from, unless a
 * closer import already tagged it (Decision 5, Phase 7 Step 4).
 *
 * `normalizeSection` fires `CL0602` twice for one broken imported section — once here, when
 * `imported`'s own `normalizeComponent` call runs on it alone, and once more in the importer,
 * when the merged document is normalized. The first report already names the right file (it
 * *is* that file's own load); the second, without this tag, repeats the identical message
 * against the importer instead, which reads as a duplicate rather than as "this is inherited,
 * go fix it over there." The tag rides through `layerSectionDef`'s `{...from}` copy and
 * `resolveSectionSources`' `{...def}` copies untouched, because neither ever assigns this key
 * — it only stops surviving where a local override actually replaces the section's content,
 * which is exactly when the second report would no longer be about the imported copy anyway.
 */
function tagSectionOrigins(sections, fileBasename) {
  const out = {};
  for (const [name, def] of Object.entries(sections || {})) {
    if (def && typeof def === 'object' && !Array.isArray(def) && !('__importedFrom' in def)) {
      out[name] = { ...def, __importedFrom: fileBasename };
    } else {
      out[name] = def;
    }
  }
  return out;
}

// ── Section sources (§7.7) ───────────────────────────────────────────────────

/**
 * Turn every `file:` and `from:` in a section record into plain `text:`.
 *
 * Variant deltas are resolved too, one level down, and they have to be: a delta is applied
 * by `applySectionVariant` *after* normalization, so a `file:` left unresolved inside one
 * would reach the emitter as an unread key and produce nothing. One walk covers both
 * positions, which is also what keeps a source meaning the same thing in a variant as in
 * the section it varies.
 *
 * Paths resolve against the project base with the *root* variable table — the rule `from:`
 * and `include:` already follow, and for the same reason: this document is cached by
 * resolved path and shared by every leaf, so a per-branch source would make one cache key
 * stand for two documents. A section that needs to vary by branch varies through
 * `branches:`, which is what that key is for.
 */
function resolveSectionSources(sections, options) {
  const out = {};
  for (const [name, def] of Object.entries(sections || {})) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) { out[name] = def; continue; }

    const resolved = resolveOneSource(def, name, options);

    if (resolved.variants && typeof resolved.variants === 'object' && !Array.isArray(resolved.variants)) {
      const variants = {};
      for (const [variantName, delta] of Object.entries(resolved.variants)) {
        variants[variantName] = (delta && typeof delta === 'object' && !Array.isArray(delta))
          ? resolveOneSource(delta, `${name}/${variantName}`, options)
          : delta;
      }
      resolved.variants = variants;
    }

    out[name] = resolved;
  }
  return out;
}

/**
 * Read one section definition's source, or hand it back untouched when it declares none.
 *
 * A section declares at most one source. `text:` alongside `file:` is CL0619 rather than a
 * precedence rule, on the same reasoning as CL0601's text-and-slot: the ambiguity is real —
 * does the file replace the text, precede it, or follow it? — and every answer is a
 * convention the author would have to look up. Refusing it keeps the option of defining one
 * later; picking silently would not.
 */
function resolveOneSource(def, label, options) {
  const { spec, base, variables, diagnostics } = options;
  const hasFile = typeof def.file === 'string' && def.file !== '';
  const hasFrom = def.from && typeof def.from === 'object' && !Array.isArray(def.from);
  if (!hasFile && !hasFrom) return def;

  const result = { ...def };
  delete result.file;
  delete result.from;

  if (hasFile && hasFrom) {
    report(diagnostics, 'error', CODES.SECTION_TEXT_AND_SOURCE,
      `section "${label}" declares both "file:" and "from:" — a section takes its text from `
      + 'one source. Split the two into their own sections, which is also what lets each '
      + 'carry its own heading and position.',
      spec);
    return result;
  }

  if (def.text !== undefined && def.text !== null && def.text !== '') {
    report(diagnostics, 'error', CODES.SECTION_TEXT_AND_SOURCE,
      `section "${label}" declares "text:" and ${hasFile ? '"file:"' : '"from:"'} — a section `
      + 'takes its text from one source. The text is kept and the file is ignored; move the '
      + 'file into its own section if both were meant to appear.',
      spec);
    return result;
  }

  const rawPath = hasFile ? def.file : def.from.script;
  if (typeof rawPath !== 'string' || rawPath === '') {
    report(diagnostics, 'error', CODES.SECTION_SOURCE_NOT_FOUND,
      `section "${label}" has a "from:" with no "script:" naming a file to read.`,
      spec);
    return result;
  }

  const expanded = expandTokens(rawPath, { variables });
  const resolved = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(base || path.dirname(spec), expanded);

  if (!fs.existsSync(resolved)) {
    report(diagnostics, 'error', CODES.SECTION_SOURCE_NOT_FOUND,
      `section "${label}" reads from "${rawPath}"`
      + `${expanded === rawPath ? '' : ` (expanded to ${expanded})`}, which does not exist. `
      + 'The path resolves against the project base unless it is absolute — the same base '
      + '`imports:`, `include:` and every `components:` entry use.',
      spec);
    return result;
  }

  const source = readSource(resolved);

  if (hasFile) {
    result.text = source.trimEnd();
    return result;
  }

  const { text, error } = runExtractor(def.from.extract, source);
  if (error) {
    report(diagnostics, 'error', CODES.SECTION_EXTRACT_UNKNOWN,
      `section "${label}": ${error}`, spec);
    return result;
  }
  result.text = text;
  return result;
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
