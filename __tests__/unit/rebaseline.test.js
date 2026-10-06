'use strict';

const fs = require('fs');
const path = require('path');

// These compare fresh output with committed baseline trees without compiling a fixture.

const { OPAQUE } = require('../helpers/diffShape');
const { withTmpDir, writeTree } = require('../helpers/project');

// `diffTree` needs no fixture, and requiring the script has no side effects: the set is
// loaded only under `require.main === module`, so this suite runs on every checkout.
const { diffTree, writeBaselines } = require('../../scripts/rebaseline');
const { listFilesRelative } = require('../../src/util');

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

describe('diffTree — path casing is structural', () => {
  const cases = [
    ['filename', 'Label.md', 'label.md'],
    ['directory', 'Branches/knight/Label.md', 'branches/knight/Label.md'],
  ];

  test.each(cases)('reports a %s case rename with identical bytes in both modes', (_name, expectedPath, actualPath) => {
    for (const markdownOnly of [true, false]) {
      const expected = tree({ [expectedPath]: '# same\n' });
      const actual = tree({ [actualPath]: '# same\n' });
      const report = diffTree(actual, expected, { markdownOnly });

      expect(report.caseRenames).toEqual([{ from: expectedPath, to: actualPath }]);
      expect(report.caseCollisions).toEqual([]);
    }
  });

  test.each(cases)('reports a %s case rename when bytes also change in both modes', (_name, expectedPath, actualPath) => {
    for (const markdownOnly of [true, false]) {
      const expected = tree({ [expectedPath]: '# old\n' });
      const actual = tree({ [actualPath]: '# new\n' });
      const report = diffTree(actual, expected, { markdownOnly });

      expect(report.caseRenames).toEqual([{ from: expectedPath, to: actualPath }]);
    }
  });

  test('reports Scripts path casing even when script classification runs', () => {
    const expected = tree({ 'Branches/a/Scripts/library.js': LIB });
    const actual = tree({ 'branches/a/Scripts/library.js': LIB });
    const report = diffTree(actual, expected, { markdownOnly: true });

    expect(report.caseRenames).toEqual([{
      from: 'Branches/a/Scripts/library.js', to: 'branches/a/Scripts/library.js',
    }]);
    expect(report.relocated).toEqual([{
      from: ['Branches/a/Scripts/library.js'], to: 'branches/a/Scripts/library.js',
    }]);
  });

  test('reports Placeholders directory casing even when derived classification runs', () => {
    const expected = tree({ 'Branches/a/Placeholders.yaml': PH });
    const actual = tree({ 'branches/a/Placeholders.yaml': PH });
    const report = diffTree(actual, expected, { markdownOnly: true });

    expect(report.caseRenames).toEqual([{
      from: 'Branches/a/Placeholders.yaml', to: 'branches/a/Placeholders.yaml',
    }]);
  });

  test('same spelling and content is not reported as a case change', () => {
    const files = { 'Branches/a/Label.md': '# same\n' };
    const report = diffTree(tree(files), tree(files), { markdownOnly: true });

    expect(report.caseRenames).toEqual([]);
    expect(report.caseCollisions).toEqual([]);
  });
});

function snapshotTree(root) {
  return listFilesRelative(root).map((rel) => [rel, fs.readFileSync(path.join(root, ...rel.split('/')))]);
}

