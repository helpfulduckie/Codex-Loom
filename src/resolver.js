'use strict';

const { deepClone, findKey, getCI, setCI, deleteCI, VAR_ALIASES, normalizeVarKey } = require('./util');

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
 * Apply a delta to a card's body fields and eligible top-level fields.
 * Mutates card in place.
 *
 * v3 top-level card fields that variants can modify:
 *   name, pronouns, aid (object), render (object), body (object)
 * The `id` field cannot be altered by variants or branches.
 */
function applyFieldsDelta(card, delta) {
  if (!delta || typeof delta !== 'object') return;

  const topLevelFields = ['name', 'pronouns', 'aid', 'render', 'v'];

  // Warn if the delta contains multiple variable-block aliases
  const deltaAliasKeys = Object.keys(delta).filter(k => VAR_ALIASES.has(k.toLowerCase()));
  if (deltaAliasKeys.length > 1) {
    const cardId = card.id || (typeof card.name === 'string' ? card.name : '(unknown)');
    console.warn(`  WARN: card "${cardId}" variant delta contains multiple variable-block aliases (${deltaAliasKeys.map(k => `"${k}"`).join(', ')}). Merging — subfield conflicts resolve last-writer-wins.`);
  }

  for (const [key, op] of Object.entries(delta)) {
    const keyLower = key.toLowerCase();
    if (keyLower === 'id') continue; // id is immutable

    const normalizedKey = normalizeVarKey(key);
    const normalizedLower = normalizedKey.toLowerCase();
    const isTopLevel = topLevelFields.some(f => f === normalizedLower);

    if (isTopLevel) {
      const currentVal = getCI(card, normalizedKey);
      const newVal = applyFieldOp(currentVal, op);
      if (newVal === '__DELETE__') {
        deleteCI(card, normalizedKey);
      } else {
        setCI(card, normalizedKey, newVal);
      }
    } else if (keyLower === 'body') {
      // Explicit body: block — apply as subfield ops
      if (!card.body) card.body = {};
      const newVal = applyFieldOp(card.body, op);
      if (newVal !== '__DELETE__') card.body = newVal;
    } else {
      // Unknown key: treat as body field op
      if (!card.body) card.body = {};
      const currentVal = getCI(card.body, key);
      const newVal = applyFieldOp(currentVal, op);
      if (newVal === '__DELETE__') {
        deleteCI(card.body, key);
      } else {
        setCI(card.body, key, newVal);
      }
    }
  }
}

/**
 * Apply a variant delta to a card. Handles structural keys and field ops.
 */
function applyDelta(card, delta) {
  if (!delta) return;
  // Skip structural-only keys
  for (const [key, value] of Object.entries(delta)) {
    const keyLower = key.toLowerCase();
    if (['variants', 'importvariants', '_source'].includes(keyLower)) continue;
    applyFieldsDelta(card, { [key]: value });
  }
}

/**
 * Walk a variant path (slash-separated) on a card definition and collect deltas.
 * e.g. "human/noble" → apply 'human' variant delta, then 'noble' child of 'human'.
 */
function collectVariantDeltas(cardDef, variantPath) {
  const deltas = [];
  if (!variantPath) return deltas;
  const parts = variantPath.split('/').map(p => p.trim()).filter(Boolean);
  let variantTree = cardDef.variants;

  for (const part of parts) {
    if (!variantTree || typeof variantTree !== 'object') {
      console.warn(`  WARN: variant "${part}" not found in variant tree of "${cardDef.id || cardDef.name}"`);
      break;
    }
    const actualKey = Object.keys(variantTree).find(k => k.toLowerCase() === part.toLowerCase());
    if (!actualKey) {
      console.warn(`  WARN: variant "${part}" not found in variant tree of "${cardDef.id || cardDef.name}"`);
      break;
    }
    const variantDef = variantTree[actualKey];
    deltas.push(variantDef);
    variantTree = variantDef.variants;
  }

  return deltas;
}

/**
 * Parse importVariants: to a list of variant path strings.
 * Accepts: string, or array of strings.
 */
function parseVariantsList(variants) {
  if (!variants) return [];
  if (typeof variants === 'string') return [variants];
  if (Array.isArray(variants)) return variants.map(String);
  return [];
}

/**
 * Resolve the branch spec for a card/block, walking the branch path.
 *
 * Returns:
 *   null             → card is excluded from this branch (explicit ~ on the key)
 *   string[]         → variant names to apply (may be empty)
 *
 * Resolution at each depth level:
 *   1. If the exact key maps to null (~) → return null immediately (no wildcard)
 *   2. Collect '*' wildcard variants as baseline
 *   3. Collect exact key match variants (stacked on top of wildcard)
 *   4. If mapping form: descend via 'branches' sub-key for next depth
 *
 * Both '*' and an explicit key can match at the same level; explicit adds to wildcard.
 *
 * @param {object|null} spec - the branches: mapping on a card def
 * @param {string[]} branchPath - leaf branch path e.g. ['A', 'X']
 * @returns {null | string[]}
 */
