'use strict';

/** A compile in capture mode runs every check and writes nothing to disk. */

const fs = require('fs');
const path = require('path');
const { withTmpDir, writeTree } = require('../helpers/project');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');
const { takeCapturedOutput } = require('../../src/outputLedger');

function project() {
  const tmpDir = withTmpDir();
  writeTree(tmpDir, {
    'templates/Card.template': '{$body.Text}',
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'branches:',
      '  a: {}',
      '  b: {}',
    ].join('\n'),
    'Codex/items.yaml': [
      '- id: one',
      '  name: One',
      '  aid: {type: character, triggers: [one]}',
      '  render: {template: Card}',
      '  body: {Text: one text}',
    ].join('\n'),
  });
  return tmpDir;
}

describe('compile with capture', () => {
  test('creates no output directory', () => {
    const tmpDir = project();
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics: new Diagnostics(), capture: true });
    expect(fs.existsSync(path.join(tmpDir, 'output'))).toBe(false);
  });

  test('leaves capture mode off once the compile returns', () => {
    const tmpDir = project();
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics: new Diagnostics(), capture: true });
    expect(takeCapturedOutput()).toBeNull();
  });
});
