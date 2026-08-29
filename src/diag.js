'use strict';

/**
 * The diagnostic bus (v4 spec §4.4).
 *
 * Every diagnostic carries a stable code, a severity, and — where the loader could
 * supply one — a source span. Codes exist so that three things are possible that plain
 * message strings cannot support: documentation anchors, lint suppression, and test
 * assertions that survive rewording a message.
 *
 * This module is deliberately free of `fs` and `console`. `model/` is required to be
 * pure (§3.3), and it can only stay pure if reporting a problem does not mean printing
 * one. Collect diagnostics here; let the CLI decide what reaches a terminal.
 */

const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
});

const SEVERITY_LABEL = Object.freeze({
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
});

/**
 * Code bands. The spec fixes four codes by example (CL0210, CL0310, CL0442, CL0520);
 * these ranges are chosen to contain them so documented codes never have to move.
 *
 *   CL01xx  loading — file discovery, YAML parse, entry-point resolution
 *   CL02xx  schema — unknown keys, wrong types, relocation suggestions
 *   CL03xx  items — resolution, variants, imports, branch dispatch
 *   CL04xx  render — templates, functions, lint checks
 *   CL05xx  tokens — variables, roles, placeholders, scoping
 *   CL06xx  components — slots, sections, missing component sources
 *   CL07xx  emit — output layout, platform limits
 */
