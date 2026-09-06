'use strict';


const fs = require('fs');
const path = require('path');
const { FILENAME: PLACEHOLDERS_FILENAME } = require('./emit/placeholders');
const { walkBranchChain } = require('./model/branches');

function writeOutput(outputDir, type, renderedItems) {
  const typeDir = path.join(outputDir, 'Story Cards', type);
  fs.mkdirSync(typeDir, { recursive: true });
  const outputPath = path.join(typeDir, `${type}.md`);
  fs.writeFileSync(outputPath, renderedItems.join('\n\n') + '\n', 'utf8');
  return outputPath;
}

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

function cleanAndArchive(config, leaves, log) {
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
    log.info(`  Cleaned: ${path.relative(baseOutput, dir) || '(root)'}`);
  }

  const branchesRoot = path.join(baseOutput, 'Branches');
  const diskNodes = findNodeDirsOnDisk(branchesRoot);
  const stale = diskNodes.filter(d => !expectedDirs.has(path.resolve(d)));
  if (stale.length === 0) return;

  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  const archiveBase = path.join(baseOutput, 'Archive', ts);

  for (const staleDir of stale) {
    cleanBranchOutputDir(staleDir);
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
  cleanAndArchive,
  buildBranchOutputDir,
  resolveBranchFolderPath,
};
