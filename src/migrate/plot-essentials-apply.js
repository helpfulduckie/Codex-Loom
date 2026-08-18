'use strict';

/**
 * Applying a Plot Essentials conversion to the files (§7.2, §14.2).
 *
 * `plot-essentials.js` decides what each v3 block becomes and touches nothing. This does
 * the surgery: rewrites the component as `sections:`, adds a render target to every item an
 * `- import:` block named, and moves each inline block out into an item file of its own.
 *
 * ── Why this edits YAML documents rather than re-serializing ────────────────
 *
 * Item files are the author's own prose — section rules, comment banners, deliberate line
 * breaks — and a migration whose diff is mostly reformatting is one nobody can review for
 * the changes that matter. So every edit goes through `YAML.parseDocument` and sets
 * individual nodes, leaving every untouched line byte-identical. `v3.js` made the same
 * choice for the same reason.
 *
 * ── The one case that needs a graft ─────────────────────────────────────────
 *
 * A v3 Plot Essentials block could carry its own `branches:`, resolved independently of the
 * item's. v4 has one item with one dispatch, so the two have to become one. The placement
 * goes into a variant and that variant's name is grafted into the item's existing branch
 * tree at exactly the nodes the block's spec selected — which works because `render:` is
 * variant-modifiable, so a branch can move an item without new machinery.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const { YAML_SUFFIXES, hasSuffix } = require('../util');

const NL = '\n';
const SPLIT_LINES = /\r?\n/;

/** Header for the file inline blocks are moved into, so its provenance is on the page. */
const HEADER_LINES = [
  '# Items moved out of Plot Essentials by the v3 migrator (§7.5).',
  '# Each carries no `aid:` block, which §7.4 permits for an item with no story-card target.',
  '# Rename this file and fold the items into wherever they belong.',
];

// ── node helpers ─────────────────────────────────────────────────────────────

/** The id a project item entry answers to, lowercased. */
function entryId(node) {
  if (!YAML.isMap(node)) return null;
  const raw = node.get('id') || node.get('import')
    || (typeof node.get('name') === 'string' ? node.get('name') : null);
  return raw ? String(raw).toLowerCase() : null;
}

/** `node.render`, created if absent. */
function renderMap(doc, node) {
  let render = node.get('render', true);
  if (!YAML.isMap(render)) {
    render = doc.createNode({});
    node.set('render', render);
  }
  return render;
}

/** Write the render target (and the suppression, when the block was full-style) onto a map. */
function setTarget(doc, render, target, suppressStoryCard) {
  if (suppressStoryCard) render.set('storyCard', false);
  render.set('plotEssential', doc.createNode(target));
}

// ── the branch graft ─────────────────────────────────────────────────────────

/**
 * Every branch path a v3 block's own `branches:` spec *included*.
 *
 * Exclusions are the paths that need nothing — `~` on a block meant "no Plot Essentials
 * here", and in v4 that is simply the placement variant not being applied. Only the
 * inclusions have to be written somewhere.
 */
function includedPaths(spec, prefix = []) {
  const paths = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return paths;

  for (const [key, value] of Object.entries(spec)) {
    const here = [...prefix, key];
    if (value === null || value === undefined) continue;      // excluded on this branch
    if (Array.isArray(value) || typeof value === 'string') { paths.push(here); continue; }
    if (typeof value === 'object') {
      if (value.branches) paths.push(...includedPaths(value.branches, here));
      else paths.push(here);
    }
  }
  return paths;
}

/**
 * Add `variantName` to the item's dispatch at one branch path, creating the path if needed.
 *
 * The four shapes a dispatch node can already have are the four `resolveBranchSpec` accepts,
 * and each takes the name differently — a bare scalar has to become a list to hold two, and
 * a mapping carries its variants under `apply:` beside the `branches:` it descends through.
 */
