'use strict';

const fs = require('fs');
const path = require('path');
const { loadYaml } = require('./loader/yaml');

/**
 * Every suffix Codex Loom will read a YAML document from (§4.6).
 *
 * `.cl.yaml` is what v4 authors write: once a value may legally begin with an unquoted
 * `{$`, the file is not valid YAML, and the composite extension keeps generic YAML
 * tooling from claiming it while still reading as YAML-shaped to a human.
 *
 * `.yml` is here because v3's `findFiles` matched `.yaml` alone and silently ignored
 * `.yml` — a file that looks like it should load and simply does not. Once `.yml` is
 * accepted, `.cl.yml` has to be too, or the composite form would be arbitrarily narrower
 * than the plain one. §4.6 names only the `.cl.yaml`/`.yaml` pair because it was written
 * against the assumption that `.yml` was already handled.
 *
 * Plain `.yaml`/`.yml` are not deprecated and get no warning; `--migrate` renames only
 * when asked.
 */
const YAML_SUFFIXES = Object.freeze(['.cl.yaml', '.cl.yml', '.yaml', '.yml']);

/** Config entry points, in the order they are searched (§4.6). */
const CONFIG_BASENAMES = Object.freeze([
  'compile.cl.yaml', 'compile.cl.yml', 'compile.yaml', 'compile.yml',
]);

/**
 * The reporter `model/` expects, wired to the console in the v3 format.
 *
 * `model/` takes no `console` (§3.3), so it reports through a caller-supplied
 * `onWarn(code, message)`. This is the adapter the compile phases pass until they are
 * carrying a diagnostics bus of their own; it prints exactly what v3 printed, so moving
 * the modules changed no output.
 */
function consoleWarner(code, message) {
  console.warn(`  WARN: ${message}`);
}

function hasSuffix(name, suffixes) {
  const lower = name.toLowerCase();
  return suffixes.some((s) => lower.endsWith(s));
}

/**
 * Recursively collect files matching one suffix or a list of them.
 *
 * Symlinks are followed, with broken ones skipped rather than thrown.
 */
function findFiles(dir, ext) {
  const suffixes = Array.isArray(ext) ? ext : [ext];
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          results.push(...findFiles(full, suffixes));
        } else if (stat.isFile() && hasSuffix(entry.name, suffixes)) {
          results.push(full);
        }
      } catch (_) { /* broken symlink — skip */ }
    } else if (entry.isDirectory()) {
      results.push(...findFiles(full, suffixes));
    } else if (entry.isFile() && hasSuffix(entry.name, suffixes)) {
      results.push(full);
    }
  }
  return results;
}

// `loadYaml` now lives in loader/yaml.js, which parses with position tracking so
// diagnostics can name a line and column (§4.4). It is re-exported here unchanged so
// the existing call sites — and loader.js's own re-export — keep working.

function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deepClone(v);
  return out;
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

function normalizeVarKey(key) {
  return VAR_ALIASES.has(key.toLowerCase()) ? 'v' : key;
}

/**
 * Expand {%key} variable references in a string.
 * Cycle-detects via a resolving Set.
 */
function resolveVariables(text, variables, _resolving) {
  if (!variables || typeof text !== 'string') return text;
  if (!_resolving) _resolving = new Set();

  return text.replace(/\{%([^}]+)\}/g, (match, key) => {
    const lower = key.trim().toLowerCase();
    if (_resolving.has(lower)) {
      console.warn(`  WARN: cycle detected in variable "{%${key}}"`);
      return match;
    }
    const actualKey = Object.keys(variables).find(k => k.toLowerCase() === lower);
    if (actualKey === undefined) {
      console.warn(`  WARN: variable "{%${key}}" not declared`);
      return match;
    }
    _resolving.add(lower);
    const expanded = resolveVariables(String(variables[actualKey]), variables, _resolving);
    _resolving.delete(lower);
    return expanded;
  });
}

