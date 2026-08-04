'use strict';

/**
 * The schema validation engine (v4 spec §4.3).
 *
 * Shared by `config/schema.js` (the compile.cl.yaml surface) and `loader/schema.js`
 * (the item surface), because §4.3's most valuable behavior is cross-level: it has to
 * know that `triggers:` written at an item's top level is a key belonging under `aid:`.
 * That requires one engine with a view of a whole declared key surface, not two
 * validators each checking their own level.
 *
 * Like `diag.js`, this module touches neither `fs` nor `console`. It takes a parsed
 * value and a schema, and returns diagnostics.
 *
 * ── Descriptor shape ────────────────────────────────────────────────────────
 *
 *   { type, keys, of, required, note, alias }
 *
 *   type      one of the TYPES below, or an array of them for a union
 *   keys      for 'map': the declared key set — anything else is an unknown-key ERROR
 *   of        for 'seq' and 'record': the descriptor every element/value must match
 *   required  the key must be present
 *   note      the key is recognized but not yet implemented; presence is a WARN
 *   alias     the key is a superseded spelling; `alias` names its replacement
 */

const TYPES = Object.freeze({
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  SEQ: 'seq',
  /** A closed mapping: every key must be declared in `keys`. */
  MAP: 'map',
  /** An open mapping: keys are the author's to choose, values follow `of`. */
  RECORD: 'record',
  /** An open namespace — `body:`, `notes:`, `v:`. Never validated, never suggested. */
  ANY: 'any',
});

const CODES = Object.freeze({
  UNKNOWN_KEY: 'CL0201',
  WRONG_TYPE: 'CL0202',
  MISSING_REQUIRED: 'CL0203',
  NOT_YET_IMPLEMENTED: 'CL0204',
  SUPERSEDED_KEY: 'CL0205',
  /** The canonical §4.3 case: a valid key written at the wrong level. */
  MISPLACED_KEY: 'CL0210',
});

// ── suggestions ──────────────────────────────────────────────────────────────

/**
 * Damerau-Levenshtein distance — edit distance counting a transposition as one edit.
 *
 * Plain Levenshtein scores `titel` against `title` as 2, because it can only express a
 * swap as two substitutions. Transposing adjacent characters is the most common typo
 * there is, so under a tolerance tight enough to avoid nonsense suggestions, plain
 * Levenshtein misses exactly the case most worth catching.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const d = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/**
 * Index every declared key name to the dotted paths where it is declared.
 *
 * Only closed, schema-validated levels are indexed. `body:`, `notes:` and `v:` accept
 * arbitrary keys by design, so indexing them would make every key "valid somewhere" and
 * turn every relocation suggestion into a technically-true, useless one — *did you mean
 * to nest it under notes:?* for a block that accepts all keys. Open namespaces have no
 * declared key set and are therefore never proposed as a destination.
 */
function buildKeyIndex(schema) {
  const index = new Map();
  // The branch-node descriptor is self-referential — `branches:` holds more branch
  // nodes — so the walk has to remember which descriptors it has already indexed.
  const seen = new Set();

  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    const types = Array.isArray(node.type) ? node.type : [node.type];

    if (types.includes(TYPES.MAP) && node.keys) {
      for (const [key, child] of Object.entries(node.keys)) {
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(path.length ? `${path.join('.')}.${key}` : key);
        walk(child, [...path, key]);
      }
    }
    // A record's values may themselves be closed maps (branch nodes, lint packs).
    if (types.includes(TYPES.RECORD) && node.of) walk(node.of, [...path, '*']);
    if (types.includes(TYPES.SEQ) && node.of) walk(node.of, [...path, '[]']);
  };

  walk(schema, []);
  return index;
}

/**
 * Build the hint for an unknown key.
 *
 * Relocation is checked before spelling, and the order is deliberate: a misspelling
 * usually produces output that is obviously missing something, while a valid key in the
 * wrong position produces output that looks complete and is quietly wrong. Falling back
 * to edit distance only when no relocation match exists also keeps the two kinds of
 * suggestion from competing to explain the same key.
 */
function suggestFor(key, ownPath, declaredHere, keyIndex) {
  const elsewhere = (keyIndex.get(key) || []).filter((p) => p !== [...ownPath, key].join('.'));
  if (elsewhere.length > 0) {
    const owner = elsewhere[0].split('.').slice(0, -1).join('.');
    return {
      code: CODES.MISPLACED_KEY,
      hint: owner
        ? `"${key}" is valid under "${owner}:" — did you mean to nest it there?`
        : `"${key}" is valid at the top level — did you mean to move it there?`,
    };
  }

  let best = null;
  for (const candidate of declaredHere) {
    const distance = levenshtein(key.toLowerCase(), candidate.toLowerCase());
    const tolerance = Math.max(1, Math.floor(candidate.length / 3));
    if (distance <= tolerance && (!best || distance < best.distance)) best = { candidate, distance };
  }
  if (best) return { code: CODES.UNKNOWN_KEY, hint: `Did you mean "${best.candidate}"?` };

  return { code: CODES.UNKNOWN_KEY, hint: null };
}

// ── type checking ────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a sequence';
  if (isPlainObject(value)) return 'a mapping';
  return `a ${typeof value}`;
}

function typeName(types) {
  const readable = {
    [TYPES.STRING]: 'a string',
    [TYPES.NUMBER]: 'a number',
    [TYPES.BOOLEAN]: 'a boolean',
    [TYPES.SEQ]: 'a sequence',
    [TYPES.MAP]: 'a mapping',
    [TYPES.RECORD]: 'a mapping',
  };
  return types.map((t) => readable[t] || t).join(' or ');
}

