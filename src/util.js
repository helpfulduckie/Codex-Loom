'use strict';

const fs = require('fs');
const path = require('path');
const { loadYaml } = require('./loader/yaml');
const { CODES: DIAG_CODES, severityOf } = require('./diag');

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

/**
 * The top-level item fields a variant, branch or field op may modify (§4.5, §7.2).
 *
 * One list, because there were two: `model/item.js` applied import-level overrides from
 * its own copy and `model/fieldops.js` applied variant deltas from another. They agreed
 * by luck rather than by construction, and adding `notes:` to one and not the other
 * would have made a field variant-addressable in a variant and not on an import.
 *
 * `id` is absent deliberately — it is immutable to variants and branches, and moves only
 * through rename-on-import (§17.4). `body:` is absent because it is not a whole-value
 * field: deltas apply to it subfield by subfield.
 *
 * `kind` is present because a canon item's story/reference nature is a property of the
 * copy, not of the canon (§4.8): importing a narrative item and rendering it into a
 * component as a swappable alternate makes *that* copy reference material while the canon
 * item stays narrative. Author intent is what `kind:` carries, and the importer is an
 * author.
 */
const ITEM_TOP_LEVEL_FIELDS = Object.freeze(['name', 'pronouns', 'aid', 'render', 'v', 'notes', 'kind']);

/**
 * `description:` is an accepted alias for `notes:` (§4.5), normalized at the boundary so
 * nothing downstream sees which spelling arrived — the same treatment `v:`'s four aliases
 * get. The two names are a permanent split across the AID ecosystem: back-end and modding
 * contexts say `notes`, front-end and UI contexts say `description`. Requiring the right
 * one is a tax with no benefit.
 */
const NOTES_ALIASES = new Set(['notes', 'description']);

function normalizeNotesKey(key) {
  return NOTES_ALIASES.has(String(key).toLowerCase()) ? 'notes' : key;
}

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
    // §4.5: `notes:` is a top-level field like any other, so a template can read it.
    // `render.notesTemplate` is the reason it has to be here — a marker config such as
    // `notes: {known: true}` is rendered by a template that reads `{$notes.known}`.
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
 * Report every distinct match of `re` found in `text`, once per distinct match rather than
 * once per occurrence. Resets `re.lastIndex` first, since these are shared, stateful
 * `g`-flag RegExp objects.
 *
 * **Every match goes onto the diagnostic bus under `code`, and none of them go to the
 * console.** Until Phase 5 this printed a bare `WARN:` line with no code and gated nothing,
 * so a leaked `{$she}` in compiled output exited zero while `lint.js` listed the same
 * pattern as an ERROR — one check, two answers, depending on which of the two ran. §12.5
 * settles it in favour of the compiler: a leak is a fact about the output, so it is an
 * ERROR on the bus and it fails the run.
 *
 * `sink.diagnostics` is optional so the detectors stay usable as predicates, which is what
 * their boolean return is for. Every production call site passes one.
 */
function reportPattern(text, label, re, code, describe, sink = {}) {
  if (typeof text !== 'string') return false;
  const { diagnostics, file } = sink;
  const seen = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      if (diagnostics) {
        diagnostics.add(severityOf(code), code, `${describe(m[0])} in ${label}`, { file });
      }
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  return seen.size > 0;
}

/**
 * Final safety net: report any {$…} field/pronoun/character token left unresolved in
 * rendered output (an item or component). One diagnostic per distinct leftover token.
 *
 * Targets {$…} only — {%…} is handled by checkUnexpandedVariables, and {@…} is
 * intentionally never expanded in item content.
 *
 * @param {string} text   - the fully-rendered output to scan
 * @param {string} label  - human-readable location, e.g. 'item "Aria" (Character)'
 * @param {object} [sink]  - { diagnostics, file } — where findings are reported
 * @returns {boolean}     - true if any unresolved token was found
 */