describe('writeBaselines — casing preflight', () => {
  function fixture() {
    const root = withTmpDir();
    const tmpDir = withTmpDir();
    const baseline = path.join(root, 'project', 'baseline');
    const output = path.join(tmpDir, 'project', 'output');
    const reportFrom = path.join(tmpDir, 'project', 'reports', 'first');
    const reportTo = path.join(root, 'project', 'reports', 'first');
    const laterFrom = path.join(tmpDir, 'project', 'reports', 'later');
    const laterTo = path.join(root, 'project', 'reports', 'later');
    writeTree(baseline, {
      'Edited.md': '# old\n', 'Removed.md': '# remove\n', 'Placeholders.yaml': PH,
    });
    writeTree(output, {
      'Edited.md': '# new\n', 'Added.md': '# add\n', 'Placeholders.yaml': `${PH}house: Which wing?\n`,
    });
    writeTree(reportFrom, { 'stable.md': '# stable\n' });
    writeTree(reportTo, { 'stable.md': '# stable\n' });
    writeTree(laterFrom, { 'Case.md': '# report\n' });
    writeTree(laterTo, { 'case.md': '# report\n' });
    const reportDiff = diffTree(laterFrom, laterTo, { markdownOnly: false });
    const results = [{
      project: { name: 'fixture', dir: 'project' },
      output: diffTree(output, baseline, { markdownOnly: true }),
      reports: [
        { label: 'first', from: reportFrom, to: reportTo, diff: diffTree(reportFrom, reportTo, { markdownOnly: false }) },
        { label: 'later', from: laterFrom, to: laterTo, diff: reportDiff },
      ],
    }];
    return { root, tmpDir, baseline, results };
  }

  test('blocks earlier valid output writes when a later report unit changes case', () => {
    const { root, tmpDir, baseline, results } = fixture();
    const before = snapshotTree(root);

    expect(results[0].reports[1].diff.caseRenames).toEqual([{ from: 'case.md', to: 'Case.md' }]);
    expect(() => writeBaselines(results, {
      root, OUTPUT_SUBDIR: 'output', BASELINE_SUBDIR: 'baseline',
    }, tmpDir)).toThrow(/case\.md → Case\.md/);
    expect(snapshotTree(root)).toEqual(before);
    expect(fs.existsSync(path.join(baseline, 'Added.md'))).toBe(false);
  });

  test('blocks output writes when output itself changes path case', () => {
    const { root, tmpDir, baseline, results } = fixture();
    const outputRoot = path.join(tmpDir, 'project', 'output');
    fs.renameSync(path.join(outputRoot, 'Edited.md'), path.join(outputRoot, 'edited.md'));
    results[0].output = diffTree(outputRoot, baseline, { markdownOnly: true });
    results[0].reports.pop();
    results[0].reports.pop();
    const before = snapshotTree(root);

    expect(results[0].output.caseRenames).toEqual([{ from: 'Edited.md', to: 'edited.md' }]);
    expect(() => writeBaselines(results, {
      root, OUTPUT_SUBDIR: 'output', BASELINE_SUBDIR: 'baseline',
    }, tmpDir)).toThrow(/Edited\.md → edited\.md/);
    expect(snapshotTree(root)).toEqual(before);
  });

  test('a later project case change blocks every earlier project mutation', () => {
    const { root, tmpDir, results } = fixture();
    results[0].reports.pop();
    const laterBaseline = path.join(root, 'later-project', 'baseline');
    const laterOutput = path.join(tmpDir, 'later-project', 'output');
    writeTree(laterBaseline, { 'Character.md': '# old\n' });
    writeTree(laterOutput, { 'character.md': '# new\n' });
    results.push({
      project: { name: 'later fixture', dir: 'later-project' },
      output: diffTree(laterOutput, laterBaseline, { markdownOnly: true }),
      reports: [],
    });
    const before = snapshotTree(root);

    expect(() => writeBaselines(results, {
      root, OUTPUT_SUBDIR: 'output', BASELINE_SUBDIR: 'baseline',
    }, tmpDir)).toThrow(/Character\.md → character\.md/);
    expect(snapshotTree(root)).toEqual(before);
  });

  test('blocks ambiguous folded paths and reports every original spelling', () => {
    const root = withTmpDir();
    const tmpDir = withTmpDir();
    const actualRoot = path.join(tmpDir, 'actual');
    const expectedRoot = path.join(root, 'baseline');
    fs.mkdirSync(actualRoot, { recursive: true });
    fs.mkdirSync(expectedRoot, { recursive: true });
    fs.writeFileSync(path.join(actualRoot, 'a.md'), '# actual\n');
    fs.writeFileSync(path.join(expectedRoot, 'a.md'), '# expected\n');
    const listings = new Map([
      [actualRoot, ['A.md', 'a.md']],
      [expectedRoot, ['a.md']],
    ]);
    let guardedScript;
    jest.resetModules();
    jest.doMock('../../src/util', () => ({
      ...jest.requireActual('../../src/util'),
      listFilesRelative: (dir) => listings.get(dir) || jest.requireActual('../../src/util').listFilesRelative(dir),
    }));
    try {
      jest.isolateModules(() => {
        guardedScript = require('../../scripts/rebaseline');
      });
    } finally {
      jest.dontMock('../../src/util');
    }

    const report = guardedScript.diffTree(actualRoot, expectedRoot, { markdownOnly: false });
    expect(report.caseRenames).toEqual([]);
    expect(report.caseCollisions).toEqual([{ key: 'a.md', actual: ['A.md', 'a.md'], expected: ['a.md'] }]);
    const before = snapshotTree(root);
    expect(() => guardedScript.writeBaselines([{
      project: { name: 'fixture', dir: 'project' }, output: report, reports: [],
    }], { root, OUTPUT_SUBDIR: 'output', BASELINE_SUBDIR: 'baseline' }, tmpDir))
      .toThrow(/actual: A\.md, a\.md; expected: a\.md/);
    expect(snapshotTree(root)).toEqual(before);
  });

  test('writes ordinary output and report diffs when no case changes exist', () => {
    const { root, tmpDir, baseline, results } = fixture();
    fs.rmSync(path.join(tmpDir, 'project', 'reports', 'later', 'Case.md'));
    fs.writeFileSync(path.join(tmpDir, 'project', 'reports', 'later', 'case.md'), '# changed report\n');
    fs.writeFileSync(path.join(root, 'project', 'reports', 'later', 'case.md'), '# old report\n');
    results[0].reports[1].diff = diffTree(results[0].reports[1].from, results[0].reports[1].to, { markdownOnly: false });

    writeBaselines(results, { root, OUTPUT_SUBDIR: 'output', BASELINE_SUBDIR: 'baseline' }, tmpDir);

    expect(fs.readFileSync(path.join(baseline, 'Edited.md'), 'utf8')).toBe('# new\n');
    expect(fs.readFileSync(path.join(baseline, 'Added.md'), 'utf8')).toBe('# add\n');
    expect(fs.readFileSync(path.join(baseline, 'Placeholders.yaml'), 'utf8')).toBe(`${PH}house: Which wing?\n`);
    expect(fs.existsSync(path.join(baseline, 'Removed.md'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'project', 'reports', 'later', 'case.md'), 'utf8')).toBe('# changed report\n');
  });
});
