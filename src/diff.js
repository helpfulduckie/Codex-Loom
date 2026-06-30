'use strict';

const fs   = require('fs');
const path = require('path');
const { resolveCard, resolveBranchSpec, collectVariantDeltas } = require('./resolver');

// ── shared helpers ────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}

/** Component families captured per leaf, in display order. */
const COMPONENT_FAMILIES = [
  ['plotEssentials', 'Plot Essentials'],
  ['aiInstructions', 'AI Instructions'],
  ['authorsNote',    "Author's Note"],
];

// ════════════════════════════════════════════════════════════════════════════
//  --diff : Shared.md + per-leaf *.delta.md  (rendered-block level, no annotation)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Partition captured per-leaf output into universally-shared blocks and per-leaf deltas.
 *
 * A card (keyed by id) or component block (keyed by family+key) is *shared* iff it is
 * present in every leaf and its rendered text is identical across all of them. Otherwise
 * it is *varying*: each leaf's own version goes into that leaf's delta, and leaves where
 * it is absent (e.g. ~-excluded) silently omit it.
 *
 * @param {Array} leafData - [{ label, fileBase, cards: Map<id,{type,rendered}>,
 *                              components: { plotEssentials:[{key,text}], ... } }]
 * @returns {{ shared: object, deltas: Map<fileBase, object> }}
 */
function buildSharedAndDeltas(leafData) {
  const leafCount = leafData.length;

  // ── Cards ──────────────────────────────────────────────────────────────────
  const cardIds = new Set();
  for (const leaf of leafData) for (const id of leaf.cards.keys()) cardIds.add(id);

  const sharedCards = [];                       // [{ id, type, rendered }]
  const deltaCardsByLeaf = new Map();           // fileBase -> [{ id, type, rendered }]
  for (const leaf of leafData) deltaCardsByLeaf.set(leaf.fileBase, []);

  for (const id of [...cardIds].sort()) {
    const entries = leafData.map(l => l.cards.get(id));
    const present = entries.filter(Boolean);
    const isShared = present.length === leafCount &&
      present.every(e => e.rendered === present[0].rendered);

    if (isShared) {
      sharedCards.push({ id, type: present[0].type, rendered: present[0].rendered });
    } else {
      for (const leaf of leafData) {
        const e = leaf.cards.get(id);
        if (e) deltaCardsByLeaf.get(leaf.fileBase).push({ id, type: e.type, rendered: e.rendered });
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

  const shared = { cards: sharedCards, components: sharedComponents };
  const deltas = new Map();
  for (const leaf of leafData) {
    deltas.set(leaf.fileBase, {
      label:      leaf.label,
      cards:      deltaCardsByLeaf.get(leaf.fileBase),
      components: deltaComponentsByLeaf.get(leaf.fileBase),
    });
  }
  return { shared, deltas };
}

function renderCardSection(cards) {
  if (cards.length === 0) return null;
  const byType = new Map();
  for (const c of cards) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type).push(c);
  }
  const parts = ['## Story Cards'];
  for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
    parts.push(`### ${type}`);
    for (const c of byType.get(type)) parts.push(c.rendered);
  }
  return parts.join('\n\n');
}

function renderComponentSections(components) {
  const out = [];
  for (const [fam, title] of COMPONENT_FAMILIES) {
    const blocks = components[fam] || [];
    if (blocks.length === 0) continue;
    out.push(`## ${title}\n\n` + blocks.map(b => b.text).join('\n\n'));
  }
  return out;
}

function writeSharedDoc(shared, outputDir) {
  const parts = ['# Shared (identical across all leaves)'];
  const cardSection = renderCardSection(shared.cards);
  if (cardSection) parts.push(cardSection);
  parts.push(...renderComponentSections(shared.components));
  if (parts.length === 1) parts.push('_Nothing is identical across every leaf._');
  const outPath = path.join(outputDir, 'Shared.md');
  fs.writeFileSync(outPath, parts.join('\n\n') + '\n', 'utf8');
  return outPath;
}

