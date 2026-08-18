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
  TEMPLATE_NOT_FOUND: 'CL0420',
  RENDER_FAILED: 'CL0421',

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

  // Components (§7.2). Raised by `model/component.js`, which reports through `onWarn`
  // and therefore takes its severity from the table below.
  SECTION_TEXT_AND_SLOT: 'CL0601',
  SECTION_RENDERS_NOTHING: 'CL0602',
  SECTION_WRAP_UNKNOWN: 'CL0603',
  SECTION_VARIANT_NOT_FOUND: 'CL0604',

  // Placement (§7.4). Raised in `compile.js`, which is the only place that holds an item's
  // targets and the branch's slot set at the same time, so these carry their severity at
  // the call site and stay out of the table below.
  ITEM_NO_OUTPUT: 'CL0610',
  TARGET_UNDECLARED_SLOT: 'CL0611',
  TARGET_NOT_A_SLOT: 'CL0612',
  TARGET_NAMES_NO_SLOT: 'CL0613',
  SLOT_EMPTY: 'CL0614',
  COMPONENT_RENDERS_NOTHING: 'CL0615',

  // Emit (§8). Both are facts about what Velvet Lattice can carry to AID, not opinions
  // about content — which is why they live in the compiler rather than in lint (§12.5).
  TRIGGER_CONTAINS_COMMA: 'CL0701',
  TRIGGER_EMPTY: 'CL0702',
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
});

/** WARN is the default: an unregistered code is still reported, never silently dropped. */
function severityOf(code) {
  return SEVERITY_BY_CODE[code] || SEVERITY.WARN;
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
  constructor() {
    this._items = [];
  }

  add(severity, code, message, loc = {}, opts = {}) {
    const diag = new Diagnostic({
      code,
      severity,
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

module.exports = { Diagnostic, Diagnostics, SEVERITY, SEVERITY_LABEL, CODES, SEVERITY_BY_CODE, severityOf, busWarner };
