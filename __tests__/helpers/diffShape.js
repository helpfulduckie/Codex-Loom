'use strict';

/**
 * Fixture diff classifier (v4 spec §14.3).
 *
 * §14.3 declares, per phase, what shape the fixture diff is allowed to take — "expected
 * diff: fence lines only. Any body-text diff is a bug." That rule is the thing that keeps
 * a re-baseline from degrading into "regenerate because it went red", but as prose it is
 * only as good as whoever reads the diff. This module makes it mechanical: it classifies
 * every changed line of a compiled `.md` as `fence`, `title` or `body`, so the harness can
 * assert the shape rather than asking a human to eyeball 890 files.
 *
 * ── Why the classes are these three ─────────────────────────────────────────
 *
 * Phase 2 moves the VL envelope out of templates and into `emit/vl.js` (§8.2). The
 * envelope is exactly two things in the emitted bytes: the `## Title` line and the
 * `~~~`-delimited fence beneath it. Everything else in a compiled card is body text
 * rendered by a template, and Phase 2 must not touch a byte of it. So `fence` + `title`
 * *is* Phase 2's expected-diff shape, expressed as a partition of the file.
 *
 * The classes are deliberately per-line rather than per-file. A card whose fence changed
 * and whose body also changed is the failure case worth catching, and a per-file verdict
 * would report it as "changed" alongside the 2,000 cards that changed correctly.
 *
 * ── Over-reporting is safe; under-reporting is not ──────────────────────────
 *
 * Every fallback here widens the changed set rather than narrowing it. An unterminated
 * fence marks the whole file `opaque`; a diff too large for the LCS table marks the whole
 * changed region as `body`. A coarse answer costs a false alarm during review. A clever
 * one that misclassified a body line as fence would wave through exactly the regression
 * this module exists to catch.
 */

/** Marks a file whose structure could not be trusted — never a passable diff shape. */
const OPAQUE = 'opaque';

/** Beyond this many cells the LCS table is skipped in favor of a coarse whole-region diff. */
const LCS_CELL_LIMIT = 4_000_000;

/**
 * Assign every line a class: `fence`, `title` or `body`.
 *
 * Returns null when the file's fences do not pair up, which the caller reports as
 * `opaque`. A trailing unterminated fence would otherwise classify the entire rest of the
 * file as `fence` and hide every body change beneath it.
 */
function classifyLines(lines) {
  const out = new Array(lines.length);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The emitter writes the delimiter on its own line, and so did every v3 template.
    if (line.trim() === '~~~') {
      out[i] = 'fence';
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out[i] = 'fence';
      continue;
    }
    out[i] = /^##\s/.test(line) ? 'title' : 'body';
  }
  return inFence ? null : out;
}

/**
 * Line indices that differ between two files, as `{ a, b }` index arrays.
 *
 * Common prefix and suffix are trimmed first, which in practice reduces a fence-only
 * change to a handful of lines and keeps the LCS table trivially small.
 */
function changedIndices(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const spanA = endA - start;
  const spanB = endB - start;
  const range = (from, to) => Array.from({ length: to - from }, (_, k) => from + k);

  // One side is pure insertion or deletion, or the region is too big to align precisely.
  if (spanA === 0 || spanB === 0 || spanA * spanB > LCS_CELL_LIMIT) {
    return { a: range(start, endA), b: range(start, endB) };
  }

  // LCS over the trimmed region; anything not on the common subsequence changed.
  const table = Array.from({ length: spanA + 1 }, () => new Uint32Array(spanB + 1));
  for (let i = spanA - 1; i >= 0; i--) {
    for (let j = spanB - 1; j >= 0; j--) {
      table[i][j] = a[start + i] === b[start + j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const changedA = [];
  const changedB = [];
  let i = 0;
  let j = 0;
  while (i < spanA && j < spanB) {
    if (a[start + i] === b[start + j]) {
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      changedA.push(start + i++);
    } else {
      changedB.push(start + j++);
    }
  }
  while (i < spanA) changedA.push(start + i++);
  while (j < spanB) changedB.push(start + j++);

  return { a: changedA, b: changedB };
}

/**
 * Classify the difference between a baseline file and a freshly compiled one.
 *
 * @param {string} expectedText the committed baseline
 * @param {string} actualText   what this compile produced
 * @param {{ maxSamples?: number }} [options]
 * @returns {{ identical: boolean, classes: string[], changedLines: number, samples: string[] }}
 *   `classes` is the sorted set of line classes the change touched — the value a phase's
 *   expected-diff shape is checked against.
 */
function classifyDiff(expectedText, actualText, options = {}) {
  const maxSamples = options.maxSamples === undefined ? 4 : options.maxSamples;
  if (expectedText === actualText) {
    return { identical: true, classes: [], changedLines: 0, samples: [] };
  }

  // Split on \n alone so a CRLF/LF change surfaces as a changed line rather than
  // being normalized away — it is a real difference in the bytes AID receives.
  const expected = expectedText.split('\n');
  const actual = actualText.split('\n');

  const expectedClasses = classifyLines(expected);
  const actualClasses = classifyLines(actual);
  const changed = changedIndices(expected, actual);
  const changedLines = changed.a.length + changed.b.length;

  if (!expectedClasses || !actualClasses) {
    return { identical: false, classes: [OPAQUE], changedLines, samples: ['unpaired ~~~ fence'] };
  }

  const classes = new Set();
  const samples = [];
  // Budget each side separately: a removed line and its replacement are the pair that
  // makes a diff readable, and a shared budget would spend itself on deletions alone.
  const perSide = Math.max(1, Math.ceil(maxSamples / 2));
  const record = (sign, indices, lines, lineClasses) => {
    let shown = 0;
    for (const index of indices) {
      classes.add(lineClasses[index]);
      if (shown++ < perSide) samples.push(`${sign}${index + 1}: ${lines[index]}`);
    }
  };
  record('-', changed.a, expected, expectedClasses);
  record('+', changed.b, actual, actualClasses);

  return { identical: false, classes: [...classes].sort(), changedLines, samples };
}

module.exports = { classifyDiff, classifyLines, changedIndices, OPAQUE };
