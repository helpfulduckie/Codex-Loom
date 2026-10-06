'use strict';

/**
 * Text sources that stand in for files on disk during one compile, so a caller holding
 * unsaved edits can compile them without writing them.
 *
 * Readers are many and deep in the call tree, so they ask here rather than taking a map
 * through every signature. A compile is synchronous; `withSourceOverrides` brackets it, and
 * outside that bracket `readSource` is a plain file read. An override replaces only the
 * content of a file the caller's existence checks already found on disk.
 */

const fs = require('fs');
const path = require('path');

let overrides = null;

// Windows paths differ by case without naming different files.
function keyOf(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalize(source) {
  if (!source) return null;
  const entries = source instanceof Map ? source.entries() : Object.entries(source);
  const out = new Map();
  for (const [filePath, text] of entries) out.set(keyOf(filePath), text);
  return out;
}

/** Run `fn` with `sources` (path -> text, object or Map) installed, restoring the prior state. */
function withSourceOverrides(sources, fn) {
  const previous = overrides;
  overrides = normalize(sources);
  try {
    return fn();
  } finally {
    overrides = previous;
  }
}

/** The override text for `filePath` when one is installed, else the file's content. */
function readSource(filePath, encoding = 'utf8') {
  if (overrides) {
    const key = keyOf(filePath);
    if (overrides.has(key)) return overrides.get(key);
  }
  return fs.readFileSync(filePath, encoding);
}

module.exports = { withSourceOverrides, readSource };