/**
 * Walk the text-bearing sections of an item (body, aid, render, name) and apply
 * `transform(str) → str` to every string value (array elements mapped, nested
 * objects recursed). Mutates the item in place.
 *
 * This is the single place the set of `{$…}`/text sections lives, so the field
 * interpolation, cross-item, and pronoun passes all reach the same fields.
 * `name` is normalized to an object ({display, full, …}) by resolveItem before
 * any of these passes run.
 */
function walkItemTextFields(item, transform) {
  if (!item) return;
  for (const section of [item.body, item.aid, item.render, item.name]) {
    if (section && typeof section === 'object') walkTextRecursive(section, transform);
  }
}

/**
 * The render context for an item: its top-level fields, with the open namespaces
 * defaulted to {} so field lookups never hit undefined. `extra` merges in per-caller
 * additions (e.g. itemMap for cross-item render functions).
 *
 * `body`/`aid`/`render`/`v` keep object identity when present — callers that mutate
 * item.body through the context depend on that.
 */
function itemContext(item, extra) {
  return {
    id:       item.id,
    name:     item.name,
    pronouns: item.pronouns,
    aid:      item.aid    || {},
    render:   item.render || {},
    body:     item.body   || {},
    v:        item.v      || {},
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

// ── mechanical syntax patterns ──────────────────────────────────────────────
//
// Single source of truth for every compile-time artifact pattern that should
// never survive into rendered output. Shared between the automatic per-write
// safety net below and the standalone `--lint` post-hoc scanner (src/lint.js),
// so the two never drift out of sync with each other or with the token list
// documented in documentation/06-field-operations.md, 07-templates.md, and
// 08-pronouns.md.

const FIELD_TOKEN_RE    = /\{\$[^{}]+\}/g;
const VAR_TOKEN_RE       = /\{%[^}]+\}/g;
const TEMPLATE_FN_RE     = /\{(?:join|list|and|prose|block|keys|inline)\([^{}]*\)\}/g;
const TEMPLATE_TAG_RE    = /\{\/?if\b[^{}]*\}|\{\/?wrapper\}|\{\/?preserve\}|\{include\s+[^{}]+\}/g;
const VERB_MARKER_RE     = /\[(?:s|es|is|was|has)\]/g;
// A bracketed lowercase word that looks like an *attempted* verb-conjugation
// marker but isn't one of the five real ones ([s]/[es]/[is]/[was]/[has]) or
// the unrelated [e] background-knowledge marker — e.g. an author writing
// "[does]" or "[have]" from a guess rather than the documented marker list.
// Real bracket usage elsewhere ([Secret: ...], [object Object]) always has
// a capital letter, punctuation, or a space, so it never matches this shape.
const SUSPECT_VERB_MARKER_RE = /\[(?!s\]|es\]|is\]|was\]|has\]|e\])[a-z]{1,8}\]/g;
const JS_ARTIFACT_RE     = /\[object (?:Object|Undefined|Null|Array)\]/g;
const JS_WORD_RE         = /\b(?:undefined|NaN)\b/g;

/**
 * Blank out the content of every VL front-matter fence (`~~~ ... ~~~`),
 * preserving newlines so line numbers stay aligned. The fence only ever holds
 * `triggers: [...]`, `encapsulate: ...`, and `notes: [e]` — a single-word
 * trigger array like `triggers: [door]` is a legitimate AID trigger, not an
 * attempted (and mistyped) verb-conjugation marker, so the suspect-verb-marker
 * heuristic should never see it. Other checks still scan the fence normally.
 *
 * What counts as a fence is `emit/vl.js`'s to define (§8.6). This delegates rather
 * than keeping a second, slightly different regex — the local one was unanchored, so
 * it also treated a mid-line `~~~` as a delimiter.
 */
function maskFencedRegions(text) {
  return require('./emit/vl').maskFences(text);
}

/**
 * Warn about every distinct match of `re` found in `text`, one line per
 * distinct match (not per occurrence). Resets `re.lastIndex` first since
 * these are shared, stateful `g`-flag RegExp objects.
 */
