'use strict';

/**
 * A progress log that collects instead of printing — for a test that asserts on a line
 * the compiler narrates (the snapshot drift notice, say). `lines` holds every call in
 * order; `verboseLines` holds only the `verbose` channel, for a test that wants to know a
 * line was gated. The silent default lives in `src/log.js`; this file is test-only so the
 * library never carries a collector it does not use.
 */
function collectingLog() {
  const lines = [];
  const verboseLines = [];
  return {
    lines,
    verboseLines,
    info: (line) => { lines.push(line); },
    verbose: (line) => { lines.push(line); verboseLines.push(line); },
  };
}

module.exports = { collectingLog };
