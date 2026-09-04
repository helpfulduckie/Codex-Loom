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

const {
  deepClone, findKey, getCI, setCI, deleteCI, VAR_ALIASES, normalizeVarKey,
  ITEM_TOP_LEVEL_FIELDS, normalizeNotesKey,
} = require('../util');
const { CODES } = require('../diag');

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
 *
 * ── CL0328, the no-op field operation (§3.2) ────────────────────────────────
 *
 * `-{x}` and `/{a}/{b}` are `split(…).join(…)` under the hood, which hands back the
 * original value when the target substring is absent — a silent no-op. That silence is
 * how upstream drift ships: a library item's text changes, a consuming project's
 * `hair: -{in a controlled bun}` quietly stops biting, and the card compiles clean.
 *
 * The naive "warn on every missed op" is unusable — `06-field-operations.md`'s pronoun
 * swap-chain (`/{She}/{He}`, `/{she}/{he}`, `/{her}/{his}`) is *built* on misses, since
 * any one description contains some of those forms and not others. So the report is
 * scoped the way `CL0326` scopes selectors: three of seven matched is normal, zero of
 * seven is the mistake. `onWarn` fires only when **every** removal/swap in a chain
 * missed, or when a **standalone** `-{}` / `/{}/{}` missed. Pass `ctx` as
 * `{ onWarn, label }` to arm it; without `ctx` the function is byte-for-byte as before.
 */
function applyFieldOp(current, op, ctx = null) {
  const { value, changed, targeted } = applyOp(current, op, ctx);
  // The chain and mapping arms of `applyOp` raise CL0328 at their own boundaries; this
  // wrapper covers the remaining shape — a lone op string that targeted something and
  // matched nothing.
  if (ctx && ctx.onWarn && typeof op === 'string' && targeted && !changed) {
    ctx.onWarn(CODES.FIELD_OP_NOOP, standaloneNoopMessage(ctx.label, op));
  }
  return value;
}

/** The `+{…}` / `-{…}` / `/{…}/{…}` matchers, shared by every arm. */
const APPEND_RE = /^\+\{([\s\S]*)\}$/;
const REMOVE_RE = /^-\{([\s\S]*)\}$/;
const SWAP_RE = /^\/\{([\s\S]*?)\}\/\{([\s\S]*?)\}$/;

/**
 * The workhorse `applyFieldOp` wraps. Returns `{ value, changed, targeted }`:
 *   value     the new value, or '__DELETE__'
 *   targeted  the op (tree) contained at least one removal or swap — the ops that can miss
 *   changed   at least one op actually did something (an append or a replace always does;
 *             a removal/swap does only when its target is present)
 *
 * `changed` keys off target *presence*, not `value !== current`: a missed `-{x}` still
 * `.trim()`s the string, so an inequality test would read a whitespace trim as a match.
 */
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
      // A standalone op string per subfield is the mapping arm's to report — `applyOp`'s
      // scalar arm never warns, and the chain arm above only fires for an array subOp.
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

/** `a` + `.` + `b`, skipping an empty side so a missing label never leads with a dot. */
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

/**
 * Apply a delta to an item's body fields and eligible top-level fields.
 * Mutates item in place.
 *
 * The top-level fields variants can modify are `util.ITEM_TOP_LEVEL_FIELDS`; `body:` is
 * handled separately below because deltas apply to it subfield by subfield rather than
 * as a whole value. The `id` field cannot be altered by variants or branches.
 */
function applyFieldsDelta(item, delta, onWarn) {
  if (!delta || typeof delta !== 'object') return;

  const topLevelFields = ITEM_TOP_LEVEL_FIELDS;
  const labelBase = item.id
    || (typeof item.name === 'string' ? item.name : (item.name && item.name.full))
    || '(unknown)';
  const opCtx = onWarn ? (field) => ({ onWarn, label: joinLabel(labelBase, field) }) : () => null;

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

    // Both alias families collapse here, so a variant may write `description:` and hit
    // the same field an item declared as `notes:` (§4.5).
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
      // Explicit body: block — apply as subfield ops. The mapping arm appends each
      // subfield name to the label, so the context carries only the item here.
      if (!item.body) item.body = {};
      const newVal = applyFieldOp(item.body, op, onWarn ? { onWarn, label: labelBase } : null);
      if (newVal !== '__DELETE__') item.body = newVal;
    } else {
      // Unknown key: treat as body field op
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

module.exports = { applyFieldOp, applyFieldsDelta, applyDelta };
