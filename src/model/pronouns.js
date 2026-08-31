'use strict';

const { walkItemTextFields } = require('../util');

// Pure by contract (§3.3): warnings go to a caller-supplied onWarn(code, message).
const CODES = Object.freeze({
  CROSS_ITEM_REF_MISSING: 'CL0330',
  // Roles (§9.2, §9.3) — see diag.js for the full band comment; the values here are the
  // source of truth `diag.test.js` checks against `SEVERITY_BY_CODE`.
  ROLE_UNDECLARED: 'CL0540',
  ROLE_COLLIDES_WITH_ITEM: 'CL0541',
  ROLE_TARGET_EXCLUDED: 'CL0542',
  ROLE_INDIRECTION: 'CL0543',
  ROLE_UNUSED: 'CL0545',
});

/**
 * Pronoun resolution for Codex Loom v4.
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
 * Rewrite a token's leading identifier from a role name to its bound item id (§9.2, §9.3).
 *
 * Returns the bound item id, or `null` when `leading` is not a declared role — the caller
 * falls through to its existing item-id handling unchanged. A role that IS declared but
 * cannot resolve — collides with an item id, targets another role, or targets an item this
 * branch excludes — raises its own ERROR and also returns `null`: the token is left
 * unresolved on purpose, so `CL0430` catches it a second time at the output sweep (settled
 * 2026-08-22, the same two-reports trade Phase 7 Decision 5 made for `CL0602`).
 *
 * Gated on `roles` carrying at least one entry, so a branch that declares none behaves
 * exactly as it did before this existed — no new diagnostic on a corpus nothing here
 * touches yet.
 */
function resolveRole(leading, { roles, registry, resolvedById, onWarn, onRoleUsed }) {
  if (!roles || Object.keys(roles).length === 0) return null;
  const leadingLower = leading.toLowerCase();
  const roleKey = Object.keys(roles).find((k) => k.toLowerCase() === leadingLower);
  if (roleKey === undefined) return null;

  if (registry.has(leadingLower)) {
    if (onWarn) {
      onWarn(
        CODES.ROLE_COLLIDES_WITH_ITEM,
        `"${leading}" is both a declared role and an item id, which is ambiguous — rename `
        + 'one (§9.3).',
      );
    }
    return null;
  }

  const boundId = roles[roleKey];
  const boundLower = boundId === null || boundId === undefined ? '' : String(boundId).toLowerCase();
  const targetIsRole = Object.keys(roles).some((k) => k.toLowerCase() === boundLower);
  if (targetIsRole) {
    if (onWarn) {
      onWarn(
        CODES.ROLE_INDIRECTION,
        `role "${roleKey}" is bound to "${boundId}", which is itself a role — a role must `
        + 'resolve directly to an item id, one level of indirection always (§9.3).',
      );
    }
    return null;
  }

  const target = (resolvedById && resolvedById.get(boundLower)) || registry.get(boundLower);
  if (!target) {
    if (onWarn) {
      onWarn(
        CODES.ROLE_TARGET_EXCLUDED,
        `role "${roleKey}" is bound to "${boundId}", which does not resolve on this branch.`,
      );
    }
    return null;
  }

  if (onRoleUsed) onRoleUsed(roleKey);
  return boundId;
}

/** The message CL0540 raises — the compiler cannot tell an undeclared role from a misspelled item id (§9.3, both readings are named). */
function roleUndeclaredMessage(name, roles) {
  const scope = roles && Object.keys(roles).length
    ? `Roles declared in scope: ${Object.keys(roles).join(', ')}.`
    : 'No roles are declared on this branch.';
  return `"{$${name}}" does not resolve to a declared role or a known item id. ${scope}`;
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
  const { item, registry, branchProtagonist, resolvedById, roles, onWarn, onRoleUsed } = opts;
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
    let inner = braceContent.trim().slice(1); // strip leading $

    // Roles resolve first, always (§9.3): rewrite a leading role name to its bound item id
    // so every check below sees an ordinary card reference. `{$LI}`, `{$LI's}`, `{$LI.he}`
    // and `{$LI.body.X}` all share one leading identifier, so one substitution handles all
    // four — everything past this point reads `inner`, never `braceContent`.
    {
      const dot0 = inner.indexOf('.');
      const possessive = dot0 === -1 && inner.toLowerCase().endsWith("'s");
      const leading = dot0 !== -1 ? inner.slice(0, dot0) : possessive ? inner.slice(0, -2) : inner;
      const trailing = dot0 !== -1 ? inner.slice(dot0) : possessive ? "'s" : '';
      const roleId = resolveRole(leading, { roles, registry, resolvedById, onWarn, onRoleUsed });
      if (roleId !== null) inner = roleId + trailing;
    }

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

        // Otherwise it's a cross-item field ref like {$Id.body.field} — leave for second
        // pass, but reconstructed from `inner` rather than the original `match`: a role
        // rewrite above already replaced the leading identifier, and `applyCrossItemRefs`
        // only understands item ids, never role names.
        return `{$${inner}}`;
      }

      // prefix not a registry ID — leave as-is. Role-aware (§9.3) and gated on `roles`
      // being non-null — some node in the chain declared a `roles:` key, even if every
      // binding it declared is now unbound — the compiler cannot tell an undeclared role
      // from a misspelled item id, so on role-aware territory this reports both readings
      // in addition to — not instead of — CL0430 catching the same leaked token later at
      // the output sweep (settled 2026-08-22). A project that never mentions roles behaves
      // exactly as it did before this existed.
      if (onWarn && roles) {
        onWarn(CODES.ROLE_UNDECLARED, roleUndeclaredMessage(prefix, roles));
      }
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

    // Unknown — leave as-is (see the dotted branch above for why CL0540 is gated the
    // same way here).
    if (onWarn && roles) {
      onWarn(CODES.ROLE_UNDECLARED, roleUndeclaredMessage(inner, roles));
    }
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
 * @param {Map} resolvedById
 * @param {object|null} roles - this branch's merged role table (§9.2)
 * @param {function|null} onWarn - (code, message) => void, for §9.3's role diagnostics
 * @param {function|null} onRoleUsed - (roleKey) => void, for CL0545's usage tracking
 */
function applyPronounPasses(item, registry, branchProtagonist, resolvedById, roles, onWarn, onRoleUsed) {
  const opts = { item, registry, branchProtagonist, resolvedById, roles, onWarn, onRoleUsed };
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
