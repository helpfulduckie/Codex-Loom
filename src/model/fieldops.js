'use strict';

/**
 * Field operations (v4 spec §3.2).
 *
 * Value-level edits with no knowledge of items or branches, which is the seam this
 * module was split along: `+{}` / `-{}` / `/{}/{}` / `~` operate on a value and say
 * nothing about what holds it.
 *
 * Pure by contract (§3.3): no `fs`, no `console`. Warnings go to a caller-supplied
 * `onWarn(code, message)` so reporting a problem does not mean printing one.
 */

const { deepClone, findKey, getCI, setCI, deleteCI, VAR_ALIASES, normalizeVarKey } = require('../util');

const CODES = Object.freeze({
  VARIANT_DELTA_VAR_ALIASES: 'CL0320',
});

/**
 * Apply a single field operation to a current value.
 * Returns the new value or the sentinel '__DELETE__'.
 *
 * Operations (on string values):
 *   null / ~        → remove (DELETE)
 *   "+{value}"      → append
 *   "-{value}"      → remove substring (or remove matching array element)
 *   "/{a}/{b}"      → swap
 *   anything else   → replace
 *
 * If op is a mapping and current is also a mapping, recurse into subfields.
 * If op is an array of op-strings, apply sequentially.
 * If op is a value array (not all op-strings), replace.
 */
function applyFieldOp(current, op) {
  if (Array.isArray(op)) {
    const isOpsArray = op.length === 0 || op.every(
      el => typeof el === 'string' && /^\+\{|^-\{|^\/\{/.test(el.trim())
    );
    if (isOpsArray) {
      let value = current;
      for (const step of op) {
        if (value === '__DELETE__') break;
        value = applyFieldOp(value, step);
      }
      return value;
    }
    return op;
  }

  if (op !== null && typeof op === 'object' && !Array.isArray(op)) {
    const result = typeof current === 'object' && current !== null ? deepClone(current) : {};
    for (const [subKey, subOp] of Object.entries(op)) {
      const actualKey = findKey(result, subKey);
      const currentSub = actualKey !== null ? result[actualKey] : undefined;
      if (subOp === null) {
        if (actualKey !== null) delete result[actualKey];
      } else {
        const newVal = applyFieldOp(currentSub, subOp);
        if (newVal === '__DELETE__') {
          if (actualKey !== null) delete result[actualKey];
        } else {
          setCI(result, subKey, newVal);
        }
      }
    }
    return result;
  }

  if (op === null || op === undefined) return '__DELETE__';

  const opStr = String(op).trim();

  if (Array.isArray(current)) {
    const appendMatch = opStr.match(/^\+\{([\s\S]*)\}$/);
    if (appendMatch) return [...current, appendMatch[1]];
    const removeMatch = opStr.match(/^-\{([\s\S]*)\}$/);
    if (removeMatch) return current.filter(el => el !== removeMatch[1]);
    const swapMatch = opStr.match(/^\/\{([\s\S]*?)\}\/\{([\s\S]*?)\}$/);
    if (swapMatch) return current.map(el => String(el).split(swapMatch[1]).join(swapMatch[2]));
    return op;
  }

  if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
    const values = Object.values(current).filter(v => v != null);
    return applyFieldOp(values, op);
  }

  const currentStr = current !== null && current !== undefined ? String(current) : '';

  const appendMatch = opStr.match(/^\+\{([\s\S]*)\}$/);
  if (appendMatch) {
    const toAdd = appendMatch[1];
    if (!currentStr) return toAdd;
    return [currentStr, toAdd];
  }

  const removeMatch = opStr.match(/^-\{([\s\S]*)\}$/);
  if (removeMatch) return currentStr.split(removeMatch[1]).join('').trim();

  const swapMatch = opStr.match(/^\/\{([\s\S]*?)\}\/\{([\s\S]*?)\}$/);
  if (swapMatch) return currentStr.split(swapMatch[1]).join(swapMatch[2]).trim();

  return op;
}

/**
 * Apply a delta to an item's body fields and eligible top-level fields.
 * Mutates item in place.
 *
 * v3 top-level item fields that variants can modify:
 *   name, pronouns, aid (object), render (object), body (object)
 * The `id` field cannot be altered by variants or branches.
 */
function applyFieldsDelta(item, delta, onWarn) {
  if (!delta || typeof delta !== 'object') return;

  const topLevelFields = ['name', 'pronouns', 'aid', 'render', 'v'];

  // Warn if the delta contains multiple variable-block aliases
  const deltaAliasKeys = Object.keys(delta).filter(k => VAR_ALIASES.has(k.toLowerCase()));
  if (deltaAliasKeys.length > 1) {
    const itemId = item.id || (typeof item.name === 'string' ? item.name : '(unknown)');
    if (onWarn) {
      onWarn(CODES.VARIANT_DELTA_VAR_ALIASES,
        `item "${itemId}" variant delta contains multiple variable-block aliases (${deltaAliasKeys.map(k => `"${k}"`).join(', ')}). Merging — subfield conflicts resolve last-writer-wins.`);
    }
  }

  for (const [key, op] of Object.entries(delta)) {
    const keyLower = key.toLowerCase();
    if (keyLower === 'id') continue; // id is immutable

    const normalizedKey = normalizeVarKey(key);
    const normalizedLower = normalizedKey.toLowerCase();
    const isTopLevel = topLevelFields.some(f => f === normalizedLower);

    if (isTopLevel) {
      const currentVal = getCI(item, normalizedKey);
      const newVal = applyFieldOp(currentVal, op);
      if (newVal === '__DELETE__') {
        deleteCI(item, normalizedKey);
      } else {
        setCI(item, normalizedKey, newVal);
      }
    } else if (keyLower === 'body') {
      // Explicit body: block — apply as subfield ops
      if (!item.body) item.body = {};
      const newVal = applyFieldOp(item.body, op);
      if (newVal !== '__DELETE__') item.body = newVal;
    } else {
      // Unknown key: treat as body field op
      if (!item.body) item.body = {};
      const currentVal = getCI(item.body, key);
      const newVal = applyFieldOp(currentVal, op);
      if (newVal === '__DELETE__') {
        deleteCI(item.body, key);
      } else {
        setCI(item.body, key, newVal);
      }
    }
  }
}

/**
 * Apply a variant delta to an item. Handles structural keys and field ops.
 */
function applyDelta(item, delta, onWarn) {
  if (!delta) return;
  // Skip structural-only keys
  for (const [key, value] of Object.entries(delta)) {
    const keyLower = key.toLowerCase();
    if (['variants', 'importvariants', '_source'].includes(keyLower)) continue;
    applyFieldsDelta(item, { [key]: value }, onWarn);
  }
}

module.exports = { applyFieldOp, applyFieldsDelta, applyDelta, CODES };