function warnPattern(text, label, re, describe) {
  if (typeof text !== 'string') return false;
  const seen = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      console.warn(`  WARN: ${describe(m[0])} in ${label}`);
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  return seen.size > 0;
}

/**
 * Final safety net: warn about any {$…} field/pronoun/character token left
 * unresolved in rendered output (an item or component). Emits one warning per
 * distinct leftover token.
 *
 * Targets {$…} only — {%…} is handled by warnUnexpandedVariables, and {@…} is
 * intentionally never expanded in item content.
 *
 * @param {string} text   - the fully-rendered output to scan
 * @param {string} label  - human-readable location, e.g. 'item "Aria" (Character)'
 * @returns {boolean}     - true if any unresolved token was found
 */
function warnUnresolvedFieldTokens(text, label) {
  return warnPattern(text, label, FIELD_TOKEN_RE, m => `unresolved token ${m}`);
}

/**
 * Final safety net: warn about any {%variable} token left unexpanded in rendered
 * output (an item or component). Emits one warning per distinct leftover token.
 *
 * Targets {%...} only — {@...} is intentionally not expanded in item content, so
 * a literal {@...} here is expected and must not be flagged.
 *
 * @param {string} text   - the fully-rendered output to scan
 * @param {string} label  - human-readable location, e.g. 'item "Aria" (Character)'
 * @returns {boolean}     - true if any unexpanded variable was found
 */
function warnUnexpandedVariables(text, label) {
  return warnPattern(text, label, VAR_TOKEN_RE, m => `unexpanded variable ${m}`);
}

/**
 * Final safety net: warn about mechanical compile-time artifacts other than
 * the {$…}/{%…} tokens above — leaked render functions ({join}/{list}/...),
 * leaked template control tags ({if}/{wrapper}/{preserve}/{include}),
 * unresolved verb-conjugation markers ([s]/[is]/[was]/...), and JS
 * interpolation failures ([object Object], bare undefined/NaN). Emits one
 * warning per distinct leftover match.
 *
 * @param {string} text   - the fully-rendered output to scan
 * @param {string} label  - human-readable location, e.g. 'item "Aria" (Character)'
 * @returns {boolean}     - true if any artifact was found
 */
function warnMechanicalArtifacts(text, label) {
  let found = false;
  found = warnPattern(text, label, TEMPLATE_FN_RE,  m => `leaked render function ${m}`) || found;
  found = warnPattern(text, label, TEMPLATE_TAG_RE, m => `leaked template tag ${m}`) || found;
  found = warnPattern(text, label, VERB_MARKER_RE,  m => `unresolved verb-conjugation marker ${m}`) || found;
  found = warnPattern(maskFencedRegions(text), label, SUSPECT_VERB_MARKER_RE, m => `bracketed "${m}" isn't a recognized verb-conjugation marker ([s]/[es]/[is]/[was]/[has]) or [e] — possible typo`) || found;
  found = warnPattern(text, label, JS_ARTIFACT_RE,  m => `JS interpolation artifact ${m}`) || found;
  found = warnPattern(text, label, JS_WORD_RE,      m => `possible JS interpolation artifact "${m}"`) || found;
  return found;
}

module.exports = {
  findFiles, loadYaml, deepClone, findKey, getCI, setCI, deleteCI, VAR_ALIASES, normalizeVarKey,
  YAML_SUFFIXES, CONFIG_BASENAMES, hasSuffix, consoleWarner,
  resolveVariables, warnUnexpandedVariables, walkItemTextFields, itemContext, warnUnresolvedFieldTokens,
  warnMechanicalArtifacts, maskFencedRegions,
  FIELD_TOKEN_RE, VAR_TOKEN_RE, TEMPLATE_FN_RE, TEMPLATE_TAG_RE, VERB_MARKER_RE, SUSPECT_VERB_MARKER_RE, JS_ARTIFACT_RE, JS_WORD_RE,
};
