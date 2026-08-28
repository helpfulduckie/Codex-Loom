'use strict';

/**
 * `scripts/rebaseline.js` — the `Scripts/` relocation guard (Phase 12 Step 6).
 *
 * `diffTree` re-baselines markdown by content. Phase 12 Step 6 lifts a project's shipped
 * `Scripts/*.js` root-ward, so the tool has to recognize a non-`.md` file that left one
 * path and reappeared byte-identically at another as *moved* — re-baselined by relocating
 * it, not re-contenting it. The stop condition is the refusal: a `.js` whose bytes changed,
 * or one with no byte-identical counterpart, must classify OPAQUE so the run aborts.
 *
 * These drive `diffTree` directly against two hand-built trees — the "actual" (freshly
 * compiled) and "expected" (committed baseline) dirs it normally gets from a temp compile.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { diffTree } = require('../../scripts/rebaseline');
const { OPAQUE } = require('../helpers/diffShape');

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Build a tree from `{ relPath: contents }` and return its root. */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-rebaseline-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const LIB = 'exports.shared = 1;\n// a fairly long line to make a byte flip unambiguous\n';

test('a per-leaf script lifted to the root is reported as relocated, not changed', () => {
  const expected = tree({
    'Label.md': '# Root\n',
    'Branches/a/Scripts/library.js': LIB,
    'Branches/b/Scripts/library.js': LIB,
  });
  const actual = tree({
    'Label.md': '# Root\n',
    'Scripts/library.js': LIB,
  });

  const report = diffTree(actual, expected, { markdownOnly: true });

  expect(report.relocated).toHaveLength(1);
  expect(report.relocated[0].to).toBe('Scripts/library.js');
  expect(report.relocated[0].from.sort()).toEqual([
    'Branches/a/Scripts/library.js',
    'Branches/b/Scripts/library.js',
  ]);
  expect(report.removed).toEqual([]);
  expect(report.added).toEqual([]);
  expect([...report.classes]).toEqual([]);
});

test('a one-byte change to a lifted script aborts — no relocation, OPAQUE class', () => {
  const expected = tree({
    'Branches/a/Scripts/library.js': LIB,
    'Branches/b/Scripts/library.js': LIB,
  });
  const actual = tree({
    'Scripts/library.js': LIB.replace('shared = 1', 'shared = 2'),
  });

  const report = diffTree(actual, expected, { markdownOnly: true });

  expect(report.relocated).toEqual([]);
  expect([...report.classes]).toContain(OPAQUE);
});

test('a script edited in place (same path, changed bytes) still aborts', () => {
  const expected = tree({ 'Scripts/library.js': LIB });
  const actual = tree({ 'Scripts/library.js': LIB.replace('shared = 1', 'shared = 9') });

  const report = diffTree(actual, expected, { markdownOnly: true });

  expect([...report.classes]).toContain(OPAQUE);
});

test('a script that vanishes with no counterpart aborts', () => {
  const expected = tree({ 'Branches/a/Scripts/library.js': LIB });
  const actual = tree({ 'Label.md': '# only markdown now\n' });

  const report = diffTree(actual, expected, { markdownOnly: true });

  expect(report.relocated).toEqual([]);
  expect([...report.classes]).toContain(OPAQUE);
});

test('identical trees produce no relocation and no diff class', () => {
  const files = { 'Label.md': '# Root\n', 'Scripts/library.js': LIB };
  const report = diffTree(tree(files), tree(files), { markdownOnly: true });

  expect(report.relocated).toEqual([]);
  expect(report.changed).toEqual([]);
  expect([...report.classes]).toEqual([]);
});
