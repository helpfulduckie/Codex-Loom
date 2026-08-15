'use strict';

const { walkItemTextFields } = require('../util');

// Pure by contract (§3.3): warnings go to a caller-supplied onWarn(code, message).
const CODES = Object.freeze({
  CROSS_ITEM_REF_MISSING: 'CL0330',
});

/**
 * Pronoun resolution for Codex Loom v3.
 *
 * Braced token forms in templates and field text:
 *   {$she} {$her~} etc.        - unscoped; resolves against item's own pronouns field
 *   {$Id}                      - character reference; "you" if Id is protagonist, else name.display
 *   {$Id's}                    - possessive name; "your" if Id is protagonist, else "Name's"
 *   {$Id.she} {$Id.her~} etc.  - scoped pronoun; resolves vs Id's pronouns, protagonist-aware
 *
 * Verb conjugation:
 *   [s] [es] [is] [was] [has]  - conjugate based on most-recently-referenced {$Id}
 */

const PRONOUN_SETS = {
  female: {
    subject:     'she',
    object:      'her',
    possessive:  'her',
    reflexive:   'herself',
    contraction: "she's",
    verb_is:     'is',
    verb_was:    'was',
  },
  male: {
    subject:     'he',
    object:      'him',
    possessive:  'his',
    reflexive:   'himself',
    contraction: "he's",
    verb_is:     'is',
    verb_was:    'was',
  },
  nonbinary: {
    subject:     'they',
    object:      'them',
    possessive:  'their',
    reflexive:   'themselves',
    contraction: "they're",
    verb_is:     'are',
    verb_was:    'were',
  },
  you: {
    subject:     'you',
    object:      'you',
    possessive:  'your',
    reflexive:   'yourself',
    contraction: "you're",
    verb_is:     'are',
    verb_was:    'were',
  },
};

// Pronoun sets that use plural verb forms (drop [s], [es])
const PLURAL_SETS = new Set(['nonbinary', 'they', 'you']);

const PRONOUN_TOKEN_MAP = {
  'she':        'subject',
  'he':         'subject',
  'they':       'subject',
  'her':        'object',
  'him':        'object',
  'them':       'object',
  'her~':       'possessive',
  'his~':       'possessive',
  'their~':     'possessive',
  'herself':    'reflexive',
  'himself':    'reflexive',
  'themselves': 'reflexive',
  "she's":      'contraction',
  "he's":       'contraction',
  "they're":    'contraction',
  'is':         'verb_is',
  'are':        'verb_is',
  'was':        'verb_was',
  'were':       'verb_was',
};

/**
 * Resolve a pronoun token keyword against a pronoun set name.
 * Preserves leading case of the original token.
 */
function resolveProunounToken(token, setName) {
  const lower = token.toLowerCase();
  const role = PRONOUN_TOKEN_MAP[lower];
  const normalizedSet = (setName || '').toLowerCase();
  // Map 'they' and 'nonbinary' to the nonbinary set
  const canonicalSet = (normalizedSet === 'they' || normalizedSet === 'nonbinary') ? 'nonbinary' : normalizedSet;
  const set = PRONOUN_SETS[canonicalSet];
  const bare = lower.endsWith('~') ? lower.slice(0, -1) : lower;

  if (!role || !set) return matchCase(bare, token);
  return matchCase(set[role], token);
}

/**
 * Preserve the case pattern of `original` onto `str`.
 */
function matchCase(str, original) {
  if (!str) return str;
  if (original && original[0] === original[0].toUpperCase() &&
      original[0] !== original[0].toLowerCase()) {
    return str[0].toUpperCase() + str.slice(1);
  }
  return str.toLowerCase();
}

/**
 * Get the display name from an item (first word if scalar, name.display if mapping).
 */
function getDisplayName(item) {
  const name = item.name;
  if (!name) return item.id || '';
  if (typeof name === 'string') return name.split(/\s+/)[0];
  if (typeof name === 'object') return name.display || Object.values(name)[0] || item.id || '';
  return String(name);
}

/**
 * Get the full name from an item.
 */
