'use strict';

// `safeResolve` re-resolves items the compile has already resolved and reported on, purely
// to build the annotation report. It reports nothing: every diagnostic it could raise was
// raised — and printed — during the compile that produced the tree being annotated.
const silentWarner = () => {};

const fs   = require('fs');
const path = require('path');
const { resolveItem, resolveBranchSpec, collectVariantDeltas } = require('./resolver');
const { resolveItemRef } = require('./model/refs');

// ── shared helpers ────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}

/** Shift markdown heading levels down by `shift` (capped at level 6), matching overview/leaf reports. */
function shiftHeadings(content, shift) {
  if (shift <= 0) return content;
  return content.replace(/^(#{1,6})(?= )/gm, (_, hashes) => {
    const newLevel = Math.min(hashes.length + shift, 6);
    return '#'.repeat(newLevel);
  });
}

/** Component families captured per leaf, in display order. */
const COMPONENT_FAMILIES = [
  ['plotEssentials', 'Plot Essentials'],
  ['aiInstructions', 'AI Instructions'],
  ['authorsNote',    "Author's Note"],
];

// ════════════════════════════════════════════════════════════════════════════
//  --with-diff : Shared.md + per-leaf *.delta.md  (rendered-block level, no annotation)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Partition captured per-leaf output into universally-shared blocks and per-leaf deltas.
 *
 * A item (keyed by id) or component block (keyed by family+key) is *shared* iff it is
 * present in every leaf and its rendered text is identical across all of them. Otherwise
 * it is *varying*: each leaf's own version goes into that leaf's delta, and leaves where
 * it is absent (e.g. ~-excluded) silently omit it.
 *
 * @param {Array} leafData - [{ label, fileBase, items: Map<id,{type,rendered}>,
 *                              components: { plotEssentials:[{key,text}], ... } }]
 * @returns {{ shared: object, deltas: Map<fileBase, object> }}
 */
function buildSharedAndDeltas(leafData) {
  const leafCount = leafData.length;

  // ── Items ──────────────────────────────────────────────────────────────────
  const itemIds = new Set();
  for (const leaf of leafData) for (const id of leaf.items.keys()) itemIds.add(id);

  const sharedItems = [];                       // [{ id, type, rendered }]
  const deltaItemsByLeaf = new Map();           // fileBase -> [{ id, type, rendered }]
  for (const leaf of leafData) deltaItemsByLeaf.set(leaf.fileBase, []);

  for (const id of [...itemIds].sort()) {
    const entries = leafData.map(l => l.items.get(id));
    const present = entries.filter(Boolean);
    const isShared = present.length === leafCount &&
      present.every(e => e.rendered === present[0].rendered);

    if (isShared) {
      sharedItems.push({ id, type: present[0].type, rendered: present[0].rendered });
    } else {
      for (const leaf of leafData) {
        const e = leaf.items.get(id);
        if (e) deltaItemsByLeaf.get(leaf.fileBase).push({ id, type: e.type, rendered: e.rendered });
      }
    }
  }

  // ── Component blocks ────────────────────────────────────────────────────────
  // sharedComponents[family] = [{ key, text }]; deltaComponentsByLeaf[fileBase][family] = [...]
  const sharedComponents = {};
  const deltaComponentsByLeaf = new Map();
  for (const leaf of leafData) {
    deltaComponentsByLeaf.set(leaf.fileBase, {});
    for (const [fam] of COMPONENT_FAMILIES) deltaComponentsByLeaf.get(leaf.fileBase)[fam] = [];
  }

  for (const [fam] of COMPONENT_FAMILIES) {
    sharedComponents[fam] = [];
    const keys = new Set();
    for (const leaf of leafData) for (const b of leaf.components[fam] || []) keys.add(b.key);

    for (const key of keys) {
      const entries = leafData.map(l => (l.components[fam] || []).find(b => b.key === key) || null);
      const present = entries.filter(Boolean);
      const isShared = present.length === leafCount &&
        present.every(e => e.text === present[0].text);

      if (isShared) {
        sharedComponents[fam].push({ key, text: present[0].text });
      } else {
        for (const leaf of leafData) {
          const b = (leaf.components[fam] || []).find(x => x.key === key);
          if (b) deltaComponentsByLeaf.get(leaf.fileBase)[fam].push(b);
        }
      }
    }
  }

  const shared = { items: sharedItems, components: sharedComponents };
  const deltas = new Map();
  for (const leaf of leafData) {
    deltas.set(leaf.fileBase, {
      label:      leaf.label,
      items:      deltaItemsByLeaf.get(leaf.fileBase),
      components: deltaComponentsByLeaf.get(leaf.fileBase),
    });
  }
  return { shared, deltas };
}

