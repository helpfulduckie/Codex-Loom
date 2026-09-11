'use strict';


const fs = require('fs');
const path = require('path');

const { loadYamlDocument, YamlLoadError } = require('./yaml');
const { validate } = require('../schema');
const { COMPONENT_SCHEMA } = require('./component-schema');
const { normalizeComponent, mergeSectionRecords, applySectionSelector } = require('../model/component');
const { resolveVariables } = require('../util');
const { runExtractor } = require('../extract');
const { CODES, originWarner } = require('../diag');
const {
  attachOrigins, createOriginIndex, copyOrigins, transferOrigins, originLocation,
} = require('../origin');

function isMapping(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function loadComponentDocument(spec, options = {}) {
  const {
    diagnostics, label = 'component', variables = null, base = null, stack = [],
    dependencyLedger = null, requestedAt = null,
  } = options;

  if (!spec || typeof spec !== 'string') return null;
  if (!fs.existsSync(spec)) {
    const message = `${label} file not found: ${spec}; this component is skipped. Create the file or correct the component path.`;
    diagnostics.warn(CODES.YAML_FILE_UNREADABLE, message, requestedAt || { file: spec });
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

  const onWarn = originWarner(diagnostics, { file: spec });
  const document = attachOrigins({}, sourceMap.exportOrigins());

  const inherited = resolveImports(doc, spec, {
    diagnostics, label, variables, base, stack, onWarn, dependencyLedger, document,
  });
  const local = localSections(doc.sections, document);
  const sections = inherited === null ? local : mergeSectionRecords(inherited, local, onWarn);

  const sourced = resolveSectionSources(sections, {
    spec, base, variables, diagnostics,
  });

  const component = normalizeComponent({ ...doc, sections: sourced }, { onWarn });
  if (component.sections.length === 0) return null;
  return attachOrigins(
    { ...component, rawSections: sourced, source: spec },
    sourceMap.exportOrigins(),
  );
}

// Each section record carries its own origins, keyed relative to the section, so they
// survive the import merge and overlay by value rather than by containing document.
function localSections(sections, document) {
  if (!isMapping(sections)) return sections || {};
  const out = transferOrigins(document, {}, ['sections'], []);
  for (const [name, def] of Object.entries(sections)) {
    out[name] = isMapping(def) ? transferOrigins(document, { ...def }, ['sections', name], []) : def;
  }
  return out;
}

function resolveImports(doc, spec, options) {
  const {
    diagnostics, label, variables, base, stack, onWarn, dependencyLedger, document,
  } = options;
  const entries = Array.isArray(doc.imports) ? doc.imports : [];
  if (entries.length === 0) return null;

  const chain = [...stack, path.resolve(spec)];
  let sections = {};

  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || !entry.from) return;
    const at = (...parts) => originLocation(document, ['imports', String(index), ...parts], { file: spec });

    const expanded = resolveVariables(String(entry.from), variables, { diagnostics, location: at('from') });
    const resolved = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(base || path.dirname(spec), expanded);

    if (chain.some((seen) => seen === resolved)) {
      report(diagnostics, 'error', CODES.IMPORT_CYCLE,
        `component import cycle: "${path.basename(resolved)}" is already being resolved `
        + `further up this chain (${chain.map((p) => path.basename(p)).join(' → ')}). `
        + 'The import is skipped; nothing from it is merged. Break the cycle.',
        at('from'));
      return;
    }

    if (!fs.existsSync(resolved)) {
      report(diagnostics, 'error', CODES.IMPORT_NOT_FOUND,
        `component import not found: ${entry.from}${expanded === String(entry.from) ? '' : ` (expanded to ${expanded})`}. `
        + 'A `from:` resolves against the project base unless it is absolute — the same '
        + 'base `include:` and every `components:` entry use. Correct `from:` or add the file.',
        at('from'));
      return;
    }

    const imported = loadComponentDocument(resolved, {
      diagnostics, label, variables, base, stack: chain, dependencyLedger,
    });
    if (!imported) return;

    let contributed = tagSectionOrigins(imported.rawSections, path.basename(resolved));
    for (const { name, path: selectorPath } of parseSelectorList(entry.importVariants)) {
      const applied = applySectionSelector(contributed, name);
      contributed = applied.sections;
      if (applied.matched === 0) {
        report(diagnostics, 'warn', CODES.SELECTOR_MATCHED_NOTHING,
          `importVariants selector "${name}" matched none of the `
          + `${Object.keys(contributed).length} sections imported from `
          + `${path.basename(resolved)}. No imported section defines that variant, so the `
          + 'selector changes nothing; check the spelling or add the variant to a section.',
          at('importVariants', ...selectorPath));
      }
    }

    sections = mergeSectionRecords(sections, contributed, onWarn);
  });

  return sections;
}

