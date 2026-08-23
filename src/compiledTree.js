'use strict';

/**
 * The shared compiled-tree shape (v4 spec §15, Phase 10 Decision 1).
 *
 * `seedmap.js`, `bodysize.js` and `overview.js` each walked the compiled output tree
 * separately — one up from a leaf through `Branches/` parents, two down from the root —
 * and none of the three implemented Velvet Lattice's own merge. This module is the one
 * traversal both directions are built from: `childBranches` is the single place a child
 * directory list is read off disk, `ancestorDirs` is the single upward walk, and
 * `resolveAt`/`buildTree` are two views of the same per-node merge — computed fresh from
 * a single directory for `resolveAt`, computed incrementally on the way down for
 * `buildTree`. Both call the same `mergeDict`/`mergeCardsByFile` functions, so nothing
 * about what "resolved" means can drift between them.
 *
 * Every node carries what it declares itself (`own`) and what Velvet Lattice resolves
 * there by folding every ancestor down to it (`resolved`). `--overview` prints `own`;
 * `--seed-map` and `--card-sizes` need `resolved`, each with its own filter applied
 * afterward — the trigger filter and the hasFence filter are report rules, not merge
 * rules, and stay with their reports rather than moving into this module.
 *
 * `resolved.components` and `resolved.placeholders` are VL's own merge (`scenario.py:30`):
 * `{...parent, ...local}` keyed by filename, local wins. `resolved.cards` keeps today's
 * union-deduplicated-by-file rule for this step — Decision 3 changes it to a name-keyed
 * map in Step 2, which is why the merge is one small function rather than inline.
 *
 * `resolved.scripts` is not a merge at all: nothing under a branch's `Scripts/` dir
 * inherits from a parent — each branch's `Scripts/` is written whole from its own
 * `componentRefs.scripts` source, already resolved by the time it lands on disk. It is
 * carried here for a future consumer that wants a script inventory across the tree;
 * nothing in this phase reads it.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const { parseCards } = require('./emit/vl');
const { FILENAME: PLACEHOLDERS_FILE } = require('./emit/placeholders');

// ── filesystem primitives ───────────────────────────────────────────────────

function readFileTrim(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Every `.md` file under `dir`, depth-first, sorted. */
function collectMdFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) results.push(full);
    }
  }
  walk(dir);
  return results;
}

/** Every file under `dir`, depth-first, sorted — for `own.scripts`. */
function collectFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else results.push(full);
    }
  }
  walk(dir);
  return results;
}

/** Immediate child branch directories under `nodeDir/Branches`, sorted. */
function childBranches(nodeDir) {
  const branchesDir = path.join(nodeDir, 'Branches');
  if (!fs.existsSync(branchesDir)) return [];
  return fs.readdirSync(branchesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ name: e.name, dir: path.join(branchesDir, e.name) }));
}

/**
 * Walk from a node dir upward through `Branches/` parent levels.
 * Returns dirs root-first (ancestors before the node itself).
 */
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

// ── own (per-node, unmerged) ─────────────────────────────────────────────────

/** This node's own components — `.md` files directly in its `Components/` dir. */
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

/** This node's own cards — parsed from `.md` files directly in its `Story Cards/` dir. */
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

/** This node's own placeholder declarations — parsed straight, no ancestor merge. */
function readOwnPlaceholders(nodeDir) {
  const file = path.join(nodeDir, PLACEHOLDERS_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    // An unreadable Placeholders.yaml is the compiler's to report, not the report's. The
    // honest fallback is to resolve without it and let the rest of the merge stand.
    return {};
  }
}

function readOwn(nodeDir) {
  return {
    components: readOwnComponents(nodeDir),
    cards: readOwnCards(nodeDir),
    placeholders: readOwnPlaceholders(nodeDir),
    scripts: collectFiles(path.join(nodeDir, 'Scripts')),
  };
}

// ── resolved (VL's merge down the ancestor chain) ────────────────────────────

/** VL's `{...parent, ...local}` merge, keyed by filename (`scenario.py:30`). */
function mergeDict(parentDict, ownDict) {
  return { ...parentDict, ...ownDict };
}

/**
 * Today's rule: union of ancestor and own cards, deduplicated by source file.
 *
 * The dedup guards against a file reachable twice (impossible in a tree, but the rule
 * predates this module and is kept exactly), not against `ownCards` itself — a single
 * file is one card sometimes and several other times (one `##` heading per card), and
 * they all carry that same `file` value. Checking against `seenFiles` alone, and never
 * adding to it mid-loop, is what keeps every card from a multi-card file.
 */
function mergeCardsByFile(parentCards, ownCards) {
  const seenFiles = new Set(parentCards.map((c) => c.file));
  return [...parentCards, ...ownCards.filter((card) => !seenFiles.has(card.file))];
}

const EMPTY_RESOLVED = { components: {}, cards: [], placeholders: {}, scripts: [] };

function foldResolved(parentResolved, own) {
  return {
    components: mergeDict(parentResolved.components, own.components),
    cards: mergeCardsByFile(parentResolved.cards, own.cards),
    placeholders: mergeDict(parentResolved.placeholders, own.placeholders),
    scripts: own.scripts,
  };
}

/**
 * `own` and `resolved` for a single node, reached by walking up from it. For any node
 * also reachable from a `buildTree` call, this returns the same values that node carries
 * — both fold the same ancestor chain through the same merge functions.
 */
function resolveAt(nodeDir) {
  let own = null;
  let resolved = EMPTY_RESOLVED;
  for (const dir of ancestorDirs(nodeDir)) {
    own = readOwn(dir);
    resolved = foldResolved(resolved, own);
  }
  return { own, resolved };
}

// ── the tree ─────────────────────────────────────────────────────────────────

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

/** Build the compiled tree rooted at `rootDir` (a scenario output root). */
function buildTree(rootDir) {
  return buildNode(path.resolve(rootDir), [], null);
}

/** Every node, root first depth-first. */
function flattenNodes(root) {
  const nodes = [root];
  for (const child of root.children) nodes.push(...flattenNodes(child));
  return nodes;
}

/** Every leaf node. */
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
  collectFiles,
  mergeDict,
  mergeCardsByFile,
};
