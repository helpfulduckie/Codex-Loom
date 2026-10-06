'use strict';

/**
 * The variance report: for every item whose story card differs between leaves, each
 * distinct rendered version once, the leaves that receive it, and how it differs from the
 * version it was built on.
 *
 * Organized by item rather than by leaf, so a difference shared by many leaves is written
 * once, and a card renamed by a variant stays in one entry. Versions are labeled by the
 * variants that produced them and diffed along that chain — `major/anchor + human` against
 * `major/anchor` — with the base printed in full. Diffs are of the rendered text, because
 * the report's question is what AID receives, not which YAML key changed (that is annotate).
 */

const fs = require('fs');
const path = require('path');
const { reportIdentity } = require('./report');

const { resolveBranchSpec } = require('./model/branches');
const { collectVariantDeltas, parseVariantsList } = require('./model/item');
const { splitRef } = require('./model/refs');
const { parseCards } = require('./emit/vl');

// ── Version lines and diffs ──────────────────────────────────────────────────

/**
 * A rendered card as the lines a reader compares: title, fence keys, body. The fence's
 * `meta:` block is for Codex Loom's own checks and never reaches AID, so it is left out.
 */
function cardLines(rendered) {
  const out = [];
  let inMeta = false;
  for (const raw of String(rendered).split(/\r?\n/)) {
    if (/^~~~\s*$/.test(raw)) { inMeta = false; continue; }
    if (/^meta:\s*$/.test(raw)) { inMeta = true; continue; }
    if (inMeta && /^\s/.test(raw)) continue;
    inMeta = false;
    out.push(raw.replace(/^##\s+/, ''));
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.filter((line) => line.trim() !== '');
}

function lcs(a, b, eq) {
  const m = a.length; const n = b.length;
  const t = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      t[i][j] = eq(a[i], b[j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  const ops = []; let i = 0; let j = 0;
  while (i < m && j < n) {
    if (eq(a[i], b[j])) { ops.push({ op: '=', a: a[i], b: b[j], bi: j }); i += 1; j += 1; }
    else if (t[i + 1][j] >= t[i][j + 1]) { ops.push({ op: '-', a: a[i], bi: j }); i += 1; }
    else { ops.push({ op: '+', b: b[j], bi: j }); j += 1; }
  }
  while (i < m) { ops.push({ op: '-', a: a[i], bi: n }); i += 1; }
  while (j < n) { ops.push({ op: '+', b: b[j], bi: j }); j += 1; }
  return ops;
}

const LABELED = /^([^:\n]{1,40}):(?: (.*))?$/;
const labelOf = (line) => { const m = LABELED.exec(line); return m ? m[1] : null; };
const isBullet = (line) => /^\s*- /.test(line);
/** Card fence keys: labeled lines, but settings rather than a heading the body hangs from. */
const FENCE_KEYS = new Set(['triggers', 'encapsulate', 'notes', 'kind', 'type', 'description']);

// Separators stay outside a mark: they read as unchanged, and GFM will not open `~~` or
// `**` between a letter and punctuation, so marking them would print the markers raw. A
// leading `- ` staying outside is also what keeps a marked bullet a list item.
const SEPARATOR = /^[\s;,.:!?[\]{}()\-—]+|[\s;,.:!?[\]{}()\-—]+$/g;
function mark(run, marker) {
  const core = run.replace(SEPARATOR, '');
  if (!core) return run;
  const at = run.indexOf(core);
  return `${run.slice(0, at)}${marker}${core}${marker}${run.slice(at + core.length)}`;
}
const strike = (s) => mark(s, '~~');
const bold = (s) => mark(s, '**');

const tokens = (line) => line.split(/(\s+|[;,.:!?[\]{}()])/).filter((t) => t !== '');
const isWord = (t) => /\w/.test(t);

/**
 * At or above this share of common words, two lines are one line edited and are marked
 * word by word. It is low on purpose: a pronoun and verb swap on a short line changes most
 * of its words, and that swap is what the protagonist branches are read for.
 */
const SAME_LINE = 1 / 3;

/** Share of `a`'s and `b`'s words they have in common, 0–1. */
function similarity(a, b) {
  const wa = tokens(a).filter(isWord); const wb = tokens(b).filter(isWord);
  if (!wa.length || !wb.length) return 0;
  const common = lcs(wa, wb, (x, y) => x === y).filter((o) => o.op === '=').length;
  return (2 * common) / (wa.length + wb.length);
}

/**
 * Unchanged text too slight to anchor a reader between two changes — spacing, punctuation,
 * one short word. Changes either side of it are merged, or a rewritten phrase comes out as
 * alternating single-word marks.
 */
function isSlight(text) {
  const words = tokens(text).filter(isWord);
  return words.length === 0 || (words.length === 1 && words[0].length < 3);
}

/**
 * One line changed in place, marked by word: `asks whether ~~she tames~~ **you tame**`.
 * Each changed stretch is one struck run followed by one added run.
 */
function inlineDiff(from, to) {
  const chunks = []; // { eq: text } | { a: removed, b: added }
  let pendingEq = '';
  for (const o of lcs(tokens(from), tokens(to), (x, y) => x === y)) {
    if (o.op === '=') { pendingEq += o.a; continue; }
    let last = chunks[chunks.length - 1];
    if (pendingEq) {
      if (last && last.eq === undefined && isSlight(pendingEq)) {
        last.a += pendingEq; last.b += pendingEq;
      } else {
        chunks.push({ eq: pendingEq });
        last = null;
      }
      pendingEq = '';
    }
    if (!last || last.eq !== undefined) { last = { a: '', b: '' }; chunks.push(last); }
    if (o.op === '-') last.a += o.a; else last.b += o.b;
  }
  if (pendingEq) chunks.push({ eq: pendingEq });

  return chunks.map((c) => {
    if (c.eq !== undefined) return c.eq;
    // text absorbed into both sides is unchanged; keep it out of a side that is otherwise empty
    const a = c.a.trim() && tokens(c.a).some(isWord) ? strike(c.a) : '';
    const b = c.b.trim() && tokens(c.b).some(isWord) ? bold(c.b) : '';
    return a && b ? `${a.replace(/\s+$/, '')} ${b.replace(/^\s+/, '')}` : (a || b);
  }).join('');
}

/**
 * The changed lines of `to` against `from`, as markdown. Lines match on identical text or a
 * shared `Label:`; within a block of changes, a removed and an added line that are mostly
 * the same words are shown as one line marked word by word. A bullet or an unlabeled line
 * is preceded by the nearest line above it that names what it belongs to, and a gap of
 * unchanged lines is `…`.
 */
function renderDiff(fromLines, toLines) {
  const ops = lcs(fromLines, toLines, (x, y) => x === y || (labelOf(x) !== null && labelOf(x) === labelOf(y)));
  const out = [];
  let lastShown = -1; // index into toLines of the last line accounted for
  const show = (line, bi) => {
    if (bi > lastShown + 1 && out.length > 0) out.push('…');
    out.push(line);
    lastShown = Math.max(lastShown, bi);
  };
  // A line that only makes sense under a heading gets the heading first, once: a bullet
  // gets the labeled line its list hangs from, and an unlabeled line gets the labeled
  // line it directly continues, if it continues one.
  const context = (line, bi) => {
    if (labelOf(line) !== null && !isBullet(line)) return;
    for (let k = bi - 1; k > lastShown; k -= 1) {
      if (isBullet(toLines[k]) && isBullet(line)) continue;
      const label = labelOf(toLines[k]);
      if (label !== null && !FENCE_KEYS.has(label)) show(toLines[k], k);
      return;
    }
  };
  // Two lines sharing a label are one field changed: mark the value in place, unless one
  // side's value is empty, which means the field moved into a list below it.
  const field = (a, b) => {
    const ma = LABELED.exec(a); const mb = LABELED.exec(b);
    if (!ma || !mb || ma[1] !== mb[1]) return 'none';
    return ma[2] && mb[2] ? 'same' : 'reshaped';
  };
  const replace = (a, b, bi) => {
    context(b, bi);
    const f = field(a, b);
    if (f === 'same' || (f === 'none' && similarity(a, b) >= SAME_LINE)) show(inlineDiff(a, b), bi);
    else { show(strike(a), bi - 1); show(bold(b), bi); }
  };

  for (let i = 0; i < ops.length;) {
    const o = ops[i];
    if (o.op === '=') {
      if (o.a !== o.b) replace(o.a, o.b, o.bi);
      i += 1; continue;
    }
    // A block of removals and additions between two matched lines.
    const removed = []; const added = [];
    for (; i < ops.length && ops[i].op !== '='; i += 1) {
      (ops[i].op === '-' ? removed : added).push(ops[i]);
    }
    const pairs = new Map(); // added index -> removed op
    const used = new Set();
    added.forEach((ad, ai) => {
      const match = removed.find((r) => !used.has(r) && similarity(r.a, ad.b) >= SAME_LINE);
      if (match) { used.add(match); pairs.set(ai, match); }
    });
    const before = added.length ? added[0].bi : (removed[0] ? removed[0].bi : 0);
    for (const r of removed) {
      if (used.has(r)) continue;
      context(r.a, before);
      show(strike(r.a), before - 1);
    }
    added.forEach((ad, ai) => {
      if (pairs.has(ai)) { replace(pairs.get(ai).a, ad.b, ad.bi); return; }
      context(ad.b, ad.bi);
      show(bold(ad.b), ad.bi);
    });
  }
  return out;
}

// ── Versions, labels and lineage ────────────────────────────────────────────

/** The variant names an item def receives on a leaf, keeping only names it defines. */
function appliedVariants(itemDef, branchPath) {
  const always = itemDef.import ? itemDef.importVariants : itemDef._include_variants;
  const spec = itemDef.import ? itemDef.branches : (itemDef._include_branch_spec || itemDef.branches);
  const dispatched = resolveBranchSpec(spec, branchPath) || [];
  const names = [...(always ? parseVariantsList(always) : []), ...dispatched];
  // An include names its variants for every item in a file, and most items lack most names.
  if (itemDef.import) return names;
  return names.filter((name) => {
    const deltas = collectVariantDeltas(itemDef, name, null);
    return deltas === null || deltas.length > 0;
  });
}

function defsById(allItemDefs) {
  const out = new Map();
  for (const def of allItemDefs) {
    const id = def.id || (def.import ? splitRef(def.import).id : null)
      || (typeof def.name === 'string' ? def.name : null);
    if (id) out.set(String(id).toLowerCase(), def);
  }
  return out;
}

const isPrefix = (p, q) => p.length < q.length && p.every((n, i) => n === q[i]);
const expandPath = (name) => name.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));

function describeRoles(roles) {
  return Object.entries(roles).map(([k, v]) => `${k}: ${v}`).join(', ');
}

/** Roles bound on every leaf of this version but not on every leaf of the item. */
function distinguishingRoles(version, allLeaves) {
  const common = (leaves) => {
    const [first, ...rest] = leaves.map((l) => l.roles || {});
    return Object.fromEntries(Object.entries(first || {}).filter(([k, v]) => rest.every((r) => r[k] === v)));
  };
  const mine = common(version.leaves);
  const everyone = common(allLeaves);
  return Object.fromEntries(Object.entries(mine).filter(([k, v]) => everyone[k] !== v));
}

function measure(rendered, type) {
  const [card] = parseCards(rendered, { type });
  if (!card) return { size: 0, role: null };
  let role = null;
  const meta = card.meta && card.meta.meta;
  if (meta && typeof meta === 'object') {
    for (const v of Object.values(meta)) if (v && typeof v === 'object' && v.role) role = String(v.role);
  }
  return { size: (card.body || '').length, role };
}

function buildItemVariance(id, leafData, def) {
  const versions = [];
  const present = [];
  const absent = [];
  for (const leaf of leafData) {
    const entry = leaf.items && leaf.items.get(id);
    if (!entry) { absent.push(leaf.label); continue; }
    const variants = def ? appliedVariants(def, leaf.branchPath) : [];
    const record = { label: leaf.label, roles: leaf.roles || {}, variants };
    present.push(record);
    let v = versions.find((x) => x.rendered === entry.rendered);
    if (!v) {
      v = { rendered: entry.rendered, type: entry.type, leaves: [], ...measure(entry.rendered, entry.type) };
      versions.push(v);
    }
    v.leaves.push(record);
  }
  if (versions.length < 2 && absent.length === 0) return null;

  for (const v of versions) {
    // A version's variant chain is the shortest any of its leaves applied: a variant that
    // changed nothing on one leaf does not make the version depend on it. A nested path
    // applies its parents first, so `major/anchor` counts as `major` then `major/anchor`.
    v.variants = v.leaves.map((l) => l.variants.flatMap(expandPath))
      .sort((a, b) => a.length - b.length)[0];
    v.chains = [...new Set(v.leaves.map((l) => l.variants.join(' + ') || 'base'))];
    v.roles = distinguishingRoles(v, present);
    v.lines = cardLines(v.rendered);
    v.title = v.lines[0];
  }

  // The base prints in full: the version with the fewest variants, then the most leaves.
  versions.sort((a, b) => a.variants.length - b.variants.length
    || Object.keys(a.roles).length - Object.keys(b.roles).length
    || b.leaves.length - a.leaves.length);
  const [base] = versions;

  // Each other version diffs against the version whose chain is the longest prefix of its
  // own, or against an equal chain without its roles; failing both, against the base.
  for (const v of versions.slice(1)) {
    const candidates = versions.filter((u) => u !== v && (
      isPrefix(u.variants, v.variants)
      || (u.variants.join('\u0000') === v.variants.join('\u0000')
        && Object.keys(u.roles).length < Object.keys(v.roles).length)));
    candidates.sort((a, b) => b.variants.length - a.variants.length);
    v.parent = candidates[0] || base;
  }

  // Read in lineage order: each version directly after the one it builds on.
  const ordered = [];
  const visit = (v) => {
    ordered.push(v);
    versions.filter((u) => u.parent === v)
      .sort((a, b) => a.variants.length - b.variants.length || b.leaves.length - a.leaves.length)
      .forEach(visit);
  };
  visit(base);
  return { id, versions: ordered, absent, base };
}

function versionName(v) {
  const chain = v.chains.join(' = ');
  const roles = Object.keys(v.roles).length ? ` · ${describeRoles(v.roles)}` : '';
  return `${chain}${roles}`;
}

function renderItem({ id, versions, absent, base }) {
  const titles = [...new Set(versions.map((v) => v.title))];
  const lines = [`## ${titles.join(' / ')}`, ''];
  if (titles.length > 1) lines.push(`_one item, \`${id}\`, renamed by its variants_`, '');
  lines.push(`${versions.length} version${versions.length === 1 ? '' : 's'}`
    + `${absent.length ? `, absent on ${absent.length} branch${absent.length === 1 ? '' : 'es'}` : ''}.`, '');

  lines.push('| Version | Branches | Size |', '|---|---|---|');
  for (const v of versions) {
    const size = `${v.size}${v.role ? ` (${v.role})` : ''}`;
    lines.push(`| ${versionName(v)} | ${v.leaves.map((l) => l.label).join(', ')} | ${size} |`);
  }
  if (absent.length) lines.push(`| — | ${absent.join(', ')} | |`);
  lines.push('');

  lines.push(`### ${versionName(base)}`, '', ...base.lines, '');
  for (const v of versions.slice(1)) {
    const diff = renderDiff(v.parent.lines, v.lines);
    lines.push(`### ${versionName(v)}`, '', `_against ${versionName(v.parent)}_`, '');
    lines.push(...(diff.length ? diff : ['_identical text; differs only in the card fence_']), '');
  }
  return lines.join('\n');
}

function buildVarianceDoc(leafData, allItemDefs, title) {
  const defs = defsById(allItemDefs);
  const ids = [...new Set(leafData.flatMap((l) => (l.items ? [...l.items.keys()] : [])))].sort();
  const entries = [];
  const constant = [];
  for (const id of ids) {
    const entry = buildItemVariance(id, leafData, defs.get(id));
    if (entry) entries.push(entry); else constant.push(id);
  }
  entries.sort((a, b) => b.versions.length - a.versions.length || a.id.localeCompare(b.id));

  const head = [
    `# Variance: ${title}`,
    '',
    `_Every item whose story card differs between the ${leafData.length} branches, each`
      + ' distinct version once. The base prints in full; each other version shows only its'
      + ' changed lines against the version it builds on: ~~removed~~, **added**._',
    '',
    `${entries.length} item${entries.length === 1 ? '' : 's'} vary; `
      + `${constant.length} render the same on every branch.`,
    '',
  ];
  return [...head, ...entries.map(renderItem)].join('\n');
}

function runVarianceMode(leafData, allItemDefs, outputDir, title, fallbackName = title) {
  const identity = reportIdentity(title, fallbackName);
  const doc = buildVarianceDoc(leafData, allItemDefs, identity.label);
  const outPath = path.join(outputDir, `${identity.stem}.variance.md`);
  fs.writeFileSync(outPath, doc.trimEnd() + '\n', 'utf8');
  return { written: [outPath] };
}

module.exports = {
  runVarianceMode, buildVarianceDoc, renderDiff, inlineDiff, cardLines, appliedVariants,
};