const CODES = Object.freeze({
  YAML_PARSE_FAILED: 'CL0101',
  YAML_FILE_UNREADABLE: 'CL0102',
  YAML_EMPTY_FILE: 'CL0103',
  YAML_NULL_DOCUMENT: 'CL0104',
  TOKEN_SWALLOWED_BY_YAML: 'CL0105',

  // Items and render (§3.2, §7). These live here rather than in `compile.js` because
  // `emit/` raises them too and cannot import from `compile.js` without a cycle.
  ITEM_RESOLUTION_FAILED: 'CL0324',
  DUPLICATE_RESOLVED_ID: 'CL0325',
  /**
   * A selector aimed at many targets that matched none of them (§7.6.2a).
   *
   * The guard that makes arity-N silence safe. A selector aimed at one target warns per
   * miss, because one miss is the whole of what it asked for; a selector aimed at every
   * item in an included file misses most of them by construction, so warning per miss is
   * noise and Step 0 silences it. What silence costs is the typo: a misspelled name applies
   * to nothing, alters no output and — without this — raises nothing at all. Three of seven
   * is normal, zero of seven is a mistake, and only the second is reported.
   */
  SELECTOR_MATCHED_NOTHING: 'CL0326',

  /**
   * The parser/eval band (§13, Phase 9). `CL0410`–`CL0412` predate this band and are
   * declared in local `CODES` tables (`loader.js`, `compile.js`) rather than here — a trap
   * for a free-code search, since grepping this registry for an open slot in `CL041x`
   * misses both. Grep the number across the repo, not the registry.
   *
   * `TEMPLATE_PARSE_FAILED` covers a malformed render-function call wherever one is found:
   * inside a `.template` file (via `render()`, with a file and — once the parser lands — a
   * line) or inside a card body field (via `applyFieldRenderFunctions`, file only — a body
   * field has no useful line within a multi-thousand-line YAML file). Both are the same
   * defect, a call that doesn't parse, found in two different kinds of source.
   */
  TEMPLATE_PARSE_FAILED: 'CL0413',
  TEMPLATE_UNKNOWN_FUNCTION: 'CL0414',
  TEMPLATE_UNCLOSED_BLOCK: 'CL0415',
  PARTIAL_CYCLE: 'CL0416',
  PARTIAL_NOT_FOUND: 'CL0417',

  /**
   * A genuine cycle in cross-item render-function dependencies (Phase 9 Step 2), replacing
   * the uncoded `console.warn` the fixpoint loop printed after `maxPasses` — this one names
   * the participating items and fields because the dependency graph now exists to ask.
   */
  CROSS_ITEM_CYCLE: 'CL0418',

  TEMPLATE_NOT_FOUND: 'CL0420',
  RENDER_FAILED: 'CL0421',

  // Leaked compile-time artifacts, found by sweeping rendered output (§12.5). Every one of
  // them means the compiler failed and the failure is visible in the file it just wrote,
  // which is a fact about the output rather than an opinion about it — so they are ERRORs
  // on the bus, and `lint.level` cannot reach them.
  //
  // They share one decade rather than filing `{%key}` under CL05xx with the other variable
  // diagnostics, because what is reported here is not the token family but the leak: one
  // detector set, run at one moment, over one finished string. Splitting them by what
  // leaked would scatter a single check across three bands.
  LEAKED_FIELD_TOKEN: 'CL0430',
  LEAKED_VARIABLE: 'CL0431',
  LEAKED_RENDER_FUNCTION: 'CL0432',
  LEAKED_TEMPLATE_TAG: 'CL0433',
  LEAKED_VERB_MARKER: 'CL0434',
  LEAKED_JS_ARTIFACT: 'CL0435',

  // The two heuristics that run in the same sweep and are *not* facts: both judge whether
  // ordinary prose was meant, and both can be wrong about it. `[does]` may be an author's
  // deliberate bracket, and "undefined" is a word. They stay WARN and are tagged opinion-
  // layer below, which is what `lint.level` reaches.
  SUSPECT_VERB_MARKER: 'CL0436',
  SUSPECT_JS_WORD: 'CL0437',

  // Tokens (§6.4, §12). `~` unbinds an inherited binding; unbinding something that was
  // never inherited is meaningless as written and reliably means the author meant to
  // include, so it warns rather than passing silently.
  PLACEHOLDER_UNBIND_UNKNOWN: 'CL0530',
  PLACEHOLDER_CYCLE: 'CL0531',
  PLACEHOLDER_UNDECLARED: 'CL0532',
  PLACEHOLDER_INVALID_CONTEXT: 'CL0533',
  PLACEHOLDER_IN_TITLE: 'CL0534',
  PLACEHOLDER_UNUSED: 'CL0535',
  PLACEHOLDER_DUPLICATE_QUESTION: 'CL0536',

  /**
   * Roles (§9.2, §9.3). A role is a per-branch name → item id binding, resolved at the
   * start of the pronoun pass (`model/pronouns.js`) before any other token lookup runs.
   * `ROLE_UNBIND_UNKNOWN` mirrors `PLACEHOLDER_UNBIND_UNKNOWN`'s shape exactly — the same
   * `~`-on-nothing-inherited mistake, one decade over. The other four are §9.3's resolution
   * rules, verbatim: one level of indirection always, a role/item-id namespace collision is
   * an ERROR, an undeclared role in a token is an ERROR, and a role bound to an item this
   * branch excludes is an ERROR.
   */
  ROLE_UNBIND_UNKNOWN: 'CL0544',
  ROLE_UNDECLARED: 'CL0540',
  ROLE_COLLIDES_WITH_ITEM: 'CL0541',
  ROLE_TARGET_EXCLUDED: 'CL0542',
  ROLE_INDIRECTION: 'CL0543',
  ROLE_UNUSED: 'CL0545',

  // Components (§7.2). Raised by `model/component.js`, which reports through `onWarn`
  // and therefore takes its severity from the table below.
  SECTION_TEXT_AND_SLOT: 'CL0601',
  SECTION_RENDERS_NOTHING: 'CL0602',
  SECTION_WRAP_UNKNOWN: 'CL0603',
  SECTION_VARIANT_NOT_FOUND: 'CL0604',

  /**
   * A component-level `branches:` dispatch that matched no section at all (§7.6.2a).
   *
   * `CL0326`'s shape one layer up, and it exists for the same reason. A dispatch on the
   * component names every section it holds, so missing most of them is normal and warning
   * per section would be noise — but a misspelled name then applies to nothing, changes no
   * output, and raises nothing. Three of seven sections is normal; zero of seven is a typo.
   */
  COMPONENT_DISPATCH_MATCHED_NOTHING: 'CL0605',

  // Component imports (§7.6).
  IMPORT_NOT_FOUND: 'CL0606',
  IMPORT_CYCLE: 'CL0607',
  IMPORT_DELETE_UNKNOWN: 'CL0608',

  // Placement (§7.4). Raised in `compile.js`, which is the only place that holds an item's
  // targets and the branch's slot set at the same time, so these carry their severity at
  // the call site and stay out of the table below.
  ITEM_NO_OUTPUT: 'CL0610',
  TARGET_UNDECLARED_SLOT: 'CL0611',
  TARGET_NOT_A_SLOT: 'CL0612',
  TARGET_NAMES_NO_SLOT: 'CL0613',
  SLOT_EMPTY: 'CL0614',
  COMPONENT_RENDERS_NOTHING: 'CL0615',

  /**
   * A leaf carrying a description and no `Opening.md` (§7.7).
   *
   * Velvet Lattice sets a node's prompt to `components["Opening"] or node.description`, so
   * a leaf with one and not the other does not produce an empty prompt — it produces the
   * store blurb as the opening scene. In v3 this could not happen, because descriptions
   * were written only at the output root; `adventureDescription:` is what makes the pairing
   * reachable, and the ERROR is the price of reaching it.
   */
  LEAF_DESCRIPTION_NO_OPENING: 'CL0616',

  // Section sources (§7.7). Resolved once per component file, where `imports:` are — a
  // `file:` read per leaf would report a missing path 32 times for The Institute.
  SECTION_SOURCE_NOT_FOUND: 'CL0617',
  SECTION_EXTRACT_UNKNOWN: 'CL0618',
  SECTION_TEXT_AND_SOURCE: 'CL0619',

  /** `metadata:` on a component whose output has nowhere to put frontmatter (§7.7). */
  COMPONENT_METADATA_UNSUPPORTED: 'CL0620',

  /** Both description keys aimed at one `Description.md` — an unbranched root (§7.7). */
  DESCRIPTION_KEYS_COLLIDE: 'CL0621',

  /**
   * Two story cards share a name across different types on the same leaf (§8, Phase 10
   * Decision 3). Velvet Lattice's `_merge_story_cards` keys on `name` alone, so the two
   * collide and the winner is position-dependent. Today every leaf holds full copies, so
   * the resolution is stable; under inheritance it will not be. WARN rather than ERROR
   * because the hazard is latent rather than live.
   */
  CARD_NAME_COLLISION: 'CL0622',

  /**
   * §7.8's `render.storyCards` entries. Raised in `compile.js`, which is the only place
   * that holds the component's sections and the leaf's occupants at once — so, like the
   * placement codes above, they carry severity at the call site and are absent from
   * `SEVERITY_BY_CODE`.
   *
   * `NO_TITLE` is an ERROR because the title is the card's AID name and the frontier keys
   * on it — an untitled entry has nowhere to land. `UNKNOWN_SECTION` and `RENDERS_NOTHING`
   * are WARNs: the component field still ships, so a broken alternate is a lost card rather
   * than a broken compile.
   */
  STORY_CARD_ENTRY_NO_TITLE: 'CL0623',
  STORY_CARD_ENTRY_UNKNOWN_SECTION: 'CL0624',
  STORY_CARD_ENTRY_RENDERS_NOTHING: 'CL0625',

  /**
   * `aid.type` as a path segment, and what a case-insensitive filesystem does with two of
   * them (§8).
   *
   * `aid.type` becomes `Story Cards/{type}/{type}.md`. On Windows and macOS `Character/`
   * and `character/` are one directory and one file, so two type groups that differ only
   * in case are written to the same path and the second write destroys the first. The
   * compiler counts both groups, so the run reports the full card count and ships fewer
   * cards — the failure is silent in the one place an author would look to catch it.
   *
   * ERROR, on `CL0622`'s reasoning: Velvet Lattice merging two cards by name is the same
   * shape of loss, and an author who wrote a case-variant pair is always wrong. It is
   * checked after normalization, so a pair that folds to one built-in (`Character` and
   * `character`) is a merge the compiler performed on purpose and not reported here —
   * only a pair that still differs after folding still collides.
   */
  CARD_TYPE_CASE_COLLISION: 'CL0626',

  /**
   * An `aid.type` naming one of AID's five built-in card types in any casing other than
   * lowercase, folded to lowercase on the way out (§8).
   *
   * AI Dungeon stores the type string verbatim and groups by exact match, and its built-in
   * categories are lowercase — confirmed against the platform, not inferred. So `Character`
   * reaches AID as a *custom* category sitting beside the built-in `character` rather than
   * inside it. Velvet Lattice folded these itself until 0.2 dropped the normalization, and
   * nothing downstream replaced it.
   *
   * WARN, and reported once per distinct authored value rather than once per card: the fold
   * is a correction the author will want, but it changes what ships, and 27 identical lines
   * for one authoring decision would bury it.
   */
  CARD_TYPE_NORMALIZED: 'CL0627',

  /**
   * An `aid.type` with leading whitespace, trimmed on the way out (§8).
   *
   * `validateCardType` already rejects a *trailing* space or period, because Windows strips
   * those from a path segment and the type would silently become a different one. A leading
   * space survives instead: it makes a real ` Character/` directory and reaches AID as a
   * distinct category whose name differs from the obvious one by an invisible character.
   * Trimmed rather than rejected, because there is exactly one thing the author meant.
   */
  CARD_TYPE_LEADING_SPACE: 'CL0628',

  // Emit (§8). Both are facts about what Velvet Lattice can carry to AID, not opinions
  // about content — which is why they live in the compiler rather than in lint (§12.5).
  TRIGGER_CONTAINS_COMMA: 'CL0701',
  TRIGGER_EMPTY: 'CL0702',

  // Platform field caps (§8.5). Facts about what AID stores, measured after placeholder
  // substitution because Velvet Lattice expands `%key%` to its longer question text on the
  // way there. Each cap needs two codes rather than one: severity is a property of the
  // code (see `SEVERITY_BY_CODE` below), so a band and its cap cannot share one.
  OPENING_OVER_LIMIT: 'CL0710',
  OPENING_NEAR_LIMIT: 'CL0711',
  CARD_BODY_OVER_LIMIT: 'CL0712',
  CARD_BODY_NEAR_LIMIT: 'CL0713',
  NOTES_OVER_LIMIT: 'CL0714',
  NOTES_NEAR_LIMIT: 'CL0715',
});