function renderItemSection(items) {
  if (items.length === 0) return null;
  const byType = new Map();
  for (const c of items) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type).push(c);
  }
  const parts = ['## Story Cards'];
  for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
    parts.push(`### ${type}`);
    for (const c of byType.get(type)) parts.push(shiftHeadings(c.rendered, 2));
  }
  return parts.join('\n\n');
}

function renderComponentSections(components) {
  const out = [];
  for (const [fam, title] of COMPONENT_FAMILIES) {
    const blocks = components[fam] || [];
    if (blocks.length === 0) continue;
    const fenced = fam === 'plotEssentials' || fam === 'aiInstructions';
    const body   = blocks.map(b => fenced ? `\`\`\`\n${b.text}\n\`\`\`` : b.text).join('\n\n');
    out.push(`## ${title}\n\n${body}`);
  }
  return out;
}

function writeSharedDoc(shared, outputDir) {
  const parts = ['# Shared (identical across all leaves)'];
  const itemSection = renderItemSection(shared.items);
  if (itemSection) parts.push(itemSection);
  parts.push(...renderComponentSections(shared.components));
  if (parts.length === 1) parts.push('_Nothing is identical across every leaf._');
  const outPath = path.join(outputDir, 'Shared.md');
  fs.writeFileSync(outPath, parts.join('\n\n') + '\n', 'utf8');
  return outPath;
}

function writeDeltaDoc(fileBase, delta, outputDir) {
  const parts = [`# Delta: ${delta.label}`, '_Everything this branch has that is not in Shared.md._'];
  const itemSection = renderItemSection(delta.items);
  if (itemSection) parts.push(itemSection);
  parts.push(...renderComponentSections(delta.components));
  if (parts.length === 2) parts.push('_This branch matches the shared baseline exactly._');
  const filename = sanitizeFilename(fileBase) + '.delta.md';
  const outPath = path.join(outputDir, filename);
  fs.writeFileSync(outPath, parts.join('\n\n') + '\n', 'utf8');
  return outPath;
}

/** Emit Shared.md and one <leaf>.delta.md per leaf. Returns written paths. */
function runDiffMode(leafData, outputDir) {
  const { shared, deltas } = buildSharedAndDeltas(leafData);
  const written = [writeSharedDoc(shared, outputDir)];
  for (const [fileBase, delta] of deltas) written.push(writeDeltaDoc(fileBase, delta, outputDir));
  return written;
}

// ════════════════════════════════════════════════════════════════════════════
//  --with-annotate : per-leaf *.annotate.md  (field-level diff vs project base + provenance)
// ════════════════════════════════════════════════════════════════════════════

const DIFF_ROOTS = ['name', 'pronouns', 'aid', 'body'];

/** True if `obj` has a key matching `name` case-insensitively. */
function hasKeyCI(obj, name) {
  return obj && typeof obj === 'object' &&
    Object.keys(obj).some(k => k.toLowerCase() === name.toLowerCase());
}

/**
 * Flatten an item's diff-relevant fields to a map of lowercase dot-path → JSON value.
 * Only roots in DIFF_ROOTS are walked; leaves are scalars and arrays (arrays compared whole).
 */
function flattenItem(item) {
  const out = {};
  const walk = (val, prefix) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val)) walk(v, prefix ? `${prefix}.${k}` : k);
    } else {
      out[prefix.toLowerCase()] = JSON.stringify(val);
    }
  };
  for (const root of DIFF_ROOTS) {
    if (item[root] === undefined) continue;
    walk(item[root], root);
  }
  return out;
}

/** Diff two flattened items → [{ path, base, leaf }] for every differing leaf-path. */
function diffFlattened(base, leaf) {
  const paths = new Set([...Object.keys(base), ...Object.keys(leaf)]);
  const changes = [];
  for (const p of [...paths].sort()) {
    if (base[p] !== leaf[p]) {
      changes.push({
        path: p,
        base: base[p] === undefined ? '(absent)' : base[p],
        leaf: leaf[p] === undefined ? '(removed)' : leaf[p],
      });
    }
  }
  return changes;
}

/**
 * Collect the set of lowercase dot-paths a variant delta touches, normalized to the
 * same root namespace as flattenItem (bare keys and explicit `body:` → `body.*`).
 */
function collectDeltaKeyPaths(delta) {
  const paths = new Set();
  const walk = (val, prefix) => {
    paths.add(prefix.toLowerCase());
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val)) walk(v, `${prefix}.${k}`);
    }
  };
  if (!delta || typeof delta !== 'object') return paths;
  for (const [key, val] of Object.entries(delta)) {
    const kl = key.toLowerCase();
    if (['variants', 'importvariants', '_source'].includes(kl)) continue;
    if (kl === 'body')                                   walk(val, 'body');
    else if (['name', 'pronouns', 'aid'].includes(kl))   walk(val, kl);
    else if (['render', 'v'].includes(kl))               { /* not diffed */ }
    else                                                 walk(val, `body.${key}`);
  }
  return paths;
}

