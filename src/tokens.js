'use strict';

const fs = require('fs');
const { resolveVariables } = require('./util');

/**
 * Single shared expander for the two compile-time token families:
 *
 *   {%key}   compile variable  — value substitution (recursive, cycle-detected,
 *                                warns on undeclared). Always handled by
 *                                util.resolveVariables, the canonical % core.
 *   {@key}   named reference    — resolves a name declared in
 *                                structure.input.components and/or
 *                                structure.input.canon to a path or file contents.
 *
 * The two kinds intentionally stay distinct (a value vs. a named resource), but
 * every call site routes through here so scope, lookup namespace, warnings, and
 * cycle handling are identical everywhere.
 *
 * @param {string} text
 * @param {object} opts
 * @param {object} [opts.variables]  - plain object of {%key} values (config.variables or branch-merged)
 * @param {Map}    [opts.components] - flattened or per-type component name → path. Accepts either a
 *                                     single Map<name,path> or an object whose values are such Maps.
 * @param {Map}    [opts.canon]      - canon name → absolute path (Map<name,path>)
 * @param {'path'|'content'} [opts.mode='path'] - for {@key} that resolves to a FILE:
 *                                     'path' returns the path string; 'content' reads the file.
 *                                     Directories always return the path regardless of mode.
 * @param {boolean} [opts.warnMissing=true] - emit a WARN when an {@key} name is not found.
 * @returns {string}
 */
function expandTokens(text, opts = {}) {
  if (typeof text !== 'string') return text;
  const { variables, components, canon, mode = 'path', warnMissing = true } = opts;

  return text.replace(/\{([@%])([^}]+)\}/g, (match, sigil, rawKey) => {
    if (sigil === '%') {
      // Delegate to the canonical % implementation (handles recursion + cycles + undeclared warn).
      return resolveVariables(match, variables);
    }
    // sigil === '@' — named reference (components first, then canon).
    const name = rawKey.trim();
    const dirPath = lookupReference(name, components, canon);
    if (dirPath === undefined) {
      if (warnMissing) console.warn(`  WARN: component key "{@${name}}" not found`);
      return match;
    }
    if (mode === 'content' && fs.existsSync(dirPath) && fs.statSync(dirPath).isFile()) {
      return fs.readFileSync(dirPath, 'utf8').trim();
    }
    return dirPath;
  });
}

/**
 * Resolve a {@name} against components (first) then canon. Case-insensitive.
 * `components` may be a Map<name,path> or an object of such Maps (the per-type
 * shape stored in config._resolvedComponents). Returns the resolved path, or
 * undefined if the name matches nothing.
 */
function lookupReference(name, components, canon) {
  const lower = name.toLowerCase();

  const searchMap = (map) => {
    if (!map || typeof map.keys !== 'function') return undefined;
    for (const key of map.keys()) {
      if (key.toLowerCase() === lower) return map.get(key);
    }
    return undefined;
  };

  if (components) {
    if (typeof components.keys === 'function') {
      const hit = searchMap(components);
      if (hit !== undefined) return hit;
    } else {
      for (const map of Object.values(components)) {
        const hit = searchMap(map);
        if (hit !== undefined) return hit;
      }
    }
  }

  return searchMap(canon);
}

module.exports = { expandTokens, lookupReference };
