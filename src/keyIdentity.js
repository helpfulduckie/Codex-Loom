'use strict';

const { CODES } = require('./diag');

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
    if (mapping(selection) && selection.branches) {
      checkDispatchKeys(selection.branches, { ...context, path: [...context.path, key, 'branches'] });
    }
  }
}

function checkItemKeys(value, context, delta = false) {
  if (!mapping(value)) return;
  if (delta) checkSiblingKeys(value, context);
  const content = new Set(['body', 'v', 'var', 'vars', 'variable', 'variables', 'notes', 'description']);
  for (const [key, field] of Object.entries(value)) {
    if (content.has(delta ? key.toLowerCase() : key)) {
      checkSiblingKeys(field, { ...context, path: [...context.path, key] }, true);
    }
  }
  if (delta) {
    const structural = new Set(['name', 'pronouns', 'aid', 'render', 'v', 'var', 'vars', 'variable', 'variables',
      'notes', 'description', 'kind', 'meta', 'body', 'variants', 'branches', 'importvariants', '_source']);
    for (const [key, field] of Object.entries(value)) {
      if (!structural.has(key.toLowerCase())) checkSiblingKeys(field, { ...context, path: [...context.path, key] }, true);
    }
  }
  checkDispatchKeys(value.branches, { ...context, path: [...context.path, 'branches'] });
  checkSiblingKeys(value.variants, { ...context, path: [...context.path, 'variants'] });
  for (const [name, variant] of Object.entries(mapping(value.variants) ? value.variants : {})) {
    checkItemKeys(variant, { ...context, path: [...context.path, 'variants', name] }, true);
  }
}

function checkSectionKeys(value, context) {
  if (!mapping(value)) return;
  checkDispatchKeys(value.branches, { ...context, path: [...context.path, 'branches'] });
  checkSiblingKeys(value.variants, { ...context, path: [...context.path, 'variants'] });
  for (const [name, delta] of Object.entries(mapping(value.variants) ? value.variants : {})) {
    const child = { ...context, path: [...context.path, 'variants', name] };
    if (mapping(delta)) checkSiblingKeys(delta.text, { ...child, path: [...child.path, 'text'] });
    checkSectionKeys(delta, child);
  }
}

module.exports = { checkSiblingKeys, checkDispatchKeys, checkItemKeys, checkSectionKeys };
