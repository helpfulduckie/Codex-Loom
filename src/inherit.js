'use strict';

const fs = require('fs');
const path = require('path');
const { branchTreeDeclares } = require('./model/branches');
const { writeSectionedComponent, renderFrontmatter } = require('./emit/components');
const {
  writeOutput, buildBranchOutputDir, resolveBranchFolderPath,
} = require('./outputPaths');
const { writeOutputFile } = require('./outputLedger');

/** The branch tree as nodes keyed by path prefix; `leaf` is the leaf index ending there. */
function buildPlacementTree(leafPaths) {
  const root = { path: [], children: new Map(), leaf: null };
  leafPaths.forEach((p, li) => {
    let node = root;
    for (const seg of p) {
      if (!node.children.has(seg)) {
        node.children.set(seg, { path: [...node.path, seg], children: new Map(), leaf: null });
      }
      node = node.children.get(seg);
    }
    node.leaf = li;
  });
  return root;
}

/**
 * Where to write one file's versions so every leaf resolves to its own version.
 *
 * Velvet Lattice resolves a leaf to the nearest copy on its path, and cannot remove an
 * inherited value, so a leaf without the file forbids any copy above it. Among layouts that
 * resolve correctly this picks the fewest copies, and on a tie the fewest copies that
 * shadow an inherited one — so a file gains an override only when it saves a copy.
 *
 * `leafVersion` maps leaf index -> version index; returns [{ path, version }].
 */
function placeWithOverrides(tree, leafVersion, versionCount) {
  // State s is what a node inherits: 0 for nothing, k for version k-1.
  const states = versionCount + 1;
  const solved = new Map(); // node -> { cost: [{w, sh}], write: [k|0] } per inherited state
  const better = (a, b) => a.w < b.w || (a.w === b.w && a.sh < b.sh);

  const solve = (node) => {
    const kids = [...node.children.values()];
    kids.forEach(solve);
    const cost = []; const write = [];
    for (let s = 0; s < states; s += 1) {
      let best = null; let bestWrite = 0;
      for (let opt = 0; opt < states; opt += 1) {
        if (opt !== 0 && opt === s) continue; // rewriting what is inherited is never useful
        const t = opt === 0 ? s : opt;
        if (node.leaf !== null) {
          const need = leafVersion.has(node.leaf) ? leafVersion.get(node.leaf) + 1 : 0;
          if (t !== need) continue;
        }
        const total = { w: opt === 0 ? 0 : 1, sh: opt !== 0 && s !== 0 ? 1 : 0 };
        let feasible = true;
        for (const kid of kids) {
          const c = solved.get(kid).cost[t];
          if (!c) { feasible = false; break; }
          total.w += c.w; total.sh += c.sh;
        }
        if (feasible && (!best || better(total, best))) { best = total; bestWrite = opt; }
      }
      cost.push(best);
      write.push(bestWrite);
    }
    solved.set(node, { cost, write });
  };
  solve(tree);

  const out = [];
  const walk = (node, s) => {
    const opt = solved.get(node).write[s];
    if (opt !== 0) out.push({ path: node.path, version: opt - 1 });
    const t = opt === 0 ? s : opt;
    for (const kid of node.children.values()) walk(kid, t);
  };
  walk(tree, 0);
  return out;
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

  const scriptLeaves = leaves.map((branchPath) => {
    const folderPath = resolveBranchFolderPath(config.branches, branchPath);
    const outputDir = buildBranchOutputDir(config._resolvedOutput, folderPath);
    return { branchPath, outputDir, files: deferredScripts.get(outputDir) || new Map() };
  });
  const scriptNames = [...new Set(scriptLeaves.flatMap(({ files }) => [...files.keys()]))]
    .sort((a, b) => a.localeCompare(b));
  if (scriptNames.length > 0) {
    const sourceBuffers = new Map();
    const getBuffer = (source) => {
      const absolute = path.resolve(source);
      if (!sourceBuffers.has(absolute)) sourceBuffers.set(absolute, fs.readFileSync(absolute));
      return sourceBuffers.get(absolute);
    };
    const tree = buildPlacementTree(scriptLeaves.map(({ branchPath }) => branchPath));
    const ownedScripts = new Map();
    for (const filename of scriptNames) {
      const versions = [];
      const leafVersion = new Map();
      for (let li = 0; li < scriptLeaves.length; li += 1) {
        const source = scriptLeaves[li].files.get(filename);
        if (!source) continue;
        const buffer = getBuffer(source);
        let version = versions.findIndex((candidate) => candidate.equals(buffer));
        if (version < 0) {
          version = versions.length;
          versions.push(buffer);
        }
        leafVersion.set(li, version);
      }
      for (const { path: nodePath, version } of placeWithOverrides(tree, leafVersion, versions.length)) {
        const outputDir = buildBranchOutputDir(
          config._resolvedOutput, resolveBranchFolderPath(config.branches, nodePath),
        );
        if (!ownedScripts.has(outputDir)) ownedScripts.set(outputDir, []);
        ownedScripts.get(outputDir).push([filename, versions[version]]);
      }
    }
    for (const [outputDir, files] of ownedScripts) {
      for (const [filename, buffer] of files) {
        const dest = path.join(outputDir, 'Scripts', ...filename.split(/[\\/]/));
        writeOutputFile(dest, buffer);
      }
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

    // Velvet Lattice keys story cards on name alone and a node's own card overrides the one
    // it inherits, so placement is decided per name: each distinct (type, text) of that
    // name is one version.
    const byName = new Map(); // name -> { versions: [{type, text, sortKey, carry}], leafVersion, clash }
    deferredCardLeaves.forEach((leaf, li) => {
      for (const [type, entries] of leaf.grouped) {
        for (const e of entries) {
          let rec = byName.get(e.name);
          if (!rec) { rec = { versions: [], leafVersion: new Map(), clash: false }; byName.set(e.name, rec); }
          let vi = rec.versions.findIndex((v) => v.type === type && v.text === e.rendered);
          if (vi < 0) {
            vi = rec.versions.length;
            rec.versions.push({ type, text: e.rendered, sortKey: e.sortKey, carry: new Set() });
          }
          rec.versions[vi].carry.add(li);
          if (rec.leafVersion.has(li) && rec.leafVersion.get(li) !== vi) rec.clash = true;
          rec.leafVersion.set(li, vi);
        }
      }
    });

    const ownedByNode = new Map();
    const putOwned = (node, type, sortKey, rendered) => {
      const dir = buildBranchOutputDir(
        config._resolvedOutput, resolveBranchFolderPath(config.branches, node),
      );
      if (!ownedByNode.has(dir)) ownedByNode.set(dir, new Map());
      const byType = ownedByNode.get(dir);
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push({ sortKey, rendered });
    };
    const tree = buildPlacementTree(leafPaths);
    for (const rec of byName.values()) {
      if (rec.clash) {
        // One leaf carries two cards of this name (CL0622). Override placement would be
        // ambiguous, so each version keeps the placement it would have on its own.
        for (const v of rec.versions) {
          for (const node of frontier([], v.carry)) putOwned(node, v.type, v.sortKey, v.text);
        }
        continue;
      }
      for (const { path: node, version } of placeWithOverrides(tree, rec.leafVersion, rec.versions.length)) {
        const v = rec.versions[version];
        putOwned(node, v.type, v.sortKey, v.text);
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

module.exports = { placeInheritedFiles, placeWithOverrides, buildPlacementTree };
