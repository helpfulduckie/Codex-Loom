'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { withTmpDir } = require('../helpers/project');
const api = require('../..');
const examples = require('../../examples/projects');

const ROOT = path.resolve(__dirname, '../..').split(path.sep).join('/');
const EXAMPLES_DIR = path.resolve(__dirname, '../../examples');
const TSC = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc');

const constName = (name) => `preview_${name.replace(/[^A-Za-z0-9]/g, '_')}`;

// Real previews carry shapes the small contract project does not reach (variants, tiers, roles,
// every component type), so a field the compiler emits but index.d.ts omits, or declares but
// never emits, fails here. All the projects share one tsc run to keep the time down.
test('every example project preview satisfies the package declarations', () => {
  const previews = examples.PROJECTS.map((project) => {
    const config = path.join(EXAMPLES_DIR, project.dir, examples.SOURCE_SUBDIR, examples.CONFIG_NAME);
    return { name: project.name, result: api.preview(config, { live: true }) };
  });
  for (const { name, result } of previews) expect([name, result.status]).toEqual([name, 'ok']);

  const lines = [`import * as loom from ${JSON.stringify(ROOT)};`];
  for (const { name, result } of previews) {
    lines.push(`const ${constName(name)}: loom.PreviewResult = ${JSON.stringify(result)};`);
  }
  const [first, second] = previews;
  const comparison = api.comparePreviews(first.result, second.result);
  lines.push(`const comparison: loom.PreviewComparison = ${JSON.stringify(comparison)};`);

  const dir = withTmpDir();
  const file = path.join(dir, 'examples.ts');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  const checked = spawnSync(process.execPath, [TSC, '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2020', '--module', 'commonjs', '--types', 'node',
    '--typeRoots', path.join(ROOT, 'node_modules/@types'), file], { encoding: 'utf8' });
  expect(checked.stdout + checked.stderr).toBe('');
  expect(checked.status).toBe(0);
}, 300000);
