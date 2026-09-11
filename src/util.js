'use strict';

const fs = require('fs');
const path = require('path');
const { loadYaml } = require('./loader/yaml');
const { CODES: DIAG_CODES, severityOf } = require('./diag');
const { FUNCTION_NAMES } = require('./render/parse');

const YAML_SUFFIXES = Object.freeze(['.cl.yaml', '.cl.yml', '.yaml', '.yml']);

const CONFIG_BASENAMES = Object.freeze([
  'compile.cl.yaml', 'compile.cl.yml', 'compile.yaml', 'compile.yml',
]);

const RESERVED_LIBRARY_BASENAMES = Object.freeze(['library.cl.yaml']);

const PATH_UNSAFE_CHARS = '<>:"/\\\\|?*';

// Shared by schema and reference diagnostics; transpositions count as one edit.
function damerauLevenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

function hasSuffix(name, suffixes) {
  const lower = name.toLowerCase();
  return suffixes.some((s) => lower.endsWith(s));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function findFiles(dir, ext, { sort = false } = {}) {
  const suffixes = Array.isArray(ext) ? ext : [ext];
  const results = [];
  if (!fs.existsSync(dir)) return results;
  let entries = fs.readdirSync(dir, { withFileTypes: true });
  if (sort) entries = entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          results.push(...findFiles(full, suffixes, { sort }));
        } else if (stat.isFile() && hasSuffix(entry.name, suffixes)) {
          results.push(full);
        }
      } catch (_) { /* broken symlink — skip */ }
    } else if (entry.isDirectory()) {
      results.push(...findFiles(full, suffixes, { sort }));
    } else if (entry.isFile() && hasSuffix(entry.name, suffixes)) {
      results.push(full);
    }
  }
  return results;
}

function readFileTrim(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function listFilesRelative(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}


function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deepClone(v);
  return out;
}

function transformStringValues(value, transform) {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map((entry) => transformStringValues(entry, transform));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = transformStringValues(entry, transform);
    }
    return out;
  }
  return value;
}

function findKey(obj, key) {
  if (obj === null || typeof obj !== 'object') return null;
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return k;
  }
  return null;
}

function getCI(obj, key) {
  const actual = findKey(obj, key);
  return actual !== null ? obj[actual] : undefined;
}

function setCI(obj, key, value) {
  const actual = findKey(obj, key);
  if (actual !== null) {
    obj[actual] = value;
  } else {
    obj[key] = value;
  }
}

function deleteCI(obj, key) {
  const actual = findKey(obj, key);
  if (actual !== null) delete obj[actual];
}

const VAR_ALIASES = new Set(['v', 'var', 'vars', 'variable', 'variables']);

const ITEM_TOP_LEVEL_FIELDS = Object.freeze(['name', 'pronouns', 'aid', 'render', 'v', 'notes', 'kind', 'meta']);

const NOTES_ALIASES = new Set(['notes', 'description']);

function normalizeNotesKey(key) {
  return NOTES_ALIASES.has(String(key).toLowerCase()) ? 'notes' : key;
}

function normalizeVarKey(key) {
  return VAR_ALIASES.has(key.toLowerCase()) ? 'v' : key;
}

function resolveVariables(text, variables, sink = {}) {
  if (typeof text !== 'string') return text;
  const { diagnostics, file, location, branchOnly = null } = sink;

  const declared = isPlainObject(variables) ? variables : {};
  const loc = location || { file };

  const expand = (str, chain) => str.replace(/\{%([^}]+)\}/g, (match, rawKey) => {
    const key = rawKey.trim();
    const lower = key.toLowerCase();

    const cycleAt = chain.indexOf(lower);
    if (cycleAt >= 0) {
      const loop = [...chain.slice(cycleAt), lower].join('" → "');
      diagnostics.error(DIAG_CODES.VARIABLE_CYCLE, `variable cycle: "${loop}"`, loc);
      return match;
    }

    const actualKey = Object.keys(declared).find((k) => k.toLowerCase() === lower);
    if (actualKey === undefined || declared[actualKey] === null || declared[actualKey] === undefined) {
      if (branchOnly && branchOnly.has(lower)) {
        diagnostics.error(
          DIAG_CODES.VARIABLE_PRE_BRANCH,
          `"{%${key}}" is declared only under a branch, but this value resolves before `
          + 'branches are enumerated.',
          loc,
          { hint: 'Only root-level variables are available in include/import paths and under structure:.' },
        );
      } else {
        diagnostics.error(DIAG_CODES.VARIABLE_UNDECLARED,
          `variable "{%${key}}" is not declared, so the token remains literal; declare or correct the key.`, loc);
      }
      return match;
    }

    return expand(String(declared[actualKey]), [...chain, lower]);
  });

  return expand(text, []);
}

function walkItemTextFields(item, transform) {
  if (!item) return;
  for (const section of [item.body, item.aid, item.render, item.name]) {
    if (section && typeof section === 'object') walkTextRecursive(section, transform);
  }
}

const ITEM_CONTEXT_KEYS = Object.freeze(['id', 'name', 'pronouns', 'aid', 'render', 'body', 'v', 'notes']);

