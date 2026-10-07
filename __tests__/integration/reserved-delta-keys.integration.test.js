'use strict';

const path = require('path');
const { preview } = require('../../src/compile');
const { CODES } = require('../../src/diag');
const { withTmpDir, writeTree } = require('../helpers/project');

function run(key, explicitBody = false, selected = true) {
  const dir = withTmpDir();
  writeTree(dir, {
    'compile.yaml': 'version: 4\nstructure:\n  input:\n    items: [%TMP%/items]\n'
      + '    templates: [%TMP%/templates]\n  output: %TMP%/output\nbranches: {selected: {}}',
    'items/items.yaml': '- id: hero\n  name: Hero\n  aid: {type: Item}\n'
      + `  body: {${key}: base, Unreserved: base}\n  variants:\n    alt:\n`
      + (explicitBody ? `      body: {${key}: changed}\n` : `      ${key}: changed\n`)
      + '      Unreserved: changed\n'
      + (selected ? '  branches: {selected: alt}' : ''),
    'templates/Item.template': `{$body.${key}}|{$body.Unreserved}`,
  });
  return preview(path.join(dir, 'compile.yaml'));
}

test.each(['import', 'Import', 'include', 'Include', 'branches', 'Branches'])(
  'reserved delta key %s warns at its source and leaves the body field unchanged', (key) => {
    const result = run(key);
    expect(result.status).toBe('ok');
    const warnings = result.diagnostics.filter(d => d.code === CODES.VARIANT_RESERVED_KEY);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ severity: 'warn', line: 7, col: 7 });
    expect(warnings[0].message).toContain(`Key "${key}"`);
    expect(warnings[0].message).toContain(`body: {${key}: ...}`);
    expect(result.cards[0].rendered).toContain('base|changed');
    expect(result.items[0].fields.find(field => field.path.join('.') === 'body.Unreserved'))
      .toMatchObject({ value: 'changed' });
  }
);

test.each(['Import', 'Include', 'Branches'])(
  'explicit body field %s changes without a reserved-key warning', (key) => {
    const result = run(key, true);
    expect(result.status).toBe('ok');
    expect(result.diagnostics.filter(d => d.code === CODES.VARIANT_RESERVED_KEY)).toEqual([]);
    expect(result.cards[0].rendered).toContain('changed|changed');
    expect(result.items[0].fields.find(field => field.path.join('.') === `body.${key}`))
      .toMatchObject({ value: 'changed', origin: { authoredPath: ['variants', 'alt', 'body', key] } });
  }
);

test('an unused variant still warns about a reserved delta key during loading', () => {
  const result = run('Import', false, false);
  expect(result.status).toBe('ok');
  expect(result.diagnostics.filter(d => d.code === CODES.VARIANT_RESERVED_KEY)).toHaveLength(1);
  expect(result.cards[0].rendered).toContain('base|base');
});

test('section variants honor nested dispatch maps through the shared normalization view', () => {
  const dir = withTmpDir();
  writeTree(dir, {
    'compile.yaml': 'version: 4\nstructure:\n  output: %TMP%/output\n'
      + 'components: {aiInstructions: "%TMP%/components/ai.yaml"}\n'
      + 'branches: {outer: {branches: {inner: {}}}}',
    'components/ai.yaml': 'Sections:\n  Intro:\n    Text: BASE\n'
      + '    Variants: {alt: {Text: ALT}}\n    Branches: {outer: {Branches: {inner: alt}}}',
  });
  const result = preview(path.join(dir, 'compile.yaml'));
  expect(result.status).toBe('ok');
  expect(result.leaves[0].components.aiInstructions.text).toContain('ALT');
});
