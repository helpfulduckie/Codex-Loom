'use strict';

/** A tolerant compile reports an unknown key and carries on without it. */

const path = require('path');
const { withTmpDir, writeTree } = require('../helpers/project');
const { compile } = require('../../src/compile');
const { Diagnostics, CODES } = require('../../src/diag');

function project() {
  const tmpDir = withTmpDir();
  writeTree(tmpDir, {
    'templates/Item.template': '{$body.Desc}',
    'items/items.yaml': [
      '- id: Widget',
      '  name: Widget',
      '  aid: {type: Item, title: Widget}',
      '  render: {template: Item, wraper: curly}',
      '  body: {Desc: a widget}',
    ].join('\n'),
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/items]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'branches:',
      '  A: {}',
    ].join('\n'),
  });
  return path.join(tmpDir, 'compile.yaml');
}

describe('compile with tolerant', () => {
  test('an unknown key aborts the load by default', () => {
    expect(() => compile(project(), { diagnostics: new Diagnostics(), capture: true }))
      .toThrow(/error.* while loading; nothing was compiled/);
  });

  test('an unknown key is reported and the compile completes when tolerant', () => {
    const diagnostics = new Diagnostics();
    expect(() => compile(project(), { diagnostics, capture: true, tolerant: true })).not.toThrow();
    expect(diagnostics.errors.map((d) => d.code)).toContain(CODES.UNKNOWN_KEY);
  });
});
