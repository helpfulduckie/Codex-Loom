'use strict';

/**
 * Check the YAML examples in documentation/NN-*.md against the live schema surfaces.
 *
 * Stage 1  extract every ```yaml block, with its file, line, heading and lead-in prose
 * Stage 2  parse it as YAML — a parse failure is either an illustrative block or a broken one
 * Stage 3  work out which schema level the fragment sits at, by intersecting the key index,
 *          then run the real validator (src/schema.js) at that level and report its codes
 *
 * Level detection is the interesting part: a doc block is usually a fragment with no
 * indication of its nesting. `buildKeyIndex` gives every path a key is legal at, so the
 * common parent of all the block's top-level keys is the level it must belong to.
 *
 * Usage: node scripts/check-doc-examples.js [file-substring ...]
 *
 * ── Status: a bootstrap, and half of it is meant to be deleted ─────────────────
 *
 * Written 2026-09-02 for the documentation audit (commits 76bc7dd, 49ca7ba), where it
 * cleared 104 of 128 blocks and found no unknown-key errors — while the audit's own
 * reading found ~25 real errors it could not have caught. **A schema check is a floor.**
 * It proves a documented key exists and is well-typed; it cannot catch a doc that
 * describes the wrong behavior, which is what most of the audit's findings were.
 *
 * The intended end state is a Jest test, with the inference in `candidateLevels` /
 * `FILE_SURFACE` / `headingPath` **deleted** and replaced by an annotation in the fence
 * info string:
 *
 *     ```yaml surface=config level=structure.input
 *
 * Inference was right for 104 blocks but it is a pile of heuristics — a hardcoded
 * file→surface table and heading-path scoring — and it will rot. Declaring the level
 * where the block lives is the same inference→declaration move §13 and §4.3 already made.
 * Bootstrap the annotations from what this prints, hand-check them once, then delete the
 * guessing and move this under `__tests__/`.
 *
 * ── Known work, as of 2026-09-02 ───────────────────────────────────────────────
 *
 *   7 YAML-FAIL   Documentation conventions that are not valid YAML, and so cannot be
 *                 tested: `# or` splitting two alternatives in one fence, and `...` used
 *                 as "other fields omitted" (it is YAML's own document-end token). The
 *                 `variants()` / `dedent()` helpers below undo them for checking, but the
 *                 blocks still cannot be pasted by a reader. Fixing the source — two
 *                 fences instead of `# or`, `# ...` instead of `...` — makes ~9 blocks
 *                 genuinely testable and is the other half of this task.
 *
 *   6 NO-LEVEL    `fields:` / `groups:` / `templates:` blocks. There is no schema surface
 *   4 ERR         wired up for `fields.cl.yaml` (its validation is inline in
 *                 `src/loader/field-table.js`, not an exported descriptor), so these fall
 *                 through to `structure.input.templates` and mis-report. Not doc errors —
 *                 every one was verified by hand. Wiring that surface, or annotating the
 *                 fences, removes all ten.
 *
 *   6 OPEN-NS     `body:` / `v:` / `metadata:` fragments. Open by design, never checkable.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const REPO = path.resolve(__dirname, '..');
const DOCS = path.join(REPO, 'documentation');
// Resolve as if from the repo, so both its own modules and its node_modules are visible.
const R = createRequire(path.join(REPO, 'package.json'));

const yaml = R('js-yaml');
const { validate, buildKeyIndex } = R('./src/schema.js');
const { CONFIG_SCHEMA } = R('./src/config/schema.js');
const { ITEM_SCHEMA } = R('./src/loader/schema.js');
const { COMPONENT_SCHEMA } = R('./src/loader/component-schema.js');
const { Diagnostics } = R('./src/diag.js');

const SURFACES = {
  config: { schema: CONFIG_SCHEMA, index: buildKeyIndex(CONFIG_SCHEMA) },
  item: { schema: ITEM_SCHEMA, index: buildKeyIndex(ITEM_SCHEMA) },
  component: { schema: COMPONENT_SCHEMA, index: buildKeyIndex(COMPONENT_SCHEMA) },
};

/**
 * Which surface a file's examples default to. `render:` and `branches:` exist on more than
 * one surface with different shapes, so the containing document is a stronger signal than
 * the block's own keys — 05's `branches:` is an item's, 02's is a branch node's.
 */
const FILE_SURFACE = {
  '02-compile-yaml': ['config', 'item', 'component'],
  '03-item-yaml': ['item', 'config', 'component'],
  '04-imports-and-includes': ['item', 'component', 'config'],
  '05-branches-and-variants': ['item', 'config', 'component'],
  '06-field-operations': ['item', 'config', 'component'],
  '09-components': ['component', 'config', 'item'],
  '10-field-declarations': ['config', 'item', 'component'],
  '13-roles': ['config', 'item', 'component'],
  '15-context-tiering': ['config', 'item', 'component'],
};
const DEFAULT_ORDER = ['config', 'item', 'component'];

