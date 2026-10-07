'use strict';

const path = require('path');
const { preview } = require('../../src/compile');
const { CODES } = require('../../src/diag');
const { withTmpDir, writeTree } = require('../helpers/project');

const CONFIG = [
  'version: 4', 'structure:', '  input:', '    items: [%TMP%/items]',
  '    templates: [%TMP%/templates]', '  output: %TMP%/output',
  'templateFor: {base: tier.cl.yaml}',
].join('\n');

test('capitalized Templates in a templateFor file renders the selected field list', () => {
  const dir = withTmpDir();
  writeTree(dir, {
    'compile.yaml': CONFIG,
    'items/items.cl.yaml': '- id: Hero\n  name: Hero\n  aid: {type: Item}\n  body: {Name: hero, Detail: secret}\n',
    'items/component.cl.yaml': 'Sections: {intro: {Text: prose}}\n',
    'templates/fields.cl.yaml': 'fields: {name: {from: Name}, detail: {from: Detail}}\ntemplates: {Item: [name, detail]}\n',
    'templates/tier.cl.yaml': 'Templates: {Item: [{Field: name, Label: Selected}]}\n',
  });
  const result = preview(path.join(dir, 'compile.yaml'));
  expect(result.status).toBe('ok');
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(result.cards[0].rendered).toContain('Selected: hero');
  expect(result.cards[0].rendered).not.toContain('secret');
  expect(result.items).toHaveLength(1);
});

test('templateFor validation reports nested canonical paths at authored key locations', () => {
  const dir = withTmpDir();
  writeTree(dir, {
    'compile.yaml': CONFIG,
    'items/items.cl.yaml': '- id: Hero\n  name: Hero\n  aid: {type: Item}\n  body: {Name: hero}\n',
    'templates/fields.cl.yaml': 'fields: {name: {from: Name}}\ntemplates: {Item: [name]}\n',
    'templates/tier.cl.yaml': 'Templates:\n  Item:\n    - Field: name\n      Label: 42\n',
  });
  const result = preview(path.join(dir, 'compile.yaml'));
  const finding = result.diagnostics.find((d) => d.code === CODES.WRONG_TYPE);
  expect(finding).toMatchObject({ file: path.join(dir, 'templates/tier.cl.yaml'), line: 4, col: 7 });
  expect(finding.message).toContain('templates.Item.0.label');
});

test('an unknown key in a templateFor file is reported once and counted once', () => {
  const dir = withTmpDir();
  writeTree(dir, {
    'compile.yaml': `${CONFIG}\nbranches: {one: {}, two: {}}`,
    'items/items.cl.yaml': '- id: Hero\n  name: Hero\n  aid: {type: Item}\n  body: {Name: hero}\n',
    'templates/fields.cl.yaml': 'fields: {name: {from: Name}}\ntemplates: {Item: [name]}\n',
    'templates/tier.cl.yaml': 'Templates:\n  Item:\n    - Field: name\n      Bogus: 1\n',
  });
  const result = preview(path.join(dir, 'compile.yaml'));
  expect(result.status).toBe('ok');
  expect(result.diagnostics.filter((d) => d.code === CODES.UNKNOWN_KEY)).toHaveLength(1);
  expect(result.droppedKeys).toBe(1);
});
