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

const { deepClone, findKey, ITEM_TOP_LEVEL_FIELDS, NOTES_ALIASES } = require('../util');
const { applyFieldOp, applyFieldsDelta, applyDelta } = require('./fieldops');
const { resolveBranchSpec } = require('./branches');
const { resolveItemRef, describeRefFailure } = require('./refs');

const CODES = Object.freeze({
  VARIANT_NOT_FOUND: 'CL0321',
  NO_TYPE_OR_TEMPLATE: 'CL0322',
  NOTES_AND_DESCRIPTION: 'CL0323',
});

/**
 * The components an item may route into (§7.3), in the order targets are reported.
 *
 * `description`, `opening` and `branchFraming` are absent because they keep their own
 * pipelines until Phase 6 — the schema declares them so an author can write ahead of the
 * implementation, and this list is what the implementation actually reads.
 */
const PLACEABLE_COMPONENTS = Object.freeze([
  'plotEssential', 'summary', 'aiInstructions', 'authorsNote',
]);

/** §7.4: items within a slot sort by `order:`, and 5 is the middle of the road. */
const DEFAULT_ORDER = 5;

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
 * Walk a variant path (slash-separated) on an item definition and collect deltas.
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
 * Strip compiler-internal metadata from an item before cloning.
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
 * Resolve an item fully for a given branch leaf path.
 *
 * @param {object} itemDef - the item or import definition
 * @param {Map} registry   - full merged item registry
 * @param {string[]} branchPath - active leaf path
 * @returns {object|null} fully resolved item, or null if excluded from this branch
 */
function resolveItem(itemDef, registry, branchPath, onWarn) {
  let item;
  let sourceItemForVariants; // the item definition that holds the variants library

  if (itemDef.import) {
    // ── Import ──────────────────────────────────────────────────────────────
    const found = resolveItemRef(registry, itemDef.import);
    if (!found.item) {
      throw new Error(`Import failed: ${describeRefFailure(found)}`);
    }
    const canonItem = found.item;

    item = deepClone(stripMeta(canonItem));
    sourceItemForVariants = canonItem;

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
    for (const key of ITEM_TOP_LEVEL_FIELDS) {
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
    sourceItemForVariants = itemDef;

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
      const localDeltas = collectVariantDeltas(sourceItemForVariants, vName, onWarn);
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

  // Scoped to items that emit a story card (§7.4). An item routed only into components
  // needs neither key: `resolvePlacements` builds each target's template from
  // `target.template || render.template || aid.type`, so a template on the target alone
  // fully specifies it, and a component placement that reaches none of the three still
  // falls through to verbatim pass-through. A story card has no such rung — `getTemplate`
  // failing is CL0420 — which is what leaves a card, and only a card, with something to
  // warn about.
  //
  // Reported here rather than left to CL0420 for the same reason the placeholder context
  // check runs before the ladder: CL0420 names the type it could not find, and when the
  // author set no type at all it reports `?`. This names the cause.
  if (item.render.storyCard !== false && !item.aid.type && !item.render.template) {
    const name = item.id || (typeof item.name === 'string' ? item.name : '');
    if (onWarn) {
      onWarn(CODES.NO_TYPE_OR_TEMPLATE,
        `item "${name}" emits a story card but has neither aid.type nor render.template, `
        + 'so no template can be selected for it. Add one, or set "render.storyCard: false" '
        + 'if it was only ever meant to render into a component.');
    }
  }

  // Collapse `description:` into `notes:` (§4.5). Downstream — the emitter, field ops,
  // reports — only ever sees `notes:`, so no consumer has to know both spellings.
  // Declaring both is an ERROR rather than a merge: they are two names for one field, so
  // two values means the author believes they are two fields, and picking a winner would
  // hide that.
  const notesKeys = Object.keys(item).filter((k) => NOTES_ALIASES.has(k.toLowerCase()));
  if (notesKeys.length > 1) {
    const label = item.id || (item.name && item.name.full) || '(unknown)';
    if (onWarn) {
      onWarn(CODES.NOTES_AND_DESCRIPTION,
        `item "${label}" declares both ${notesKeys.map((k) => `"${k}"`).join(' and ')}. `
        + '"description" is an accepted alias for "notes" (§4.5), so these are one field — '
        + 'keep whichever value is correct and delete the other.');
    }
  }
  for (const key of notesKeys) {
    if (key !== 'notes') {
      if (item.notes === undefined) item.notes = item[key];
      delete item[key];
    }
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

/**
 * Where a resolved item renders — the §7.2 inversion, in one function.
 *
 * The item states its targets and this reads them; nothing pulls an item in. That is the
 * whole of the change Phase 3 makes, and the reason this lives in `model/item.js` rather
 * than in the emitter: an item resolved through two pipelines that can disagree is the
 * largest single bug category in the project's history (§7.1), so there is exactly one
 * place that decides what an item is and exactly one place that decides where it goes,
 * and they are the same module.
 *
 * Returns `{ storyCard, targets }`. A target carries the slot it names, the order it
 * sorts by, and the template that renders it *for that target* — resolved here rather
 * than at render time because §7.4's ladder starts at the target and only then falls back
 * to the item, which is knowledge the emitter would otherwise have to reconstruct.
 *
 * ── The template ladder, and what `null` means ──────────────────────────────
 *
 * Target `template:` → `render.template` → `aid.type` → verbatim. The last rung is why
 * the field can come back `null`: an item with no type and no template still renders, by
 * passing its own text through untouched, which is what a genre block written as prose
 * needs. `resolveItem` has already collapsed rungs two and three into each other, so by
 * the time this runs the ladder has at most two live rungs — it is spelled out in full
 * anyway, because the collapse is a normalization and not a guarantee.
 *
 * ── Why `true` produces a target ────────────────────────────────────────────
 *
 * `plotEssential: true` names no slot and cannot resolve, and the schema cannot express
 * "boolean, but only false". It is carried through here as a target with a null slot so
 * that step 7 reports it alongside the undeclared-slot ERROR — one place that reports on
 * targets, rather than two that can disagree about which targets exist.
 */
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
  PLACEABLE_COMPONENTS, DEFAULT_ORDER, CODES,
};
