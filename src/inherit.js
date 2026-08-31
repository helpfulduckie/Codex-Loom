'use strict';

const path = require('path');
const { branchTreeDeclares } = require('./model/branches');
const { writeSectionedComponent } = require('./emit/components');
const { copyScripts } = require('./treeWrite');
const {
  writeOutput, buildBranchOutputDir, resolveBranchFolderPath,
} = require('./outputPaths');

/**
 * Phase 11 Steps 4 & 5 — component/script inheritance and story-card frontier placement.
 *
 * The leaf loop renders and checks every component and card per leaf, but defers the
 * *file write* to here, where the full set of per-leaf texts is known. A value identical
 * at every leaf (and redeclared by no branch) is written once at the node Velvet Lattice
 * inherits it from; anything else is written per leaf, byte-for-byte where the leaf loop
 * used to write it.
 *
 * Returns the number of files written, for the spine to fold into `totalFiles`.
 */
function placeInheritedFiles({
  deferredComponents, deferredScripts, deferredCardLeaves,
  leaves, config, diagnostics, verbose,
}) {
  let filesWritten = 0;

  // ── Phase 11 Step 4: component and script inheritance ──────────────────────
  //
  // Each deferred component (and the `Scripts/` dir) is written once at the output root
  // when its value is identical at every leaf and no branch node redeclares it — the
  // shape Velvet Lattice inherits down the tree for free. Anything else is written per
  // leaf, byte-for-byte where the leaf loop used to write it, so the fallback is the old
  // behavior rather than a new one.
  //
  // "Identical at every leaf" is required to be a total match, not a majority: a leaf that
  // excludes the component (`~`, or a gap) is not in `perLeaf`, and lifting to the root
  // would make VL inherit it there anyway. `leaves.length > 1` skips the single-leaf
  // projects, where the one "leaf" already *is* the root and lifting would be a no-op that
  // only muddies the diff.
  const canLift = (perLeaf, declaredInBranches) => leaves.length > 1
    && perLeaf.size === leaves.length
    && !declaredInBranches
    && new Set(perLeaf.values()).size === 1;

  for (const { descriptor, metadata, perLeaf } of deferredComponents.values()) {
    const declaredInBranches = branchTreeDeclares(
      config.branches, (node) => node.components && node.components[descriptor.key] !== undefined,
    );
    if (canLift(perLeaf, declaredInBranches)) {
      const [text] = perLeaf.values();
      const outPath = writeSectionedComponent(
        config._resolvedOutput, descriptor, text, { diagnostics }, metadata,
      );
      if (outPath) {
        if (verbose) console.log(`    OK: ${descriptor.verboseLabel} (inherited from root) → ${outPath}`);
        filesWritten++;
      }
    } else {
      for (const [leafDir, text] of perLeaf) {
        const outPath = writeSectionedComponent(
          leafDir, descriptor, text, { diagnostics }, metadata,
        );
        if (outPath) {
          if (verbose) console.log(`    OK: ${descriptor.verboseLabel} → ${outPath}`);
          filesWritten++;
        }
      }
    }
  }

  // The `Scripts/` dir rides the same lift test (Phase 12 Step 6). `canLift` compares the
  // resolved spec strings — one distinct spec across every leaf is one identical
  // `fs.cpSync` by construction — but `scripts/rebaseline.js` still asserts byte-identity
  // of the copied files, because this pass is the only thing between a lifted layout and a
  // silently re-contented script. A single-leaf project (`leaves.length === 1`) writes per
  // leaf, where the one "leaf" already is the output root, so its layout does not move.
  if (deferredScripts.size > 0) {
    const scriptsDeclaredInBranches = branchTreeDeclares(
      config.branches, (node) => node.scripts !== undefined,
    );
    if (canLift(deferredScripts, scriptsDeclaredInBranches)) {
      const [spec] = deferredScripts.values();
      copyScripts(spec, config._resolvedOutput);
      if (verbose) {
        console.log(`    OK: Scripts/ (inherited from root) → ${path.join(config._resolvedOutput, 'Scripts')}`);
      }
    } else {
      for (const [leafDir, spec] of deferredScripts) copyScripts(spec, leafDir);
    }
  }

  // ── Phase 11 Step 5: story-card inheritance ────────────────────────────────
  //
  // A card was rendered once per leaf above. Velvet Lattice inherits a node's cards down
  // its subtree, merging by card name, so a card that renders byte-identically across a
  // whole subtree need only be written once, at that subtree's root. This pass finds, for
  // each card, the minimal set of nodes whose subtrees partition exactly the leaves that
  // rendered it — the frontier — and writes the card there. A card that varies within its
  // scope (a protagonist-dependent body, say) has each of its versions placed the same
  // way, and one that reaches an irregular set of leaves falls all the way back to a copy
  // per leaf. Every leaf still *resolves* to the same card set it did before; only the
  // file layout changes (v4 spec §14.3, §15).
  if (deferredCardLeaves.length <= 1) {
    // One leaf (or none): there is no subtree to inherit down, so the frontier would only
    // relocate the single leaf's cards to the output root for no saving. Write them where
    // they were — same as the pre-Step-5 leaf loop did.
    for (const leaf of deferredCardLeaves) {
      const byType = new Map();
      for (const [type, entries] of leaf.grouped) byType.set(type, entries);
      for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
        const items = byType.get(type)
          .slice()
          .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.rendered.localeCompare(b.rendered))
          .map((c) => c.rendered);
        const outPath = writeOutput(leaf.outputDir, type, items);
        if (verbose) console.log(`    OK: ${type} (${items.length} card(s)) → ${outPath}`);
        filesWritten += 1;
      }
    }
  } else {
    const leafPaths = deferredCardLeaves.map((l) => l.branchPath);
    const leavesUnder = (prefix) => {
      const out = [];
      for (let i = 0; i < leafPaths.length; i += 1) {
        if (prefix.every((seg, k) => leafPaths[i][k] === seg)) out.push(i);
      }
      return out;
    };
    // The minimal nodes (as branch-id paths) whose subtrees cover exactly `carry`.
    const frontier = (prefix, carry) => {
      const under = leavesUnder(prefix);
      if (under.length === 0) return [];
      if (under.every((i) => carry.has(i))) return [prefix];
      const deeper = under.filter((i) => leafPaths[i].length > prefix.length);
      if (deeper.length === 0) {
        return under.filter((i) => carry.has(i)).map((i) => leafPaths[i]);
      }
      const childSegs = [...new Set(deeper.map((i) => leafPaths[i][prefix.length]))];
      const nodes = [];
      for (const seg of childSegs) nodes.push(...frontier([...prefix, seg], carry));
      for (const i of under) {
        if (leafPaths[i].length === prefix.length && carry.has(i)) nodes.push(prefix);
      }
      return nodes;
    };

    // Every rendering of every card, indexed by the (type, name) pair — a card's file is
    // `Story Cards/<type>/<type>.md` and Velvet Lattice merges within it by name, so that
    // pair is the identity inheritance has to preserve. A per-branch variant that changes
    // the name or the type is a different card here and lands on its own leaves; one that
    // only changes the body is one entry with two texts, each placed on its own frontier.
    // Keying on the item id would be wrong — a `variants:` item keeps one id while its
    // name and type differ per branch. (The key separator is a control char so it cannot
    // occur in either half.)
    const cardIndex = new Map();
    deferredCardLeaves.forEach((leaf, li) => {
      for (const [type, entries] of leaf.grouped) {
        for (const e of entries) {
          const key = `${type}\x01${e.name}`;
          let rec = cardIndex.get(key);
          if (!rec) { rec = { type, byText: new Map() }; cardIndex.set(key, rec); }
          let group = rec.byText.get(e.rendered);
          if (!group) { group = { carry: new Set(), sortKey: e.sortKey }; rec.byText.set(e.rendered, group); }
          group.carry.add(li);
        }
      }
    });

    // nodeDir → type → [{ sortKey, rendered }]
    const ownedByNode = new Map();
    const putOwned = (dir, type, sortKey, rendered) => {
      if (!ownedByNode.has(dir)) ownedByNode.set(dir, new Map());
      const byType = ownedByNode.get(dir);
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push({ sortKey, rendered });
    };
    for (const rec of cardIndex.values()) {
      for (const [text, group] of rec.byText) {
        for (const node of frontier([], group.carry)) {
          const dir = buildBranchOutputDir(
            config._resolvedOutput, resolveBranchFolderPath(config.branches, node),
          );
          putOwned(dir, rec.type, group.sortKey, text);
        }
      }
    }

    // Types alphabetical, cards within a type by id then rendered text — the order
    // `renderBranchItems` used to apply itself, now applied once per owning node.
    for (const [dir, byType] of ownedByNode) {
      for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
        const items = byType.get(type)
          .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.rendered.localeCompare(b.rendered))
          .map((c) => c.rendered);
        const outPath = writeOutput(dir, type, items);
        if (verbose) console.log(`    OK: ${type} (${items.length} card(s)) → ${outPath}`);
        filesWritten += 1;
      }
    }
  }

  return filesWritten;
}

module.exports = { placeInheritedFiles };