// `__importedFrom` only lets a merged copy's message defer to the imported file's own
// report; the section's origins, not this name, say where it was authored.
function tagSectionOrigins(sections, fileBasename) {
  const out = {};
  for (const [name, def] of Object.entries(sections || {})) {
    if (def && typeof def === 'object' && !Array.isArray(def) && !('__importedFrom' in def)) {
      out[name] = copyOrigins(def, { ...def, __importedFrom: fileBasename });
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
        if (!isMapping(delta)) { variants[variantName] = delta; continue; }
        const view = transferOrigins(resolved, { ...delta }, ['variants', variantName], []);
        const sourced = resolveOneSource(view, `${name}/${variantName}`, options);
        if (sourced === view) { variants[variantName] = delta; continue; }
        variants[variantName] = sourced;
        transferOrigins(sourced, resolved, [], ['variants', variantName]);
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

  const at = (...parts) => originLocation(def, parts, { file: spec });
  const result = copyOrigins(def, { ...def });
  delete result.file;
  delete result.from;
  transferOrigins(null, result, [], ['file']);
  transferOrigins(null, result, [], ['from']);

  if (hasFile && hasFrom) {
    report(diagnostics, 'error', CODES.SECTION_TEXT_AND_SOURCE,
      `section "${label}" declares both "file:" and "from:" — a section takes its text from `
      + 'one source. Split the two into their own sections, which is also what lets each '
      + 'carry its own heading and position.',
      at('from'));
    return result;
  }

  if (def.text !== undefined && def.text !== null && def.text !== '') {
    report(diagnostics, 'error', CODES.SECTION_TEXT_AND_SOURCE,
      `section "${label}" declares "text:" and ${hasFile ? '"file:"' : '"from:"'} — a section `
      + 'takes its text from one source. The text is kept and the file is ignored; move the '
      + 'file into its own section if both were meant to appear; the text remains selected and the file ignored.',
      at(hasFile ? 'file' : 'from'));
    return result;
  }

  const rawPath = hasFile ? def.file : def.from.script;
  if (typeof rawPath !== 'string' || rawPath === '') {
    report(diagnostics, 'error', CODES.SECTION_SOURCE_NOT_FOUND,
      `section "${label}" has a "from:" with no "script:" naming a file to read. Add a valid script path.`,
      at('from'));
    return result;
  }

  const pathAt = hasFile ? at('file') : at('from', 'script');
  const expanded = resolveVariables(rawPath, variables, { diagnostics, location: pathAt });
  const resolved = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(base || path.dirname(spec), expanded);

  if (!fs.existsSync(resolved)) {
    report(diagnostics, 'error', CODES.SECTION_SOURCE_NOT_FOUND,
      `section "${label}" reads from "${rawPath}"`
      + `${expanded === rawPath ? '' : ` (expanded to ${expanded})`}, which does not exist. `
      + 'The path resolves against the project base unless it is absolute — the same base '
      + '`imports:`, `include:` and every `components:` entry use. Correct the path or add the file.',
      pathAt);
    return result;
  }

  const source = fs.readFileSync(resolved, 'utf8');

  if (hasFile) {
    result.text = source.trimEnd();
    return externalText(result, resolved);
  }

  const { text, error } = runExtractor(def.from.extract, source);
  if (error) {
    report(diagnostics, 'error', CODES.SECTION_EXTRACT_UNKNOWN,
      `section "${label}": ${error} Choose a supported transform.`, at('from', 'extract'));
    return result;
  }
  result.text = text;
  return externalText(result, resolved);
}

// Loaded text has no YAML path: its origin is the file it was read from, with no line.
// Findings about the declaration itself use the `file:`/`from:` origin before this runs.
function externalText(result, file) {
  const external = attachOrigins({}, createOriginIndex([{ file, path: [] }]));
  return transferOrigins(external, result, [], ['text']);
}

function parseSelectorList(value) {
  if (!value) return [];
  if (typeof value === 'string') return [{ name: value, path: [] }];
  if (Array.isArray(value)) {
    return value
      .map((name, index) => ({ name, path: [String(index)] }))
      .filter(({ name }) => typeof name === 'string' && name);
  }
  return [];
}

function report(diagnostics, severity, code, message, loc) {
  diagnostics[severity](code, message, loc);
}

module.exports = { loadComponentDocument };
