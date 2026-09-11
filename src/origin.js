'use strict';

const ORIGINS = Symbol('codexLoomOrigins');
const PATH_SEP = '\u0000';

function pathKey(parts) {
  return (Array.isArray(parts) ? parts : [parts]).map(String).join(PATH_SEP);
}

function createOriginIndex(entries = []) {
  const index = Object.create(null);
  for (const entry of entries) {
    if (!entry || !Array.isArray(entry.path)) continue;
    const record = { file: entry.file || null, path: entry.path.map(String) };
    if (typeof entry.line === 'number') record.line = entry.line;
    if (typeof entry.col === 'number') record.col = entry.col;
    index[pathKey(record.path)] = record;
  }
  return index;
}

function attachOrigins(value, index) {
  if (!value || typeof value !== 'object') return value;
  Object.defineProperty(value, ORIGINS, {
    value: index || createOriginIndex(), enumerable: false, configurable: true,
  });
  return value;
}

function getOrigins(value) {
  return value && typeof value === 'object' ? value[ORIGINS] || null : null;
}

function lookup(index, parts, nearest) {
  if (!index) return null;
  const path = (Array.isArray(parts) ? parts : [parts]).map(String);
  const floor = nearest ? 0 : path.length;
  for (let length = path.length; length >= floor; length--) {
    const hit = index[pathKey(path.slice(0, length))];
    if (hit) return { ...hit, path: hit.path.slice() };
  }
  return null;
}

function originAt(value, ...parts) {
  return lookup(getOrigins(value), parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts, false);
}

function nearestOrigin(value, ...parts) {
  return lookup(getOrigins(value), parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts, true);
}

function copyOrigins(source, target) {
  const index = getOrigins(source);
  return index ? attachOrigins(target, overlayOriginIndexes(null, index)) : target;
}

function overlayOriginIndexes(base, overlay) {
  const index = Object.create(null);
  for (const [key, record] of Object.entries({ ...base, ...overlay })) {
    index[key] = { ...record, path: record.path.slice() };
  }
  return index;
}

// Index keys follow runtime paths; records keep the original authored YAML paths.
function transferOrigins(source, target, sourcePath = [], targetPath = [], { replace = true, descendants = true } = {}) {
  const sourceIndex = getOrigins(source);
  const index = overlayOriginIndexes(null, getOrigins(target));
  const from = pathKey(sourcePath);
  const to = pathKey(targetPath);
  const under = (key, prefix) => prefix === '' || key === prefix || key.startsWith(prefix + PATH_SEP);
  if (replace) {
    for (const key of Object.keys(index)) if (under(key, to)) delete index[key];
  }
  const root = nearestOrigin(source, sourcePath);
  if (root) index[to] = root;
  if (descendants) {
    for (const [key, record] of Object.entries(sourceIndex || {})) {
      if (!under(key, from)) continue;
      const suffix = key === from ? '' : (from ? key.slice(from.length + 1) : key);
      index[to && suffix ? to + PATH_SEP + suffix : to || suffix] = { ...record, path: record.path.slice() };
    }
  }
  if (sourceIndex || getOrigins(target)) attachOrigins(target, index);
  return target;
}

function originLocation(value, parts = [], fallback = {}) {
  const origin = nearestOrigin(value, parts);
  if (!origin) return value && value._source ? { ...fallback, file: value._source } : { ...fallback };
  const { file, line, col, ...context } = fallback;
  return { ...context, ...origin };
}

module.exports = {
  createOriginIndex, attachOrigins, getOrigins, originAt, nearestOrigin,
  copyOrigins, overlayOriginIndexes, transferOrigins, originLocation,
};
