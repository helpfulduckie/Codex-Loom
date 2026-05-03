'use strict';

/**
 * Pronoun resolution for AID card compiler.
 *
 * Two systems:
 *
 * 1. Braced pronoun tokens {$she}, {$her~} etc. in templates and field values.
 *    Resolve against the card's `pronouns:` field.
 *
 * 2. Bare $ markers in field values: $Aness, $she, $her~
 *    Resolve against the active protagonist context.
 *
 * Verb conjugation: love[s] → love or loves depending on active pronoun set.
 */

// Pronoun sets
const PRONOUN_SETS = {
  female: {
    subject:    'she',
    object:     'her',
    possessive: 'her',
    reflexive:  'herself',
    contraction:'she\'s',
  },
  male: {
    subject:    'he',
    object:     'him',
    possessive: 'his',
    reflexive:  'himself',
    contraction:'he\'s',
  },
  they: {
    subject:    'they',
    object:     'them',
    possessive: 'their',
    reflexive:  'themselves',
    contraction:'they\'re',
  },
  you: {
    subject:    'you',
    object:     'you',
    possessive: 'your',
    reflexive:  'yourself',
    contraction:'you\'re',
  },
};

// Whether this pronoun set uses plural verb forms (drop the s)
const PLURAL_SETS = new Set(['they', 'you']);

/**
 * Map a pronoun token keyword to its grammatical role.
 * All lookups are case-insensitive; output case matches input case.
 */
const PRONOUN_TOKEN_MAP = {
  // subject
  'she': 'subject',
  'he': 'subject',
  'they': 'subject',
  // object
  'her': 'object',
  'him': 'object',
  'them': 'object',
  // possessive (~ suffix)
  'her~': 'possessive',
  'his~': 'possessive',
  'their~': 'possessive',
  // reflexive
  'herself': 'reflexive',
  'himself': 'reflexive',
  'themselves': 'reflexive',
  // contraction
  "she's": 'contraction',
  "he's": 'contraction',
  "they're": 'contraction',
};

/**
 * Resolve a pronoun token against a pronoun set name.
 * Returns the resolved string, preserving the original token's leading case.
 * If set is unknown or token unrecognized, returns the bare word (token without ~).
 */
function resolveProunounToken(token, setName) {
  const lower = token.toLowerCase();
  const role = PRONOUN_TOKEN_MAP[lower];
  const set = PRONOUN_SETS[setName ? setName.toLowerCase() : ''];

  // Bare word fallback: strip ~ if present
  const bare = lower.endsWith('~') ? lower.slice(0, -1) : lower;

  if (!role || !set) {
    return matchCase(bare, token);
  }

  return matchCase(set[role], token);
}

/**
 * Match the case pattern of `original` onto `str`.
 * If original starts with uppercase, capitalize str.
 * Otherwise lowercase str.
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
 * Process braced pronoun tokens {$she}, {$Her~} etc. in a string.
 * Resolves against the card's pronouns field.
 * Falls back to bare word if pronouns field is missing or unrecognized.
 */
function processBracedPronounTokens(str, pronounsField) {
  // Match {$word} or {$word~} — these are pronoun tokens, not field interpolations
  // Field interpolations like {$fields.x} are handled separately
  return str.replace(/\{\$([a-zA-Z]+~?|[a-zA-Z]+'s|[a-zA-Z]+'re)\}/g, (match, token) => {
    const lower = token.toLowerCase();
    if (PRONOUN_TOKEN_MAP[lower] !== undefined) {
      return resolveProunounToken(token, pronounsField);
    }
    // Not a pronoun token — leave for field interpolation to handle
    return match;
  });
}

/**
 * Process verb conjugation markers: love[s] → love or loves.
 * Plural sets (you, they) drop the s. Singular sets keep it.
 */
function processVerbConjugation(str, pronounsField) {
  const setName = (pronounsField || '').toLowerCase();
  const plural = PLURAL_SETS.has(setName);

  return str.replace(/\[s\]/g, () => plural ? '' : 's');
}

