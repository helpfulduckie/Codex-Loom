'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function findFiles(dir, ext) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          results.push(...findFiles(full, ext));
        } else if (stat.isFile() && entry.name.toLowerCase().endsWith(ext)) {
          results.push(full);
        }
      } catch (_) { /* broken symlink — skip */ }
    } else if (entry.isDirectory()) {
      results.push(...findFiles(full, ext));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

function loadYaml(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return yaml.load(raw);
  } catch (err) {
    throw new Error(`Failed to load YAML at ${filePath}: ${err.message}`);
  }
}

function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deepClone(v);
  return out;
}

function findKey(obj, key) {
  if (obj === null || typeof obj !== 'object') return null;
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return k;
  }
  return null;
}

function getCI(obj, key) {
  const actual = findKey(obj, key);
  return actual !== null ? obj[actual] : undefined;
}

function setCI(obj, key, value) {
  const actual = findKey(obj, key);
  if (actual !== null) {
    obj[actual] = value;
  } else {
    obj[key] = value;
  }
}

function deleteCI(obj, key) {
  const actual = findKey(obj, key);
  if (actual !== null) delete obj[actual];
}

const VAR_ALIASES = new Set(['v', 'var', 'vars', 'variable', 'variables']);

function normalizeVarKey(key) {
  return VAR_ALIASES.has(key.toLowerCase()) ? 'v' : key;
}

/**
 * Expand {%key} variable references in a string.
 * Cycle-detects via a resolving Set.
 */
function resolveVariables(text, variables, _resolving) {
  if (!variables || typeof text !== 'string') return text;
  if (!_resolving) _resolving = new Set();

  return text.replace(/\{%([^}]+)\}/g, (match, key) => {
    const lower = key.trim().toLowerCase();
    if (_resolving.has(lower)) {
      console.warn(`  WARN: cycle detected in variable "{%${key}}"`);
      return match;
    }
    const actualKey = Object.keys(variables).find(k => k.toLowerCase() === lower);
    if (actualKey === undefined) {
      console.warn(`  WARN: variable "{%${key}}" not declared`);
      return match;
    }
    _resolving.add(lower);
    const expanded = resolveVariables(String(variables[actualKey]), variables, _resolving);
    _resolving.delete(lower);
    return expanded;
  });
}

/**
 * Final safety net: warn about any {%variable} token left unexpanded in rendered
 * output (a card or component). Emits one warning per distinct leftover token.
 *
 * Targets {%...} only — {@...} is intentionally not expanded in card content, so
 * a literal {@...} here is expected and must not be flagged.
 *
 * @param {string} text   - the fully-rendered output to scan
 * @param {string} label  - human-readable location, e.g. 'card "Aria" (Character)'
 * @returns {boolean}     - true if any unexpanded variable was found
 */
function warnUnexpandedVariables(text, label) {
  if (typeof text !== 'string') return false;
  const seen = new Set();
  const re = /\{%[^}]+\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    console.warn(`  WARN: unexpanded variable ${m[0]} in ${label}`);
  }
  return seen.size > 0;
}

module.exports = { findFiles, loadYaml, deepClone, findKey, getCI, setCI, deleteCI, VAR_ALIASES, normalizeVarKey, resolveVariables, warnUnexpandedVariables };