/** Open namespaces accept arbitrary keys by design, so a fragment of one is not checkable. */
const OPEN_NAMESPACES = new Set(['body', 'notes', 'v', 'metadata', 'variables', 'roles']);

// ── Stage 1: extract ────────────────────────────────────────────────────────────

function extract(file) {
  const text = fs.readFileSync(path.join(DOCS, file), 'utf8');
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let heading = '(top)';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const h = line.match(/^(#{2,4})\s+(.*)$/);
    if (h) heading = h[2].trim();

    if (/^```ya?ml\s*$/.test(line)) {
      const start = i + 1;
      let j = start;
      while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;
      // two most recent non-empty, non-fence lines above the block
      const lead = [];
      for (let k = i - 1; k >= 0 && lead.length < 2; k--) {
        const t = lines[k].trim();
        if (!t || t.startsWith('```')) continue;
        lead.unshift(t);
      }
      blocks.push({
        file, heading, line: start,
        body: lines.slice(start, j).join('\n'),
        lead: lead.join(' / ').slice(0, 160),
      });
      i = j + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

// ── Stage 2a: doc conventions ───────────────────────────────────────────────────

/**
 * Three conventions in these docs make a block invalid YAML on purpose. None is an error;
 * all three have to be undone before the block can be checked.
 *
 *   `# or`   two alternative spellings in one fence  → split into separate examples
 *   `---`    two files in one fence                  → split
 *   `...`    "other fields omitted"                  → drop the line (it is YAML's own
 *            document-end token, which is why it breaks the parse)
 */
function variants(body) {
  const parts = body.split(/^\s*(?:#+\s*or\b.*|---)\s*$/gm);
  return parts
    .map((p) => p.split('\n').filter((l) => !/^\s*\.\.\.\s*$/.test(l)).join('\n'))
    .map(dedent)
    .map((p) => p.replace(/^\s*\n|\n\s*$/g, ''))
    .filter((p) => p.trim());
}

/**
 * A fragment shown in context is uniformly indented — `  cast:` under an implied
 * `sections:`. That is a top-level mapping starting off column 0, which YAML rejects, so
 * strip the common leading indent before parsing.
 */
function dedent(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return text;
  const min = Math.min(...lines.map((l) => l.match(/^ */)[0].length));
  if (!min) return text;
  return text.split('\n').map((l) => l.slice(min)).join('\n');
}

// ── Stage 3: level detection ────────────────────────────────────────────────────

/** A backticked dotted path in a heading — `structure.input.items` — if there is one. */
function headingPath(heading) {
  const m = heading.match(/`([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)`?/);
  return m ? m[1].replace(/[.:]$/, '') : null;
}

/**
 * Parent levels at which every one of `keys` is simultaneously legal.
 *
 * Ties are common and the shallowest is usually wrong: `library:` is legal both under
 * `scripts:` (a VL hook name) and under `structure.input`. The heading disambiguates,
 * because these docs head each key's section with its own dotted path.
 */
function candidateLevels(keys, index, heading) {
  let common = null;
  for (const k of keys) {
    const paths = index.get(k);
    if (!paths) return { levels: [], unknown: k };
    const parents = new Set(paths.map((p) => p.split('.').slice(0, -1).join('.')));
    if (common === null) common = parents;
    else common = new Set([...common].filter((p) => parents.has(p)));
    if (common.size === 0) break;
  }
  const hp = headingPath(heading || '');
  const score = (lvl) => {
    if (!hp) return 0;
    // The heading names the key itself; its parent is the level the block sits at.
    const parent = hp.split('.').slice(0, -1).join('.');
    if (lvl === parent) return 3;
    if (lvl === hp) return 2;
    if (hp.startsWith(lvl) && lvl) return 1;
    return 0;
  };
  const levels = [...(common || [])].sort(
    (a, b) => score(b) - score(a) || a.split('.').length - b.split('.').length,
  );
  return { levels, unknown: null };
}

/** Required-key complaints are meaningless against a fragment that shows one key. */
const FRAGMENT_NOISE = new Set(['CL0203']);

/** Walk a schema down a dotted level path, following record/seq `of` for `*` and `[]`. */
function descend(schema, level) {
  if (!level) return schema;
  let node = schema;
  for (const seg of level.split('.')) {
    if (!node) return null;
    if (seg === '*' || seg === '[]') { node = node.of; continue; }
    node = node.keys ? node.keys[seg] : null;
  }
  return node;
}

// ── Drive ───────────────────────────────────────────────────────────────────────

const filter = process.argv.slice(2);
const files = fs.readdirSync(DOCS)
  .filter((f) => /^\d\d-.*\.md$/.test(f))
  .filter((f) => !filter.length || filter.some((s) => f.includes(s)))
  .sort();

const results = [];

for (const file of files) {
  for (const block of extract(file)) {
   const pieces = variants(block.body);
   pieces.forEach((piece, pi) => {
    const rec = {
      ...block, status: null, detail: '',
      tag: pieces.length > 1 ? `${block.line} (alt ${pi + 1}/${pieces.length})` : String(block.line),
    };

    let doc;
    try {
      doc = yaml.load(piece);
    } catch (e) {
      rec.status = 'YAML-FAIL';
      rec.detail = e.message.split('\n')[0];
      results.push(rec);
      return;
    }

    if (doc === null || doc === undefined) {
      rec.status = 'EMPTY';
      results.push(rec);
      return;
    }

    const keep = (diags) => diags.all.filter((d) => !FRAGMENT_NOISE.has(d.code));
    const verdict = (kept, okTag) => {
      if (kept.some((d) => d.severity === 'error')) return okTag === 'ITEM-OK' ? 'ITEM-ERR' : 'ERR';
      if (kept.length) return okTag === 'ITEM-OK' ? 'ITEM-WARN' : 'WARN';
      return okTag;
    };

    // A sequence is an item file; validate each element against the item surface.
    if (Array.isArray(doc)) {
      const diags = new Diagnostics();
      doc.forEach((it, n) => {
        if (it && typeof it === 'object') {
          validate(it, ITEM_SCHEMA, { diagnostics: diags, path: [String(n)], displayOffset: 1 });
        }
      });
      const kept = keep(diags);
      rec.status = verdict(kept, 'ITEM-OK');
      rec.surface = 'item';
      rec.detail = kept.map((d) => `${d.code} ${d.message}`).join(' | ');
      results.push(rec);
      return;
    }

    if (typeof doc !== 'object') {
      rec.status = 'SCALAR';
      results.push(rec);
      return;
    }

    const keys = Object.keys(doc);

    // A fragment of an open namespace declares its own keys; nothing can validate it.
    const hp0 = headingPath(block.heading || '');
    if (hp0 && OPEN_NAMESPACES.has(hp0.split('.').pop())) {
      rec.status = 'OPEN-NS';
      rec.detail = `fragment of open namespace "${hp0}"`;
      results.push(rec);
      return;
    }

    const order = FILE_SURFACE[file.replace(/\.md$/, '')] || DEFAULT_ORDER;
    let schema = null; let level = null; let surface = null; let firstUnknown = null;
    for (const name of order) {
      const { index, schema: s } = SURFACES[name];
      const c = candidateLevels(keys, index, block.heading);
      if (firstUnknown === null) firstUnknown = c.unknown;
      if (c.levels.length) { schema = s; level = c.levels[0]; surface = name; break; }
    }

    if (!schema) {
      rec.status = 'NO-LEVEL';
      rec.detail = `keys [${keys.join(', ')}] fit no level in any surface`
        + (firstUnknown ? `; first unplaceable: "${firstUnknown}"` : '');
      results.push(rec);
      return;
    }

    const node = descend(schema, level);
    if (!node) {
      rec.status = 'NO-NODE';
      rec.detail = `level "${level}" did not resolve`;
      results.push(rec);
      return;
    }

    const diags = new Diagnostics();
    validate(doc, node, { diagnostics: diags });
    const kept = keep(diags);
    rec.status = verdict(kept, 'OK');
    rec.surface = surface;
    rec.level = level || '(root)';
    rec.detail = kept.map((d) => `${d.code} ${d.message}`).join(' | ');
    results.push(rec);
   });
  }
}

// ── Report ──────────────────────────────────────────────────────────────────────

const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

console.log('=== summary ===');
console.log(`${results.length} yaml blocks across ${files.length} files`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}

const interesting = results.filter(
  (r) => !['OK', 'ITEM-OK', 'EMPTY', 'SCALAR', 'OPEN-NS'].includes(r.status),
);
console.log(`\n=== ${interesting.length} blocks needing a look ===`);
for (const r of interesting) {
  console.log(`\n${r.file}:${r.tag || r.line}  [${r.status}]  §${r.heading}`);
  if (r.level) console.log(`  level: ${r.surface}:${r.level}`);
  console.log(`  lead:  ${r.lead}`);
  if (r.detail) console.log(`  ${r.detail}`);
}