/**
 * Process bare $ markers in field values.
 *
 * Token ends on whitespace, non-dash punctuation (except ~), or end of string.
 * $ followed by a number → leave as-is silently.
 * Unrecognized $word → warn and leave as-is.
 *
 * @param {string} str - field value text
 * @param {object} context - { card, registry, branchProtagonist }
 *   card: the resolved card object
 *   registry: full card registry Map
 *   branchProtagonist: the active branch's protagonist ID (lowercase) or null
 */
function processBareMarkers(str, context) {
  const { card, registry, branchProtagonist } = context;
  const cardProtagonist = (card.protagonist || '').toLowerCase();

  // Token regex: $ followed by word chars, dashes, tildes, apostrophes
  // Does NOT match ${...} (those are template/interpolation syntax)
  return str.replace(/\$(?!\{)([A-Za-z][A-Za-z0-9\-~']*)/g, (match, token) => {
    // $ followed by number — handled by the regex not matching, but belt-and-suspenders
    if (/^\d/.test(token)) return match;

    const lower = token.toLowerCase();

    // Check if it's a known protagonist ID
    const isProtagonistId = registry.has(lower);
    if (isProtagonistId) {
      const referencedCard = registry.get(lower);
      if (branchProtagonist && branchProtagonist === lower) {
        // This character IS the active protagonist
        return 'you';
      } else {
        // Resolve to name field
        return referencedCard.name || token;
      }
    }

    // Check if it's a pronoun token
    if (PRONOUN_TOKEN_MAP[lower] !== undefined) {
      if (!cardProtagonist) {
        console.warn(`  WARN: bare $${token} found on card "${card.name || card.id}" which has no protagonist field — leaving as-is`);
        return matchCase(lower.endsWith('~') ? lower.slice(0, -1) : lower, token);
      }

      // Is this card's protagonist the active branch protagonist?
      if (branchProtagonist && branchProtagonist === cardProtagonist) {
        // Resolve to you-set
        return resolveProunounToken(token, 'you');
      }

      // Resolve to the card's protagonist's pronoun set
      const protagonistCard = registry.get(cardProtagonist);
      if (protagonistCard && protagonistCard.pronouns) {
        return resolveProunounToken(token, protagonistCard.pronouns);
      }

      // Fallback: bare word
      const bare = lower.endsWith('~') ? lower.slice(0, -1) : lower;
      return matchCase(bare, token);
    }

    // Unrecognized — warn and leave
    console.warn(`  WARN: unrecognized bare $${token} in card "${card.name || card.id}" — leaving as-is`);
    return match;
  });
}

/**
 * Apply all pronoun processing passes to a resolved card's fields.
 * Mutates card.fields in place.
 * Pass order: braced tokens → verb conjugation → bare markers
 *
 * Effective pronoun set for verb conjugation:
 * - If this card's protagonist is the active branch protagonist → 'you'
 * - Otherwise → card's declared pronouns field
 */
function applyPronounPasses(card, registry, branchProtagonist) {
  const pronounsField = card.pronouns || null;
  const cardProtagonist = (card.protagonist || '').toLowerCase();

  // Determine effective pronoun set for verb conjugation
  const isYouMode = branchProtagonist && cardProtagonist &&
    branchProtagonist === cardProtagonist;
  const effectivePronounSet = isYouMode ? 'you' : pronounsField;

  const context = { card, registry, branchProtagonist };

  processFieldsRecursive(card.fields, (value) => {
    let s = value;
    s = processBracedPronounTokens(s, pronounsField);
    s = processVerbConjugation(s, effectivePronounSet);
    s = processBareMarkers(s, context);
    return s;
  });
}

/**
 * Recursively walk all string values in a fields object and apply a transform.
 */
function processFieldsRecursive(obj, transform) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') return; // handled by caller
  if (typeof obj !== 'object') return;

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      obj[key] = transform(val);
    } else if (typeof val === 'object' && val !== null) {
      processFieldsRecursive(val, transform);
    }
  }
}

module.exports = {
  applyPronounPasses,
  processBracedPronounTokens,
  processVerbConjugation,
  processBareMarkers,
  resolveProunounToken,
  PRONOUN_SETS,
};
