'use strict';

/**
 * Compatibility facade over `model/` (v4 spec §3.2).
 *
 * `resolver.js` was three concerns in one file: value-level field operations, item
 * resolution, and branch-spec resolution. They are now `model/fieldops.js`,
 * `model/item.js` and `model/branches.js`, split along seams that already existed —
 * field ops know nothing of items or branches, and branch-spec resolution knows nothing
 * of item content, so the three form a DAG with no circular imports.
 *
 * This file re-exports them so `compile.js`, `pe.js`, `diff.js` and the existing test
 * suite keep their import paths. It goes away when those call sites move.
 *
 * `deepClone` was never defined here — it was imported from `util.js` and re-exported.
 * It is re-exported again for the same reason, and consumers should prefer `util.js`.
 */

const { deepClone } = require('./util');
const { applyFieldOp, applyFieldsDelta, applyDelta } = require('./model/fieldops');
const { resolveItem, collectVariantDeltas, parseVariantsList } = require('./model/item');
const {
  mergeBranchSpecs, resolveBranchSpec, enumerateLeaves, getBranchConfig,
  walkBranchChain, walkBranchTree,
} = require('./model/branches');

module.exports = {
  resolveItem,
  resolveBranchSpec,
  mergeBranchSpecs,
  enumerateLeaves,
  getBranchConfig,
  walkBranchChain,
  walkBranchTree,
  deepClone,
  applyFieldsDelta,
  applyFieldOp,
  applyDelta,
  collectVariantDeltas,
  parseVariantsList,
};
