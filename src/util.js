'use strict';

const fs = require('fs');
const path = require('path');
const { loadYaml } = require('./loader/yaml');
const { CODES: DIAG_CODES, severityOf } = require('./diag');
const { FUNCTION_NAMES } = require('./render/parse');

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
 * Reserved filenames the loader must not treat as an item even though they sit beside
 * items (§9.4.2). `library.cl.yaml` is the per-library-set manifest; excluded from item
 * loading (Decision 3, Phase 8) rather than parsed, since parsing it is deferred past
 * Phase 8.
 *
 * Named for the library sets it describes, but the skip is not scoped to them: this list
 * is consulted wherever `loadItemsFromDir` walks, project item directories included, so
 * one basename means one thing everywhere. It was `canon.cl.yaml` until 2026-09-01 —
 * renamed because §11.0 retired "canon" as the mechanism word, and a reserved filename the
 * compiler matches by name is a mechanism. Nothing read it, so there is no compatibility
 * shim: a leftover `canon.cl.yaml` now loads as an ordinary item and reports as one.
 */
const RESERVED_LIBRARY_BASENAMES = Object.freeze(['library.cl.yaml']);

/**
 * Characters illegal in a Windows/Unix path segment, as a character-class source
 * fragment rather than a finished `RegExp` — shared by `overview.js`'s `sanitizeFilename`
 * and `cardType.js`, since they need different flags (`g` for a global replace, none for a
 * single test) and one extends the class with control characters. Callers wrap it in
 * `[...]` and add whatever flags they need: `new RegExp('[' + PATH_UNSAFE_CHARS + ']', 'g')`.
 */
const PATH_UNSAFE_CHARS = '<>:"/\\\\|?*';

