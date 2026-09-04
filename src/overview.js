'use strict';

const fs   = require('fs');
const path = require('path');

const { buildTree, flattenNodes, leafNodes } = require('./compiledTree');
const { PATH_UNSAFE_CHARS } = require('./util');

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

const UNSAFE_FILENAME_CHARS = new RegExp('[' + PATH_UNSAFE_CHARS + ']', 'g');

function sanitizeFilename(name) {
  return name.replace(UNSAFE_FILENAME_CHARS, '_').trim();
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
 * One story-cards block for a leaf, merging every `Story Cards/` directory on its ancestor
 * chain into a single view — one `### <type>` heading per type, its cards sorted by title.
 *
 * Since Phase 11 Step 5 a card is written at the node that owns it and inherited down, so a
 * leaf's cards are spread across several nodes on its chain. A leaf review is a picture of
 * one leaf; the author reading it should not have to know or care which node in the tree a
 * card was declared at, so this reassembles the picture rather than concatenating a block
 * per node. A within-leaf duplicate card name is a compile error (`CL0622`), so there is
 * nothing to de-duplicate — every `## <name>` chunk across the chain is a distinct card.
 */
function buildMergedStoryCardsBlock(storyCardsDirs, headingLevel) {
  const hashes = '#'.repeat(headingLevel);
  const byType = new Map(); // type name → [{ title, chunk }]

  for (const dir of storyCardsDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of collectMarkdownFiles(dir)) {
      const parts = path.relative(dir, file).split(path.sep);
      const type = parts.length > 1 ? parts[0] : '';
      const content = readFile(file);
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

/**
 * Discover every leaf node under a scenario root directory, each carrying the merged
 * story-cards block for that leaf.
 *
 * The traversal is `compiledTree.js`'s shared tree (Phase 11 Step 2) rather than a private
 * `childBranches` recursion — `overview.js` was the last report-layer walker that still
 * descended on its own.
 *
 * @typedef {{ branchNames: string[], cards: (string|null), leafDir: string }} LeafNode
 * @param {string} rootDir - absolute path of the scenario output root
 * @returns {LeafNode[]}
 */
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

/**
 * One section per node in the tree (root first, depth-first through `Branches/`),
 * each showing only what that node declares itself.
 *
 * Traversal is `compiledTree.js`'s shared tree (Phase 11 Step 2); components come from
 * `node.own.components`, the same filename-keyed map `readComponents` builds by hand.
 * Story cards stay on `buildStoryCardsBlock` — `--overview` prints raw per-node blocks,
 * not the resolved set.
 */
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

// ── exported leaf compiler ────────────────────────────────────────────────────

/**
 * Compile a single leaf node into a .leaf.md file and write it to outputDir.
 * Filename: sanitize(branchNames.join(" - ") || rootDirName) + ".leaf.md"
 */
function compileLeaf(leaf, outputDir, rootDirName, isSingleLeaf, verbose = false) {
  const { branchNames, cards, leafDir } = leaf; // `cards` is the merged block, or null

  // Walk up from the leaf to find the nearest versions of each component file.
  let dir      = leafDir;
  let opening  = null;
  let plotEss  = null;
  let ainText  = null;
  let anText   = null;
  while (true) {
    const compDir = path.join(dir, 'Components');
    if (fs.existsSync(compDir)) {
      if (opening === null) opening = readFile(path.join(compDir, 'Opening.md'));
      if (plotEss === null) plotEss = readFile(path.join(compDir, 'Plot Essentials.md'));
      if (ainText === null) ainText = readFile(path.join(compDir, 'AI Instructions.md'));
      if (anText  === null) anText  = readFile(path.join(compDir, "Author Notes.md"));
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

  const fileBase = isSingleLeaf && branchNames.length === 0
    ? rootDirName
    : branchNames.join(' - ');

  const filename = sanitizeFilename(fileBase || rootDirName) + '.leaf.md';
  const outPath  = path.join(outputDir, filename);

  const parts = [];
  parts.push(`# ${title}`);
  if (opening)  parts.push(`## Opening\n\n${opening}`);
  if (plotEss)  parts.push(`## Plot Essentials\n\n\`\`\`\n${plotEss}\n\`\`\``);
  if (ainText)  parts.push(`## AI Instructions\n\n\`\`\`\n${ainText}\n\`\`\``);
  if (anText)   parts.push(`## Author's Note\n\n${anText}`);
  if (cards) parts.push(`## Story Cards\n\n${cards}`);

  fs.writeFileSync(outPath, parts.join('\n\n'), 'utf8');
  if (verbose) console.log(`  ✓  ${filename}`);
}

// ── exported runners ──────────────────────────────────────────────────────────

/**
 * Run leaves mode on a scenario root: discover all leaves, compile each one.
 * Returns the list of output file paths written.
 */
function runLeafReviewMode(scenarioRoot, outputDir, verbose = false) {
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const leaves      = discoverLeaves(rootAbs);

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
    const filename  = sanitizeFilename(fileBase || rootDirName) + '.leaf.md';
    written.push(path.join(outputDir, filename));

    compileLeaf(leaf, outputDir, rootDirName, isSingleLeaf, verbose);
  }

  return written;
}

/**
 * Run overview mode: produce one .overview.md covering the whole tree.
 * Returns the output file path written.
 */
function runOverviewMode(scenarioRoot, outputDir, verbose = false) {
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const filename    = sanitizeFilename(rootDirName) + '.overview.md';
  const outPath     = path.join(outputDir, filename);

  const sections = collectOverviewSections(rootAbs, rootDirName);
  const doc = [`# ${rootDirName}`, ...sections].join('\n\n');
  fs.writeFileSync(outPath, doc, 'utf8');
  if (verbose) console.log(`  ✓  ${filename}`);
  return outPath;
}

module.exports = {
  buildStoryCardsBlock,
  discoverLeaves,
  compileLeaf,
  runLeafReviewMode,
  runOverviewMode,
  sanitizeFilename,
};