function checkUnresolvedFieldTokens(text, label, sink) {
  return reportPattern(text, label, FIELD_TOKEN_RE, DIAG_CODES.LEAKED_FIELD_TOKEN,
    m => `unresolved token ${m}`, sink);
}

/**
 * Final safety net: report any {%variable} token left unexpanded in rendered output (an
 * item or component). One diagnostic per distinct leftover token.
 *
 * Targets {%...} only — {@...} is intentionally not expanded in item content, so
 * a literal {@...} here is expected and must not be flagged.
 *
 * @param {string} text   - the fully-rendered output to scan
 * @param {string} label  - human-readable location, e.g. 'item "Aria" (Character)'
 * @param {object} [sink]  - { diagnostics, file } — where findings are reported
 * @returns {boolean}     - true if any unexpanded variable was found
 */
function checkUnexpandedVariables(text, label, sink) {
  return reportPattern(text, label, VAR_TOKEN_RE, DIAG_CODES.LEAKED_VARIABLE,
    m => `unexpanded variable ${m}`, sink);
}

/**
 * Final safety net: report mechanical compile-time artifacts other than
 * the {$…}/{%…} tokens above — leaked render functions ({join}/{list}/...),
 * leaked template control tags ({if}/{wrapper}/{preserve}/{include}),
 * unresolved verb-conjugation markers ([s]/[is]/[was]/...), and JS
 * interpolation failures ([object Object], bare undefined/NaN). One diagnostic per
 * distinct leftover match.
 *
 * @param {string} text   - the fully-rendered output to scan
 * @param {string} label  - human-readable location, e.g. 'item "Aria" (Character)'
 * @param {object} [sink]  - { diagnostics, file } — where findings are reported
 * @returns {boolean}     - true if any artifact was found
 */
function checkMechanicalArtifacts(text, label, sink) {
  const C = DIAG_CODES;
  let found = false;
  found = reportPattern(text, label, TEMPLATE_FN_RE,  C.LEAKED_RENDER_FUNCTION, m => `leaked render function ${m}`, sink) || found;
  found = reportPattern(text, label, TEMPLATE_TAG_RE, C.LEAKED_TEMPLATE_TAG,    m => `leaked template tag ${m}`, sink) || found;
  found = reportPattern(text, label, VERB_MARKER_RE,  C.LEAKED_VERB_MARKER,     m => `unresolved verb-conjugation marker ${m}`, sink) || found;
  // The two opinions in the sweep (§12.5). Same loop, same text, different claim: these two
  // judge whether prose was meant, so they stay WARN and `lint.level` can reach them.
  found = reportPattern(maskFencedRegions(text), label, SUSPECT_VERB_MARKER_RE, C.SUSPECT_VERB_MARKER, m => `bracketed "${m}" isn't a recognized verb-conjugation marker ([s]/[es]/[is]/[was]/[has]) or [e] — possible typo`, sink) || found;
  found = reportPattern(text, label, JS_ARTIFACT_RE,  C.LEAKED_JS_ARTIFACT,     m => `JS interpolation artifact ${m}`, sink) || found;
  found = reportPattern(text, label, JS_WORD_RE,      C.SUSPECT_JS_WORD,        m => `possible JS interpolation artifact "${m}"`, sink) || found;
  return found;
}

module.exports = {
  findFiles, loadYaml, deepClone, findKey, getCI, setCI, deleteCI, VAR_ALIASES, normalizeVarKey,
  ITEM_TOP_LEVEL_FIELDS, NOTES_ALIASES, normalizeNotesKey,
  YAML_SUFFIXES, CONFIG_BASENAMES, hasSuffix,
  resolveVariables, checkUnexpandedVariables, walkItemTextFields, itemContext, checkUnresolvedFieldTokens,
  checkMechanicalArtifacts, maskFencedRegions,
  FIELD_TOKEN_RE, VAR_TOKEN_RE, TEMPLATE_FN_RE, TEMPLATE_TAG_RE, VERB_MARKER_RE, SUSPECT_VERB_MARKER_RE, JS_ARTIFACT_RE, JS_WORD_RE,
};