function getFullName(item) {
  const name = item.name;
  if (!name) return item.id || '';
  if (typeof name === 'string') return name;
  if (typeof name === 'object') return name.full || name.display || Object.values(name)[0] || item.id || '';
  return String(name);
}

/**
 * Get the pronoun set name for an item, accounting for protagonist status.
 */
function getEffectivePronounSet(itemOrPronouns, itemId, branchProtagonist) {
  const isProtagonist = branchProtagonist && itemId &&
    branchProtagonist.toLowerCase() === itemId.toLowerCase();
  if (isProtagonist) return 'you';
  const raw = typeof itemOrPronouns === 'string' ? itemOrPronouns : (itemOrPronouns && itemOrPronouns.pronouns);
  return raw || null;
}

/**
 * Combined pronoun and verb conjugation pass.
 *
 * Processes a string left-to-right, handling:
 *   {$PronounToken}      - unscoped pronoun; against item's own pronouns; does NOT set scope
 *   {$Id}                - character reference; sets scope to Id
 *   {$Id.pronoun}        - scoped pronoun; sets scope to Id
 *   {$Id.body.field}     - cross-item ref; leave as-is (handled in second pass)
 *   [s] [es] [is] [was] [has] - conjugate using current scope
 *
 * @param {string} str
 * @param {object} opts
 *   opts.item            - the item being processed
 *   opts.registry        - full item registry Map
 *   opts.branchProtagonist - lowercase protagonist ID or null
 *   opts.resolvedById    - optional Map of post-variant resolved items by lowercase id
 */
function applyTokenPass(str, opts) {
  const { item, registry, branchProtagonist, resolvedById } = opts;
  const itemId = (item.id || '').toLowerCase();
  const itemPronounSet = getEffectivePronounSet(item, itemId, branchProtagonist);

  // Current conjugation scope: pronoun set name of the most-recently-referenced {$Id}
  let currentScope = null;

  // Combined regex: brace tokens OR conjugation markers
  const TOKEN_RE = /\{(\$[^{}]+)\}|\[(s|es|is|was|has)\]/g;

  return str.replace(TOKEN_RE, (match, braceContent, verbMarker) => {
    if (verbMarker) {
      // Verb conjugation marker
      const scope = currentScope || itemPronounSet;
      const plural = scope ? PLURAL_SETS.has(scope.toLowerCase()) : false;
      switch (verbMarker) {
        case 's':   return plural ? '' : 's';
        case 'es':  return plural ? '' : 'es';
        case 'is':  return plural ? 'are' : 'is';
        case 'was': return plural ? 'were' : 'was';
        case 'has': return plural ? 'have' : 'has';
      }
      return match;
    }

    // Brace token: braceContent is the inner part (includes leading $)
    const inner = braceContent.trim().slice(1); // strip leading $

    // Check for dot — either "Id.pronoun" or "Id.body.field"
    const dotIdx = inner.indexOf('.');
    if (dotIdx !== -1) {
      const prefix = inner.slice(0, dotIdx);
      const rest = inner.slice(dotIdx + 1);
      const prefixLower = prefix.toLowerCase();

      // Is prefix a registry ID?
      if (registry.has(prefixLower)) {
        const refItem = (resolvedById && resolvedById.get(prefixLower)) || registry.get(prefixLower);
        const refPronounSet = getEffectivePronounSet(refItem, prefixLower, branchProtagonist);

        // Is rest a pronoun token?
        const restLower = rest.toLowerCase();
        if (PRONOUN_TOKEN_MAP[restLower] !== undefined) {
          // Scoped pronoun: {$Id.she} — sets scope
          currentScope = refPronounSet || 'nonbinary';
          return resolveProunounToken(rest, refPronounSet);
        }

        // Check for {$Id.full} or {$Id.display}
        if (restLower === 'full') return matchCase(getFullName(refItem), inner);
        if (restLower === 'display') return matchCase(getDisplayName(refItem), inner);

        // Otherwise it's a cross-item field ref like {$Id.body.field} — leave for second pass
        return match;
      }

      // prefix not a registry ID — leave as-is
      return match;
    }

    // No dot — single segment
    const innerLower = inner.toLowerCase();

    // Possessive character reference: {$Aness's} → "Aness's" or "your" if protagonist
    if (innerLower.endsWith("'s")) {
      const baseId = innerLower.slice(0, -2);
      if (registry.has(baseId)) {
        const refItem = (resolvedById && resolvedById.get(baseId)) || registry.get(baseId);
        const isProtagonist = branchProtagonist && branchProtagonist === baseId;
        if (isProtagonist) return matchCase('your', inner);
        return getDisplayName(refItem) + "'s";
      }
    }

    // Is it a registry ID? → character reference
    if (registry.has(innerLower)) {
      const refItem = (resolvedById && resolvedById.get(innerLower)) || registry.get(innerLower);
      const refPronounSet = getEffectivePronounSet(refItem, innerLower, branchProtagonist);
      // Sets conjugation scope
      currentScope = refPronounSet || 'nonbinary';

      const isProtagonist = branchProtagonist && branchProtagonist === innerLower;
      if (isProtagonist) return 'you';
      return matchCase(getDisplayName(refItem), inner);
    }

    // Is it an unscoped pronoun token? → resolve against item's own pronouns
    if (PRONOUN_TOKEN_MAP[innerLower] !== undefined) {
      // Does NOT set scope
      return resolveProunounToken(inner, itemPronounSet);
    }

    // Unknown — leave as-is
    return match;
  });
}