function resolveBranchSpec(spec, branchPath) {
  if (!spec || typeof spec !== 'object') return [];

  const variantNames = [];
  let activeSpecs = [spec];

  for (const branch of branchPath) {
    const nextSpecs = [];
    const branchLower = branch.toLowerCase();

    for (const currentSpec of activeSpecs) {
      if (!currentSpec || typeof currentSpec !== 'object') continue;

      // Check explicit key for null (exclude entire card)
      const exactKey = Object.keys(currentSpec).find(k => k !== '*' && k !== '_' && k.toLowerCase() === branchLower);
      if (exactKey !== undefined) {
        const exactVal = currentSpec[exactKey];
        if (exactVal === null || exactVal === undefined) {
          return null;
        }
      }

      // Collect wildcard baseline
      if ('*' in currentSpec && currentSpec['*'] !== null) {
        const wildcardVal = currentSpec['*'];
        variantNames.push(...extractApplyList(wildcardVal));
        const wildcardSub = extractSubBranches(wildcardVal);
        if (wildcardSub) nextSpecs.push(wildcardSub);
      }

      // Collect exact key variants (stacked on top of wildcard)
      if (exactKey !== undefined) {
        const exactVal = currentSpec[exactKey];
        variantNames.push(...extractApplyList(exactVal));
        const exactSub = extractSubBranches(exactVal);
        if (exactSub) nextSpecs.push(exactSub);
      }

      // Collect fallback variants (only for branches with no exact key match)
      if (exactKey === undefined && '_' in currentSpec) {
        const fallbackVal = currentSpec['_'];
        if (fallbackVal === null || fallbackVal === undefined) {
          return null;
        }
        variantNames.push(...extractApplyList(fallbackVal));
        const fallbackSub = extractSubBranches(fallbackVal);
        if (fallbackSub) nextSpecs.push(fallbackSub);
      }
    }

    activeSpecs = nextSpecs;
  }

  return variantNames;
}

/**
 * Extract the list of variant names to apply from a branch spec value.
 * Value forms:
 *   scalar string → [string]
 *   array         → array
 *   mapping with apply: → apply value (scalar or array)
 *   mapping without apply: → []
 */
function extractApplyList(val) {
  if (val === null || val === undefined) return [];
  if (typeof val === 'string') return val ? [val] : [];
  if (Array.isArray(val)) return val.filter(v => typeof v === 'string' && v);
  if (typeof val === 'object') {
    // Mapping form: may have apply: key
    const apply = val.apply;
    if (apply === undefined) return [];
    if (typeof apply === 'string') return apply ? [apply] : [];
    if (Array.isArray(apply)) return apply.filter(v => typeof v === 'string' && v);
    return [];
  }
  return [];
}

/**
 * Extract the sub-branches mapping from a branch spec value for deeper descent.
 */
function extractSubBranches(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object' && !Array.isArray(val) && val.branches) {
    return val.branches;
  }
  return null;
}

/**
 * Strip compiler-internal metadata from a card before cloning.
 */
