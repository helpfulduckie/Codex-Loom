'use strict';

const { walkCardTextFields } = require('../util');

// Pure by contract (§3.3): warnings go to a caller-supplied onWarn(code, message).
const CODES = Object.freeze({
  CROSS_ITEM_REF_MISSING: 'CL0330',
});

/**
 * Pronoun resolution for Codex Loom v3.
 *
 * Braced token forms in templates and field text:
 *   {$she} {$her~} etc.        - unscoped; resolves against card's own pronouns field
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
 * Get the display name from a card (first word if scalar, name.display if mapping).
 */
function getDisplayName(card) {
  const name = card.name;
  if (!name) return card.id || '';
  if (typeof name === 'string') return name.split(/\s+/)[0];
  if (typeof name === 'object') return name.display || Object.values(name)[0] || card.id || '';
  return String(name);
}

/**
 * Get the full name from a card.
 */
function getFullName(card) {
  const name = card.name;
  if (!name) return card.id || '';
  if (typeof name === 'string') return name;
  if (typeof name === 'object') return name.full || name.display || Object.values(name)[0] || card.id || '';
  return String(name);
}

/**
 * Get the pronoun set name for a card, accounting for protagonist status.
 */
function getEffectivePronounSet(cardOrPronouns, cardId, branchProtagonist) {
  const isProtagonist = branchProtagonist && cardId &&
    branchProtagonist.toLowerCase() === cardId.toLowerCase();
  if (isProtagonist) return 'you';
  const raw = typeof cardOrPronouns === 'string' ? cardOrPronouns : (cardOrPronouns && cardOrPronouns.pronouns);
  return raw || null;
}

/**
 * Combined pronoun and verb conjugation pass.
 *
 * Processes a string left-to-right, handling:
 *   {$PronounToken}      - unscoped pronoun; against card's own pronouns; does NOT set scope
 *   {$Id}                - character reference; sets scope to Id
 *   {$Id.pronoun}        - scoped pronoun; sets scope to Id
 *   {$Id.body.field}     - cross-card ref; leave as-is (handled in second pass)
 *   [s] [es] [is] [was] [has] - conjugate using current scope
 *
 * @param {string} str
 * @param {object} opts
 *   opts.card            - the card being processed
 *   opts.registry        - full card registry Map
 *   opts.branchProtagonist - lowercase protagonist ID or null
 *   opts.resolvedById    - optional Map of post-variant resolved cards by lowercase id
 */
function applyTokenPass(str, opts) {
  const { card, registry, branchProtagonist, resolvedById } = opts;
  const cardId = (card.id || '').toLowerCase();
  const cardPronounSet = getEffectivePronounSet(card, cardId, branchProtagonist);

  // Current conjugation scope: pronoun set name of the most-recently-referenced {$Id}
  let currentScope = null;

  // Combined regex: brace tokens OR conjugation markers
  const TOKEN_RE = /\{(\$[^{}]+)\}|\[(s|es|is|was|has)\]/g;

  return str.replace(TOKEN_RE, (match, braceContent, verbMarker) => {
    if (verbMarker) {
      // Verb conjugation marker
      const scope = currentScope || cardPronounSet;
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
        const refCard = (resolvedById && resolvedById.get(prefixLower)) || registry.get(prefixLower);
        const refPronounSet = getEffectivePronounSet(refCard, prefixLower, branchProtagonist);

        // Is rest a pronoun token?
        const restLower = rest.toLowerCase();
        if (PRONOUN_TOKEN_MAP[restLower] !== undefined) {
          // Scoped pronoun: {$Id.she} — sets scope
          currentScope = refPronounSet || 'nonbinary';
          return resolveProunounToken(rest, refPronounSet);
        }

        // Check for {$Id.full} or {$Id.display}
        if (restLower === 'full') return matchCase(getFullName(refCard), inner);
        if (restLower === 'display') return matchCase(getDisplayName(refCard), inner);

        // Otherwise it's a cross-card field ref like {$Id.body.field} — leave for second pass
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
        const refCard = (resolvedById && resolvedById.get(baseId)) || registry.get(baseId);
        const isProtagonist = branchProtagonist && branchProtagonist === baseId;
        if (isProtagonist) return matchCase('your', inner);
        return getDisplayName(refCard) + "'s";
      }
    }

    // Is it a registry ID? → character reference
    if (registry.has(innerLower)) {
      const refCard = (resolvedById && resolvedById.get(innerLower)) || registry.get(innerLower);
      const refPronounSet = getEffectivePronounSet(refCard, innerLower, branchProtagonist);
      // Sets conjugation scope
      currentScope = refPronounSet || 'nonbinary';

      const isProtagonist = branchProtagonist && branchProtagonist === innerLower;
      if (isProtagonist) return 'you';
      return matchCase(getDisplayName(refCard), inner);
    }

    // Is it an unscoped pronoun token? → resolve against card's own pronouns
    if (PRONOUN_TOKEN_MAP[innerLower] !== undefined) {
      // Does NOT set scope
      return resolveProunounToken(inner, cardPronounSet);
    }

    // Unknown — leave as-is
    return match;
  });
}

/**
 * Apply cross-card reference resolution: {$id.body.field} → resolved field value.
 * This is a second pass run after all cards for a branch have been resolved.
 *
 * @param {object[]} resolvedCards - all cards compiled for this branch
 * @param {Map} registry - full card registry (for fallback to canonical base)
 */
function applyCrossCardRefs(resolvedCards, registry, onWarn) {
  // Build a quick lookup by id for the resolved cards
  const resolvedById = new Map();
  for (const card of resolvedCards) {
    const id = (card.id || '').toLowerCase();
    if (id) resolvedById.set(id, card);
  }

  const CROSS_RE = /\{\$([A-Za-z][A-Za-z0-9_-]*)\.body\.([^}]+)\}/g;

  function resolveRef(refId, fieldPath) {
    const lower = refId.toLowerCase();
    const sourceCard = resolvedById.get(lower) || registry.get(lower);
    if (!sourceCard) {
      if (onWarn) onWarn(CODES.CROSS_ITEM_REF_MISSING, `cross-card ref {${refId}.body.${fieldPath}} — card not found`);
      return null;
    }
    const parts = fieldPath.split('.');
    let val = sourceCard.body || {};
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

  for (const card of resolvedCards) {
    walkCardTextFields(card, processValue);
  }
}

/**
 * Apply all pronoun processing passes to a resolved card's body fields.
 * Mutates card.body in place.
 *
 * @param {object} card
 * @param {Map} registry
 * @param {string|null} branchProtagonist - lowercase protagonist ID
 */
function applyPronounPasses(card, registry, branchProtagonist, resolvedById) {
  const opts = { card, registry, branchProtagonist, resolvedById };
  walkCardTextFields(card, s => applyTokenPass(s, opts));
}

module.exports = {
  CODES,
  applyPronounPasses,
  applyTokenPass,
  applyCrossCardRefs,
  resolveProunounToken,
  getDisplayName,
  getFullName,
  matchCase,
  PRONOUN_SETS,
  PRONOUN_TOKEN_MAP,
  PLURAL_SETS,
};
