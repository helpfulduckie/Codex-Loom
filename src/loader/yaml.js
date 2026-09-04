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
const { preparse, findSwallowedTokens } = require('./preparse');
const { CODES } = require('../diag');

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
 * The source runs through `preparse` first (§4.1), so a leading `{$…}` or `{%…}` value
 * needs no defensive quoting. The preparser only inserts characters within a line, so
 * the line numbers in the SourceMap remain exact.
 *
 * Throws on a malformed document, matching js-yaml's behavior — `yaml` collects errors
 * on the document rather than throwing, so they are raised explicitly here — and on a
 * token the parser swallowed as a mapping key, which is an ERROR per §4.1.
 *
 */
function parseYaml(raw, filePath) {
  const source = preparse(raw);
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(source, { lineCounter, keepSourceTokens: false });

  if (doc.errors.length > 0) throw new Error(doc.errors[0].message);

  // js-yaml returns `undefined` for an empty document; `yaml` would return null. The
  // callers that skip empty files test for both, but the contract is worth preserving
  // exactly rather than relying on every one of them staying loose.
  const value = doc.contents === null ? undefined : doc.toJS({ maxAliasCount: -1 });
  const sourceMap = new SourceMap(filePath, buildPositions(doc, lineCounter));

  const swallowed = findSwallowedTokens(value);
  if (swallowed.length > 0) {
    const { token, path, key } = swallowed[0];
    const { line, col } = sourceMap.nearest([...path, key]);
    const at = line ? ` at line ${line}, column ${col}` : '';
    const err = new Error(
      `${CODES.TOKEN_SWALLOWED_BY_YAML}: the token ${token} was parsed as a YAML mapping key${at}. `
      + 'Wrap the value in quotes so it is read as text.'
    );
    // Read by `YamlLoadError`, so a swallowed token reaches the bus as `CL0105` rather than
    // as a generic parse failure.
    err.code = CODES.TOKEN_SWALLOWED_BY_YAML;
    throw err;
  }

  return { value, sourceMap };
}

/**
 * The one error `loadYaml` / `loadYamlDocument` throw, typed so a caller can turn it into
 * a coded diagnostic without parsing the message.
 *
 * Those two are leaf functions: they observe a fact — the file could not be read, or its
 * text could not be parsed — and throw it. What the fact *means* is the caller's to decide,
 * because the same failure is a different mistake in different places: the item registry
 * reports a parse failure as `CL0101` and moves on to the next file; `field-table.js` reports
 * the same failure as `CL0422`, because a broken field table is its own kind of wrong. So the
 * error carries `kind` (the fact) and `code` (the loading-band default for a caller with
 * nothing more specific to say), and the caller raises whichever it owns.
 *
 * `code` is `CL0102` for a read failure and `CL0101` for a parse failure — except a token
 * the parser swallowed as a mapping key, which `parseYaml` marks with `CL0105` and keeps.
 * The message is the v3 `Failed to load YAML at <path>: <reason>` string throughout, so a
 * caller that only ever wanted the text still gets it.
 */
class YamlLoadError extends Error {
  constructor(kind, filePath, cause) {
    super(`Failed to load YAML at ${filePath}: ${cause.message}`);
    this.name = 'YamlLoadError';
    this.kind = kind;
    this.file = filePath;
    this.code = kind === 'read'
      ? CODES.YAML_FILE_UNREADABLE
      : (cause.code || CODES.YAML_PARSE_FAILED);
    this.cause = cause;
  }
}

/**
 * Read and parse a YAML file, returning the parsed value.
 *
 * Contract preserved from v3 `util.loadYaml`: returns the value, yields `undefined` for an
 * empty file, and throws for both unreadable files and malformed documents — now as a
 * `YamlLoadError`, so the caller can tell which.
 */
function loadYaml(filePath) {
  return loadYamlDocument(filePath).value;
}

/** As `loadYaml`, but returns `{ value, sourceMap }` for position-aware callers. */
function loadYamlDocument(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new YamlLoadError('read', filePath, err);
  }
  try {
    return parseYaml(raw, filePath);
  } catch (err) {
    throw new YamlLoadError('parse', filePath, err);
  }
}

module.exports = { loadYaml, loadYamlDocument, parseYaml, SourceMap, YamlLoadError };
