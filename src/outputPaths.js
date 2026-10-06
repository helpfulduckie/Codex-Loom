'use strict';


const fs = require('fs');
const path = require('path');
const { FILENAME: PLACEHOLDERS_FILENAME } = require('./emit/placeholders');
const { walkBranchChain } = require('./model/branches');
const { recordWrite } = require('./outputLedger');

// ── What the compiler owns in the output tree ───────────────────────────────

/** Directories every node may hold, written only by the compiler. */
const OWNED_DIRS = ['Story Cards', 'Components', 'Scripts'];
/** Files every node may hold, written only by the compiler. */
const OWNED_NODE_FILES = ['Label.md', PLACEHOLDERS_FILENAME, 'Description.md'];
/** Root-only manifests; `canon-dependencies.json` is the earlier name of the second. */
const OWNED_ROOT_FILES = ['library-dependencies.json', 'canon-dependencies.json'];

function writeOutput(outputDir, type, renderedItems) {
  const typeDir = path.join(outputDir, 'Story Cards', type);
  fs.mkdirSync(typeDir, { recursive: true });
  const outputPath = path.join(typeDir, `${type}.md`);
  fs.writeFileSync(outputPath, renderedItems.join('\n\n') + '\n', 'utf8');
  recordWrite(outputPath);
  return outputPath;
}

/** Delete every file under `dir` the ledger does not hold, then any directory left empty. */
function sweepOwnedDir(dir, kept) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sweepOwnedDir(full, kept);
    else if (!kept.has(path.resolve(full))) fs.rmSync(full);
  }
  if (isDirEmpty(dir)) fs.rmSync(dir, { recursive: true });
}

/** Remove what the compiler owns at one node and did not write this run. */
function sweepNode(dir, kept, { root = false } = {}) {
  for (const sub of OWNED_DIRS) sweepOwnedDir(path.join(dir, sub), kept);
  for (const file of [...OWNED_NODE_FILES, ...(root ? OWNED_ROOT_FILES : [])]) {
    const target = path.join(dir, file);
    if (fs.existsSync(target) && !kept.has(path.resolve(target))) fs.rmSync(target);
  }
}

function findNodeDirsOnDisk(dir) {
  if (!fs.existsSync(dir)) return [];
  const nodes = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    nodes.push(...findNodeDirsOnDisk(path.join(child, 'Branches')));
    nodes.push(child);
  }
  return nodes;
}

function nodeDirsUpTo(leafDir, baseOutput) {
  const chain = [];
  let current = path.resolve(leafDir);
  const stop = path.resolve(baseOutput);
  while (current.length >= stop.length) {
    if (path.basename(current) !== 'Branches') chain.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

function isDirEmpty(dir) {
  if (!fs.existsSync(dir)) return true;
  return fs.readdirSync(dir).length === 0;
}

/**
 * Remove compiler output this compile did not write, after it has written everything.
 *
 * Every node the branch tree still has keeps exactly the owned files in `kept`; anything
 * else the compiler owns there is stale and goes. A node the tree no longer has is swept
 * the same way and then removed, or archived under `Archive/<timestamp>/` when something
 * the compiler does not own is left in it — Velvet Lattice's `.short_id` is the usual
 * case — since the compiler may delete what it wrote and may not delete what it did not.
 *
 * Running after the writes rather than before is what keeps a compile that throws
 * part-way from leaving the previous output half-deleted: the caller skips the sweep then.
 */
function sweepOutput(config, leaves, kept, log) {
  const baseOutput = config._resolvedOutput;

  const expectedDirs = new Set();
  for (const branchPath of leaves) {
    const folderPath = resolveBranchFolderPath(config.branches, branchPath);
    const leafDir = buildBranchOutputDir(baseOutput, folderPath);
    for (const dir of nodeDirsUpTo(leafDir, baseOutput)) expectedDirs.add(dir);
  }
  const root = path.resolve(baseOutput);
  expectedDirs.add(root);

  for (const dir of expectedDirs) sweepNode(dir, kept, { root: dir === root });

  const branchesRoot = path.join(baseOutput, 'Branches');
  const diskNodes = findNodeDirsOnDisk(branchesRoot);
  const stale = diskNodes.filter(d => !expectedDirs.has(path.resolve(d)));
  if (stale.length === 0) return;

  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  const archiveBase = path.join(baseOutput, 'Archive', ts);

  for (const staleDir of stale) {
    sweepNode(staleDir, kept);
    const container = path.join(staleDir, 'Branches');
    if (fs.existsSync(container) && isDirEmpty(container)) fs.rmSync(container, { recursive: true });
    if (isDirEmpty(staleDir)) {
      fs.rmSync(staleDir, { recursive: true, force: true });
      log.info(`  Removed empty stale branch: ${path.relative(baseOutput, staleDir)}`);
    } else {
      const rel = path.relative(baseOutput, staleDir);
      const dest = path.join(archiveBase, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(staleDir, dest);
      log.info(`  Archived stale branch → Archive/${ts}/${rel}`);
    }
  }
}

function buildBranchOutputDir(baseOutput, branchPath) {
  if (branchPath.length === 0) return baseOutput;
  return path.join(baseOutput, ...branchPath.flatMap(b => ['Branches', b]));
}

function resolveBranchFolderPath(branches, idPath) {
  return walkBranchChain(branches, idPath).folderPath;
}

module.exports = {
  writeOutput,
  sweepOutput,
  buildBranchOutputDir,
  resolveBranchFolderPath,
};
