'use strict';

const { walkItemTextFields } = require('../util');
const { CODES } = require('../diag');



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

const PLURAL_SETS = new Set(['nonbinary', 'they', 'you']);

const NAME_SCOPE = 'name';

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

function resolvePronounToken(token, setName) {
  const lower = token.toLowerCase();
  const role = PRONOUN_TOKEN_MAP[lower];
  const normalizedSet = (setName || '').toLowerCase();
  const canonicalSet = (normalizedSet === 'they' || normalizedSet === 'nonbinary') ? 'nonbinary' : normalizedSet;
  const set = PRONOUN_SETS[canonicalSet];
  const bare = lower.endsWith('~') ? lower.slice(0, -1) : lower;

  if (!role || !set) return matchCase(bare, token);
  return matchCase(set[role], token);
}

function matchCase(str, original) {
  if (!str) return str;
  if (original && original[0] === original[0].toUpperCase() &&
      original[0] !== original[0].toLowerCase()) {
    return str[0].toUpperCase() + str.slice(1);
  }
  return str.toLowerCase();
}

function isSentenceInitial(source, offset) {
  const before = source.slice(0, offset);
  if (/^\s*$/.test(before)) return true;

  const lineStart = before.lastIndexOf('\n') + 1;
  if (/^\s*[-*+]\s*$/.test(before.slice(lineStart))) return true;

  return /[.!?][\]\)}"'”’]*\s*$/.test(before);
}

function matchSentenceCase(str, source, offset) {
  return isSentenceInitial(source, offset)
    ? str[0].toUpperCase() + str.slice(1)
    : str.toLowerCase();
}

function getDisplayName(item) {
  const name = item.name;
  if (!name) return item.id || '';
  if (typeof name === 'string') return name.split(/\s+/)[0];
  if (typeof name === 'object') return name.display || Object.values(name)[0] || item.id || '';
  return String(name);
}

function getFullName(item) {
  const name = item.name;
  if (!name) return item.id || '';
  if (typeof name === 'string') return name;
  if (typeof name === 'object') return name.full || name.display || Object.values(name)[0] || item.id || '';
  return String(name);
}

function getEffectivePronounSet(itemOrPronouns, itemId, branchProtagonist) {
  const isProtagonist = branchProtagonist && itemId &&
    branchProtagonist.toLowerCase() === itemId.toLowerCase();
  if (isProtagonist) return 'you';
  const raw = typeof itemOrPronouns === 'string' ? itemOrPronouns : (itemOrPronouns && itemOrPronouns.pronouns);
  return raw || null;
}

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
        + 'the role or item.',
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
        `role "${roleKey}" is bound to "${boundId}", which is itself a role — bind it `
        + 'directly to an item id.',
      );
    }
    return null;
  }

  const target = (resolvedById && resolvedById.get(boundLower)) || registry.get(boundLower);
  if (!target) {
    if (onWarn) {
      onWarn(
        CODES.ROLE_TARGET_EXCLUDED,
        `role "${roleKey}" is bound to "${boundId}", which does not resolve on this branch; `
        + 'bind it to an available item or adjust branch scope.',
      );
    }
    return null;
  }

  if (onRoleUsed) onRoleUsed(roleKey);
  return boundId;
}

function roleUndeclaredMessage(name, roles) {
  const scope = roles && Object.keys(roles).length
    ? `Roles declared in scope: ${Object.keys(roles).join(', ')}.`
    : 'No roles are declared on this branch.';
  return `"{$${name}}" does not resolve to a declared role or a known item id, so the token `
    + `cannot resolve; correct the name. ${scope}`;
}

function applyRolePass(resolvedItems, { registry, roles, resolvedById, onRoleUsed }) {
  if (!roles || Object.keys(roles).length === 0) return;
  const TOKEN_RE = /\{\$([^{}]+)\}/g;
  const rewrite = (str) => str.replace(TOKEN_RE, (match, braceContent) => {
    const inner = braceContent.trim();
    const dot0 = inner.indexOf('.');
    const possessive = dot0 === -1 && inner.toLowerCase().endsWith("'s");
    const leading = dot0 !== -1 ? inner.slice(0, dot0) : possessive ? inner.slice(0, -2) : inner;
    const trailing = dot0 !== -1 ? inner.slice(dot0) : possessive ? "'s" : '';
    const roleId = resolveRole(leading, { roles, registry, resolvedById, onRoleUsed });
    return roleId !== null ? `{$${roleId}${trailing}}` : match;
  });
  for (const item of resolvedItems) {
    walkItemTextFields(item, rewrite);
  }
}