function writeDeltaDoc(fileBase, delta, outputDir) {
  const parts = [`# Delta: ${delta.label}`, '_Everything this branch has that is not in Shared.md._'];
  const cardSection = renderCardSection(delta.cards);
  if (cardSection) parts.push(cardSection);
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
//  --annotate : per-leaf *.annotate.md  (field-level diff vs project base + provenance)
// ════════════════════════════════════════════════════════════════════════════

const DIFF_ROOTS = ['name', 'pronouns', 'aid', 'body'];

/** True if `obj` has a key matching `name` case-insensitively. */
function hasKeyCI(obj, name) {
  return obj && typeof obj === 'object' &&
    Object.keys(obj).some(k => k.toLowerCase() === name.toLowerCase());
}

/**
 * Flatten a card's diff-relevant fields to a map of lowercase dot-path → JSON value.
 * Only roots in DIFF_ROOTS are walked; leaves are scalars and arrays (arrays compared whole).
 */
function flattenCard(card) {
  const out = {};
  const walk = (val, prefix) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val)) walk(v, prefix ? `${prefix}.${k}` : k);
    } else {
      out[prefix.toLowerCase()] = JSON.stringify(val);
    }
  };
  for (const root of DIFF_ROOTS) {
    if (card[root] === undefined) continue;
    walk(card[root], root);
  }
  return out;
}

/** Diff two flattened cards → [{ path, base, leaf }] for every differing leaf-path. */
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
 * same root namespace as flattenCard (bare keys and explicit `body:` → `body.*`).
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
 * For one card under one leaf, attribute each changed field to the applied variant(s)
 * that touch it, or flag it `unexplained`. Returns { applied, attributions } where
 * attributions maps changedPath → array of explaining variant names (empty = unexplained).
 */
function attributeChanges(cardDef, registry, branchVariantNames, changes) {
  const canonCard = cardDef.import ? registry.get(String(cardDef.import).toLowerCase()) : null;

  const variantKeyPaths = new Map(); // variantName -> Set<dotpath>
  for (const name of branchVariantNames) {
    const source = (cardDef.import && !hasKeyCI(cardDef.variants, name.split('/')[0]))
      ? canonCard
      : cardDef;
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

function safeResolve(cardDef, registry, branchPath) {
  try { return resolveCard(cardDef, registry, branchPath); }
  catch { return null; }
}

/**
 * Build the annotation document for one leaf. Iterates every card def so ~-nulled cards
 * are reported explicitly. Cards identical to their project base with no variants applied
 * are omitted (they belong in Shared.md, not the drill-down).
 */
function buildLeafAnnotation(leaf, allCardDefs, registry) {
  const { label, branchPath } = leaf;
  const sections = [`# Annotations: ${label}`,
    '_Field-level differences from each card\'s project base (no branch dispatch). ' +
    'Each delta is tagged with the variant that produced it, or `unexplained`._'];

  for (const cardDef of allCardDefs) {
    if (cardDef.include) continue;
    const cardId = cardDef.id || cardDef.import;
    if (!cardId) continue;

    const spec = cardDef.import
      ? cardDef.branches
      : (cardDef._include_branch_spec || cardDef.branches);
    const branchVariantNames = resolveBranchSpec(spec, branchPath);

    // ── Nulled (~) — excluded from this leaf ──
    if (branchVariantNames === null) {
      sections.push(`## ${cardId}\n\n- **nulled** — excluded from this branch by \`~\` dispatch`);
      continue;
    }

    const base = safeResolve(cardDef, registry, []);
    const leafCard = safeResolve(cardDef, registry, branchPath);
    if (!base || !leafCard) continue;

    const changes = diffFlattened(flattenCard(base), flattenCard(leafCard));
    if (changes.length === 0 && branchVariantNames.length === 0) continue; // shared, no variants

    const attributions = attributeChanges(cardDef, registry, branchVariantNames, changes);

    const head = branchVariantNames.length
      ? `## ${cardId}\n\n_variants applied: ${branchVariantNames.join(', ')}_`
      : `## ${cardId}`;
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

  if (sections.length === 2) sections.push('_No card differs from its project base in this branch._');
  return sections.join('\n\n');
}

/** Emit one <leaf>.annotate.md per leaf. Returns written paths. */
function runAnnotateMode(leafData, allCardDefs, registry, outputDir) {
  const written = [];
  for (const leaf of leafData) {
    const doc = buildLeafAnnotation(leaf, allCardDefs, registry);
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
  flattenCard,
  diffFlattened,
  collectDeltaKeyPaths,
};