function matchesType(value, type) {
  switch (type) {
    case TYPES.STRING: return typeof value === 'string';
    case TYPES.NUMBER: return typeof value === 'number';
    case TYPES.BOOLEAN: return typeof value === 'boolean';
    case TYPES.SEQ: return Array.isArray(value);
    case TYPES.MAP:
    case TYPES.RECORD: return isPlainObject(value);
    case TYPES.ANY: return true;
    default: return false;
  }
}

/**
 * `{}` and `[]` are interchangeable wherever a collection is expected, and normalize to
 * the declared type at the boundary (§3.3). This is deliberately narrow: it covers two
 * spellings of *nothing*, never two shapes of content, so a non-empty value of the wrong
 * type is still an ERROR. It is also strictly distinct from `~`, which means "delete
 * this" — hence the explicit null check, which must not be swept into the same branch.
 */
function normalizeEmpty(value, types) {
  if (Array.isArray(value) && value.length === 0
    && (types.includes(TYPES.MAP) || types.includes(TYPES.RECORD)) && !types.includes(TYPES.SEQ)) {
    return {};
  }
  if (isPlainObject(value) && Object.keys(value).length === 0
    && types.includes(TYPES.SEQ) && !types.includes(TYPES.MAP) && !types.includes(TYPES.RECORD)) {
    return [];
  }
  return value;
}

// ── the walk ─────────────────────────────────────────────────────────────────

/**
 * Validate `value` against `schema`, collecting diagnostics.
 *
 * Returns the value with empty collections normalized to their declared type. Nodes are
 * normalized in place, so the caller's object is updated.
 */
function validate(value, schema, options = {}) {
  const {
    diagnostics, sourceMap, path = [], keyIndex = buildKeyIndex(schema),
    // Positions and prose need different paths. A multi-item file addresses its second
    // item as `1.aid.type` for lookup, but a reader should be told "under aid: in item
    // Kaiden" — the array index is the compiler's business, not theirs.
    displayOffset = 0, context = null,
  } = options;

  const locate = (at) => (sourceMap ? sourceMap.nearest(at) : {});
  const display = (at) => at.slice(displayOffset).join('.');
  const inContext = context ? ` in ${context}` : '';

  const walk = (node, descriptor, currentPath) => {
    if (!descriptor) return node;
    const types = Array.isArray(descriptor.type) ? descriptor.type : [descriptor.type];

    if (types.includes(TYPES.ANY)) return node;

    // `~` is an explicit deletion everywhere it appears (§6.4); never a type error.
    if (node === null || node === undefined) return node;

    const normalized = normalizeEmpty(node, types);

    if (!types.some((t) => matchesType(normalized, t))) {
      if (diagnostics) {
        diagnostics.error(
          CODES.WRONG_TYPE,
          `"${display(currentPath) || '<root>'}" must be ${typeName(types)}, but is ${describeType(normalized)}${inContext}.`,
          locate(currentPath)
        );
      }
      return normalized;
    }

    if (types.includes(TYPES.SEQ) && Array.isArray(normalized)) {
      if (descriptor.of) {
        normalized.forEach((item, i) => {
          normalized[i] = walk(item, descriptor.of, [...currentPath, String(i)]);
        });
      }
      return normalized;
    }

    if (isPlainObject(normalized)) {
      if (types.includes(TYPES.MAP) && descriptor.keys) {
        const declared = Object.keys(descriptor.keys);

        for (const key of Object.keys(normalized)) {
          // Keys beginning with `_` are stamped by the loader, not written by an author
          // — `_source`, `_include_variants`, `_resolvedCanon`. Validating them would
          // report the compiler's own bookkeeping as the author's mistake.
          if (key.startsWith('_')) continue;

          const child = descriptor.keys[key];
          if (!child) {
            if (diagnostics) {
              const { code, hint } = suggestFor(key, currentPath.slice(displayOffset), declared, keyIndex);
              const shown = display(currentPath);
              const where = shown ? `under "${shown}"` : 'at the top level';
              diagnostics.error(code, `Unknown key "${key}" ${where}${inContext}.`, locate([...currentPath, key]), { hint });
            }
            continue;
          }

          if (child.note && diagnostics) {
            diagnostics.warn(
              CODES.NOT_YET_IMPLEMENTED,
              `"${key}" is recognized but not yet implemented — ${child.note}. It will be ignored.`,
              locate([...currentPath, key])
            );
          }
          if (child.alias && diagnostics) {
            diagnostics.warn(
              CODES.SUPERSEDED_KEY,
              `"${key}" has been superseded by "${child.alias}".`,
              locate([...currentPath, key])
            );
          }

          normalized[key] = walk(normalized[key], child, [...currentPath, key]);
        }

        for (const [key, child] of Object.entries(descriptor.keys)) {
          if (child.required && normalized[key] === undefined && diagnostics) {
            diagnostics.error(
              CODES.MISSING_REQUIRED,
              `Missing required key "${key}"${display(currentPath) ? ` under "${display(currentPath)}"` : ''}${inContext}.`,
              locate(currentPath)
            );
          }
        }
        return normalized;
      }

      if (types.includes(TYPES.RECORD) && descriptor.of) {
        for (const key of Object.keys(normalized)) {
          normalized[key] = walk(normalized[key], descriptor.of, [...currentPath, key]);
        }
      }
    }

    return normalized;
  };

  return walk(value, schema, path);
}

module.exports = { TYPES, CODES, validate, buildKeyIndex, levenshtein };
