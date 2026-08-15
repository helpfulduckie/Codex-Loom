'use strict';

/**
 * Item resolution: imports, variant chains, branch dispatch, name normalization
 * (v4 spec §3.2).
 *
 * Nothing else resolves an item body (§7.2). This module depends on `fieldops` for
 * value-level edits and on `branches` for dispatch; neither depends on it, so the
 * three form a DAG and the split needs no circular-import workaround.
 *
 * Pure by contract (§3.3): no `fs`, no `console`. Warnings go to a caller-supplied
 * `onWarn(code, message)`.
 */

const { deepClone, findKey } = require('../util');
const { applyFieldOp, applyFieldsDelta, applyDelta } = require('./fieldops');
const { resolveBranchSpec } = require('./branches');
const { resolveItemRef, describeRefFailure } = require('./refs');

const CODES = Object.freeze({
  VARIANT_NOT_FOUND: 'CL0321',
  NO_TYPE_OR_TEMPLATE: 'CL0322',
});

/**
 * Return true if the first segment of variantPath exists on itemDef.variants.
 * Used to decide local-vs-canon dispatch without emitting a spurious warning.
 */
function hasVariant(itemDef, variantPath) {
  if (!itemDef.variants || typeof itemDef.variants !== 'object') return false;
  const firstPart = variantPath.split('/')[0].trim().toLowerCase();
  return Object.keys(itemDef.variants).some(k => k.toLowerCase() === firstPart);
}

/**
 * Walk a variant path (slash-separated) on a item definition and collect deltas.
 * e.g. "human/noble" → apply 'human' variant delta, then 'noble' child of 'human'.
 *
 * Returns null if any segment of the path resolves to a null variant (~), which
 * signals that the item should be excluded from output entirely.
 */
function collectVariantDeltas(itemDef, variantPath, onWarn) {
  const deltas = [];
  if (!variantPath) return deltas;
  const parts = variantPath.split('/').map(p => p.trim()).filter(Boolean);
  let variantTree = itemDef.variants;

  const src = itemDef._source ? ` (${itemDef._source})` : '';
  for (const part of parts) {
    if (!variantTree || typeof variantTree !== 'object') {
      if (onWarn) {
        onWarn(CODES.VARIANT_NOT_FOUND,
          `variant "${part}" not found in variant tree of "${itemDef.id || itemDef.name}"${src}`);
      }
      break;
    }
    const actualKey = Object.keys(variantTree).find(k => k.toLowerCase() === part.toLowerCase());
    if (!actualKey) {
      if (onWarn) {
        onWarn(CODES.VARIANT_NOT_FOUND,
          `variant "${part}" not found in variant tree of "${itemDef.id || itemDef.name}"${src}`);
      }
      break;
    }
    const variantDef = variantTree[actualKey];
    if (variantDef === null) return null; // null variant (~) = exclude item
    deltas.push(variantDef);
    variantTree = variantDef.variants;
  }

  return deltas;
}

/**
 * Parse importVariants: to a list of variant path strings.
 * Accepts: string, or array of strings.
 */
function parseVariantsList(variants) {
  if (!variants) return [];
  if (typeof variants === 'string') return [variants];
  if (Array.isArray(variants)) return variants.map(String);
  return [];
}

/**
 * Strip compiler-internal metadata from a item before cloning.
 */
