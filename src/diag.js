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
});

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

module.exports = { Diagnostic, Diagnostics, SEVERITY, SEVERITY_LABEL, CODES };
