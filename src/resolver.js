'use strict';

/**
 * Card resolver — handles field operations, variant chains, and import resolution.
 *
 * Field operations (applied in variants and imports):
 *   Replace:          field: new value
 *   Remove:           field: "-"
 *   Append:           field: "+{value}"
 *   Remove substring: field: "-{value}"
 *   Swap substring:   field: "/{old}/{new}"
 *   Subfield ops:     field is a mapping, operations applied per subfield
 */

/**
 * Deep clone a plain object/array.
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deepClone(v);
  return out;
}

/**
 * Find a key in a mapping case-insensitively.
 * Returns the actual key string, or null if not found.
 */
function findKey(obj, key) {
  if (obj === null || typeof obj !== 'object') return null;
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return k;
  }
  return null;
}

/**
 * Get a value from an object case-insensitively.
 */
function getCI(obj, key) {
  const actual = findKey(obj, key);
  return actual !== null ? obj[actual] : undefined;
}

/**
 * Set a value on an object case-insensitively.
 * If the key already exists (any case), updates it in place.
 * Otherwise adds with the provided key.
 */
function setCI(obj, key, value) {
  const actual = findKey(obj, key);
  if (actual !== null) {
    obj[actual] = value;
  } else {
    obj[key] = value;
  }
}

/**
 * Delete a key from an object case-insensitively.
 */
function deleteCI(obj, key) {
  const actual = findKey(obj, key);
  if (actual !== null) delete obj[actual];
}

/**
 * Apply a single field operation to a current value.
 * Returns the new value.
 *
 * Operations (on string values):
 *   "-"            → remove (signals caller to delete the key)
 *   "+{x}"         → append x
 *   "-{x}"         → remove substring x
 *   "/{a}/{b}"     → swap a → b
 *   anything else  → replace
 *
 * If current is a mapping and op is also a mapping, recurse into subfields.
 */