function addVariantAt(doc, branchesNode, branchPath, variantName) {
  let current = branchesNode;
  for (let i = 0; i < branchPath.length; i++) {
    const key = branchPath[i];
    let next = current.get(key, true);
    const last = i === branchPath.length - 1;

    if (!last) {
      if (!YAML.isMap(next)) { next = doc.createNode({}); current.set(key, next); }
      let deeper = next.get('branches', true);
      if (!YAML.isMap(deeper)) { deeper = doc.createNode({}); next.set('branches', deeper); }
      current = deeper;
      continue;
    }

    if (YAML.isMap(next)) {
      const apply = next.get('apply', true);
      if (YAML.isSeq(apply)) apply.add(variantName);
      else if (apply != null) next.set('apply', doc.createNode([String(apply), variantName]));
      else next.set('apply', doc.createNode([variantName]));
      return;
    }
    if (YAML.isSeq(next)) { next.add(variantName); return; }
    if (next != null && !YAML.isMap(next) && !YAML.isSeq(next)) {
      const existing = next && next.value !== undefined ? next.value : next;
      current.set(key, doc.createNode(existing == null ? [variantName] : [String(existing), variantName]));
      return;
    }
    current.set(key, doc.createNode([variantName]));
  }
}

/**
 * Put a placement behind a named variant and dispatch that variant where the block applied.
 *
 * Used only when a block carried its own `branches:` — otherwise the target belongs in the
 * base `render:`, where it costs nothing and reads better.
 */
function graftPlacement(doc, node, placement, variantName, notes) {
  let variants = node.get('variants', true);
  if (!YAML.isMap(variants)) { variants = doc.createNode({}); node.set('variants', variants); }

  const render = {};
  if (placement.suppressStoryCard) render.storyCard = false;
  render.plotEssential = placement.target;
  variants.set(variantName, doc.createNode({ render }));

  let branches = node.get('branches', true);
  if (!YAML.isMap(branches)) { branches = doc.createNode({}); node.set('branches', branches); }

  const paths = includedPaths(placement.block.raw.branches);
  if (paths.length === 0) {
    notes.push(
      'item "' + placement.block.id + '" had a Plot Essentials block whose branches: excluded '
      + 'it everywhere — the "' + variantName + '" variant is written but never dispatched.',
    );
    return;
  }
  for (const branchPath of paths) addVariantAt(doc, branches, branchPath, variantName);
  notes.push(
    'item "' + placement.block.id + '" took its placement as the "' + variantName + '" variant, '
    + 'dispatched at ' + paths.map((p) => p.join('/')).join(', ') + ' — its Plot Essentials '
    + 'block carried its own branches:, and v4 resolves one dispatch per item.',
  );
}

// ── applying to item files ───────────────────────────────────────────────────

/**
 * Add every `- import:` placement to the item entry it names.
 *
 * Returns the ids that were not found. A miss is not silent: a block naming an item the
 * project never defines locally rendered in v3 through canon alone, and in v4 it needs an
 * entry to hang the target on — which is a file the author has to place, not the migrator.
 */
function applyImportPlacements(itemDirs, placements, options = {}) {
  const notes = [];
  const touched = [];
  const wanted = new Map();
  for (const placement of placements) {
    if (placement.block.kind !== 'import') continue;
    wanted.set(String(placement.block.id).toLowerCase(), placement);
  }
  const found = new Set();

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !hasSuffix(entry.name, YAML_SUFFIXES)) continue;

      const source = fs.readFileSync(full, 'utf8');
      const doc = YAML.parseDocument(source);
      if (doc.errors.length > 0 || !YAML.isSeq(doc.contents)) continue;

      let changed = false;
      for (const node of doc.contents.items) {
        const id = entryId(node);
        if (!id || !wanted.has(id) || found.has(id)) continue;
        const placement = wanted.get(id);
        found.add(id);
        changed = true;

        if (placement.block.raw.branches) {
          graftPlacement(doc, node, placement, 'pe-' + placement.target.slot, notes);
        } else {
          setTarget(doc, renderMap(doc, node), placement.target, placement.suppressStoryCard);
        }
      }

      if (!changed) continue;
      const bom = source.charCodeAt(0) === 0xFEFF ? '﻿' : '';
      const output = bom + doc.toString({ lineWidth: 0, flowCollectionPadding: false });
      if (!options.dryRun) fs.writeFileSync(full, output, 'utf8');
      touched.push(full);
    }
  };

  for (const dir of itemDirs) if (fs.existsSync(dir)) walk(dir);

  const missing = [...wanted.keys()].filter((id) => !found.has(id));
  for (const id of missing) {
    notes.push(
      'no project item entry for "' + id + '", which a Plot Essentials block imported. Add one '
      + 'carrying its render.plotEssential target — canon alone has nowhere to put placement.',
    );
  }
  return { touched, notes, missing };
}