function hasSuffix(name, suffixes) {
  const lower = name.toLowerCase();
  return suffixes.some((s) => lower.endsWith(s));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Recursively collect files matching one suffix or a list of them.
 *
 * Symlinks are followed, with broken ones skipped rather than thrown.
 *
 * `sort` orders each directory's entries by `localeCompare` before descending; it defaults
 * to `false` so every existing caller keeps `readdirSync`'s raw order unchanged.
 */
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

/**
 * Every file under `dir`, as sorted paths relative to it — not suffix-filtered, so a
 * companion file beside a matched one (a `.md` beside a `.yaml`) survives alongside it.
 */
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

// `loadYaml` now lives in loader/yaml.js, which parses with position tracking so
// diagnostics can name a line and column (§4.4). It is re-exported here unchanged so
// the existing call sites keep working.

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
 *
 * `meta` is present so the §8.2.2 annotation channel is branch-addressable: a variant may
 * set `meta.duckieConv.role` on one branch and leave it default on another, and it must
 * resolve per leaf like every other whole-value field. Without it a variant `meta:` delta
 * falls through to `body.meta` and never reaches the card fence (Phase 16).
 */
const ITEM_TOP_LEVEL_FIELDS = Object.freeze(['name', 'pronouns', 'aid', 'render', 'v', 'notes', 'kind', 'meta']);

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
 * Expand `{%key}` variable references in a string, recursively and cycle-safe.
 *
 * The compiler's one variable expander, for `compile.yaml` values as well as item,
 * component and placeholder content. It raises `CL0510` for an undeclared name, `CL0511`
 * for a cycle, and `CL0520` when the caller supplies `branchOnly`. Canon and library names
 * are exposed as `{%}` variables (§6.1), so `{%characters}/Aness.yaml` in an `include:`
 * path resolves through here like any other reference. v3's separate `{@name}` system is
 * gone (§6.1); a stray `{@...}` is left untouched, since the migrator rewrites them before
 * v4 sees the file.
 *
 * `sink` routes problems onto the bus as ERRORs, and its `diagnostics` is required:
 *   `file`        the file to name when there is no finer position
 *   `location`    a source-map `{file, line, col}`; preferred over `file` when present
 *   `branchOnly`  names declared only under a branch, enabling the §5.1 check below
 */
function resolveVariables(text, variables, sink = {}) {
  if (typeof text !== 'string') return text;
  const { diagnostics, file, location, branchOnly = null } = sink;

  // An absent variables map is an empty one, not a reason to skip checking. A config with
  // no `variables:` block that nevertheless references `{%role}` has exactly the problem
  // this reports, and returning early here would hide it.
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
    // A present-but-null key (`~`, or a bare `key:` with nothing after it) is unbound, not
    // declared — treating it as declared renders the literal string "null" into compiled
    // prose, which Phase 8 measured and fixed here. The config-time expander kept the old
    // behavior until the two merged, so `~` now unbinds the same way in both.
    if (actualKey === undefined || declared[actualKey] === null || declared[actualKey] === undefined) {
      // §5.1's distinction, and the reason it needs its own code: a name declared only
      // under a branch is not a typo, it is a scoping mistake. Reporting it as undeclared
      // would send the author hunting for a declaration that exists.
      if (branchOnly && branchOnly.has(lower)) {
        diagnostics.error(
          DIAG_CODES.VARIABLE_PRE_BRANCH,
          `"{%${key}}" is declared only under a branch, but this value resolves before `
          + 'branches are enumerated.',
          loc,
          { hint: 'Only root-level variables are available in include/import paths and under structure:.' },
        );
      } else {
        diagnostics.error(DIAG_CODES.VARIABLE_UNDECLARED, `variable "{%${key}}" is not declared`, loc);
      }
      return match;
    }

    return expand(String(declared[actualKey]), [...chain, lower]);
  });

  return expand(text, []);
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
 * The fixed top-level keys `itemContext` attaches to every item's render context.
 * Exported so a caller that needs to recognize "one of the keys every context carries"
 * (e.g. compile.js's cross-item reference scan, distinguishing those from a body field)
 * reads this list rather than restating it by hand.
 */
const ITEM_CONTEXT_KEYS = Object.freeze(['id', 'name', 'pronouns', 'aid', 'render', 'body', 'v', 'notes']);

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

/**
 * Shared generic recursion over a value graph: string values are passed through `transform`,
 * arrays are mapped leaving non-string elements alone, plain objects recurse. It inspects no
 * key names, so which top-level fields a given pass walks is entirely up to the caller — each
 * caller starts the walk from a deliberately different set (`walkItemTextFields` covers
 * body/aid/render/name; `applyVariableInterpolation` covers those plus `id`, since a variable
 * can appear in an item id; `applyFieldRenderFunctions` covers body only). Do not unify those
 * field lists — the difference is intentional, not incidental.
 */
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

/** AID's native placeholder syntax: `%key%` around a bare word, global so `replace` sees every one. */
const PLACEHOLDER_RE = /%(\w+)%/g;

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
// Alternation built from the canonical `FUNCTION_NAMES` (`render/parse.js`); the other
// seven patterns in this block stay hand-written — only the render-function name set
// is shared. Equivalent to /\{(?:inline|join|list|and|prose|block|keys)\([^{}]*\)\}/g.
const TEMPLATE_FN_RE     = new RegExp('\\{(?:' + FUNCTION_NAMES.join('|') + ')\\([^{}]*\\)\\}', 'g');
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
 * preserving newlines so line numbers stay aligned. The fence holds
 * `triggers: [...]` and `encapsulate: ...` — a single-word
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
 * `sink.diagnostics` is required; a caller that only wants the boolean return must still
 * pass a bus to catch the findings.
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
      diagnostics.add(severityOf(code), code, `${describe(m[0])} in ${label}`, { file });
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
  findFiles, readFileTrim, listFilesRelative, loadYaml, deepClone, findKey, getCI, setCI, deleteCI, VAR_ALIASES, normalizeVarKey,
  ITEM_TOP_LEVEL_FIELDS, NOTES_ALIASES, normalizeNotesKey,
  YAML_SUFFIXES, CONFIG_BASENAMES, RESERVED_LIBRARY_BASENAMES, hasSuffix, PATH_UNSAFE_CHARS, PLACEHOLDER_RE, isPlainObject,
  resolveVariables, checkUnexpandedVariables, walkItemTextFields, walkTextRecursive, itemContext, ITEM_CONTEXT_KEYS, checkUnresolvedFieldTokens,
  checkMechanicalArtifacts, maskFencedRegions,
  FIELD_TOKEN_RE, VAR_TOKEN_RE, TEMPLATE_FN_RE, TEMPLATE_TAG_RE, VERB_MARKER_RE, SUSPECT_VERB_MARKER_RE, JS_ARTIFACT_RE, JS_WORD_RE,
};
