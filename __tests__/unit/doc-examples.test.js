'use strict';

/**
 * Every ```yaml block in documentation/NN-*.md is checked against a live schema surface.
 *
 * This began as `scripts/check-doc-examples.js`, which *inferred* each block's surface from
 * a hardcoded file→surface table plus heading-path scoring. The inference was right for
 * ~104 of 128 blocks, but a file→surface table rots the moment a chapter is reorganized.
 * So the surface is now *declared* in the fence info string — the same inference→declaration
 * move §13 (field tables) and §4.3 (the schema engine) already made:
 *
 *     ```yaml surface=config level=structure.input
 *     ```yaml surface=item
 *     ```yaml surface=component
 *     ```yaml surface=fieldtable
 *     ```yaml check=none reason=<why>
 *
 * `surface=` picks the schema; `level=` (config only) walks it down a dotted path before
 * validating, so a fragment shown under `### structure.input.items` is checked at that
 * node rather than at the config root. `check=none` opts a block out — an illustrative
 * fragment, pseudo-YAML with `<placeholders>`, or a v3 shape with no v4 surface.
 *
 * ── What this catches, and what it does not ─────────────────────────────────────
 *
 * A schema check is a floor. It proves a documented key exists and is well-typed; it
 * cannot catch a doc that describes the wrong *behavior*. The mechanism-drift guards are
 * `tier-wellformed.js` and `golden.test.js`, which render and compare. This one only
 * stops a chapter from naming a key the compiler removed.
 *
 * Precedent for a doc-binding test: `diag.test.js`'s "REGISTRY agrees with
 * documentation/11-diagnostics.md" block.
 */

const fs = require('fs');
const path = require('path');

const { validate } = require('../../src/schema');
const { CONFIG_SCHEMA } = require('../../src/config/schema');
const { ITEM_SCHEMA } = require('../../src/loader/schema');
const { COMPONENT_SCHEMA } = require('../../src/loader/component-schema');
const { FIELD_TABLE_SCHEMA } = require('../../src/loader/field-table-schema');
const { Diagnostics } = require('../../src/diag');
const { parseYaml } = require('../../src/loader/yaml');

const DOCS = path.join(__dirname, '../../documentation');

const SURFACE_SCHEMA = {
  config: CONFIG_SCHEMA,
  item: ITEM_SCHEMA,
  component: COMPONENT_SCHEMA,
  fieldtable: FIELD_TABLE_SCHEMA,
};

/** Required-key complaints are meaningless against a fragment that shows one key. */
const NOISE = new Set(['CL0203']);

/** Walk a schema down a dotted level path, following record/seq `of` for `*` and `[]`. */
function descend(schema, level) {
  if (!level || level === '(root)') return schema;
  let node = schema;
  for (const seg of level.split('.')) {
    if (!node) return null;
    if (seg === '*' || seg === '[]') { node = node.of; continue; }
    node = node.keys ? node.keys[seg] : null;
  }
  return node;
}

function parseInfo(info) {
  const out = {};
  for (const tok of info.split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf('=');
    if (eq === -1) out[tok] = true;
    else out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

function extractBlocks(file) {
  const lines = fs.readFileSync(path.join(DOCS, file), 'utf8').split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^```ya?ml(?:\s+(.*?))?\s*$/);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;
    blocks.push({
      file,
      line: i + 1,
      info: (m[1] || '').trim(),
      body: lines.slice(i + 1, j).join('\n'),
    });
    i = j;
  }
  return blocks;
}

const files = fs.readdirSync(DOCS).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
const blocks = files.flatMap(extractBlocks);

describe('every documentation YAML block declares its surface', () => {
  // The annotation is itself a surface that can drift: a new block added with a bare
  // ```yaml fence, or a typo in `surface=`, is caught here rather than silently skipped.
  test('at least one block was found', () => {
    expect(blocks.length).toBeGreaterThan(100);
  });

  test.each(blocks.map((b) => [`${b.file}:${b.line}`, b]))('%s', (_label, b) => {
    const ann = parseInfo(b.info);
    const declared = Boolean(ann.surface) || ann.check === 'none';
    expect({ block: `${b.file}:${b.line}`, declared, info: b.info })
      .toEqual({ block: `${b.file}:${b.line}`, declared: true, info: b.info });
    if (ann.surface) expect(Object.keys(SURFACE_SCHEMA)).toContain(ann.surface);
    if (ann.check === 'none') expect(ann.reason).toBeTruthy();
  });
});

describe('documentation YAML validates against its declared surface', () => {
  const checkable = blocks.filter((b) => parseInfo(b.info).surface);

  test.each(checkable.map((b) => [`${b.file}:${b.line}`, b]))('%s', (_label, b) => {
    const ann = parseInfo(b.info);
    const where = `surface=${ann.surface}${ann.level ? ` level=${ann.level}` : ''}`;

    let doc;
    try {
      doc = parseYaml(b.body, `${b.file}:${b.line}`).value;
    } catch (e) {
      throw new Error(
        `${b.file}:${b.line} is annotated ${where} but does not parse as YAML: ${e.message}\n`
        + 'If the block is illustrative, annotate it `check=none reason=…` instead.',
      );
    }
    if (doc === undefined || doc === null) return;

    const diags = new Diagnostics();

    if (ann.surface === 'item') {
      const items = Array.isArray(doc) ? doc : [doc];
      items.forEach((it, n) => {
        if (it && typeof it === 'object' && !Array.isArray(it)) {
          validate(it, ITEM_SCHEMA, { diagnostics: diags, path: [String(n)], displayOffset: 1 });
        }
      });
    } else {
      const node = descend(SURFACE_SCHEMA[ann.surface], ann.level);
      if (!node) throw new Error(`${b.file}:${b.line}: level "${ann.level}" does not resolve in the ${ann.surface} surface`);
      validate(doc, node, { diagnostics: diags });
    }

    const errors = diags.all.filter((d) => d.severity === 'error' && !NOISE.has(d.code));
    if (errors.length) {
      throw new Error(
        `${b.file}:${b.line} (${where}) fails schema validation:\n  `
        + errors.map((d) => `${d.code} ${d.message}`).join('\n  ')
        + '\nEither the doc names a key the compiler removed, or the annotation is wrong.',
      );
    }
  });
});