function itemContext(item, extra) {
  return {
    id:       item.id,
    name:     item.name,
    pronouns: item.pronouns,
    aid:      item.aid    || {},
    render:   item.render || {},
    body:     item.body   || {},
    v:        item.v      || {},
    notes:    item.notes,
    ...extra,
  };
}

function walkTextRecursive(obj, transform) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      obj[key] = transform(val);
    } else if (Array.isArray(val)) {
      obj[key] = val.map(item => typeof item === 'string' ? transform(item) : item);
    } else if (typeof val === 'object' && val !== null) {
      walkTextRecursive(val, transform);
    }
  }
}

const PLACEHOLDER_RE = /%(\w+)%/g;


const FIELD_TOKEN_RE    = /\{\$[^{}]+\}/g;
const VAR_TOKEN_RE       = /\{%[^}]+\}/g;
const TEMPLATE_FN_RE     = new RegExp('\\{(?:' + FUNCTION_NAMES.join('|') + ')\\([^{}]*\\)\\}', 'g');
const TEMPLATE_TAG_RE    = /\{\/?if\b[^{}]*\}|\{\/?wrapper\}|\{\/?preserve\}|\{include\s+[^{}]+\}/g;
const VERB_MARKER_RE     = /\[(?:s|es|is|was|has)\]/g;
const SUSPECT_VERB_MARKER_RE = /\[(?!s\]|es\]|is\]|was\]|has\]|e\])[a-z]{1,8}\]/g;
const JS_ARTIFACT_RE     = /\[object (?:Object|Undefined|Null|Array)\]/g;
const JS_WORD_RE         = /\b(?:undefined|NaN)\b/g;

function maskFencedRegions(text) {
  return require('./emit/vl').maskFences(text);
}

// `loc` names the exact authored origin of `text` (a single declared value, e.g. one
// placeholder question); omit it when `text` is composed from several sources and no
// single origin applies, and the file-only fallback is correct.
function reportPattern(text, label, re, code, describe, sink = {}) {
  if (typeof text !== 'string') return false;
  const { diagnostics, file, loc } = sink;
  const seen = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      diagnostics.add(severityOf(code), code, `${describe(m[0])} in ${label}`, { file, ...loc });
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  return seen.size > 0;
}

function checkUnresolvedFieldTokens(text, label, sink) {
  return reportPattern(text, label, FIELD_TOKEN_RE, DIAG_CODES.LEAKED_FIELD_TOKEN,
    m => `compiled output contains unresolved token ${m}; correct the authoring reference or resolver input`, sink);
}

function checkUnexpandedVariables(text, label, sink) {
  return reportPattern(text, label, VAR_TOKEN_RE, DIAG_CODES.LEAKED_VARIABLE,
    m => `compiled output contains unexpanded variable ${m}; declare or correct the variable reference`, sink);
}

function checkMechanicalArtifacts(text, label, sink) {
  const C = DIAG_CODES;
  let found = false;
  found = reportPattern(text, label, TEMPLATE_FN_RE,  C.LEAKED_RENDER_FUNCTION, m => `compiled output contains leaked render function ${m}; remove or correct the source call`, sink) || found;
  found = reportPattern(text, label, TEMPLATE_TAG_RE, C.LEAKED_TEMPLATE_TAG,    m => `compiled output contains leaked template tag ${m}; close or correct the source tag`, sink) || found;
  found = reportPattern(text, label, VERB_MARKER_RE,  C.LEAKED_VERB_MARKER,     m => `compiled output contains unresolved verb-conjugation marker ${m}; correct the source marker or its subject`, sink) || found;
  found = reportPattern(maskFencedRegions(text), label, SUSPECT_VERB_MARKER_RE, C.SUSPECT_VERB_MARKER, m => `compiled output contains unrecognized bracketed word ${m}; replace it with a supported marker if it is a typo`, sink) || found;
  found = reportPattern(text, label, JS_ARTIFACT_RE,  C.LEAKED_JS_ARTIFACT,     m => `compiled output contains JS interpolation artifact ${m}; correct the source interpolation`, sink) || found;
  found = reportPattern(text, label, JS_WORD_RE,      C.SUSPECT_JS_WORD,        m => `compiled output contains bare ${m}; provide the source value or correct the interpolation`, sink) || found;
  return found;
}

module.exports = {
  damerauLevenshtein,
  findFiles, readFileTrim, listFilesRelative, loadYaml, deepClone, transformStringValues, findKey, getCI, setCI, deleteCI, VAR_ALIASES, normalizeVarKey,
  ITEM_TOP_LEVEL_FIELDS, NOTES_ALIASES, normalizeNotesKey,
  YAML_SUFFIXES, CONFIG_BASENAMES, RESERVED_LIBRARY_BASENAMES, hasSuffix, PATH_UNSAFE_CHARS, PLACEHOLDER_RE, isPlainObject,
  resolveVariables, checkUnexpandedVariables, walkItemTextFields, walkTextRecursive, itemContext, ITEM_CONTEXT_KEYS, checkUnresolvedFieldTokens,
  checkMechanicalArtifacts, maskFencedRegions,
  FIELD_TOKEN_RE, VAR_TOKEN_RE, TEMPLATE_FN_RE, TEMPLATE_TAG_RE, VERB_MARKER_RE, SUSPECT_VERB_MARKER_RE, JS_ARTIFACT_RE, JS_WORD_RE,
};
