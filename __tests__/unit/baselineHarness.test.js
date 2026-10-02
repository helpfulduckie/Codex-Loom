'use strict';

const fs = require('fs');
const path = require('path');

const { withTmpDir, writeTree } = require('../helpers/project');
const { prepareTempTree } = require('../helpers/baselineHarness');
const { listFilesRelative } = require('../../src/util');

describe('prepareTempTree', () => {
  let roots = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots = [];
  });

  test('retains source bytes and directories while excluding generated trees', () => {
    const root = withTmpDir();
    writeTree(root, {
      'Baseline/Baseline/Loom/compile.yaml': 'v3 config\n',
      'Baseline/Baseline/v4/compile.cl.yaml': 'v4 config\n',
      'Baseline/Baseline/v4/items/person.yaml': 'item source\n',
      'Baseline/Baseline/v4/templates/default.md': 'template source\n',
      'Baseline/shared-library/cards/shared.yaml': 'shared source\n',
      'Baseline/Baseline/Scripts/source.js': 'authored source\n',
      'Baseline/Baseline/Velvet Lattice/nested/stale.md': 'stale output\n',
      'Baseline/Baseline/Velvet Lattice/Scripts/stale.js': 'stale output script\n',
      'Baseline/Baseline/v3/nested/stale.md': 'stale baseline\n',
      'Baseline/Baseline/v3/Scripts/stale.js': 'stale baseline script\n',
      'Baseline/Baseline/v3-reports/nested/stale.md': 'stale report\n',
      'Baseline/Baseline/v3-reports/Scripts/stale.js': 'stale report script\n',
    });
    fs.mkdirSync(path.join(root, 'Baseline', 'empty-source-dir'), { recursive: true });

    const tempRoot = prepareTempTree({
      root,
      OUTPUT_SUBDIR: 'Velvet Lattice',
      BASELINE_SUBDIR: 'v3',
      REPORTS_SUBDIR: 'v3-reports',
    }, 'codex-loom-migrate-');
    roots.push(tempRoot);

    const retained = [
      'Baseline/Baseline/Loom/compile.yaml',
      'Baseline/Baseline/v4/compile.cl.yaml',
      'Baseline/Baseline/v4/items/person.yaml',
      'Baseline/Baseline/v4/templates/default.md',
      'Baseline/shared-library/cards/shared.yaml',
      'Baseline/Baseline/Scripts/source.js',
    ];
    for (const rel of retained) {
      expect(fs.readFileSync(path.join(tempRoot, rel))).toEqual(fs.readFileSync(path.join(root, rel)));
    }
    expect(listFilesRelative(tempRoot)).toEqual(retained.slice().sort());
    for (const rel of [
      'Baseline/Baseline/Velvet Lattice',
      'Baseline/Baseline/v3',
      'Baseline/Baseline/v3-reports',
    ]) {
      expect(fs.existsSync(path.join(tempRoot, rel))).toBe(false);
    }
    expect(fs.existsSync(path.join(tempRoot, 'Baseline', 'empty-source-dir'))).toBe(true);
  });
});