/**
 * Severity by code, for diagnostics that arrive through a channel that cannot carry one.
 *
 * `model/` reports through `onWarn(code, message)` (§3.3) — two arguments, no severity —
 * so severity has to be recoverable from the code alone. This table is the code-side copy
 * of the severity column in `documentation/11-diagnostics.md`, and a test asserts the two
 * agree. Codes raised by modules that call `diagnostics.error()`/`.warn()` directly carry
 * their severity at the call site and do not belong here.
 */
const SEVERITY_BY_CODE = Object.freeze({
  CL0320: SEVERITY.WARN,
  CL0530: SEVERITY.WARN,
  CL0531: SEVERITY.ERROR,
  CL0532: SEVERITY.ERROR,
  CL0533: SEVERITY.ERROR,
  CL0534: SEVERITY.WARN,
  CL0535: SEVERITY.WARN,
  CL0536: SEVERITY.WARN,
  CL0321: SEVERITY.WARN,
  CL0322: SEVERITY.WARN,
  CL0323: SEVERITY.ERROR,
  CL0330: SEVERITY.WARN,
  CL0601: SEVERITY.ERROR,
  CL0602: SEVERITY.WARN,
  CL0603: SEVERITY.WARN,
  CL0604: SEVERITY.WARN,
  CL0605: SEVERITY.WARN,
  CL0608: SEVERITY.WARN,
  CL0622: SEVERITY.ERROR,
  CL0626: SEVERITY.ERROR,
  CL0627: SEVERITY.WARN,
  CL0628: SEVERITY.WARN,
  CL0430: SEVERITY.ERROR,
  CL0431: SEVERITY.ERROR,
  CL0432: SEVERITY.ERROR,
  CL0433: SEVERITY.ERROR,
  CL0434: SEVERITY.ERROR,
  CL0435: SEVERITY.ERROR,
  CL0436: SEVERITY.WARN,
  CL0437: SEVERITY.WARN,
  CL0512: SEVERITY.WARN,
  CL0540: SEVERITY.ERROR,
  CL0541: SEVERITY.ERROR,
  CL0542: SEVERITY.ERROR,
  CL0543: SEVERITY.ERROR,
  CL0544: SEVERITY.WARN,
  CL0545: SEVERITY.WARN,
});

