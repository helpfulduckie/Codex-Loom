'use strict';

const fs   = require('fs');
const path = require('path');

// ── private helpers ──────────────────────────────────────────────────────────

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function collectMarkdownFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}

function shiftHeadings(content, shift) {
  if (shift <= 0) return content;
  return content.replace(/^(#{1,6})(?= )/gm, (_, hashes) => {
    const newLevel = Math.min(hashes.length + shift, 6);
    return '#'.repeat(newLevel);
  });
}

// ── exported building blocks ─────────────────────────────────────────────────

/**
 * Read all .md files from a Components/ directory.
 * Returns a map of basename-without-ext → trimmed content.
 */
function readComponents(branchDir) {
  const compDir = path.join(branchDir, 'Components');
  const result  = {};
  if (!fs.existsSync(compDir)) return result;

  const entries = fs.readdirSync(compDir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = readFile(path.join(compDir, entry.name));
      if (content) result[path.basename(entry.name, '.md')] = content;
    }
  }
  return result;
}

/**
 * Build a concatenated story-cards block from a Story Cards/ directory.
 * Groups files by their immediate sub-folder (card type).
 * headingLevel controls the markdown heading depth for group names.
 */
function buildStoryCardsBlock(storyCardsDir, headingLevel) {
  const files = collectMarkdownFiles(storyCardsDir);
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
      const content = readFile(file);
      if (content) lines.push(shiftHeadings(content, headingLevel - 1));
    }
  }
  return lines.join('\n\n');
}

/**
 * Recursively discover all leaf nodes under a scenario root directory.
 * Each leaf accumulates story-card blocks from all ancestor nodes.
 *
 * @typedef {{ branchNames: string[], cards: string[], leafDir: string }} LeafNode
 * @param {string}   branchDir     - absolute path of the node to walk
 * @param {string[]} ancestorCards - accumulated card blocks from ancestors
 * @param {string[]} branchNames   - path of branch names from root to here
 * @returns {LeafNode[]}
 */
