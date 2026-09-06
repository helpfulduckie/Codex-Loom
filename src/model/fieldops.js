'use strict';


const {
  deepClone, findKey, getCI, setCI, deleteCI, VAR_ALIASES, normalizeVarKey,
  ITEM_TOP_LEVEL_FIELDS, normalizeNotesKey,
} = require('../util');
const { CODES } = require('../diag');

function applyFieldOp(current, op, ctx = null) {
  const { value, changed, targeted } = applyOp(current, op, ctx);
  if (ctx && ctx.onWarn && typeof op === 'string' && targeted && !changed) {
    ctx.onWarn(CODES.FIELD_OP_NOOP, standaloneNoopMessage(ctx.label, op));
  }
  return value;
}

const APPEND_RE = /^\+\{([\s\S]*)\}$/;
const REMOVE_RE = /^-\{([\s\S]*)\}$/;
const SWAP_RE = /^\/\{([\s\S]*?)\}\/\{([\s\S]*?)\}$/;

function applyOp(current, op, ctx) {
  if (Array.isArray(op)) {
    const isOpsArray = op.length === 0 || op.every(
      el => typeof el === 'string' && /^\+\{|^-\{|^\/\{/.test(el.trim())
    );
    if (!isOpsArray) return { value: op, changed: true, targeted: false };

    let value = current;
    let changed = false;
    let targeted = false;
    for (const step of op) {
      if (value === '__DELETE__') break;
      const r = applyOp(value, step, ctx);
      value = r.value;
      changed = changed || r.changed;
      targeted = targeted || r.targeted;
    }
    if (ctx && ctx.onWarn && op.length > 0 && targeted && !changed) {
      ctx.onWarn(CODES.FIELD_OP_NOOP, chainNoopMessage(ctx.label, op));
    }
    return { value, changed, targeted };
  }

  if (op !== null && typeof op === 'object') {
    const result = typeof current === 'object' && current !== null ? deepClone(current) : {};
    let changed = false;
    let targeted = false;
    for (const [subKey, subOp] of Object.entries(op)) {
      const actualKey = findKey(result, subKey);
      const currentSub = actualKey !== null ? result[actualKey] : undefined;
      if (subOp === null) {
        if (actualKey !== null) delete result[actualKey];
        changed = true;
        continue;
      }
      const childCtx = ctx ? { ...ctx, label: joinLabel(ctx.label, subKey) } : ctx;
      const r = applyOp(currentSub, subOp, childCtx);
      changed = changed || r.changed;
      targeted = targeted || r.targeted;
      if (childCtx && childCtx.onWarn && typeof subOp === 'string' && r.targeted && !r.changed) {
        childCtx.onWarn(CODES.FIELD_OP_NOOP, standaloneNoopMessage(childCtx.label, subOp));
      }
      if (r.value === '__DELETE__') {
        if (actualKey !== null) delete result[actualKey];
      } else {
        setCI(result, subKey, r.value);
      }
    }
    return { value: result, changed, targeted };
  }

  if (op === null || op === undefined) return { value: '__DELETE__', changed: true, targeted: false };

  const opStr = String(op).trim();

  if (Array.isArray(current)) {
    const appendMatch = opStr.match(APPEND_RE);
    if (appendMatch) return { value: [...current, appendMatch[1]], changed: true, targeted: false };
    const removeMatch = opStr.match(REMOVE_RE);
    if (removeMatch) {
      const needle = removeMatch[1];
      return {
        value: current.filter(el => el !== needle),
        changed: needle !== '' && current.includes(needle),
        targeted: true,
      };
    }
    const swapMatch = opStr.match(SWAP_RE);
    if (swapMatch) {
      const from = swapMatch[1];
      return {
        value: current.map(el => String(el).split(from).join(swapMatch[2])),
        changed: from !== '' && current.some(el => String(el).includes(from)),
        targeted: true,
      };
    }
    return { value: op, changed: true, targeted: false };
  }

  if (current !== null && typeof current === 'object') {
    const values = Object.values(current).filter(v => v != null);
    return applyOp(values, op, ctx);
  }

  const currentStr = current !== null && current !== undefined ? String(current) : '';

  const appendMatch = opStr.match(APPEND_RE);
  if (appendMatch) {
    const toAdd = appendMatch[1];
    return { value: currentStr ? [currentStr, toAdd] : toAdd, changed: true, targeted: false };
  }

  const removeMatch = opStr.match(REMOVE_RE);
  if (removeMatch) {
    const needle = removeMatch[1];
    return {
      value: currentStr.split(needle).join('').trim(),
      changed: needle !== '' && currentStr.includes(needle),
      targeted: true,
    };
  }

  const swapMatch = opStr.match(SWAP_RE);
  if (swapMatch) {
    const from = swapMatch[1];
    return {
      value: currentStr.split(from).join(swapMatch[2]).trim(),
      changed: from !== '' && currentStr.includes(from),
      targeted: true,
    };
  }

  return { value: op, changed: true, targeted: false };
}

function joinLabel(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return `${a}.${b}`;
}

function needleOf(opStr) {
  const s = String(opStr).trim();
  const remove = s.match(REMOVE_RE);
  if (remove) return remove[1];
  const swap = s.match(SWAP_RE);
  if (swap) return swap[1];
  return '';
}

function standaloneNoopMessage(label, opStr) {
  const where = label ? `field "${label}" ` : '';
  return `${where}operation "${String(opStr).trim()}" targets "${needleOf(opStr)}", which the `
    + 'current value does not contain — it removes and replaces nothing. A `-{}` or `/{}/{}` '
    + 'that matches nothing is always a mistake: usually the text it was written against has '
    + 'drifted. Check the value, or drop the op.';
}

function chainNoopMessage(label, ops) {
  const where = label ? `field "${label}": ` : '';
  const list = ops.map((o) => `"${String(o).trim()}"`).join(', ');
  return `${where}every operation in this chain missed its target (${list}), so the chain `
    + 'changes nothing. A chain where some ops legitimately do nothing is normal (a pronoun '
    + 'swap-chain is built that way); one where none of them do is drift or a typo.';
}

function applyFieldsDelta(item, delta, onWarn) {
  if (!delta || typeof delta !== 'object') return;

  const topLevelFields = ITEM_TOP_LEVEL_FIELDS;
  const labelBase = item.id
    || (typeof item.name === 'string' ? item.name : (item.name && item.name.full))
    || '(unknown)';
  const opCtx = onWarn ? (field) => ({ onWarn, label: joinLabel(labelBase, field) }) : () => null;

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

    const normalizedKey = normalizeNotesKey(normalizeVarKey(key));
    const normalizedLower = normalizedKey.toLowerCase();
    const isTopLevel = topLevelFields.some(f => f === normalizedLower);

    if (isTopLevel) {
      const currentVal = getCI(item, normalizedKey);
      const newVal = applyFieldOp(currentVal, op, opCtx(normalizedKey));
      if (newVal === '__DELETE__') {
        deleteCI(item, normalizedKey);
      } else {
        setCI(item, normalizedKey, newVal);
      }
    } else if (keyLower === 'body') {
      if (!item.body) item.body = {};
      const newVal = applyFieldOp(item.body, op, onWarn ? { onWarn, label: labelBase } : null);
      if (newVal !== '__DELETE__') item.body = newVal;
    } else {
      if (!item.body) item.body = {};
      const currentVal = getCI(item.body, key);
      const newVal = applyFieldOp(currentVal, op, opCtx(key));
      if (newVal === '__DELETE__') {
        deleteCI(item.body, key);
      } else {
        setCI(item.body, key, newVal);
      }
    }
  }
}

function applyDelta(item, delta, onWarn) {
  if (!delta) return;
  for (const [key, value] of Object.entries(delta)) {
    const keyLower = key.toLowerCase();
    if (['variants', 'importvariants', '_source'].includes(keyLower)) continue;
    applyFieldsDelta(item, { [key]: value }, onWarn);
  }
}

module.exports = { applyFieldOp, applyFieldsDelta, applyDelta };
