'use strict';


const TYPES = Object.freeze({
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  SEQ: 'seq',
  MAP: 'map',
  RECORD: 'record',
  ANY: 'any',
});

const { CODES } = require('./diag');
const { isPlainObject, damerauLevenshtein } = require('./util');
const { checkSiblingKeys } = require('./keyIdentity');
const { getOrigins } = require('./origin');

const STRING = { type: TYPES.STRING };
const NUMBER = { type: TYPES.NUMBER };
const BOOLEAN = { type: TYPES.BOOLEAN };
const ANY = { type: TYPES.ANY };


function buildKeyIndex(schema) {
  const index = new Map();
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
    if (types.includes(TYPES.RECORD) && node.of) walk(node.of, [...path, '*']);
    if (types.includes(TYPES.SEQ) && node.of) walk(node.of, [...path, '[]']);
  };

  walk(schema, []);
  return index;
}

const RENAMED = Object.freeze({
  cards: 'items',
  overview: 'reports',
  openingChoice: 'branchFraming',
  description: 'adventureDescription',
});

const REMOVED = Object.freeze({
  card: {
    hint: '"card:" is gone in v4. Its replacement is "render.storyCards" (§7.8) — a list of '
      + 'independent renderings, each an alternate the player can swap in. Re-author it there; '
      + 'there is no automatic migration for this one, and the old card is ignored.',
  },
});

function suggestFor(key, ownPath, declaredHere, keyIndex) {
  const lower = key.toLowerCase();
  const removed = REMOVED[lower];
  if (removed !== undefined) {
    return { code: CODES.UNKNOWN_KEY, hint: removed.hint };
  }

  const renamedKey = Object.keys(RENAMED).find((candidate) => candidate.toLowerCase() === lower);
  const renamedTo = RENAMED[renamedKey];
  if (renamedTo !== undefined) {
    return {
      code: CODES.UNKNOWN_KEY,
      hint: `"${key}" was renamed to "${renamedTo}" in v4. Rename it here, or convert the whole `
        + `project with codex-loom --migrate <project> (§14.2). Until then, this key is ignored.`,
    };
  }

  const indexedKey = [...keyIndex.keys()].find((candidate) => candidate.toLowerCase() === lower);
  const elsewhere = (keyIndex.get(indexedKey) || []).filter((p) => p.toLowerCase() !== [...ownPath, key].join('.').toLowerCase());
  if (elsewhere.length > 0) {
    const owner = elsewhere[0].split('.').slice(0, -1).join('.');
    return {
      code: CODES.MISPLACED_KEY,
      hint: owner
        ? `"${key}" is valid under "${owner}:" — move it there so the compiler reads it; until then, it is ignored here.`
        : `"${key}" is valid at the top level — move it there so the compiler reads it; until then, it is ignored here.`,
    };
  }

  let best = null;
  for (const candidate of declaredHere) {
    const distance = damerauLevenshtein(key.toLowerCase(), candidate.toLowerCase());
    const tolerance = Math.max(1, Math.floor(candidate.length / 3));
    if (distance <= tolerance && (!best || distance < best.distance)) best = { candidate, distance };
  }
  if (best) return {
    code: CODES.UNKNOWN_KEY,
    hint: `"${key}" is not recognized, so it is ignored; rename it to "${best.candidate}".`,
  };

  return { code: CODES.UNKNOWN_KEY, hint: null };
}


function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a sequence';
  if (isPlainObject(value)) return 'a mapping';
  return `a ${typeof value}`;
}

