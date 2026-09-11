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
  return index ? attachOrigins(target, createOriginIndex(Object.values(index))) : target;
}

function overlayOriginIndexes(base, overlay) {
  return createOriginIndex([...Object.values(base || {}), ...Object.values(overlay || {})]);
}

module.exports = {
  createOriginIndex, attachOrigins, getOrigins, originAt, nearestOrigin,
  copyOrigins, overlayOriginIndexes,
};