function stripMeta(card) {
  const out = {};
  const skip = new Set(['variants', '_source', '_include_variants', '_include_variant_tree']);
  for (const [k, v] of Object.entries(card)) {
    if (!skip.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Resolve a card fully for a given branch leaf path.
 *
 * @param {object} cardDef - the card or import definition
 * @param {Map} registry   - full merged card registry
 * @param {string[]} branchPath - active leaf path
 * @returns {object|null} fully resolved card, or null if excluded from this branch
 */
function resolveCard(cardDef, registry, branchPath) {
  let card;
  let sourceCardForVariants; // the card definition that holds the variants library

  if (cardDef.import) {
    // ── Import ──────────────────────────────────────────────────────────────
    const canonId = String(cardDef.import).toLowerCase();
    const canonCard = registry.get(canonId);
    if (!canonCard) {
      throw new Error(`Import failed: no card with id "${cardDef.import}" found in registry`);
    }

    card = deepClone(stripMeta(canonCard));
    sourceCardForVariants = canonCard;

    // Apply importVariants from the import def (top-level, before branch dispatch)
    for (const vPath of parseVariantsList(cardDef.importVariants)) {
      for (const delta of collectVariantDeltas(canonCard, vPath)) {
        applyDelta(card, delta);
      }
    }

    // Apply import-level overrides as the project base, before branch variants run.
    // Branch variants always win over these — they are defaults, not finalizers.
    if (cardDef.body) {
      applyFieldsDelta(card, { body: cardDef.body });
    }
    for (const key of ['name', 'pronouns', 'aid', 'render', 'v']) {
      if (cardDef[key] !== undefined) {
        const newVal = applyFieldOp(card[key], cardDef[key]);
        if (newVal === '__DELETE__') delete card[key]; else card[key] = newVal;
      }
    }

    // Resolve branch spec → variant names to apply
    const branchVariantNames = resolveBranchSpec(cardDef.branches, branchPath);
    if (branchVariantNames === null) return null; // excluded

    for (const vName of branchVariantNames) {
      // Branch variant names dispatch into the import def's own variants library.
      // Those local variants may themselves have importVariants pointing to canon.
      const deltas = collectVariantDeltas(cardDef, vName);
      for (const delta of deltas) {
        // Apply any importVariants declared inside this local variant from canon
        if (delta.importVariants && canonCard) {
          for (const cvPath of parseVariantsList(delta.importVariants)) {
            for (const canonDelta of collectVariantDeltas(canonCard, cvPath)) {
              applyDelta(card, canonDelta);
            }
          }
        }
        applyDelta(card, delta);
      }
    }

  } else {
    // ── Local card definition ────────────────────────────────────────────────
    card = deepClone(stripMeta(cardDef));
    sourceCardForVariants = cardDef;

    // Handle included cards that carry importVariants from the include directive
    if (cardDef._include_variants) {
      for (const vPath of parseVariantsList(cardDef._include_variants)) {
        for (const delta of collectVariantDeltas(cardDef, vPath)) {
          applyDelta(card, delta);
        }
      }
    }

    // Resolve branch spec → variant names to apply
    const branchVariantNames = resolveBranchSpec(
      cardDef._include_branch_spec || cardDef.branches,
      branchPath
    );
    if (branchVariantNames === null) return null; // excluded

    for (const vName of branchVariantNames) {
      for (const delta of collectVariantDeltas(sourceCardForVariants, vName)) {
        applyDelta(card, delta);
      }
    }

  }

  // Normalise: ensure aid.type and render.template default to each other
  if (!card.aid) card.aid = {};
  if (!card.render) card.render = {};

  if (!card.aid.type && card.render.template) card.aid.type = card.render.template;
  if (!card.render.template && card.aid.type) card.render.template = card.aid.type;

  if (!card.aid.type && !card.render.template) {
    const name = card.id || (typeof card.name === 'string' ? card.name : '');
    console.warn(`  WARN: card "${name}" has neither aid.type nor render.template`);
  }

  // Normalize name to structured form so {$name.full} / {$name.display} always resolve
  const rawName = card.name;
  if (typeof rawName === 'string' && rawName) {
    const words = rawName.trim().split(/\s+/);
    card.name = { display: words[0], full: rawName };
  } else if (rawName && typeof rawName === 'object' && !Array.isArray(rawName)) {
    const first = rawName.display || Object.values(rawName)[0] || card.id || '';
    if (!rawName.display) rawName.display = first.split(/\s+/)[0];
    if (!rawName.full)    rawName.full    = first;
  }

  return card;
}

/**
 * Enumerate all leaf branch paths from a branch tree.
 * Returns array of arrays of strings: e.g. [['A','X'], ['A','Y'], ['B']]
 * If no branches defined, returns [[]] (one root leaf).
 */
function enumerateLeaves(branches, prefix) {
  if (!prefix) prefix = [];
  if (!branches || typeof branches !== 'object' || Object.keys(branches).length === 0) {
    return [prefix];
  }
  const leaves = [];
  for (const [key, value] of Object.entries(branches)) {
    const childBranches = value && value.branches ? value.branches : null;
    leaves.push(...enumerateLeaves(childBranches, [...prefix, key]));
  }
  return leaves;
}

/**
 * Get branch config for a given path.
 * Returns the branch config object at that path, or {} if not found.
 */
function getBranchConfig(branches, branchPath) {
  let currentMap = branches;
  let currentNode = null;
  for (const part of branchPath) {
    if (!currentMap || typeof currentMap !== 'object') return {};
    const actualKey = Object.keys(currentMap).find(k => k.toLowerCase() === part.toLowerCase());
    if (!actualKey) return {};
    currentNode = currentMap[actualKey];
    currentMap = currentNode && currentNode.branches ? currentNode.branches : null;
  }
  return currentNode || {};
}

module.exports = {
  resolveCard,
  resolveBranchSpec,
  enumerateLeaves,
  getBranchConfig,
  deepClone,
  applyFieldsDelta,
  applyFieldOp,
  collectVariantDeltas,
  parseVariantsList,
};
