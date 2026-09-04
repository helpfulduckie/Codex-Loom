'use strict';

/**
 * Output-directory paths and pre-build directory hygiene for the compiled tree.
 *
 * Where a branch node's folder lands on disk, and the pre-build sweep that wipes the
 * output-type folders from every active node and archives (or deletes) any node that has
 * gone stale.
 */

const fs = require('fs');
const path = require('path');
const { FILENAME: PLACEHOLDERS_FILENAME } = require('./emit/placeholders');
const { walkBranchChain } = require('./model/branches');

/**
 * Write compiled items to output directory.
 * One .md file per item type: Story Cards/{type}/{type}.md
 */
function writeOutput(outputDir, type, renderedItems) {
  const typeDir = path.join(outputDir, 'Story Cards', type);
  fs.mkdirSync(typeDir, { recursive: true });
  const outputPath = path.join(typeDir, `${type}.md`);
  fs.writeFileSync(outputPath, renderedItems.join('\n\n') + '\n', 'utf8');
  return outputPath;
}

/**
 * Delete Story Cards, Components, Scripts subdirs and Label.md from a branch output dir.
 */
function cleanBranchOutputDir(dir) {
  for (const sub of ['Story Cards', 'Components', 'Scripts']) {
    const target = path.join(dir, sub);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
  for (const file of ['Label.md', PLACEHOLDERS_FILENAME]) {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) fs.rmSync(target);
  }
}

/**
 * Every branch *node* dir on disk beneath a `Branches/` container, deepest first.
 *
 * Was `findLeafDirsOnDisk`, which stopped at leaves. An interior node is a node: it owns
 * a `Label.md` and, since Phase 4, a `Placeholders.yaml`, and Velvet Lattice reads both
 * and inherits them down the subtree. A sweep that only sees leaves cannot clean an
 * interior node and cannot tell that one has gone stale.
 *
 * Deepest first so a caller removing empty directories meets a child before its parent.
 */
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

/**
 * Every node dir from `leafDir` up to and including `baseOutput`.
 *
 * The `Branches` containers between them are skipped: they hold nodes and are not nodes,
 * so they carry no `Label.md` and nothing to clean.
 */
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
 * Pre-build clean: wipe output-type folders from every active branch node, then detect
 * and archive (or delete) any stale node on disk.
 *
 * **Nodes, not leaves.** This swept only leaf directories until Phase 4 raised it: a
 * declaration deleted from an interior node — its `Placeholders.yaml`, or the `Label.md`
 * that has the same shape and predates placeholders — survived in the output tree, and
 * Velvet Lattice went on reading it and inheriting it down the subtree. The compiler
 * rewrites what it emits, so only a key that stopped being emitted was affected, which is
 * exactly the edit an author makes when they mean to remove one.
 *
 * The root is a node too, and had the same hole: it was added to the expected set only
 * for a project with no branches at all, so a branched project's root `Label.md` and
 * `Placeholders.yaml` were never swept either.
 *
 * Ancestors of an expected leaf are expected, which gives the stale pass an invariant it
 * needs: a stale node can never contain a live descendant, so archiving one whole is safe.
 */
function cleanAndArchive(config, leaves) {
  const baseOutput = config._resolvedOutput;

  const expectedDirs = new Set();
  for (const branchPath of leaves) {
    const folderPath = resolveBranchFolderPath(config.branches, branchPath);
    const leafDir = buildBranchOutputDir(baseOutput, folderPath);
    for (const dir of nodeDirsUpTo(leafDir, baseOutput)) expectedDirs.add(dir);
  }
  expectedDirs.add(path.resolve(baseOutput));

  for (const dir of expectedDirs) {
    cleanBranchOutputDir(dir);
    console.log(`  Cleaned: ${path.relative(baseOutput, dir) || '(root)'}`);
  }

  const branchesRoot = path.join(baseOutput, 'Branches');
  const diskNodes = findNodeDirsOnDisk(branchesRoot);
  const stale = diskNodes.filter(d => !expectedDirs.has(path.resolve(d)));
  if (stale.length === 0) return;

  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  const archiveBase = path.join(baseOutput, 'Archive', ts);

  for (const staleDir of stale) {
    cleanBranchOutputDir(staleDir);
    // `stale` is deepest first, so a stale node's own stale children have already been
    // dealt with by the time it is reached — leaving behind an empty `Branches` container
    // that would otherwise read as content and get the node archived as a hollow shell.
    const container = path.join(staleDir, 'Branches');
    if (fs.existsSync(container) && isDirEmpty(container)) fs.rmSync(container, { recursive: true });
    if (isDirEmpty(staleDir)) {
      fs.rmSync(staleDir, { recursive: true, force: true });
      console.log(`  Removed empty stale branch: ${path.relative(baseOutput, staleDir)}`);
    } else {
      const rel = path.relative(baseOutput, staleDir);
      const dest = path.join(archiveBase, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(staleDir, dest);
      console.log(`  Archived stale branch → Archive/${ts}/${rel}`);
    }
  }
}

/**
 * Build the output directory path for a branch leaf.
 */
function buildBranchOutputDir(baseOutput, branchPath) {
  if (branchPath.length === 0) return baseOutput;
  return path.join(baseOutput, ...branchPath.flatMap(b => ['Branches', b]));
}

/**
 * Resolve the output folder path for a branch identifier path.
 * Uses the internal key name (case-preserved from the YAML) for each folder segment.
 *
 * @param {object|null} branches - root branches mapping from config
 * @param {string[]}    idPath   - branch identifier path (e.g. ['tier2', 'alpha'])
 * @returns {string[]}           - folder name path (e.g. ['tier2', 'alpha'])
 */
function resolveBranchFolderPath(branches, idPath) {
  return walkBranchChain(branches, idPath).folderPath;
}

module.exports = {
  writeOutput,
  cleanAndArchive,
  buildBranchOutputDir,
  resolveBranchFolderPath,
};
