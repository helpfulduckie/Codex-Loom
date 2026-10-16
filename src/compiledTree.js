'use strict';


const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const { parseCards } = require('./emit/vl');
const { FILENAME: PLACEHOLDERS_FILE } = require('./emit/placeholders');
const { findFiles } = require('./util');


function collectMdFiles(dir) {
  return findFiles(dir, '.md', { sort: true });
}

const compareEntries = (a, b) => a.name.localeCompare(b.name);

// Folders and files are read through a source so that the same resolution rule runs against
// a compiled tree on disk and against the in-memory output of a preview.
const diskSource = {
  dirNames: (dir) => (fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : []),
  fileNames: (dir) => (fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
    : []),
  mdFiles: collectMdFiles,
  read: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
};

/** A source over a Map of absolute file path to content, as a capturing compile returns it. */
function memorySource(files) {
  const dirs = new Map();
  const ensure = (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, { dirs: new Set(), files: new Set() });
    return dirs.get(dir);
  };
  for (const file of files.keys()) {
    const resolved = path.resolve(file);
    ensure(path.dirname(resolved)).files.add(path.basename(resolved));
    let dir = path.dirname(resolved);
    for (let parent = path.dirname(dir); parent !== dir; dir = parent, parent = path.dirname(dir)) {
      ensure(parent).dirs.add(path.basename(dir));
    }
  }
  const mdFiles = (dir) => {
    const node = dirs.get(path.resolve(dir));
    if (!node) return [];
    const entries = [
      ...[...node.dirs].map((name) => ({ name, dir: true })),
      ...[...node.files].map((name) => ({ name, dir: false })),
    ].sort(compareEntries);
    const found = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.dir) found.push(...mdFiles(full));
      else if (entry.name.endsWith('.md')) found.push(full);
    }
    return found;
  };
  return {
    dirNames: (dir) => [...(dirs.get(path.resolve(dir)) || { dirs: [] }).dirs],
    fileNames: (dir) => [...(dirs.get(path.resolve(dir)) || { files: [] }).files],
    mdFiles,
    read: (file) => {
      const content = files.get(path.resolve(file));
      if (content === undefined) return null;
      return Buffer.isBuffer(content) ? content.toString('utf8') : content;
    },
  };
}

function childBranches(nodeDir, source = diskSource) {
  const branchesDir = path.join(nodeDir, 'Branches');
  return source.dirNames(branchesDir)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, dir: path.join(branchesDir, name) }));
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


function readOwnComponents(nodeDir, source) {
  const compDir = path.join(nodeDir, 'Components');
  const result = {};
  for (const name of source.fileNames(compDir).sort((a, b) => a.localeCompare(b))) {
    if (name.endsWith('.md')) {
      const raw = source.read(path.join(compDir, name));
      const content = raw === null ? null : raw.trim();
      if (content) result[path.basename(name, '.md')] = content;
    }
  }
  return result;
}

function readOwnCards(nodeDir, source) {
  const storyCardsDir = path.join(nodeDir, 'Story Cards');
  const cards = [];
  for (const file of source.mdFiles(storyCardsDir)) {
    const content = source.read(file);
    if (content === null) continue;
    const type = path.basename(path.dirname(file));
    for (const card of parseCards(content, { type })) {
      cards.push({ ...card, file });
    }
  }
  return cards;
}

function readOwnPlaceholders(nodeDir, source) {
  const file = path.join(nodeDir, PLACEHOLDERS_FILE);
  const raw = source.read(file);
  if (raw === null) return {};
  try {
    const parsed = YAML.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

function readOwn(nodeDir, source = diskSource) {
  return {
    components: readOwnComponents(nodeDir, source),
    cards: readOwnCards(nodeDir, source),
    placeholders: readOwnPlaceholders(nodeDir, source),
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

// `chain` holds each ancestor's own records, root first, so a caller can say which
// ancestor a resolved file came from.
function resolveAt(nodeDir, source = diskSource) {
  let own = null;
  let resolved = EMPTY_RESOLVED;
  const chain = [];
  for (const dir of ancestorDirs(nodeDir)) {
    own = readOwn(dir, source);
    chain.push({ dir, own });
    resolved = foldResolved(resolved, own);
  }
  return { own, resolved, chain };
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
  memorySource,
  ancestorDirs,
  childBranches,
  collectMdFiles,
  mergeCardsByName,
};
