'use strict';

const { CODES } = require('./diag');
const { VAR_ALIASES, NOTES_ALIASES, ITEM_TOP_LEVEL_FIELDS, findKey } = require('./util');

const CONTENT_FIELDS = new Set(['body', ...VAR_ALIASES, ...NOTES_ALIASES]);
const STRUCTURAL_FIELDS = new Set([...ITEM_TOP_LEVEL_FIELDS, ...VAR_ALIASES, ...NOTES_ALIASES,
  'body', 'variants', 'branches', 'importvariants', '_source']);

const mapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkSiblingKeys(value, { diagnostics, sourceMap, path = [] }, recursive = false) {
  if (mapping(value)) {
    const seen = new Map();
    for (const key of Object.keys(value)) {
      const lower = key.toLowerCase();
      const first = seen.get(lower);
      if (first !== undefined) {
        diagnostics.error(CODES.DUPLICATE_KEY_CASE,
          `Keys "${first}" and "${key}" under "${path.join('.') || '<root>'}" differ only by capitalization and identify the same key; keep one definition or give them distinct names.`,
          sourceMap ? sourceMap.nearest([...path, key]) : {},
          { related: [{ label: 'first definition', ...(sourceMap ? sourceMap.nearest([...path, first]) : {}) }] });
      } else seen.set(lower, key);
      if (recursive) checkSiblingKeys(value[key], { diagnostics, sourceMap, path: [...path, key] }, true);
    }
  } else if (recursive && Array.isArray(value)) {
    value.forEach((entry, i) => checkSiblingKeys(entry,
      { diagnostics, sourceMap, path: [...path, String(i)] }, true));
  }
}

function checkDispatchKeys(value, context) {
  checkSiblingKeys(value, context);
  for (const [key, selection] of Object.entries(mapping(value) ? value : {})) {
    const branches = mapping(selection) ? findKey(selection, 'branches') : null;
    if (branches !== null) {
      checkDispatchKeys(selection[branches], { ...context, path: [...context.path, key, branches] });
    }
  }
}

function checkItemKeys(value, context, delta = false) {
  if (!mapping(value)) return;
  if (delta) checkSiblingKeys(value, context);
  for (const [key, field] of Object.entries(value)) {
    if (CONTENT_FIELDS.has(delta ? key.toLowerCase() : key)) {
      checkSiblingKeys(field, { ...context, path: [...context.path, key] }, true);
    }
  }
  if (delta) {
    for (const [key, field] of Object.entries(value)) {
      if (!STRUCTURAL_FIELDS.has(key.toLowerCase())) checkSiblingKeys(field, { ...context, path: [...context.path, key] }, true);
    }
  }
  const branches = findKey(value, 'branches');
  if (branches !== null) checkDispatchKeys(value[branches], { ...context, path: [...context.path, branches] });
  const variants = findKey(value, 'variants');
  if (variants === null) return;
  checkSiblingKeys(value[variants], { ...context, path: [...context.path, variants] });
  for (const [name, variant] of Object.entries(mapping(value[variants]) ? value[variants] : {})) {
    checkItemKeys(variant, { ...context, path: [...context.path, variants, name] }, true);
  }
}

function checkSectionKeys(value, context) {
  if (!mapping(value)) return;
  const branches = findKey(value, 'branches');
  if (branches !== null) checkDispatchKeys(value[branches], { ...context, path: [...context.path, branches] });
  const variants = findKey(value, 'variants');
  if (variants === null) return;
  checkSiblingKeys(value[variants], { ...context, path: [...context.path, variants] });
  for (const [name, delta] of Object.entries(mapping(value[variants]) ? value[variants] : {})) {
    const child = { ...context, path: [...context.path, variants, name] };
    const text = mapping(delta) ? findKey(delta, 'text') : null;
    if (text !== null) checkSiblingKeys(delta[text], { ...child, path: [...child.path, text] });
    checkSectionKeys(delta, child);
  }
}

module.exports = { checkSiblingKeys, checkDispatchKeys, checkItemKeys, checkSectionKeys };