function applyFieldOp(current, op) {
  // Both are mappings — recurse into subfields
  if (op !== null && typeof op === 'object' && !Array.isArray(op)) {
    const result = typeof current === 'object' && current !== null
      ? deepClone(current)
      : {};
    for (const [subKey, subOp] of Object.entries(op)) {
      const actualKey = findKey(result, subKey);
      const currentSub = actualKey !== null ? result[actualKey] : undefined;

      if (subOp === null || String(subOp).trim() === '-') {
        // Remove subfield (null/empty value or "-")
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

  // Null or empty value means remove
  if (op === null || op === undefined) return '__DELETE__';

  const opStr = String(op).trim();

  // Remove entire field (quoted "-" form still supported for explicitness)
  if (opStr === '-') return '__DELETE__';

  const currentStr = current !== null && current !== undefined
    ? String(current)
    : '';

  // Append: +{value}
  // Use '; ' for single-line scalars, newline for multiline block scalars.
  // If toAdd already starts with a separator character, don't add another.
  const appendMatch = opStr.match(/^\+\{([\s\S]*)\}$/);
  if (appendMatch) {
    const toAdd = appendMatch[1];
    if (!currentStr) return toAdd;
    if (currentStr.includes('\n')) {
      // Block scalar — append on new line
      const sep = toAdd.startsWith('\n') ? '' : '\n';
      return currentStr + sep + toAdd;
    } else {
      // Single-line scalar — append with '; ' unless toAdd already starts with separator
      const sep = toAdd.match(/^[;,\s]/) ? '' : '; ';
      return currentStr + sep + toAdd;
    }
  }

  // Remove substring: -{value}
  const removeMatch = opStr.match(/^-\{([\s\S]*)\}$/);
  if (removeMatch) {
    return currentStr.split(removeMatch[1]).join('').trim();
  }

  // Swap: /{old}/{new}
  const swapMatch = opStr.match(/^\/([^/]*)\/([^/]*)$/);
  if (swapMatch) {
    return currentStr.split(swapMatch[1]).join(swapMatch[2]).trim();
  }

  // Replace
  return op;
}

/**
 * Apply a fields delta object to a card's fields.
 * Mutates card in place.
 */
function applyFieldsDelta(card, delta) {
  if (!delta || typeof delta !== 'object') return;

  // Handle top-level card fields (name, triggers, pronouns, etc.)
  const topLevelFields = ['name', 'type', 'template', 'pronouns', 'protagonist',
    'encapsulate', 'known', 'triggers', 'id'];

  for (const [key, op] of Object.entries(delta)) {
    const isTopLevel = topLevelFields.some(f => f.toLowerCase() === key.toLowerCase());

    if (isTopLevel) {
      const currentVal = getCI(card, key);
      const newVal = applyFieldOp(currentVal, op);
      if (newVal === '__DELETE__') {
        deleteCI(card, key);
      } else {
        setCI(card, key, newVal);
      }
    } else {
      // It's a fields-level key
      if (!card.fields) card.fields = {};
      const currentVal = getCI(card.fields, key);
      const newVal = applyFieldOp(currentVal, op);
      if (newVal === '__DELETE__') {
        deleteCI(card.fields, key);
      } else {
        setCI(card.fields, key, newVal);
      }
    }
  }
}

/**
 * Walk a variant path (slash-separated string or array of paths)
 * on a canonical card definition and return the merged delta.
 *
 * e.g. "human/noble" → apply 'human' variant, then 'noble' child of 'human'
 *
 * Returns array of delta objects to apply in order.
 */
function collectVariantDeltas(canonCard, variantPath) {
  const deltas = [];
  if (!variantPath) return deltas;

  const parts = variantPath.split('/').map(p => p.trim()).filter(Boolean);
  let variantTree = canonCard.variants;

  for (const part of parts) {
    if (!variantTree || typeof variantTree !== 'object') {
      console.warn(`  WARN: variant "${part}" not found in variant tree of "${canonCard.id || canonCard.name}"`);
      break;
    }

    // Case-insensitive variant lookup
    const actualKey = Object.keys(variantTree).find(
      k => k.toLowerCase() === part.toLowerCase()
    );

    if (!actualKey) {
      console.warn(`  WARN: variant "${part}" not found in variant tree of "${canonCard.id || canonCard.name}"`);
      break;
    }

    const variantDef = variantTree[actualKey];
    deltas.push(variantDef);
    variantTree = variantDef.variants;
  }

  return deltas;
}

/**
 * Parse the variants list from an import definition.
 * Supports: string "a/b/c", or array ["a/b", "c/d/e"]
 * Returns array of path strings.
 */
function parseVariantsList(variants) {
  if (!variants) return [];
  if (typeof variants === 'string') return [variants];
  if (Array.isArray(variants)) return variants.map(String);
  return [];
}

/**
 * Resolve a card fully for a given branch leaf path.
 *
 * @param {object} cardDef - the card or import definition from the project
 * @param {Map} registry - full merged card registry
 * @param {string[]} branchPath - active leaf path e.g. ['A', 'X']
 * @returns {object} fully resolved card data (no variants, no import keys)
 */
function resolveCard(cardDef, registry, branchPath) {
  let card;
  let canonCard = null;

  if (cardDef.import) {
    // --- Import resolution ---
    const importPath = cardDef.import;
    const parts = importPath.split('/').map(p => p.trim());
    const canonId = parts[0].toLowerCase();
    const variantPath = parts.slice(1).join('/');

    canonCard = registry.get(canonId);
    if (!canonCard) {
      throw new Error(`Import failed: no card with id "${canonId}" found in registry`);
    }

    // Start with canonical base (strip compiler metadata)
    card = deepClone(stripMeta(canonCard));

    // Apply primary import variant path
    if (variantPath) {
      for (const delta of collectVariantDeltas(canonCard, variantPath)) {
        applyDelta(card, delta, canonCard);
      }
    }

    // Apply additional import-variant chains from canon
    for (const vPath of parseVariantsList(cardDef['import-variant'])) {
      for (const delta of collectVariantDeltas(canonCard, vPath)) {
        applyDelta(card, delta, canonCard);
      }
    }

    // Apply scenario-level fields
    if (cardDef.fields) {
      applyFieldsDelta(card, cardDef.fields);
    }

    // Apply top-level overrides from import def (name, pronouns, etc.)
    for (const key of ['name', 'type', 'template', 'pronouns', 'protagonist',
      'encapsulate', 'known', 'triggers']) {
      if (cardDef[key] !== undefined) {
        card[key] = cardDef[key];
      }
    }

  } else {
    // --- Local card definition ---
    card = deepClone(stripMeta(cardDef));
    canonCard = null;
  }

  // Walk branch path, applying branch variants
  applyBranchVariants(card, cardDef, canonCard, branchPath);

  return card;
}

/**
 * Apply branch variant deltas by walking the branch path.
 */
function applyBranchVariants(card, cardDef, canonCard, branchPath) {
  let variantTree = cardDef.variants;

  for (const branch of branchPath) {
    if (!variantTree || typeof variantTree !== 'object') break;

    const actualKey = Object.keys(variantTree).find(
      k => k.toLowerCase() === branch.toLowerCase()
    );
    if (!actualKey) break;

    const branchVariant = variantTree[actualKey];

    // Apply import-variant chains from canon
    if (branchVariant['import-variant'] && canonCard) {
      for (const vPath of parseVariantsList(branchVariant['import-variant'])) {
        for (const delta of collectVariantDeltas(canonCard, vPath)) {
          applyDelta(card, delta, canonCard);
        }
      }
    }

    // Apply local fields
    if (branchVariant.fields) {
      applyFieldsDelta(card, branchVariant.fields);
    }

    // Apply top-level overrides
    for (const key of ['name', 'type', 'template', 'pronouns', 'protagonist',
      'encapsulate', 'known', 'triggers']) {
      if (branchVariant[key] !== undefined) {
        card[key] = branchVariant[key];
      }
    }

    variantTree = branchVariant.variants;
  }
}

/**
 * Apply a variant delta to a card in progress.
 * Handles both fields-level and top-level keys in the delta.
 */
function applyDelta(card, delta, canonCard) {
  if (!delta) return;

  const topLevelFields = ['name', 'type', 'template', 'pronouns', 'protagonist',
    'encapsulate', 'known', 'triggers'];

  for (const [key, value] of Object.entries(delta)) {
    // Skip compiler/structural keys
    if (['variants', 'import-variant', '_source'].includes(key.toLowerCase())) continue;

    const isTopLevel = topLevelFields.some(f => f.toLowerCase() === key.toLowerCase());

    if (isTopLevel) {
      const current = getCI(card, key);
      const newVal = applyFieldOp(current, value);
      if (newVal === '__DELETE__') {
        deleteCI(card, key);
      } else {
        setCI(card, key, newVal);
      }
    } else if (key.toLowerCase() === 'fields') {
      applyFieldsDelta(card, value);
    } else {
      // Treat unknown top-level keys in variant as field operations
      if (!card.fields) card.fields = {};
      const current = getCI(card.fields, key);
      const newVal = applyFieldOp(current, value);
      if (newVal === '__DELETE__') {
        deleteCI(card.fields, key);
      } else {
        setCI(card.fields, key, newVal);
      }
    }
  }
}

/**
 * Strip compiler-internal metadata from a card before cloning.
 */
function stripMeta(card) {
  const { variants, _source, ...rest } = card;
  return rest;
}

/**
 * Enumerate all leaf branch paths from a branch tree.
 * Returns array of arrays of strings, e.g. [['A','X'], ['A','Y'], ['B','Z']]
 * If no branches defined, returns [[]] (one leaf, the root).
 */
function enumerateLeaves(branches, prefix = []) {
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
 * Returns the branch config object at the leaf, or {} if not found.
 */
function getBranchConfig(branches, branchPath) {
  // branches is the raw branches map (e.g. config.branches)
  // Each entry may have a nested 'branches' key for sub-branches
  let currentMap = branches;
  let currentNode = null;
  for (const part of branchPath) {
    if (!currentMap || typeof currentMap !== 'object') return {};
    const actualKey = Object.keys(currentMap).find(
      k => k.toLowerCase() === part.toLowerCase()
    );
    if (!actualKey) return {};
    currentNode = currentMap[actualKey];
    currentMap = currentNode && currentNode.branches ? currentNode.branches : null;
  }
  return currentNode || {};
}

module.exports = {
  resolveCard,
  enumerateLeaves,
  getBranchConfig,
  deepClone,
  applyFieldsDelta,
  collectVariantDeltas,
  applyFieldOp,
};