/** WARN is the default: an unregistered code is still reported, never silently dropped. */
function severityOf(code) {
  return SEVERITY_BY_CODE[code] || SEVERITY.WARN;
}

// ── the compiler / lint split (§12.5) ────────────────────────────────────────

/**
 * The opinion layer, by code.
 *
 * §12.5 draws one line: compiler diagnostics are facts about the output, lint findings are
 * opinions about its quality. The line is about *what a check claims*, not about where the
 * code that runs it lives — `CL0535` and `CL0536` are opinions computed inside the compile
 * because they need the branch-merged placeholder table, and `CL0436`/`CL0437` are opinions
 * found by the same sweep that finds six facts. Both cases are tagged here rather than
 * relocated, because where a check runs and which layer it belongs to are separate
 * questions.
 *
 * Membership is the whole of what `lint.level` can reach. Everything absent from this set
 * is a fact, and an author cannot silence a fact — which is what makes `level: off` a safe
 * thing to write (§12.5).
 */
const OPINION_CODES = Object.freeze(new Set([
  'CL0436', // bracketed word that isn't a real verb-conjugation marker
  'CL0437', // bare "undefined"/"NaN", which is also two English words
  'CL0535', // a placeholder declared and never referenced beneath its declaring node
  'CL0536', // two placeholder keys declaring the same question text
]));

