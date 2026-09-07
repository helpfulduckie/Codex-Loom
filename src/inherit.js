'use strict';

const fs = require('fs');
const path = require('path');
const { branchTreeDeclares } = require('./model/branches');
const { writeSectionedComponent, renderFrontmatter } = require('./emit/components');
const {
  writeOutput, buildBranchOutputDir, resolveBranchFolderPath,
} = require('./outputPaths');

function copyScripts(srcDir, targetDir) {
  if (!srcDir || !fs.existsSync(srcDir)) return;
  const dest = path.join(targetDir, 'Scripts');
  fs.cpSync(srcDir, dest, { recursive: true });
}

function placeInheritedFiles({
  deferredComponents, deferredScripts, deferredCardLeaves,
  leaves, config, diagnostics, log,
}) {
  let filesWritten = 0;

  const canLift = (perLeaf, declaredInBranches) => leaves.length > 1
    && perLeaf.size === leaves.length
    && !declaredInBranches
    && new Set(perLeaf.values()).size === 1;

  for (const { descriptor, perLeaf } of deferredComponents.values()) {
    const declaredInBranches = branchTreeDeclares(
      config.branches, (node) => node.components && node.components[descriptor.key] !== undefined,
    );
    const payloads = new Map(
      [...perLeaf].map(([dir, artifact]) => [dir, `${renderFrontmatter(artifact.metadata)}${artifact.text}`]),
    );
    if (canLift(payloads, declaredInBranches)) {
      const [{ text, metadata }] = perLeaf.values();
      const outPath = writeSectionedComponent(
        config._resolvedOutput, descriptor, text, { diagnostics }, metadata,
      );
      if (outPath) {
        log.verbose(`    OK: ${descriptor.verboseLabel} (inherited from root) → ${outPath}`);
        filesWritten++;
      }
    } else {
      for (const [leafDir, { text, metadata }] of perLeaf) {
        const outPath = writeSectionedComponent(
          leafDir, descriptor, text, { diagnostics }, metadata,
        );
        if (outPath) {
          log.verbose(`    OK: ${descriptor.verboseLabel} → ${outPath}`);
          filesWritten++;
        }
      }
    }
  }

  if (deferredScripts.size > 0) {
    const scriptsDeclaredInBranches = branchTreeDeclares(
      config.branches, (node) => node.scripts !== undefined,
    );
    if (canLift(deferredScripts, scriptsDeclaredInBranches)) {
      const [spec] = deferredScripts.values();
      copyScripts(spec, config._resolvedOutput);
      log.verbose(`    OK: Scripts/ (inherited from root) → ${path.join(config._resolvedOutput, 'Scripts')}`);
    } else {
      for (const [leafDir, spec] of deferredScripts) copyScripts(spec, leafDir);
    }
  }

  if (deferredCardLeaves.length <= 1) {
    for (const leaf of deferredCardLeaves) {
      const byType = new Map();
      for (const [type, entries] of leaf.grouped) byType.set(type, entries);
      for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
        const items = byType.get(type)
          .slice()
          .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.rendered.localeCompare(b.rendered))
          .map((c) => c.rendered);
        const outPath = writeOutput(leaf.outputDir, type, items);
        log.verbose(`    OK: ${type} (${items.length} card(s)) → ${outPath}`);
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

    for (const [dir, byType] of ownedByNode) {
      for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
        const items = byType.get(type)
          .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.rendered.localeCompare(b.rendered))
          .map((c) => c.rendered);
        const outPath = writeOutput(dir, type, items);
        log.verbose(`    OK: ${type} (${items.length} card(s)) → ${outPath}`);
        filesWritten += 1;
      }
    }
  }

  return filesWritten;
}

module.exports = { placeInheritedFiles };