/**
 * Apply cross-item reference resolution: {$id.body.field} → resolved field value.
 * This is a second pass run after all items for a branch have been resolved.
 *
 * @param {object[]} resolvedItems - all items compiled for this branch
 * @param {Map} registry - full item registry (for fallback to canonical base)
 */
function applyCrossItemRefs(resolvedItems, registry, onWarn, resolvedById) {
  // Callers that already have an id→item map (the compiler does) pass it in; standalone
  // callers get one built here.
  if (!resolvedById) {
    resolvedById = new Map();
    for (const item of resolvedItems) {
      const id = (item.id || '').toLowerCase();
      if (id) resolvedById.set(id, item);
    }
  }

  const CROSS_RE = /\{\$([A-Za-z][A-Za-z0-9_-]*)\.body\.([^}]+)\}/g;

  function resolveRef(refId, fieldPath) {
    const lower = refId.toLowerCase();
    const sourceItem = resolvedById.get(lower) || registry.get(lower);
    if (!sourceItem) {
      if (onWarn) onWarn(CODES.CROSS_ITEM_REF_MISSING, `cross-item ref {${refId}.body.${fieldPath}} — item not found`);
      return null;
    }
    const parts = fieldPath.split('.');
    let val = sourceItem.body || {};
    for (const part of parts) {
      if (val === null || typeof val !== 'object') return null;
      const actualKey = Object.keys(val).find(k => k.toLowerCase() === part.toLowerCase());
      if (actualKey === undefined) return null;
      val = val[actualKey];
    }
    return val !== null && val !== undefined ? String(val) : null;
  }

  function processValue(str) {
    return str.replace(CROSS_RE, (match, refId, fieldPath) => {
      const val = resolveRef(refId, fieldPath);
      return val !== null ? val : match;
    });
  }

  for (const item of resolvedItems) {
    walkItemTextFields(item, processValue);
  }
}

/**
 * Apply all pronoun processing passes to a resolved item's body fields.
 * Mutates item.body in place.
 *
 * @param {object} item
 * @param {Map} registry
 * @param {string|null} branchProtagonist - lowercase protagonist ID
 */
function applyPronounPasses(item, registry, branchProtagonist, resolvedById) {
  const opts = { item, registry, branchProtagonist, resolvedById };
  walkItemTextFields(item, s => applyTokenPass(s, opts));
}

module.exports = {
  CODES,
  applyPronounPasses,
  applyTokenPass,
  applyCrossItemRefs,
  resolveProunounToken,
  getDisplayName,
  getFullName,
  matchCase,
  PRONOUN_SETS,
  PRONOUN_TOKEN_MAP,
  PLURAL_SETS,
};