function isOpinion(code) {
  return OPINION_CODES.has(code);
}

/** The three values `lint.level` and `--lint-level` accept, in the order they say less. */
const LINT_LEVELS = Object.freeze(['off', 'error', 'warn']);

const SEVERITY_RANK = Object.freeze({ [SEVERITY.INFO]: 0, [SEVERITY.WARN]: 1, [SEVERITY.ERROR]: 2 });

/**
 * Apply a `lint.level` to one opinion-layer diagnostic. Returns the severity it reaches the
 * author at, or `null` if it does not reach them at all.
 *
 * **`level` names the one severity the opinion layer is allowed to speak at.** Clamp the
 * diagnostic to it, then drop whatever is left below it — one rule, and it is the only rule
 * that satisfies both things §12.5 asks for. Under `warn` an opinion ERROR demotes to WARN,
 * so nothing in the opinion layer can fail a build; under `error` the prose heuristics, all
 * of them WARN, disappear and pack findings about mod config survive at full severity. That
 * second case is the author-facing meaning the docs lead with: *validate my mod configs,
 * skip the prose heuristics*.
 *
 * Unset is not a level. A project that says nothing gets every opinion at the severity it
 * was raised with, which is what keeps a pack ERROR able to fail a build by default.
 */
function applyLintLevel(severity, level) {
  if (!level) return severity;
  if (level === 'off') return null;
  const ceiling = level === 'error' ? SEVERITY.ERROR : SEVERITY.WARN;
  const clamped = SEVERITY_RANK[severity] <= SEVERITY_RANK[ceiling] ? severity : ceiling;
  return SEVERITY_RANK[clamped] < SEVERITY_RANK[ceiling] ? null : clamped;
}

/**
 * Adapt a `Diagnostics` bus to the `onWarn(code, message)` callback `model/` expects.
 *
 * The severity comes from the code, so an ERROR raised inside a pure module reaches the bus
 * as an ERROR and gates the exit code like any other — which is the whole point: the old
 * console adapter printed `WARN` for everything and gated nothing.
 */
function busWarner(diagnostics, loc) {
  return (code, message) => diagnostics.add(severityOf(code), code, message, loc || {});
}

/**
 * One diagnostic. `file`/`line`/`col` are optional throughout: a diagnostic about a
 * whole project has no span, and template-level errors keep imprecise positions until
 * the render rewrite (§13). A missing span degrades the rendering, never the code.
 */
