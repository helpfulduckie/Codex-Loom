'use strict';

/**
 * Position-aware YAML loading (v4 spec §4.4).
 *
 * §4.4 requires every diagnostic to name a file, line and column, and says this has to
 * be designed in rather than retrofitted. js-yaml exposes no node positions and has no
 * API to add them, so v4 parses with `yaml` (eemeli), which gives every node a source
 * range, and pairs the parsed value with a path → position index.
 *
 * `loadYaml` keeps the old contract exactly — same return values, same thrown message —
 * so the existing call sites are unaffected. New code that wants positions calls
 * `loadYamlDocument` and gets a `SourceMap` alongside the value.
 *
 * Parse-semantic equivalence with js-yaml 4 was checked across all 88 YAML files in the
 * fixture and test corpora before the swap: all 88 parse identically. Both default to
 * the YAML 1.2 core schema, so the usual divergence suspects (`yes`/`no` as booleans,
 * timestamps, merge keys) do not apply to either.
 */

const fs = require('fs');
const YAML = require('yaml');

/**
 * Path components are joined with NUL. The separator has to be a character that cannot
 * appear in a key, and keys here routinely contain spaces, dots and dashes — the fixture
 * branch names alone include `Free Form` and `Location - Angrek`.
 */
const PATH_SEP = '\u0000';

/**
 * Maps a path within a document to where it was written.
 *
 * Positions point at the *key* for mapping entries and at the *value* for sequence
 * entries, which is what a reader needs: "unknown key `triggers`" should underline the
 * key, while "item 3 in this list is malformed" should underline the item.
 */
class SourceMap {
  constructor(file, positions) {
    this.file = file || null;
    this._positions = positions || new Map();
  }

  /**
   * Look up a path, given either as an array or as varargs:
   *   map.at('structure', 'input', 'items', 0)
   *   map.at(['structure', 'input', 'items', 0])
   *
   * Always returns a location object usable by `diag.js`; when the path is unknown the
   * file alone still comes back, so a diagnostic degrades to file-granular rather than
   * losing its location entirely.
   */
  at(...parts) {
    const pathParts = (parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts).map(String);
    const hit = this._positions.get(pathParts.join(PATH_SEP));
    if (!hit) return { file: this.file };
    return { file: this.file, line: hit.line, col: hit.col };
  }

  /** True when the exact path was recorded — useful for falling back to a parent path. */
  has(...parts) {
    const pathParts = (parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts).map(String);
    return this._positions.has(pathParts.join(PATH_SEP));
  }

  /**
   * The nearest recorded ancestor of a path, including the path itself. Diagnostics
   * about a value that the document does not contain — a missing required key, say —
   * can still point at the block that should have held it.
   */
  nearest(...parts) {
    const pathParts = (parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts).map(String);
    for (let i = pathParts.length; i >= 0; i--) {
      const key = pathParts.slice(0, i).join(PATH_SEP);
      const hit = this._positions.get(key);
      if (hit) return { file: this.file, line: hit.line, col: hit.col };
    }
    return { file: this.file };
  }

  get size() {
    return this._positions.size;
  }
}

/** Walk the node tree, recording a 1-based line/col for every addressable path. */
function buildPositions(doc, lineCounter) {
  const positions = new Map();

  const record = (parts, offset) => {
    if (typeof offset !== 'number') return;
    const { line, col } = lineCounter.linePos(offset);
    positions.set(parts.join(PATH_SEP), { line, col, offset });
  };

  const walk = (node, parts) => {
    if (!node || typeof node !== 'object') return;
    if (YAML.isMap(node)) {
      for (const pair of node.items) {
        if (!pair || pair.key === undefined || pair.key === null) continue;
        const key = String(pair.key.value !== undefined ? pair.key.value : pair.key);
        const childParts = [...parts, key];
        record(childParts, pair.key.range && pair.key.range[0]);
        walk(pair.value, childParts);
      }
    } else if (YAML.isSeq(node)) {
      node.items.forEach((item, index) => {
        const childParts = [...parts, String(index)];
        if (item && item.range) record(childParts, item.range[0]);
        walk(item, childParts);
      });
    }
  };

  if (doc.contents && doc.contents.range) record([], doc.contents.range[0]);
  walk(doc.contents, []);
  return positions;
}

/**
 * Parse YAML text. Returns the value plus a SourceMap.
 *
 * Throws on a malformed document, matching js-yaml's behavior — `yaml` collects errors
 * on the document rather than throwing, so they are raised explicitly here.
 */
function parseYaml(raw, filePath) {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(raw, { lineCounter, keepSourceTokens: false });

  if (doc.errors.length > 0) throw new Error(doc.errors[0].message);

  // js-yaml returns `undefined` for an empty document; `yaml` would return null. The
  // callers that skip empty files test for both, but the contract is worth preserving
  // exactly rather than relying on every one of them staying loose.
  const value = doc.contents === null ? undefined : doc.toJS({ maxAliasCount: -1 });

  return { value, sourceMap: new SourceMap(filePath, buildPositions(doc, lineCounter)), doc };
}

/**
 * Read and parse a YAML file, returning the parsed value.
 *
 * Contract preserved from v3 `util.loadYaml`: returns the value, yields
 * `undefined` for an empty file, and throws `Failed to load YAML at <path>: <reason>`
 * for both unreadable files and malformed documents.
 */
function loadYaml(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseYaml(raw, filePath).value;
  } catch (err) {
    throw new Error(`Failed to load YAML at ${filePath}: ${err.message}`);
  }
}

/** As `loadYaml`, but returns `{ value, sourceMap, doc }` for position-aware callers. */
function loadYamlDocument(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseYaml(raw, filePath);
  } catch (err) {
    throw new Error(`Failed to load YAML at ${filePath}: ${err.message}`);
  }
}

module.exports = { loadYaml, loadYamlDocument, parseYaml, SourceMap };
