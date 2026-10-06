'use strict';


const { deepClone, findKey, ITEM_TOP_LEVEL_FIELDS, NOTES_ALIASES } = require('../util');
const { applyFieldOp, applyFieldsDelta, applyDelta } = require('./fieldops');
const { resolveBranchSpec } = require('./branches');
const { resolveItemRef, describeRefFailure } = require('./refs');
const { CODES } = require('../diag');
const { copyOrigins, transferOrigins, originLocation } = require('../origin');

const PLACEABLE_COMPONENTS = Object.freeze([
  'plotEssential', 'summary', 'aiInstructions', 'authorsNote', 'adventureDescription',
  'opening',
]);

const DEFAULT_ORDER = 5;

function hasVariant(itemDef, variantPath) {
  if (!itemDef.variants || typeof itemDef.variants !== 'object') return false;
  const firstPart = variantPath.split('/')[0].trim().toLowerCase();
  return Object.keys(itemDef.variants).some(k => k.toLowerCase() === firstPart);
}

function basename(source) {
  const parts = String(source).split(/[\\/]/);
  return parts[parts.length - 1] || String(source);
}

function collectVariantDeltas(itemDef, variantPath, onWarn, options = {}) {
  const warn = options.silent ? null : onWarn;
  const deltas = [];
  if (!variantPath) return deltas;
  const parts = variantPath.split('/').map(p => p.trim()).filter(Boolean);
  let variantTree = itemDef.variants;
  let variantOriginPath = ['variants'];

  const src = itemDef._source ? ` (${basename(itemDef._source)})` : '';
  for (const part of parts) {
    if (!variantTree || typeof variantTree !== 'object') {
      if (warn) {
        warn(CODES.VARIANT_NOT_FOUND,
          `variant "${part}" is not defined in the variant tree of "${itemDef.id || itemDef.name}"${src}; check the spelling or add the variant.`,
          options.loc || originLocation(itemDef, variantOriginPath));
      }
      break;
    }
    const actualKey = Object.keys(variantTree).find(k => k.toLowerCase() === part.toLowerCase());
    if (!actualKey) {
      if (warn) {
        warn(CODES.VARIANT_NOT_FOUND,
          `variant "${part}" is not defined in the variant tree of "${itemDef.id || itemDef.name}"${src}; check the spelling or add the variant.`,
          options.loc || originLocation(itemDef, variantOriginPath));
      }
      break;
    }
    const variantDef = variantTree[actualKey];
    if (variantDef === null) return null; // null variant (~) = exclude item
    deltas.push(transferOrigins(itemDef, { ...variantDef }, [...variantOriginPath, actualKey]));
    variantOriginPath = [...variantOriginPath, actualKey, 'variants'];
    variantTree = variantDef.variants;
  }

  return deltas;
}

function parseVariantsList(variants) {
  if (!variants) return [];
  if (typeof variants === 'string') return [variants];
  if (Array.isArray(variants)) return variants.map(String);
  return [];
}

function bodyLeafValues(body, prefix = '', out = new Map()) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return out;
  for (const key of Object.keys(body)) {
    const p = prefix ? `${prefix}.${key}` : key;
    const v = body[key];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) bodyLeafValues(v, p, out);
    else out.set(p.toLowerCase(), JSON.stringify(v === undefined ? null : v));
  }
  return out;
}

function touchedLeafPaths(before, after) {
  const touched = new Set();
  for (const [p, v] of after) {
    if (!before.has(p) || before.get(p) !== v) touched.add(p);
  }
  return touched;
}

function stripMeta(item) {
  const out = {};
  const skip = new Set(['variants', '_include_variants', '_include_variant_tree']);
  for (const [k, v] of Object.entries(item)) {
    if (!skip.has(k.toLowerCase())) out[k] = v;
  }
  return copyOrigins(item, out);
}

function itemDispatch(itemDef, branchPath, onWarn) {
  const included = Boolean(itemDef._include_branch_spec);
  const selections = [];
  const names = resolveBranchSpec(included ? itemDef._include_branch_spec : itemDef.branches,
    branchPath, onWarn, { source: itemDef,
      path: [included ? '_include_branch_spec' : 'branches'], selections });
  return names === null ? null : selections;
}

