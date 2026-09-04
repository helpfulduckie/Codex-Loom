'use strict';

/**
 * Small helpers shared across the report modes (`bodysize.js`, `seedmap.js`, `provenance.js`,
 * `overview.js`, `diff.js`) — a name, a filename, a heading level, or a CSV cell, each of
 * which every mode that writes a `.md`/`.csv` pair needs the same way.
 */

const { PATH_UNSAFE_CHARS } = require('./util');

// ── csvCell ──────────────────────────────────────────────────────────────────

/**
 * Quote a CSV cell when it holds a comma, quote, or newline.
 *
 * Coalesces `undefined`/`null` to `''` before stringifying: a bare `undefined` or `null`
 * reaching output is a failure this compiler already treats as diagnosable —
 * `CL0437`/`SUSPECT_JS_WORD` flags exactly "a bare undefined/NaN appears in rendered
 * output", and Phase 8 spent a session removing the literal string `null` from compiled
 * prose. Writing those characters into a report CSV is the same failure in a different
 * output stream.
 */
function csvCell(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

// ── sanitizeFilename ─────────────────────────────────────────────────────────

const UNSAFE_FILENAME_CHARS = new RegExp('[' + PATH_UNSAFE_CHARS + ']', 'g');

function sanitizeFilename(name) {
  return name.replace(UNSAFE_FILENAME_CHARS, '_').trim();
}

// ── shiftHeadings ────────────────────────────────────────────────────────────

/** Shift markdown heading levels down by `shift` (capped at level 6). */
function shiftHeadings(content, shift) {
  if (shift <= 0) return content;
  return content.replace(/^(#{1,6})(?= )/gm, (_, hashes) => {
    const newLevel = Math.min(hashes.length + shift, 6);
    return '#'.repeat(newLevel);
  });
}

// ── branchLabel ──────────────────────────────────────────────────────────────

/** The branch names joined with ` - `, or the root directory name when there are none. */
function branchLabel(branchNames, rootDirName) {
  return branchNames.length > 0 ? branchNames.join(' - ') : rootDirName;
}

// ── leafFileName ─────────────────────────────────────────────────────────────

/**
 * The sanitized `<base>.leaf.md` filename a leaf's compiled review file is written to.
 *
 * A single-leaf scenario with no branch names falls back to the root directory name so the
 * one file it produces is not named after nothing.
 */
function leafFileName(branchNames, rootDirName, isSingleLeaf) {
  const fileBase = isSingleLeaf && branchNames.length === 0
    ? rootDirName
    : branchNames.join(' - ');
  return sanitizeFilename(fileBase || rootDirName) + '.leaf.md';
}

module.exports = {
  csvCell,
  sanitizeFilename,
  shiftHeadings,
  branchLabel,
  leafFileName,
};
