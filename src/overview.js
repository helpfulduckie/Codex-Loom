'use strict';

const fs   = require('fs');
const path = require('path');

const { buildTree, flattenNodes, leafNodes, collectMdFiles } = require('./compiledTree');
const { readFileTrim } = require('./util');
const { NULL_LOG } = require('./log');
const { sanitizeFilename, shiftHeadings, leafFileName } = require('./report');


function buildStoryCardsBlock(storyCardsDir, headingLevel) {
  const files = collectMdFiles(storyCardsDir);
  if (files.length === 0) return null;

  const hashes     = '#'.repeat(headingLevel);
  const groups     = {};
  const groupOrder = [];

  for (const file of files) {
    const rel       = path.relative(storyCardsDir, file);
    const parts     = rel.split(path.sep);
    const groupName = parts.length > 1 ? parts[0] : '';
    if (!groups[groupName]) {
      groups[groupName] = [];
      groupOrder.push(groupName);
    }
    groups[groupName].push(file);
  }

  const lines = [];
  for (const groupName of groupOrder) {
    if (groupName) lines.push(`${hashes} ${groupName}`);
    for (const file of groups[groupName]) {
      const content = readFileTrim(file);
      if (content) lines.push(shiftHeadings(content, headingLevel - 1));
    }
  }
  return lines.join('\n\n');
}

function buildMergedStoryCardsBlock(storyCardsDirs, headingLevel) {
  const hashes = '#'.repeat(headingLevel);
  const byType = new Map(); // type name → [{ title, chunk }]

  for (const dir of storyCardsDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of collectMdFiles(dir)) {
      const parts = path.relative(dir, file).split(path.sep);
      const type = parts.length > 1 ? parts[0] : '';
      const content = readFileTrim(file);
      if (!content) continue;
      for (const raw of content.split(/(?=^## )/m)) {
        const chunk = raw.trim();
        if (!chunk) continue;
        const title = (chunk.match(/^##\s+(.*)/) || [, ''])[1].trim();
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push({ title, chunk: shiftHeadings(chunk, headingLevel - 1) });
      }
    }
  }
  if (byType.size === 0) return null;

  const lines = [];
  for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
    if (type) lines.push(`${hashes} ${type}`);
    for (const { chunk } of byType.get(type).sort((a, b) => a.title.localeCompare(b.title))) {
      lines.push(chunk);
    }
  }
  return lines.join('\n\n');
}

function discoverLeaves(rootDir) {
  return leafNodes(buildTree(rootDir)).map((leaf) => {
    const dirs = [];
    for (let node = leaf; node; node = node.parent) dirs.unshift(path.join(node.dir, 'Story Cards'));
    return {
      branchNames: leaf.branchNames,
      cards: buildMergedStoryCardsBlock(dirs, 3),
      leafDir: leaf.dir,
    };
  });
}

function collectOverviewSections(rootDir, rootDirName) {
  const sections = [];

  for (const node of flattenNodes(buildTree(rootDir))) {
    const label = node.branchNames.length === 0
      ? rootDirName
      : [rootDirName, ...node.branchNames].join(' - ');

    const storyCardsDir = path.join(node.dir, 'Story Cards');
    const ownCards      = fs.existsSync(storyCardsDir)
      ? buildStoryCardsBlock(storyCardsDir, 4)
      : null;

    const sectionParts = [`## ${label}`];
    for (const [name, content] of Object.entries(node.own.components)) {
      const fenced = name === 'Plot Essentials' || name === 'AI Instructions';
      const body   = fenced ? `\`\`\`\n${content}\n\`\`\`` : content;
      sectionParts.push(`### ${name}\n\n${body}`);
    }
    if (ownCards) sectionParts.push(`### Story Cards\n\n${ownCards}`);
    if (sectionParts.length === 1) sectionParts.push('_No content at this level._');
    sections.push(sectionParts.join('\n\n'));
  }

  return sections;
}


function compileLeaf(leaf, outputDir, rootDirName, isSingleLeaf, log = NULL_LOG) {
  const { branchNames, cards, leafDir } = leaf; // `cards` is the merged block, or null

  let dir      = leafDir;
  let opening  = null;
  let plotEss  = null;
  let ainText  = null;
  let anText   = null;
  while (true) {
    const compDir = path.join(dir, 'Components');
    if (fs.existsSync(compDir)) {
      if (opening === null) opening = readFileTrim(path.join(compDir, 'Opening.md'));
      if (plotEss === null) plotEss = readFileTrim(path.join(compDir, 'Plot Essentials.md'));
      if (ainText === null) ainText = readFileTrim(path.join(compDir, 'AI Instructions.md'));
      if (anText  === null) anText  = readFileTrim(path.join(compDir, "Author Notes.md"));
    }
    if (opening !== null && plotEss !== null && ainText !== null && anText !== null) break;
    const parent     = path.dirname(dir);
    const parentName = path.basename(parent);
    if (parent === dir || parentName !== 'Branches') break;
    dir = path.dirname(parent);
  }

  const title = branchNames.length > 0
    ? `${rootDirName}: ${branchNames.join(' - ')}`
    : rootDirName;

  const filename = leafFileName(branchNames, rootDirName, isSingleLeaf);
  const outPath  = path.join(outputDir, filename);

  const parts = [];
  parts.push(`# ${title}`);
  if (opening)  parts.push(`## Opening\n\n${opening}`);
  if (plotEss)  parts.push(`## Plot Essentials\n\n\`\`\`\n${plotEss}\n\`\`\``);
  if (ainText)  parts.push(`## AI Instructions\n\n\`\`\`\n${ainText}\n\`\`\``);
  if (anText)   parts.push(`## Author's Note\n\n${anText}`);
  if (cards) parts.push(`## Story Cards\n\n${cards}`);

  fs.writeFileSync(outPath, parts.join('\n\n'), 'utf8');
  log.verbose(`  ✓  ${filename}`);
}


function runLeafReviewMode(scenarioRoot, outputDir, options = {}) {
  const { log = NULL_LOG } = options;
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const leaves      = discoverLeaves(rootAbs);

  if (leaves.length === 0) return { written: [] };

  const isSingleLeaf = leaves.length === 1;
  const written      = [];

  for (const leaf of leaves) {
    const { branchNames } = leaf;
    const filename  = leafFileName(branchNames, rootDirName, isSingleLeaf);
    written.push(path.join(outputDir, filename));

    compileLeaf(leaf, outputDir, rootDirName, isSingleLeaf, log);
  }

  return { written };
}

function runOverviewMode(scenarioRoot, outputDir, options = {}) {
  const { log = NULL_LOG } = options;
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const filename    = sanitizeFilename(rootDirName) + '.overview.md';
  const outPath     = path.join(outputDir, filename);

  const sections = collectOverviewSections(rootAbs, rootDirName);
  const doc = [`# ${rootDirName}`, ...sections].join('\n\n');
  fs.writeFileSync(outPath, doc, 'utf8');
  log.verbose(`  ✓  ${filename}`);
  return { written: [outPath], outPath };
}

module.exports = {
  buildStoryCardsBlock,
  discoverLeaves,
  compileLeaf,
  runLeafReviewMode,
  runOverviewMode,
};