function variantSelectors(source, key) {
  return parseVariantsList(source[key]).map((name, i) => ({ name,
    loc: originLocation(source, Array.isArray(source[key]) ? [key, String(i)] : [key]),
  }));
}

function resolveItem(itemDef, registry, branchPath, onWarn) {
  let item;
  let sourceItemForVariants; // the item definition that holds the variants library

  if (itemDef.import) {
    const found = resolveItemRef(registry, itemDef.import);
    if (!found.item) {
      const error = new Error(`Import failed: ${describeRefFailure(found)}`);
      error.code = found.code;
      error.hint = found.hint;
      error.importFailure = found;
      throw error;
    }
    const canonItem = found.item;

    item = copyOrigins(canonItem, deepClone(stripMeta(canonItem)));
    sourceItemForVariants = canonItem;

    for (const { name: vPath, loc } of variantSelectors(itemDef, 'importVariants')) {
      const ivDeltas = collectVariantDeltas(canonItem, vPath, onWarn, { loc });
      if (ivDeltas === null) return null; // null variant = exclude
      for (const delta of ivDeltas) {
        applyDelta(item, delta, onWarn);
      }
    }

    const projectAuthoredBody = new Set();
    let bodySnap = bodyLeafValues(item.body);
    const recordProjectBodyEdits = () => {
      const now = bodyLeafValues(item.body);
      for (const p of touchedLeafPaths(bodySnap, now)) projectAuthoredBody.add(p);
      bodySnap = now;
    };

    if (itemDef.body) {
      applyFieldsDelta(item, copyOrigins(itemDef, { body: itemDef.body }), onWarn);
    }
    recordProjectBodyEdits();
    for (const key of ITEM_TOP_LEVEL_FIELDS) {
      if (itemDef[key] !== undefined) {
        const label = `${itemDef.id || item.id || item.name || '(unknown)'}.${key}`;
        const newVal = applyFieldOp(item[key], itemDef[key], { onWarn, label,
          source: itemDef, sourcePath: [key], target: item, targetPath: [key] });
        if (newVal === '__DELETE__') delete item[key]; else item[key] = newVal;
      }
    }

    if (itemDef.id) {
      item.id = itemDef.id;
      transferOrigins(itemDef, item, ['id'], ['id']);
    }

    const branchVariantNames = itemDispatch(itemDef, branchPath, onWarn);
    if (branchVariantNames === null) return null; // excluded
    item._hasVariant = branchVariantNames.length > 0;

    for (const { name: vName, loc } of branchVariantNames) {
      const variantSource = hasVariant(itemDef, vName) ? itemDef : canonItem;
      const deltas = collectVariantDeltas(variantSource, vName, onWarn, { loc });
      if (deltas === null) return null; // null variant = exclude
      for (const delta of deltas) {
        if (delta.importVariants && canonItem) {
          for (const { name: cvPath, loc: canonLoc } of variantSelectors(delta, 'importVariants')) {
            const canonDeltas = collectVariantDeltas(canonItem, cvPath, onWarn, { loc: canonLoc });
            if (canonDeltas === null) return null; // null variant = exclude
            for (const canonDelta of canonDeltas) {
              applyDelta(item, canonDelta, onWarn);
            }
          }
        }
        applyDelta(item, delta, onWarn);
      }
      if (variantSource === itemDef) recordProjectBodyEdits();
      else bodySnap = bodyLeafValues(item.body);
    }

    Object.defineProperty(item, '_projectAuthoredBody', {
      value: [...projectAuthoredBody], enumerable: false, configurable: true, writable: true,
    });

  } else {
    item = copyOrigins(itemDef, deepClone(stripMeta(itemDef)));
    sourceItemForVariants = itemDef;

    if (itemDef._include_variants) {
      for (const vPath of parseVariantsList(itemDef._include_variants)) {
        const incDeltas = collectVariantDeltas(itemDef, vPath, onWarn, { silent: true });
        if (incDeltas === null) return null; // null variant = exclude
        for (const delta of incDeltas) {
          applyDelta(item, delta, onWarn);
        }
      }
    }

    const fannedOut = Boolean(itemDef._include_branch_spec);
    const branchVariantNames = itemDispatch(itemDef, branchPath, onWarn);
    if (branchVariantNames === null) return null; // excluded
    item._hasVariant = branchVariantNames.length > 0;

    for (const { name: vName, loc } of branchVariantNames) {
      const localDeltas = collectVariantDeltas(sourceItemForVariants, vName, onWarn, { silent: fannedOut, loc });
      if (localDeltas === null) return null; // null variant = exclude
      for (const delta of localDeltas) {
        applyDelta(item, delta, onWarn);
      }
    }

  }

  if (!item.aid) item.aid = {};
  if (!item.render) item.render = {};

  if (!item.aid.type && item.render.template) {
    item.aid.type = item.render.template;
    transferOrigins(item, item, ['render', 'template'], ['aid', 'type']);
  }
  if (!item.render.template && item.aid.type) {
    item.render.template = item.aid.type;
    transferOrigins(item, item, ['aid', 'type'], ['render', 'template']);
  }

  if (item.render.storyCard !== false && !item.aid.type && !item.render.template) {
    const name = item.id || (typeof item.name === 'string' ? item.name : '');
    if (onWarn) {
      onWarn(CODES.NO_TYPE_OR_TEMPLATE,
        `item "${name}" emits a story card but has neither aid.type nor render.template, `
        + 'so no card template can be selected. Add one, or set "render.storyCard: false" '
        + 'if the item should render only into a component.', originLocation(item, ['aid']));
    }
  }

  const notesKeys = Object.keys(item).filter((k) => NOTES_ALIASES.has(k.toLowerCase()));
  if (notesKeys.length > 1) {
    const label = item.id || (item.name && item.name.full) || '(unknown)';
    if (onWarn) {
      onWarn(CODES.NOTES_AND_DESCRIPTION,
        `item "${label}" declares both ${notesKeys.map((k) => `"${k}"`).join(' and ')}. `
        + '"description" is an alias for "notes", so these keys name one field. '
        + 'Keep the correct value and delete the other key.', originLocation(item, [notesKeys[notesKeys.length - 1]]));
    }
  }
  for (const key of notesKeys) {
    if (key !== 'notes') {
      if (item.notes === undefined) {
        item.notes = item[key];
        transferOrigins(item, item, [key], ['notes']);
      }
      delete item[key];
    }
  }

  const rawName = item.name;
  if (typeof rawName === 'string' && rawName) {
    const words = rawName.trim().split(/\s+/);
    item.name = { display: words[0], full: rawName };
    transferOrigins(item, item, ['name'], ['name', 'display'], { descendants: false });
    transferOrigins(item, item, ['name'], ['name', 'full'], { descendants: false });
  } else if (rawName && typeof rawName === 'object' && !Array.isArray(rawName)) {
    const first = rawName.display || Object.values(rawName)[0] || item.id || '';
    const firstPath = rawName.display ? ['name', 'display']
      : Object.values(rawName)[0] ? ['name', Object.keys(rawName)[0]] : ['id'];
    if (!rawName.display) {
      rawName.display = first.split(/\s+/)[0];
      transferOrigins(item, item, firstPath, ['name', 'display']);
    }
    if (!rawName.full) {
      rawName.full = first;
      transferOrigins(item, item, firstPath, ['name', 'full']);
    }
  }

  return item;
}

function resolvePlacements(item) {
  const render = (item && item.render) || {};
  const aid = (item && item.aid) || {};

  const targets = [];
  for (const component of PLACEABLE_COMPONENTS) {
    const spec = render[component];
    if (spec === undefined || spec === null || spec === false) continue;

    const target = (spec && typeof spec === 'object' && !Array.isArray(spec)) ? spec : {};
    targets.push({
      component,
      slot: typeof target.slot === 'string' && target.slot ? target.slot : null,
      order: typeof target.order === 'number' ? target.order : DEFAULT_ORDER,
      template: target.template || render.template || aid.type || null,
    });
  }

  return { storyCard: render.storyCard !== false, targets };
}

module.exports = {
  resolveItem, collectVariantDeltas, parseVariantsList, resolvePlacements,
  PLACEABLE_COMPONENTS, DEFAULT_ORDER,
};
