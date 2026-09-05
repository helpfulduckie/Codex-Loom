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

const { OPAQUE } = require('../helpers/diffShape');
const { withTmpDir, writeTree } = require('../helpers/project');

// `diffTree` needs no fixture, and requiring the script has no side effects: the set is
// loaded only under `require.main === module`, so this suite runs on every checkout.
const { diffTree } = require('../../scripts/rebaseline');

/** Build a tree from `{ relPath: contents }` and return its root. */
function tree(files) {
  return writeTree(withTmpDir(), files);
}

const LIB = 'exports.shared = 1;\n// a fairly long line to make a byte flip unambiguous\n';

describe('diffTree — the Scripts/ relocation guard', () => {
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
});

/**
 * `Placeholders.yaml` is non-`.md` but is derived, deterministic compiler output. It must
 * route into `report.derived` — not be dropped by the `.md`-only write filter (which left a
 * first-seed baseline one file short) and not classify OPAQUE on a legitimate change.
 */
const PH = 'heroName: What should we call you?\n';

describe('diffTree — Placeholders.yaml is derived output', () => {
  test('a first-seed Placeholders.yaml is routed to derived, not left in added', () => {
    const expected = tree({ 'Label.md': '# Root\n' });
    const actual = tree({ 'Label.md': '# Root\n', 'Placeholders.yaml': PH });

    const report = diffTree(actual, expected, { markdownOnly: true });

    expect(report.derived).toEqual([{ rel: 'Placeholders.yaml', kind: 'write' }]);
    expect(report.added).toEqual([]);
    expect([...report.classes]).toEqual([]);
  });

  test('a changed Placeholders.yaml is derived, not OPAQUE or changed', () => {
    const expected = tree({ 'Placeholders.yaml': PH });
    const actual = tree({ 'Placeholders.yaml': `${PH}house: Which wing?\n` });

    const report = diffTree(actual, expected, { markdownOnly: true });

    expect(report.derived).toEqual([{ rel: 'Placeholders.yaml', kind: 'write' }]);
    expect(report.changed).toEqual([]);
    expect([...report.classes]).toEqual([]);
  });

  test('a per-branch Placeholders.yaml is matched by basename', () => {
    const expected = tree({ 'Label.md': '# Root\n' });
    const actual = tree({ 'Label.md': '# Root\n', 'Branches/knight/Placeholders.yaml': 'oath: Which oath?\n' });

    const report = diffTree(actual, expected, { markdownOnly: true });

    expect(report.derived).toEqual([{ rel: 'Branches/knight/Placeholders.yaml', kind: 'write' }]);
    expect(report.added).toEqual([]);
  });

  test('a stale Placeholders.yaml gone from the compile is a derived removal', () => {
    const expected = tree({ 'Label.md': '# Root\n', 'Placeholders.yaml': PH });
    const actual = tree({ 'Label.md': '# Root\n' });

    const report = diffTree(actual, expected, { markdownOnly: true });

    expect(report.derived).toEqual([{ rel: 'Placeholders.yaml', kind: 'remove' }]);
    expect(report.removed).toEqual([]);
  });

  test('an identical Placeholders.yaml produces no derived entry', () => {
    const files = { 'Label.md': '# Root\n', 'Placeholders.yaml': PH };
    const report = diffTree(tree(files), tree(files), { markdownOnly: true });

    expect(report.derived).toEqual([]);
    expect([...report.classes]).toEqual([]);
  });

  test('a changed Scripts/*.js still aborts even with a derived Placeholders.yaml alongside', () => {
    const expected = tree({ 'Scripts/library.js': LIB, 'Placeholders.yaml': PH });
    const actual = tree({
      'Scripts/library.js': LIB.replace('shared = 1', 'shared = 7'),
      'Placeholders.yaml': `${PH}house: Which wing?\n`,
    });

    const report = diffTree(actual, expected, { markdownOnly: true });

    expect(report.derived).toEqual([{ rel: 'Placeholders.yaml', kind: 'write' }]);
    expect([...report.classes]).toContain(OPAQUE);
  });
});
