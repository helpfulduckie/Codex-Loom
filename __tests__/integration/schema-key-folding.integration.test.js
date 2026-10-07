'use strict';

const path = require('path');
const { preview } = require('../../src/compile');
const { CODES, Diagnostics } = require('../../src/diag');
const { withTmpDir, writeTree, compileProject } = require('../helpers/project');
const { loadFieldTable } = require('../../src/loader/field-table');
const { originAt } = require('../../src/origin');
const { listFilesRelative } = require('../../src/util');

const config = (extra = []) => [
  'Version: 4', 'Structure:', '  Input:', '    Items: [%TMP%/items]',
  '    Templates: [%TMP%/templates]', '  Output: %TMP%/output', ...extra,
].join('\n');

function project(files, options) {
  const dir = withTmpDir();
  writeTree(dir, { 'compile.yaml': config(), ...files });
  return { dir, result: preview(path.join(dir, 'compile.yaml'), options) };
}

test('capitalized declarations reach rendered cards, components and preview origins', () => {
  const { result } = project({
    'compile.yaml': config(['Components: {AIInstructions: "%TMP%/components/ai.cl.yaml"}']),
    'items/items.yaml': '- Id: hero\n  Name: Hero\n  Aid: {Type: Character}\n  Render: {Template: Character}\n  Body: {Hair: silver}',
    'templates/fields.cl.yaml': 'Fields:\n  appearance: {From: Hair, Label: Appearance}\nTemplates: {Character: [appearance]}',
    'components/ai.cl.yaml': 'Sections:\n  Intro:\n    Text: Use vivid prose\n    Render: {Position: 1}',
  });
  expect(result.status).toBe('ok');
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(result.cards[0].rendered).toContain('Appearance: silver');
  expect(result.leaves[0].components.aiInstructions.text).toContain('Use vivid prose');
  expect(result.items[0].fields.find((field) => field.path.join('.') === 'render.template').origin)
    .toMatchObject({ authoredPath: ['Render', 'Template'], line: 4 });
  expect(result.items[0].fields.find((field) => field.path.join('.') === 'body.Hair').origin)
    .toMatchObject({ authoredPath: ['Body', 'Hair'], line: 5 });
});

test('tolerant preview drops an unknown sibling while retaining folded origins', () => {
  const files = {
    'items/items.yaml': '- id: hero\n  name: Hero\n  Aid: {Type: Character}\n  Render:\n    Template: Character\n    Nonsense: ignored\n  Body: {Text: hello}',
    'templates/Character.template': '{$body.Text}',
  };
  const { result } = project(files);
  expect(result.status).toBe('ok');
  expect(result.droppedKeys).toBe(1);
  expect(result.diagnostics.find((d) => d.code === CODES.UNKNOWN_KEY)).toMatchObject({ line: 6, col: 5 });
  expect(result.items[0].fields.find((field) => field.path.join('.') === 'render.template').origin)
    .toMatchObject({ authoredPath: ['Render', 'Template'], line: 5 });
  expect(project(files, { tolerant: false }).result.status).toBe('blocked');
});

test.each([
  ['top-level', 'Render: {Template: Character}\n  render: {Template: Character}', 4, 5],
  ['nested', 'Aid:\n    Type: Character\n    type: Character', 5, 6],
])('strict compilation of a %s map collision writes no output files', (_where, block, firstLine, line) => {
  const { diagnostics, tmpDir, threw } = compileProject({
    'compile.yaml': config(),
    'items/items.yaml': `- id: hero\n  name: Hero\n  body: {Text: hello}\n  ${block}`,
    'templates/Character.template': '{$body.Text}',
  });
  expect(threw).not.toBeNull();
  expect(listFilesRelative(path.join(tmpDir, 'output'))).toEqual([]);
  const findings = diagnostics.all.filter((d) => d.code === CODES.DUPLICATE_KEY_CASE);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ line, related: [{ label: 'first definition', line: firstLine }] });
});

test.each(['render', 'Render'])('variant %s overrides still select the alternate template', (key) => {
  const { result } = project({
    'compile.yaml': config(['Branches: {selected: {}}']),
    'items/items.yaml': [
      '- id: hero', '  name: Hero', '  aid: {type: Character}', '  render: {template: Item}',
      '  body: {Text: hello}', `  variants: {alt: {${key}: {template: Alt}}}`,
      '  branches: {selected: alt}',
    ].join('\n'),
    'templates/Item.template': 'ITEM {$body.Text}',
    'templates/Alt.template': 'ALT {$body.Text}',
  });
  expect(result.status).toBe('ok');
  expect(result.cards[0].rendered).toContain('ALT hello');
  expect(result.items[0].fields.find((field) => field.path.join('.') === 'render.template'))
    .toMatchObject({ value: 'Alt', origin: { authoredPath: ['variants', 'alt', key, 'template'] } });
});

test.each(['vars', 'Vars'])('capitalization of %s keeps variable alias overlay precedence', (key) => {
  const { result } = project({
    'items/items.yaml': [
      '- id: hero', '  name: Hero', '  aid: {type: Character}',
      `  ${key}: {tone: first}`, '  v: {tone: second}', '  body: {Text: hello}',
    ].join('\n'),
    'templates/Character.template': '{$v.tone}',
  });
  expect(result.status).toBe('ok');
  expect(result.cards[0].rendered).toContain('second');
});

test('field table declarations keep original source spelling after map normalization', () => {
  const dir = withTmpDir();
  writeTree(dir, { 'templates/fields.cl.yaml': 'Fields:\n  Hair:\n    From: Traits.Hair' });
  const diagnostics = new Diagnostics();
  const table = loadFieldTable([path.join(dir, 'templates')], { diagnostics });
  expect(diagnostics.errors).toEqual([]);
  expect(table.fields.Hair.from).toBe('Traits.Hair');
  expect(originAt(table, ['fields', 'Hair'])).toMatchObject({ path: ['Fields', 'Hair'], line: 2 });
});
