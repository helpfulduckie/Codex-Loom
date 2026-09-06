'use strict';


const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const { parseCards } = require('./emit/vl');
const { FILENAME: PLACEHOLDERS_FILE } = require('./emit/placeholders');
const { findFiles, readFileTrim } = require('./util');


function collectMdFiles(dir) {
  return findFiles(dir, '.md', { sort: true });
}

function childBranches(nodeDir) {
  const branchesDir = path.join(nodeDir, 'Branches');
  if (!fs.existsSync(branchesDir)) return [];
  return fs.readdirSync(branchesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ name: e.name, dir: path.join(branchesDir, e.name) }));
}

function ancestorDirs(nodeDir) {
  let dir = nodeDir;
  const dirs = [];
  while (true) {
    dirs.unshift(dir);
    const parent = path.dirname(dir);
    const parentName = path.basename(parent);
    if (parent === dir || parentName !== 'Branches') break;
    dir = path.dirname(parent);
  }
  return dirs;
}


function readOwnComponents(nodeDir) {
  const compDir = path.join(nodeDir, 'Components');
  const result = {};
  if (!fs.existsSync(compDir)) return result;
  const entries = fs.readdirSync(compDir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = readFileTrim(path.join(compDir, entry.name));
      if (content) result[path.basename(entry.name, '.md')] = content;
    }
  }
  return result;
}

function readOwnCards(nodeDir) {
  const storyCardsDir = path.join(nodeDir, 'Story Cards');
  const cards = [];
  for (const file of collectMdFiles(storyCardsDir)) {
    const content = fs.readFileSync(file, 'utf8');
    const type = path.basename(path.dirname(file));
    for (const card of parseCards(content, { type })) {
      cards.push({ ...card, file });
    }
  }
  return cards;
}

function readOwnPlaceholders(nodeDir) {
  const file = path.join(nodeDir, PLACEHOLDERS_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

function readOwn(nodeDir) {
  return {
    components: readOwnComponents(nodeDir),
    cards: readOwnCards(nodeDir),
    placeholders: readOwnPlaceholders(nodeDir),
  };
}


function mergeCardsByName(parentCards, ownCards) {
  const byName = new Map(parentCards.map((c) => [c.title, c]));
  for (const card of ownCards) byName.set(card.title, card);
  return [...byName.values()];
}

const EMPTY_RESOLVED = { components: {}, cards: [], placeholders: {} };

function foldResolved(parentResolved, own) {
  return {
    components: { ...parentResolved.components, ...own.components },
    cards: mergeCardsByName(parentResolved.cards, own.cards),
    placeholders: { ...parentResolved.placeholders, ...own.placeholders },
  };
}

function resolveAt(nodeDir) {
  let own = null;
  let resolved = EMPTY_RESOLVED;
  for (const dir of ancestorDirs(nodeDir)) {
    own = readOwn(dir);
    resolved = foldResolved(resolved, own);
  }
  return { own, resolved };
}


function buildNode(nodeDir, branchNames, parent) {
  const own = readOwn(nodeDir);
  const resolved = foldResolved(parent ? parent.resolved : EMPTY_RESOLVED, own);

  const node = {
    dir: nodeDir, branchNames, isLeaf: true, parent, children: [], own, resolved,
  };

  const children = childBranches(nodeDir);
  if (children.length > 0) {
    node.isLeaf = false;
    for (const child of children) {
      node.children.push(buildNode(child.dir, [...branchNames, child.name], node));
    }
  }

  return node;
}

function buildTree(rootDir) {
  return buildNode(path.resolve(rootDir), [], null);
}

function flattenNodes(root) {
  const nodes = [root];
  for (const child of root.children) nodes.push(...flattenNodes(child));
  return nodes;
}

function leafNodes(root) {
  return flattenNodes(root).filter((n) => n.isLeaf);
}

module.exports = {
  buildTree,
  flattenNodes,
  leafNodes,
  resolveAt,
  ancestorDirs,
  childBranches,
  collectMdFiles,
  mergeCardsByName,
};
