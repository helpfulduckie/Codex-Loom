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

const CODES = Object.freeze({
  VARIANT_NOT_FOUND: 'CL0321',
  NO_TYPE_OR_TEMPLATE: 'CL0322',
});

/**
 * Return true if the first segment of variantPath exists on cardDef.variants.
 * Used to decide local-vs-canon dispatch without emitting a spurious warning.
 */
function hasVariant(cardDef, variantPath) {
  if (!cardDef.variants || typeof cardDef.variants !== 'object') return false;
  const firstPart = variantPath.split('/')[0].trim().toLowerCase();
  return Object.keys(cardDef.variants).some(k => k.toLowerCase() === firstPart);
}

/**
 * Walk a variant path (slash-separated) on a card definition and collect deltas.
 * e.g. "human/noble" → apply 'human' variant delta, then 'noble' child of 'human'.
 *
 * Returns null if any segment of the path resolves to a null variant (~), which
 * signals that the card should be excluded from output entirely.
 */
function collectVariantDeltas(cardDef, variantPath, onWarn) {
  const deltas = [];
  if (!variantPath) return deltas;
  const parts = variantPath.split('/').map(p => p.trim()).filter(Boolean);
  let variantTree = cardDef.variants;

  const src = cardDef._source ? ` (${cardDef._source})` : '';
  for (const part of parts) {
    if (!variantTree || typeof variantTree !== 'object') {
      if (onWarn) {
        onWarn(CODES.VARIANT_NOT_FOUND,
          `variant "${part}" not found in variant tree of "${cardDef.id || cardDef.name}"${src}`);
      }
      break;
    }
    const actualKey = Object.keys(variantTree).find(k => k.toLowerCase() === part.toLowerCase());
    if (!actualKey) {
      if (onWarn) {
        onWarn(CODES.VARIANT_NOT_FOUND,
          `variant "${part}" not found in variant tree of "${cardDef.id || cardDef.name}"${src}`);
      }
      break;
    }
    const variantDef = variantTree[actualKey];
    if (variantDef === null) return null; // null variant (~) = exclude card
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
 * Strip compiler-internal metadata from a card before cloning.
 */
function stripMeta(card) {
  const out = {};
  const skip = new Set(['variants', '_include_variants', '_include_variant_tree']);
  for (const [k, v] of Object.entries(card)) {
    if (!skip.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Resolve a card fully for a given branch leaf path.
 *
 * @param {object} cardDef - the card or import definition
 * @param {Map} registry   - full merged card registry
 * @param {string[]} branchPath - active leaf path
 * @returns {object|null} fully resolved card, or null if excluded from this branch
 */
function resolveCard(cardDef, registry, branchPath, onWarn) {
  let card;
  let sourceCardForVariants; // the card definition that holds the variants library

  if (cardDef.import) {
    // ── Import ──────────────────────────────────────────────────────────────
    const canonId = String(cardDef.import).toLowerCase();
    const canonCard = registry.get(canonId);
    if (!canonCard) {
      throw new Error(`Import failed: no card with id "${cardDef.import}" found in registry`);
    }

    card = deepClone(stripMeta(canonCard));
    sourceCardForVariants = canonCard;

    // Apply importVariants from the import def (top-level, before branch dispatch)
    for (const vPath of parseVariantsList(cardDef.importVariants)) {
      const ivDeltas = collectVariantDeltas(canonCard, vPath, onWarn);
      if (ivDeltas === null) return null; // null variant = exclude
      for (const delta of ivDeltas) {
        applyDelta(card, delta, onWarn);
      }
    }

    // Apply import-level overrides as the project base, before branch variants run.
    // Branch variants always win over these — they are defaults, not finalizers.
    if (cardDef.body) {
      applyFieldsDelta(card, { body: cardDef.body }, onWarn);
    }
    for (const key of ['name', 'pronouns', 'aid', 'render', 'v']) {
      if (cardDef[key] !== undefined) {
        const newVal = applyFieldOp(card[key], cardDef[key]);
        if (newVal === '__DELETE__') delete card[key]; else card[key] = newVal;
      }
    }

    // Resolve branch spec → variant names to apply
    const branchVariantNames = resolveBranchSpec(cardDef.branches, branchPath);
    if (branchVariantNames === null) return null; // excluded
    card._hasVariant = branchVariantNames.length > 0;

    for (const vName of branchVariantNames) {
      // Branch variant names dispatch local-first: if the import def defines the variant,
      // use it (allowing project-level overrides); otherwise fall back to the canon card.
      const variantSource = hasVariant(cardDef, vName) ? cardDef : canonCard;
      const deltas = collectVariantDeltas(variantSource, vName, onWarn);
      if (deltas === null) return null; // null variant = exclude
      for (const delta of deltas) {
        // Apply any importVariants declared inside this local variant from canon
        if (delta.importVariants && canonCard) {
          for (const cvPath of parseVariantsList(delta.importVariants)) {
            const canonDeltas = collectVariantDeltas(canonCard, cvPath, onWarn);
            if (canonDeltas === null) return null; // null variant = exclude
            for (const canonDelta of canonDeltas) {
              applyDelta(card, canonDelta, onWarn);
            }
          }
        }
        applyDelta(card, delta, onWarn);
      }
    }

  } else {
    // ── Local card definition ────────────────────────────────────────────────
    card = deepClone(stripMeta(cardDef));
    sourceCardForVariants = cardDef;

    // Handle included cards that carry importVariants from the include directive
    if (cardDef._include_variants) {
      for (const vPath of parseVariantsList(cardDef._include_variants)) {
        const incDeltas = collectVariantDeltas(cardDef, vPath, onWarn);
        if (incDeltas === null) return null; // null variant = exclude
        for (const delta of incDeltas) {
          applyDelta(card, delta, onWarn);
        }
      }
    }

    // Resolve branch spec → variant names to apply
    const branchVariantNames = resolveBranchSpec(
      cardDef._include_branch_spec || cardDef.branches,
      branchPath
    );
    if (branchVariantNames === null) return null; // excluded
    card._hasVariant = branchVariantNames.length > 0;

    for (const vName of branchVariantNames) {
      const localDeltas = collectVariantDeltas(sourceCardForVariants, vName, onWarn);
      if (localDeltas === null) return null; // null variant = exclude
      for (const delta of localDeltas) {
        applyDelta(card, delta, onWarn);
      }
    }

  }

  // Normalise: ensure aid.type and render.template default to each other
  if (!card.aid) card.aid = {};
  if (!card.render) card.render = {};

  if (!card.aid.type && card.render.template) card.aid.type = card.render.template;
  if (!card.render.template && card.aid.type) card.render.template = card.aid.type;

  if (!card.aid.type && !card.render.template) {
    const name = card.id || (typeof card.name === 'string' ? card.name : '');
    if (onWarn) onWarn(CODES.NO_TYPE_OR_TEMPLATE, `card "${name}" has neither aid.type nor render.template`);
  }

  // Normalize name to structured form so {$name.full} / {$name.display} always resolve
  const rawName = card.name;
  if (typeof rawName === 'string' && rawName) {
    const words = rawName.trim().split(/\s+/);
    card.name = { display: words[0], full: rawName };
  } else if (rawName && typeof rawName === 'object' && !Array.isArray(rawName)) {
    const first = rawName.display || Object.values(rawName)[0] || card.id || '';
    if (!rawName.display) rawName.display = first.split(/\s+/)[0];
    if (!rawName.full)    rawName.full    = first;
  }

  return card;
}

module.exports = { resolveCard, collectVariantDeltas, parseVariantsList, CODES };