function rangeText(descriptor) {
  const { min, max } = descriptor;
  if (min !== undefined && max !== undefined) return `between ${min} and ${max}`;
  if (min !== undefined) return `at least ${min}`;
  return `at most ${max}`;
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

function remapOrigins(value, fromParts, toParts) {
  const index = getOrigins(value);
  if (!index) return;
  const from = fromParts.map(String).join('\u0000');
  const to = toParts.map(String).join('\u0000');
  const moved = [];
  for (const key of Object.keys(index)) {
    if (key !== from && !key.startsWith(from + '\u0000')) continue;
    moved.push([to + key.slice(from.length), index[key]]);
    delete index[key];
  }
  for (const [key, record] of moved) index[key] = record;
}

function normalizeMapKeys(node, descriptor, { diagnostics, sourceMap, path = [], originRoot = node, originPath = path } = {}) {
  const types = Array.isArray(descriptor.type) ? descriptor.type : [descriptor.type];
  if (!types.includes(TYPES.MAP) || !descriptor.keys || !isPlainObject(node)) return;
  const declared = new Map(Object.keys(descriptor.keys).map((key) => [key.toLowerCase(), key]));
  const groups = new Map();
  const entries = Object.entries(node);
  for (const [key] of entries) {
    if (key.startsWith('_')) continue;
    const canonical = declared.get(key.toLowerCase());
    if (canonical === undefined) continue;
    if (!groups.has(canonical)) groups.set(canonical, []);
    groups.get(canonical).push(key);
  }
  for (const [canonical, keys] of groups) {
    const first = keys[0];
    for (const key of keys.slice(1)) {
      diagnostics.error(CODES.DUPLICATE_KEY_CASE,
        `Keys "${first}" and "${key}" under "${path.join('.') || '<root>'}" differ only by capitalization and identify the same key; keep one definition or give them distinct names.`,
        sourceMap ? sourceMap.nearest([...path, key]) : {},
        { related: [{ label: 'first definition', ...(sourceMap ? sourceMap.nearest([...path, first]) : {}) }] });
    }
    if (first !== canonical) {
      if (sourceMap && sourceMap.remapPath) sourceMap.remapPath([...path, first], [...path, canonical]);
      remapOrigins(originRoot, [...originPath, first], [...originPath, canonical]);
      if (node !== originRoot) remapOrigins(node, [first], [canonical]);
    }
  }
  if ([...groups].some(([canonical, keys]) => keys.length > 1 || keys[0] !== canonical)) {
    // Alias overlays consume insertion order, so folding must retain authored precedence.
    for (const [key] of entries) delete node[key];
    for (const [key, field] of entries) {
      const canonical = key.startsWith('_') ? undefined : declared.get(key.toLowerCase());
      if (canonical !== undefined && groups.get(canonical)[0] !== key) continue;
      Object.defineProperty(node, canonical === undefined ? key : canonical, {
        value: field, enumerable: true, configurable: true, writable: true,
      });
    }
  }
}


function validate(value, schema, options = {}) {
  const {
    diagnostics, sourceMap, path = [], keyIndex = buildKeyIndex(schema),
    displayOffset = 0, context = null, dropUnknown = false,
  } = options;

  const locate = (at) => (sourceMap ? sourceMap.nearest(at) : {});
  const display = (at) => at.slice(displayOffset).join('.');
  const inContext = context ? ` in ${context}` : '';

  const walk = (node, descriptor, currentPath) => {
    if (!descriptor) return node;
    normalizeMapKeys(node, descriptor, { diagnostics, sourceMap, path: currentPath,
      originRoot: value, originPath: currentPath.slice(path.length) });
    const keyContext = { diagnostics, sourceMap, path: currentPath };
    if (descriptor.caseInsensitiveKeys) checkSiblingKeys(node, keyContext);
    if (descriptor.checkKeys) descriptor.checkKeys(node, keyContext);
    const types = Array.isArray(descriptor.type) ? descriptor.type : [descriptor.type];

    if (types.includes(TYPES.ANY)) return node;

    if (node === null || node === undefined) return node;

    const normalized = normalizeEmpty(node, types);

    if (!types.some((t) => matchesType(normalized, t))) {
      diagnostics.error(
        CODES.WRONG_TYPE,
        `"${display(currentPath) || '<root>'}" must be ${typeName(types)}, but is ${describeType(normalized)}${inContext}; replace it with the required type or the value is ignored.`,
        locate(currentPath)
      );
      return normalized;
    }

    if (descriptor.values && !descriptor.values.includes(normalized)) {
      diagnostics.error(
        CODES.VALUE_NOT_ALLOWED,
        `"${display(currentPath) || '<root>'}" is ${JSON.stringify(normalized)}, but must be `
        + `${descriptor.values.map((v) => JSON.stringify(v)).join(' or ')}${inContext}; replace it with one of those values or it is rejected.`,
        locate(currentPath)
      );
      return normalized;
    }

    if (typeof normalized === 'number'
      && (descriptor.min !== undefined || descriptor.max !== undefined)) {
      const below = descriptor.min !== undefined && normalized < descriptor.min;
      const above = descriptor.max !== undefined && normalized > descriptor.max;
      if (below || above) {
        diagnostics.error(
          CODES.VALUE_OUT_OF_RANGE,
          `"${display(currentPath) || '<root>'}" is ${normalized}, but must be ${rangeText(descriptor)}${inContext}; change it to a value in that range or it is rejected.`,
          locate(currentPath)
        );
        return normalized;
      }
    }

    if (typeof normalized === 'string' && descriptor.pattern !== undefined) {
      let re;
      try {
        re = new RegExp(String(descriptor.pattern), 'i');
      } catch (err) {
        re = null;
      }
      if (re && !re.test(normalized)) {
        diagnostics.error(
          CODES.PATTERN_MISMATCH,
          `"${display(currentPath) || '<root>'}" is ${JSON.stringify(normalized)}, but must match `
          + `${JSON.stringify(String(descriptor.pattern))}${inContext}; change it to match the pattern or it is rejected.`,
          locate(currentPath)
        );
        return normalized;
      }
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
      const record = types.includes(TYPES.RECORD);
      const declaredKeys = record && descriptor.keys ? descriptor.keys : {};
      if (record && descriptor.keyPattern !== undefined) {
        let keyRe;
        try { keyRe = new RegExp(String(descriptor.keyPattern)); } catch (err) { keyRe = null; }
        if (keyRe) {
          for (const key of Object.keys(normalized)) {
            if (!keyRe.test(key)) {
              diagnostics.error(
                CODES.PATTERN_MISMATCH,
                `Key "${key}" under "${display(currentPath) || '<root>'}" must match `
                + `${JSON.stringify(String(descriptor.keyPattern))}${inContext}; rename it to match the pattern.`,
                locate([...currentPath, key])
              );
            }
          }
        }
      }
      if (types.includes(TYPES.MAP) && descriptor.keys) {
        const declared = Object.keys(descriptor.keys);

        for (const key of Object.keys(normalized)) {
          if (key.startsWith('_')) continue;

          const child = descriptor.keys[key];
          if (!child) {
            const { code, hint } = suggestFor(key, currentPath.slice(displayOffset), declared, keyIndex);
            const shown = display(currentPath);
            const where = shown ? `under "${shown}"` : 'at the top level';
            diagnostics.error(code, `Unknown key "${key}" ${where}${inContext}; remove it or rename/move it to a supported location, or it is ignored.`, locate([...currentPath, key]), { hint });
            if (dropUnknown) delete normalized[key];
            continue;
          }

          if (child.note && diagnostics) {
            const message = child.noteFinal
              ? `"${key}" is recognized but is not a render target and never will be — ${child.note}. Remove it or use a supported key; it is ignored.`
              : `"${key}" is recognized but not yet implemented — ${child.note}. Remove it or use a supported key; it is ignored until implemented.`;
            diagnostics.warn(
              CODES.NOT_YET_IMPLEMENTED,
              message,
              locate([...currentPath, key])
            );
          }
          if (child.alias && diagnostics) {
            diagnostics.warn(
              CODES.SUPERSEDED_KEY,
              `"${key}" has been superseded by "${child.alias}"; replace it with the current spelling so it keeps working if the old spelling is removed.`,
              locate([...currentPath, key])
            );
          }

          normalized[key] = walk(normalized[key], child, [...currentPath, key]);
        }

        for (const [key, child] of Object.entries(descriptor.keys)) {
          if (child.required && normalized[key] === undefined && diagnostics) {
            diagnostics.error(
              CODES.MISSING_REQUIRED,
              `Missing required key "${key}"${display(currentPath) ? ` under "${display(currentPath)}"` : ''}${inContext}; add it or validation of this value fails.`,
              locate(currentPath)
            );
          }
        }
        return normalized;
      }

      if (types.includes(TYPES.RECORD) && descriptor.keys) {
        for (const [key, child] of Object.entries(descriptor.keys)) {
          if (normalized[key] !== undefined) normalized[key] = walk(normalized[key], child, [...currentPath, key]);
          else if (child.required && diagnostics) {
            diagnostics.error(
              CODES.MISSING_REQUIRED,
              `Missing required key "${key}"${display(currentPath) ? ` under "${display(currentPath)}"` : ''}${inContext}; add it or validation of this value fails.`,
              locate(currentPath)
            );
          }
        }
        if (descriptor.of) {
          for (const key of Object.keys(normalized)) {
            if (!Object.prototype.hasOwnProperty.call(declaredKeys, key)) {
              normalized[key] = walk(normalized[key], descriptor.of, [...currentPath, key]);
            }
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

module.exports = { TYPES, STRING, NUMBER, BOOLEAN, ANY, validate, normalizeMapKeys, buildKeyIndex, levenshtein: damerauLevenshtein };