class Diagnostic {
  constructor({ code, severity, message, file, line, col, hint }) {
    this.code = code;
    this.severity = severity;
    this.message = message;
    this.file = file || null;
    this.line = typeof line === 'number' ? line : null;
    this.col = typeof col === 'number' ? col : null;
    this.hint = hint || null;
  }

  /** `file:line:col`, degrading gracefully as position information runs out. */
  get location() {
    if (!this.file) return '';
    if (this.line === null) return this.file;
    if (this.col === null) return `${this.file}:${this.line}`;
    return `${this.file}:${this.line}:${this.col}`;
  }

  /**
   * The §4.4 shape:
   *
   *   ERROR CL0310 codex/npcs.cl.yaml:112:9
   *     Item "Kaiden" dispatches branch "felix" to variant "Felix", which is not
   *     defined on this item or on canon item "Kaiden" (canon:main).
   */
  format() {
    const head = [SEVERITY_LABEL[this.severity] || this.severity, this.code, this.location]
      .filter(Boolean)
      .join(' ');
    const indent = (text) => String(text).split('\n').map((l) => `  ${l}`).join('\n');
    const parts = [head, indent(this.message)];
    if (this.hint) parts.push(indent(this.hint));
    return parts.join('\n');
  }

  toString() {
    return this.format();
  }
}

/** A collector. Nothing is printed; callers decide what to do with what accumulates. */
class Diagnostics {
  /**
   * `lintLevel` is the §12.5 ceiling, and it is applied here — at `add` — rather than at
   * print time. Everything downstream reads the bus: `hasErrors()` gates the exit code, the
   * printer walks `all`, and the pathological fixture snapshots it. Filtering in one of
   * those places and not the others is how a silenced diagnostic still fails a build.
   */
  constructor(options = {}) {
    this._items = [];
    this._lintLevel = options.lintLevel || null;
  }

  /** Set after construction, for the bus that exists before `compile.cl.yaml` is read. */
  setLintLevel(level) {
    this._lintLevel = level || null;
    return this;
  }

  get lintLevel() {
    return this._lintLevel;
  }

  add(severity, code, message, loc = {}, opts = {}) {
    let effective = severity;
    if (this._lintLevel && isOpinion(code)) {
      effective = applyLintLevel(severity, this._lintLevel);
      if (effective === null) return null;
    }
    const diag = new Diagnostic({
      code,
      severity: effective,
      message,
      file: loc.file,
      line: loc.line,
      col: loc.col,
      hint: opts.hint,
    });
    this._items.push(diag);
    return diag;
  }

  error(code, message, loc, opts) {
    return this.add(SEVERITY.ERROR, code, message, loc, opts);
  }

  warn(code, message, loc, opts) {
    return this.add(SEVERITY.WARN, code, message, loc, opts);
  }

  info(code, message, loc, opts) {
    return this.add(SEVERITY.INFO, code, message, loc, opts);
  }

  /** Absorb another collector's diagnostics — for folding a sub-compile's results up. */
  merge(other) {
    if (!other) return this;
    const items = Array.isArray(other) ? other : other.all;
    this._items.push(...items);
    return this;
  }

  get all() {
    return this._items.slice();
  }

  bySeverity(severity) {
    return this._items.filter((d) => d.severity === severity);
  }

  get errors() {
    return this.bySeverity(SEVERITY.ERROR);
  }

  get warnings() {
    return this.bySeverity(SEVERITY.WARN);
  }

  hasErrors() {
    return this._items.some((d) => d.severity === SEVERITY.ERROR);
  }

  get length() {
    return this._items.length;
  }

  isEmpty() {
    return this._items.length === 0;
  }

  clear() {
    this._items = [];
    return this;
  }

  format() {
    return this._items.map((d) => d.format()).join('\n\n');
  }

  toString() {
    return this.format();
  }
}

module.exports = {
  Diagnostic, Diagnostics, SEVERITY, SEVERITY_LABEL, CODES, SEVERITY_BY_CODE, severityOf, busWarner,
  OPINION_CODES, isOpinion, LINT_LEVELS, applyLintLevel,
};