function discoverLeaves(branchDir, ancestorCards, branchNames) {
  const storyCardsDir = path.join(branchDir, 'Story Cards');
  const branchesDir   = path.join(branchDir, 'Branches');

  const myCards = [...ancestorCards];
  if (fs.existsSync(storyCardsDir)) {
    const block = buildStoryCardsBlock(storyCardsDir, 2);
    if (block) myCards.push(block);
  }

  const childBranches = fs.existsSync(branchesDir)
    ? fs.readdirSync(branchesDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  if (childBranches.length === 0) {
    return [{ branchNames, cards: myCards, leafDir: branchDir }];
  }

  const leaves = [];
  for (const child of childBranches) {
    const childPath = path.join(branchesDir, child.name);
    leaves.push(...discoverLeaves(childPath, myCards, [...branchNames, child.name]));
  }
  return leaves;
}

/**
 * Walk every node in the tree (root + all branches, depth-first), collecting
 * one section per node showing only that node's own content.
 */
function collectOverviewSections(branchDir, branchNames, rootDirName) {
  const sections = [];

  const label   = branchNames.length === 0
    ? rootDirName
    : [rootDirName, ...branchNames].join(' - ');
  const heading = `## ${label}`;

  const ownComponents = readComponents(branchDir);
  const storyCardsDir = path.join(branchDir, 'Story Cards');
  const ownCards      = fs.existsSync(storyCardsDir)
    ? buildStoryCardsBlock(storyCardsDir, 4)
    : null;

  const sectionParts = [heading];
  for (const [name, content] of Object.entries(ownComponents)) {
    sectionParts.push(`### ${name}\n\n${content}`);
  }
  if (ownCards) sectionParts.push(`### Story Cards\n\n${ownCards}`);
  if (sectionParts.length === 1) sectionParts.push('_No content at this level._');
  sections.push(sectionParts.join('\n\n'));

  const branchesDir = path.join(branchDir, 'Branches');
  if (fs.existsSync(branchesDir)) {
    const children = fs.readdirSync(branchesDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      sections.push(
        ...collectOverviewSections(
          path.join(branchesDir, child.name),
          [...branchNames, child.name],
          rootDirName,
        )
      );
    }
  }
  return sections;
}

// ── exported leaf compiler ────────────────────────────────────────────────────

/**
 * Compile a single leaf node into a .overview.md file and write it to outputDir.
 * Filename: sanitize(branchNames.join(" - ") || rootDirName) + ".overview.md"
 */
function compileLeaf(leaf, outputDir, rootDirName, isSingleLeaf) {
  const { branchNames, cards, leafDir } = leaf;

  // Walk up from the leaf to find the nearest Opening.md and Plot Essentials.md.
  let dir     = leafDir;
  let opening = null;
  let plotEss = null;
  while (true) {
    const compDir = path.join(dir, 'Components');
    if (fs.existsSync(compDir)) {
      if (opening === null) opening = readFile(path.join(compDir, 'Opening.md'));
      if (plotEss === null) plotEss = readFile(path.join(compDir, 'Plot Essentials.md'));
    }
    if (opening !== null && plotEss !== null) break;
    const parent     = path.dirname(dir);
    const parentName = path.basename(parent);
    if (parent === dir || parentName !== 'Branches') break;
    dir = path.dirname(parent);
  }

  const title = branchNames.length > 0
    ? branchNames[branchNames.length - 1]
    : rootDirName;

  const fileBase = isSingleLeaf && branchNames.length === 0
    ? rootDirName
    : branchNames.join(' - ');

  const filename = sanitizeFilename(fileBase || rootDirName) + '.overview.md';
  const outPath  = path.join(outputDir, filename);

  const parts = [];
  parts.push(`# ${title}`);
  if (opening) parts.push(`# Opening\n\n${opening}`);
  if (plotEss) parts.push(`# Plot Essentials\n\n${plotEss}`);
  if (cards.length > 0) parts.push(`# Story Cards\n\n${cards.join('\n\n')}`);

  fs.writeFileSync(outPath, parts.join('\n\n'), 'utf8');
  console.log(`  ✓  ${filename}`);
}

// ── exported runners ──────────────────────────────────────────────────────────

/**
 * Run leaves mode on a scenario root: discover all leaves, compile each one.
 * Returns the list of output file paths written.
 */
function runLeafReviewMode(scenarioRoot, outputDir) {
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const leaves      = discoverLeaves(rootAbs, [], []);

  if (leaves.length === 0) {
    console.warn('  WARN: No branch leaves found — nothing to compile.');
    return [];
  }

  const isSingleLeaf = leaves.length === 1;
  const written      = [];

  for (const leaf of leaves) {
    const { branchNames } = leaf;
    const fileBase  = isSingleLeaf && branchNames.length === 0
      ? rootDirName
      : branchNames.join(' - ');
    const filename  = sanitizeFilename(fileBase || rootDirName) + '.overview.md';
    written.push(path.join(outputDir, filename));

    compileLeaf(leaf, outputDir, rootDirName, isSingleLeaf);
  }

  return written;
}

/**
 * Run overview mode: produce one .overview.md covering the whole tree.
 * Returns the output file path written.
 */
function runOverviewMode(scenarioRoot, outputDir) {
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const filename    = sanitizeFilename(rootDirName) + '.overview.md';
  const outPath     = path.join(outputDir, filename);

  const sections = collectOverviewSections(rootAbs, [], rootDirName);
  const doc = [`# ${rootDirName}`, ...sections].join('\n\n');
  fs.writeFileSync(outPath, doc, 'utf8');
  console.log(`  ✓  ${filename}`);
  return outPath;
}

module.exports = {
  readComponents,
  buildStoryCardsBlock,
  discoverLeaves,
  collectOverviewSections,
  compileLeaf,
  runLeafReviewMode,
  runOverviewMode,
};
