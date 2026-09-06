'use strict';


const fs = require('fs');
const YAML = require('yaml');
const { preparse, findSwallowedTokens } = require('./preparse');
const { CODES } = require('../diag');

const PATH_SEP = '\u0000';

class SourceMap {
  constructor(file, positions) {
    this.file = file || null;
    this._positions = positions || new Map();
  }

  at(...parts) {
    const pathParts = (parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts).map(String);
    const hit = this._positions.get(pathParts.join(PATH_SEP));
    if (!hit) return { file: this.file };
    return { file: this.file, line: hit.line, col: hit.col };
  }

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

function parseYaml(raw, filePath) {
  const source = preparse(raw);
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(source, { lineCounter, keepSourceTokens: false });

  if (doc.errors.length > 0) throw new Error(doc.errors[0].message);

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
    err.code = CODES.TOKEN_SWALLOWED_BY_YAML;
    throw err;
  }

  return { value, sourceMap };
}

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

function loadYaml(filePath) {
  return loadYamlDocument(filePath).value;
}

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