function applyTokenPass(str, opts) {
  const { item, registry, branchProtagonist, resolvedById, roles, onWarn, onRoleUsed } = opts;
  const itemId = (item.id || '').toLowerCase();
  const itemPronounSet = getEffectivePronounSet(item, itemId, branchProtagonist);

  let currentScope = null;

  const TOKEN_RE = /\{(\$[^{}]+)\}|\[(s|es|is|was|has)\]/g;

  return str.replace(TOKEN_RE, (match, braceContent, verbMarker, offset, source) => {
    if (verbMarker) {
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

    let inner = braceContent.trim().slice(1); // strip leading $

    {
      const dot0 = inner.indexOf('.');
      const possessive = dot0 === -1 && inner.toLowerCase().endsWith("'s");
      const leading = dot0 !== -1 ? inner.slice(0, dot0) : possessive ? inner.slice(0, -2) : inner;
      const trailing = dot0 !== -1 ? inner.slice(dot0) : possessive ? "'s" : '';
      const roleId = resolveRole(leading, { roles, registry, resolvedById, onWarn, onRoleUsed });
      if (roleId !== null) inner = roleId + trailing;
    }

    const dotIdx = inner.indexOf('.');
    if (dotIdx !== -1) {
      const prefix = inner.slice(0, dotIdx);
      const rest = inner.slice(dotIdx + 1);
      const prefixLower = prefix.toLowerCase();

      if (registry.has(prefixLower)) {
        const refItem = (resolvedById && resolvedById.get(prefixLower)) || registry.get(prefixLower);
        const refPronounSet = getEffectivePronounSet(refItem, prefixLower, branchProtagonist);

        const restLower = rest.toLowerCase();
        if (PRONOUN_TOKEN_MAP[restLower] !== undefined) {
          currentScope = refPronounSet || 'nonbinary';
          return resolvePronounToken(rest, refPronounSet);
        }

        if (restLower === 'full') return matchCase(getFullName(refItem), inner);
        if (restLower === 'display') return matchCase(getDisplayName(refItem), inner);

        return `{$${inner}}`;
      }

      if (onWarn && roles) {
        onWarn(CODES.ROLE_UNDECLARED, roleUndeclaredMessage(prefix, roles));
      }
      return match;
    }

    const innerLower = inner.toLowerCase();

    if (innerLower.endsWith("'s")) {
      const baseId = innerLower.slice(0, -2);
      if (registry.has(baseId)) {
        const refItem = (resolvedById && resolvedById.get(baseId)) || registry.get(baseId);
        const isProtagonist = branchProtagonist && branchProtagonist === baseId;
        if (isProtagonist) return matchSentenceCase('your', source, offset);
        return getDisplayName(refItem) + "'s";
      }
    }

    if (registry.has(innerLower)) {
      const refItem = (resolvedById && resolvedById.get(innerLower)) || registry.get(innerLower);
      const isProtagonist = branchProtagonist && branchProtagonist === innerLower;
      currentScope = isProtagonist ? 'you' : NAME_SCOPE;
      if (isProtagonist) return matchSentenceCase('you', source, offset);
      return matchCase(getDisplayName(refItem), inner);
    }

    if (PRONOUN_TOKEN_MAP[innerLower] !== undefined) {
      return resolvePronounToken(inner, itemPronounSet);
    }

    if (onWarn && roles) {
      onWarn(CODES.ROLE_UNDECLARED, roleUndeclaredMessage(inner, roles));
    }
    return match;
  });
}

function applyCrossItemRefs(resolvedItems, { registry, onWarn, resolvedById }) {
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
      if (onWarn) onWarn(CODES.CROSS_ITEM_REF_MISSING,
        `cross-item ref {${refId}.body.${fieldPath}} names no resolved item; check the id or define the item before using the reference.`);
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

function applyPronounPasses(item, { registry, branchProtagonist, resolvedById, roles, onWarn, onRoleUsed } = {}) {
  const tokenOpts = { item, registry, branchProtagonist, resolvedById, roles, onWarn, onRoleUsed };
  walkItemTextFields(item, s => applyTokenPass(s, tokenOpts));
}

module.exports = {
  applyRolePass,
  applyPronounPasses,
  applyTokenPass,
  applyCrossItemRefs,
  resolvePronounToken,
  getDisplayName,
  getFullName,
  PRONOUN_SETS,
};