/**
 * Move inline Plot Essentials blocks into an item file of their own.
 *
 * §7.5's rule: standalone Plot Essentials content is an item, because it carries structured
 * body fields rendered through a template. `aid:` is dropped rather than carried, since §7.4
 * asks for triggers and a type only when a story-card target exists — and a block that lived
 * in Plot Essentials has none.
 */
function buildInlineItems(placements) {
  const items = [];
  for (const placement of placements) {
    if (placement.block.kind !== 'inline') continue;
    const raw = placement.block.raw;
    const item = {};

    for (const [key, value] of Object.entries(raw)) {
      if (key === 'render' || key === 'aid' || key === 'heading' || key === 'headingLevel') continue;
      item[key] = value;
    }

    const render = {};
    // v3 let a block name its template through `aid.type`, the same fallback an item uses.
    // The type itself goes, because there is no story card for it to file.
    const template = placement.block.template || (raw.aid && raw.aid.type) || null;
    if (template) render.template = template;
    render.storyCard = false;
    render.plotEssential = placement.target;
    item.render = render;

    items.push(item);
  }
  return items;
}


// ── orchestration ────────────────────────────────────────────────────────────

/**
 * Migrate one project's Plot Essentials, end to end.
 *
 * Assumes `v3.js` has already run: the config must be v4-valid before the compiler's own
 * loader can be used to answer what a block resolved to, and using that loader rather than a
 * private copy is what keeps the migrator's idea of a wrapper identical to the compiler's.
 */
function migratePlotEssentialsFiles(configPath, options = {}) {
  const { loadCompileConfig, loadItemsFromDir, loadTemplates } = require('../loader');
  const { buildCanonRegistry } = require('../loader/registry');
  const { buildCompileContext } = require('../compile');
  const { convertPlotEssentials, buildItemLookup } = require('./plot-essentials');

  const saved = { log: console.log, warn: console.warn, error: console.error };
  let config; let registry; let templateNames;
  try {
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    config = loadCompileConfig(configPath);
    const canon = buildCanonRegistry(config._resolvedCanon);
    registry = buildItemLookup(canon, loadItemsFromDir(config._resolvedItems));
    const { templates } = loadTemplates(config._resolvedTemplates);
    templateNames = new Set([...templates.keys()].map((k) => String(k).toLowerCase()));
  } finally {
    Object.assign(console, saved);
  }

  const pePath = buildCompileContext(config, []).componentRefs.plotEssential;
  if (!pePath || !fs.existsSync(String(pePath))) {
    return { notes: ['no Plot Essentials file to migrate.'], touched: [] };
  }

  const source = fs.readFileSync(String(pePath), 'utf8');
  const blocks = YAML.parse(source);
  if (!Array.isArray(blocks)) {
    return { notes: ['Plot Essentials is already a sections: document — nothing to migrate.'], touched: [] };
  }

  const { sections, placements, notes } = convertPlotEssentials(blocks, registry, templateNames);
  const applied = applyImportPlacements(config._resolvedItems, placements, options);
  notes.push(...applied.notes);

  // The component keeps its own leading comments: they describe the project, not the block
  // list, and a migration that silently discards an author's banner is one they cannot audit.
  const banner = source.split(SPLIT_LINES).filter((line) => line.trim().startsWith('#')).join(NL);
  const componentText = (banner ? banner + NL + NL : '')
    + YAML.stringify({ sections }, { lineWidth: 0 });
  if (!options.dryRun) fs.writeFileSync(String(pePath), componentText, 'utf8');
  const touched = [String(pePath), ...applied.touched];

  const inlineItems = buildInlineItems(placements);
  if (inlineItems.length > 0) {
    const dir = config._resolvedItems[0];
    const itemsPath = path.join(dir, 'plot-essentials-items.yaml');
    const header = HEADER_LINES.join(NL) + NL;
    if (!options.dryRun) {
      fs.writeFileSync(itemsPath, header + YAML.stringify(inlineItems, { lineWidth: 0 }), 'utf8');
    }
    touched.push(itemsPath);
    notes.push(
      inlineItems.length + ' inline Plot Essentials block(s) became items in '
      + path.basename(itemsPath) + ' — they were content, not shape, so they cannot stay in a '
      + 'component that only declares shape.',
    );
  }

  return { notes, touched, sections, placements };
}

module.exports = {
  migratePlotEssentialsFiles,
  entryId,
  includedPaths,
  addVariantAt,
  graftPlacement,
  applyImportPlacements,
  buildInlineItems,
};
