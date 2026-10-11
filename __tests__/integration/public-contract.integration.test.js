'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { withTmpDir, writeTree } = require('../helpers/project');
const api = require('../..');

const ROOT = path.resolve(__dirname, '../..').replace(/\\/g, '/');
const TSC = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc');

function typecheck(source) {
  const dir = withTmpDir();
  const file = path.join(dir, 'contract.ts');
  fs.writeFileSync(file, `import * as loom from ${JSON.stringify(ROOT)};\n${source}`, 'utf8');
  return spawnSync(process.execPath, [TSC, '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2020', '--module', 'commonjs', '--types', 'node',
    '--typeRoots', path.join(ROOT, 'node_modules/@types'), file], { encoding: 'utf8' });
}

const assignment = (name, type, value) => `const ${name}: loom.${type} = ${JSON.stringify(value)};\n`;

test('serialized public API results satisfy the package declarations', () => {
  const dir = withTmpDir();
  writeTree(dir, {
    'compile.yaml': [
      'version: 4', 'structure:', '  input:', '    items: [%TMP%/items]',
      '    library: {core: %TMP%/library}', '    templates: [%TMP%/templates]',
      '    snapshot: %TMP%/snapshot', '  output: %TMP%/output',
      'variables: {place: Harbor}', 'roles: {guide: Hero}',
      'components: {plotEssential: %TMP%/components/pe.yaml}',
      'scripts: {input: ./input.js}',
      'branches:', '  A: {}', '  B:', '    variables: {place: Summit}',
    ].join('\n'),
    'library/items.yaml': [
      '- id: Hero', '  name: Hero', '  aid: {type: Item, title: Hero}',
      '  render: {template: Item, plotEssential: {slot: party}}',
      '  body: {Desc: library hero, Rank: captain}',
    ].join('\n'),
    'items/items.yaml': [
      '- import: core:Hero', '  branches: {B: bold}',
      '  variants:', '    bold:', '      body: {Desc: bold hero, Rank: ~}',
    ].join('\n'),
    'templates/Item.template': '{$body.Desc}',
    'input.js': 'return 1;',
    'components/base.yaml': 'sections:\n  intro:\n    text: Base prose\n',
    'components/pe.yaml': [
      'imports:', '  - from: %TMP%/components/base.yaml',
      'sections:', '  intro:', "    text: 'Set in {%place}.'",
      '  party:', '    slot: true',
    ].join('\n'),
  });
  const config = path.join(dir, 'compile.yaml');
  const frozen = api.freezeLibraries(config);
  const before = api.preview(config);
  const library = path.join(dir, 'library/items.yaml');
  fs.writeFileSync(library, fs.readFileSync(library, 'utf8').replace('library hero', 'edited hero'));
  const after = api.preview(config, { live: true });
  const withErrors = api.preview(config, { live: true, sources: {
    [library]: fs.readFileSync(library, 'utf8').replace('slot: party', 'slot: missing'),
  } });
  const blockedConfig = path.join(dir, 'blocked.yaml');
  fs.writeFileSync(blockedConfig, 'version: 4\nunknown: invalid\n', 'utf8');
  const blocked = api.preview(blockedConfig, { tolerant: false });
  const inspection = api.inspectSnapshot(config);
  expect(before.status).toBe('ok');
  expect(blocked.status).toBe('blocked');
  expect(withErrors.status).toBe('ok');
  expect(withErrors.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  expect(before.items.some((item) => item.fields.some((field) => field.layers.length))).toBe(true);
  expect(before.items.some((item) => item.removedFields.length)).toBe(true);
  expect(before.sections.length).toBeGreaterThan(0);
  expect(before.bindings.length).toBeGreaterThan(0);
  expect(before.libraries.length).toBeGreaterThan(0);
  expect(before.files.some((file) => file.binary && file.digest.startsWith('sha256:'))).toBe(true);
  expect(before.sections.some((section) => section.settings.some((setting) => setting.layers.length))).toBe(true);
  const comparison = api.comparePreviews(before, after, { pairs: [['A', 'B']] });
  expect(comparison.libraries.length).toBeGreaterThan(0);
  expect(comparison.leaves.some((leaf) => leaf.components.length)).toBe(true);
  const text = [
    assignment('before', 'PreviewResult', before), assignment('after', 'PreviewResult', after),
    assignment('withErrors', 'PreviewResult', withErrors),
    assignment('blocked', 'PreviewResult', blocked), assignment('frozen', 'FreezeResult', frozen),
    assignment('blockedFreeze', 'FreezeResult', api.freezeLibraries(blockedConfig)),
    assignment('inspection', 'SnapshotInspection', inspection),
    assignment('blockedInspection', 'SnapshotInspection', api.inspectSnapshot(blockedConfig)),
    assignment('comparison', 'PreviewComparison', comparison),
    assignment('blockedComparison', 'PreviewComparison', api.comparePreviews(before, blocked)),
    `const parsed: string = loom.preparse('body: {$token}');`,
    `const compiled: void = loom.compile('compile.yaml', { sources: new Map([['x.yaml', 'body: text']]) });`,
    `const checked: loom.FreezeResult = loom.freezeLibraries('compile.yaml', { expectedState: 'hash' });`,
    `if (before.status === 'ok') { const config: string = before.project.config; }`,
    `if (blocked.status === 'blocked') { const project: null = blocked.project; }`,
  ].join('\n');
  const checked = typecheck(text);
  expect(checked.stdout + checked.stderr).toBe('');
  expect(checked.status).toBe(0);
}, 60000);

test.each([
  ['field origin', 'Field', { path: ['body'], value: 'text', layers: [] }],
  ['layer deletion marker', 'FieldLayer', { kind: 'variant', name: 'bold', library: null, op: '~', file: null, line: null, col: null, before: 'x', beforeAbsent: false, beforeOrigin: null, after: null }],
  ['section state', 'Section', { name: 'intro', slot: false, state: 'unknown', position: 5, variants: [], source: null, settings: [], occupants: [], uses: null, text: null }],
  ['binary digest', 'PreviewFile', { path: 'script.js', binary: true, bytes: 2 }],
  ['binding layer location', 'BindingLayer', { branchPath: [], removed: false, before: null, after: 'x' }],
  ['library file index', 'Library', { name: 'core', path: '/core', sourcePath: '/core', frozen: false, files: [{ file: 'wrong', items: [] }] }],
  ['snapshot hashes', 'SnapshotInspectionEntry', { name: 'core', kind: 'library', sourcePath: '/core', snapshotPath: '/snapshot', isNew: false, live: { 'items.yaml': 3 }, frozen: {}, added: [], removed: [], changed: [] }],
  ['freeze entry changes', 'FreezeEntry', { name: 'core', kind: 'library', isNew: false, added: [], removed: [], changed: [3] }],
  ['comparison item change', 'ItemChange', { id: 'Hero', change: 'changed', fields: [], output: 'yes' }],
])('declarations reject an invalid %s independently', (_name, type, value) => {
  const checked = typecheck(assignment('invalid', type, value));
  expect(checked.status).not.toBe(0);
  expect(checked.stdout).toMatch(/error TS/);
}, 30000);

test.each([
  ['ok', null], ['blocked', { config: '/project/compile.yaml' }],
])('preview status %s enforces its project discriminator', (status, project) => {
  const checked = typecheck(assignment('invalid', 'PreviewResult', {
    status, project, droppedKeys: 0, diagnostics: [], sourceFiles: [], items: [], cards: [],
    sections: [], bindings: [], outputs: [], branches: [], libraries: [], leaves: [], files: [],
  }));
  expect(checked.status).not.toBe(0);
  expect(checked.stdout).toMatch(/error TS/);
}, 30000);