function stripMeta(item) {
  const out = {};
  const skip = new Set(['variants', '_include_variants', '_include_variant_tree']);
  for (const [k, v] of Object.entries(item)) {
    if (!skip.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Resolve a item fully for a given branch leaf path.
 *
 * @param {object} itemDef - the item or import definition
 * @param {Map} registry   - full merged item registry
 * @param {string[]} branchPath - active leaf path
 * @returns {object|null} fully resolved item, or null if excluded from this branch
 */
function resolveItem(itemDef, registry, branchPath, onWarn) {
  let item;
  let sourceCardForVariants; // the item definition that holds the variants library

  if (itemDef.import) {
    // ── Import ──────────────────────────────────────────────────────────────
    const found = resolveItemRef(registry, itemDef.import);
    if (!found.item) {
      throw new Error(`Import failed: ${describeRefFailure(found)}`);
    }
    const canonItem = found.item;

    item = deepClone(stripMeta(canonItem));
    sourceCardForVariants = canonItem;

    // Apply importVariants from the import def (top-level, before branch dispatch)
    for (const vPath of parseVariantsList(itemDef.importVariants)) {
      const ivDeltas = collectVariantDeltas(canonItem, vPath, onWarn);
      if (ivDeltas === null) return null; // null variant = exclude
      for (const delta of ivDeltas) {
        applyDelta(item, delta, onWarn);
      }
    }

    // Apply import-level overrides as the project base, before branch variants run.
    // Branch variants always win over these — they are defaults, not finalizers.
    if (itemDef.body) {
      applyFieldsDelta(item, { body: itemDef.body }, onWarn);
    }
    for (const key of ['name', 'pronouns', 'aid', 'render', 'v']) {
      if (itemDef[key] !== undefined) {
        const newVal = applyFieldOp(item[key], itemDef[key]);
        if (newVal === '__DELETE__') delete item[key]; else item[key] = newVal;
      }
    }

    // Rename-on-import (§17.4). Only the id moves — `name:` is left alone deliberately, so
    // a rename that should also change the display name says so rather than having one
    // inferred from an id that may be a slug.
    if (itemDef.id) item.id = itemDef.id;

    // Resolve branch spec → variant names to apply
    const branchVariantNames = resolveBranchSpec(itemDef.branches, branchPath);
    if (branchVariantNames === null) return null; // excluded
    item._hasVariant = branchVariantNames.length > 0;

    for (const vName of branchVariantNames) {
      // Branch variant names dispatch local-first: if the import def defines the variant,
      // use it (allowing project-level overrides); otherwise fall back to the canon item.
      const variantSource = hasVariant(itemDef, vName) ? itemDef : canonItem;
      const deltas = collectVariantDeltas(variantSource, vName, onWarn);
      if (deltas === null) return null; // null variant = exclude
      for (const delta of deltas) {
        // Apply any importVariants declared inside this local variant from canon
        if (delta.importVariants && canonItem) {
          for (const cvPath of parseVariantsList(delta.importVariants)) {
            const canonDeltas = collectVariantDeltas(canonItem, cvPath, onWarn);
            if (canonDeltas === null) return null; // null variant = exclude
            for (const canonDelta of canonDeltas) {
              applyDelta(item, canonDelta, onWarn);
            }
          }
        }
        applyDelta(item, delta, onWarn);
      }
    }

  } else {
    // ── Local item definition ────────────────────────────────────────────────
    item = deepClone(stripMeta(itemDef));
    sourceCardForVariants = itemDef;

    // Handle included items that carry importVariants from the include directive
    if (itemDef._include_variants) {
      for (const vPath of parseVariantsList(itemDef._include_variants)) {
        const incDeltas = collectVariantDeltas(itemDef, vPath, onWarn);
        if (incDeltas === null) return null; // null variant = exclude
        for (const delta of incDeltas) {
          applyDelta(item, delta, onWarn);
        }
      }
    }

    // Resolve branch spec → variant names to apply
    const branchVariantNames = resolveBranchSpec(
      itemDef._include_branch_spec || itemDef.branches,
      branchPath
    );
    if (branchVariantNames === null) return null; // excluded
    item._hasVariant = branchVariantNames.length > 0;

    for (const vName of branchVariantNames) {
      const localDeltas = collectVariantDeltas(sourceCardForVariants, vName, onWarn);
      if (localDeltas === null) return null; // null variant = exclude
      for (const delta of localDeltas) {
        applyDelta(item, delta, onWarn);
      }
    }

  }

  // Normalise: ensure aid.type and render.template default to each other
  if (!item.aid) item.aid = {};
  if (!item.render) item.render = {};

  if (!item.aid.type && item.render.template) item.aid.type = item.render.template;
  if (!item.render.template && item.aid.type) item.render.template = item.aid.type;

  if (!item.aid.type && !item.render.template) {
    const name = item.id || (typeof item.name === 'string' ? item.name : '');
    if (onWarn) onWarn(CODES.NO_TYPE_OR_TEMPLATE, `item "${name}" has neither aid.type nor render.template`);
  }

  // Normalize name to structured form so {$name.full} / {$name.display} always resolve
  const rawName = item.name;
  if (typeof rawName === 'string' && rawName) {
    const words = rawName.trim().split(/\s+/);
    item.name = { display: words[0], full: rawName };
  } else if (rawName && typeof rawName === 'object' && !Array.isArray(rawName)) {
    const first = rawName.display || Object.values(rawName)[0] || item.id || '';
    if (!rawName.display) rawName.display = first.split(/\s+/)[0];
    if (!rawName.full)    rawName.full    = first;
  }

  return item;
}

module.exports = { resolveItem, collectVariantDeltas, parseVariantsList, CODES };
