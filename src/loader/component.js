'use strict';


const fs = require('fs');
const path = require('path');

const { loadYamlDocument, YamlLoadError } = require('./yaml');
const { validate } = require('../schema');
const { COMPONENT_SCHEMA } = require('./component-schema');
const { normalizeComponent, mergeSectionRecords, applySectionSelector } = require('../model/component');
const { resolveVariables } = require('../util');
const { runExtractor } = require('../extract');
const { CODES, busWarner } = require('../diag');

function loadComponentDocument(spec, options = {}) {
  const {
    diagnostics, label = 'component', variables = null, base = null, stack = [],
    dependencyLedger = null,
  } = options;

  if (!spec || typeof spec !== 'string') return null;
  if (!fs.existsSync(spec)) {
    const message = `${label} file not found: ${spec}; this component is skipped. Create the file or correct the component path.`;
    diagnostics.warn(CODES.YAML_FILE_UNREADABLE, message, { file: spec });
    return null;
  }

  if (dependencyLedger) dependencyLedger.add(path.resolve(spec));

  let doc; let sourceMap;
  try {
    ({ value: doc, sourceMap } = loadYamlDocument(spec));
  } catch (err) {
    if (!(err instanceof YamlLoadError)) throw err;
    diagnostics.error(err.code, `${label}: ${err.message}`, { file: spec });
    return null;
  }
  if (doc === null || doc === undefined) return null;

  if (Array.isArray(doc)) {
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

  validate(doc, COMPONENT_SCHEMA, { diagnostics, sourceMap, context: `the ${label} component` });

  const onWarn = busWarner(diagnostics, { file: spec });

  const inherited = resolveImports(doc, spec, {
    diagnostics, label, variables, base, stack, onWarn, dependencyLedger,
  });
  const sections = inherited === null
    ? (doc.sections || {})
    : mergeSectionRecords(inherited, doc.sections || {}, onWarn);

  const sourced = resolveSectionSources(sections, {
    spec, base, variables, diagnostics,
  });

  const component = normalizeComponent({ ...doc, sections: sourced }, { onWarn });
  return component.sections.length > 0
    ? { ...component, rawSections: sourced, source: spec }
    : null;
}

function resolveImports(doc, spec, options) {
  const { diagnostics, label, variables, base, stack, onWarn, dependencyLedger } = options;
  const entries = Array.isArray(doc.imports) ? doc.imports : [];
  if (entries.length === 0) return null;

  const chain = [...stack, path.resolve(spec)];
  let sections = {};

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !entry.from) continue;

    const expanded = resolveVariables(String(entry.from), variables, { diagnostics, file: spec });
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

  const expanded = resolveVariables(rawPath, variables, { diagnostics, file: spec });
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

  const source = fs.readFileSync(resolved, 'utf8');

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

function parseSelectorList(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v);
  return [];
}

function report(diagnostics, severity, code, message, file) {
  diagnostics[severity](code, message, { file });
}

module.exports = { loadComponentDocument };