/** A changed path is explained by a delta if either is a prefix of (or equal to) the other. */
function pathExplained(changedPath, deltaPaths) {
  for (const dp of deltaPaths) {
    if (changedPath === dp || changedPath.startsWith(dp + '.') || dp.startsWith(changedPath + '.')) {
      return true;
    }
  }
  return false;
}

/**
 * For one item under one leaf, attribute each changed field to the applied variant(s)
 * that touch it, or flag it `unexplained`. Returns { applied, attributions } where
 * attributions maps changedPath → array of explaining variant names (empty = unexplained).
 */
function attributeChanges(itemDef, registry, branchVariantNames, changes) {
  const canonItem = itemDef.import ? (resolveItemRef(registry, itemDef.import).item || null) : null;

  const variantKeyPaths = new Map(); // variantName -> Set<dotpath>
  for (const name of branchVariantNames) {
    const source = (itemDef.import && !hasKeyCI(itemDef.variants, name.split('/')[0]))
      ? canonItem
      : itemDef;
    const deltas = collectVariantDeltas(source, name) || [];
    const paths = new Set();
    for (const d of deltas) for (const p of collectDeltaKeyPaths(d)) paths.add(p);
    variantKeyPaths.set(name, paths);
  }

  const attributions = {};
  for (const ch of changes) {
    const explainers = [];
    for (const [name, paths] of variantKeyPaths) {
      if (pathExplained(ch.path, paths)) explainers.push(name);
    }
    attributions[ch.path] = explainers;
  }
  return attributions;
}

function safeResolve(itemDef, registry, branchPath) {
  try { return resolveItem(itemDef, registry, branchPath, silentWarner); }
  catch { return null; }
}

/**
 * Build the annotation document for one leaf. Iterates every item def so ~-nulled items
 * are reported explicitly. Items identical to their project base with no variants applied
 * are omitted (they belong in Shared.md, not the drill-down).
 */
function buildLeafAnnotation(leaf, allItemDefs, registry) {
  const { label, branchPath } = leaf;
  const sections = [`# Annotations: ${label}`,
    '_Field-level differences from each item\'s project base (no branch dispatch). ' +
    'Each delta is tagged with the variant that produced it, or `unexplained`._'];

  for (const itemDef of allItemDefs) {
    const itemId = itemDef.id || itemDef.import;
    if (!itemId) continue;

    const spec = itemDef.import
      ? itemDef.branches
      : (itemDef._include_branch_spec || itemDef.branches);
    const branchVariantNames = resolveBranchSpec(spec, branchPath);

    // ── Nulled (~) — excluded from this leaf ──
    if (branchVariantNames === null) {
      sections.push(`## ${itemId}\n\n- **nulled** — excluded from this branch by \`~\` dispatch`);
      continue;
    }

    const base = safeResolve(itemDef, registry, []);
    const leafItem = safeResolve(itemDef, registry, branchPath);
    if (!base || !leafItem) continue;

    const changes = diffFlattened(flattenItem(base), flattenItem(leafItem));
    if (changes.length === 0 && branchVariantNames.length === 0) continue; // shared, no variants

    const attributions = attributeChanges(itemDef, registry, branchVariantNames, changes);

    const head = branchVariantNames.length
      ? `## ${itemId}\n\n_variants applied: ${branchVariantNames.join(', ')}_`
      : `## ${itemId}`;
    const lines = [head];

    if (changes.length === 0) {
      lines.push('- _variant(s) applied but produced no field change vs base_');
    }
    for (const ch of changes) {
      const explainers = attributions[ch.path];
      const tag = explainers.length ? `explained-by ${explainers.join(', ')}` : '**unexplained**';
      lines.push(`- \`${ch.path}\` — ${tag}\n    - base: ${ch.base}\n    - leaf: ${ch.leaf}`);
    }
    sections.push(lines.join('\n'));
  }

  if (sections.length === 2) sections.push('_No item differs from its project base in this branch._');
  return sections.join('\n\n');
}

/** Emit one <leaf>.annotate.md per leaf. Returns written paths. */
function runAnnotateMode(leafData, allItemDefs, registry, outputDir) {
  const written = [];
  for (const leaf of leafData) {
    const doc = buildLeafAnnotation(leaf, allItemDefs, registry);
    const filename = sanitizeFilename(leaf.fileBase) + '.annotate.md';
    const outPath = path.join(outputDir, filename);
    fs.writeFileSync(outPath, doc + '\n', 'utf8');
    written.push(outPath);
  }
  return written;
}

module.exports = {
  buildSharedAndDeltas,
  runDiffMode,
  buildLeafAnnotation,
  runAnnotateMode,
  // exported for unit tests
  flattenItem,
  diffFlattened,
  collectDeltaKeyPaths,
};
