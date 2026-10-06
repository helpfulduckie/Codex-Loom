'use strict';

/** A compile given `sources` reads those texts in place of the files on disk. */

const fs = require('fs');
const path = require('path');
const { withTmpDir, writeTree } = require('../helpers/project');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');

function project() {
  const tmpDir = withTmpDir();
  writeTree(tmpDir, {
    'templates/Item.template': '{$body.Desc}',
    'openings/open.md': 'Opening on disk\n',
    'items/items.yaml': [
      '- id: Widget',
      '  name: Widget',
      '  aid: {type: Item, title: Widget}',
      '  render: {template: Item}',
      '  body: {Desc: item on disk}',
    ].join('\n'),
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/items]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'components:',
      '  opening: %TMP%/openings/open.md',
      'branches:',
      '  A: {}',
    ].join('\n'),
  });
  return tmpDir;
}

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** The compiled output as one string; the source files must come through unchanged. */
function compiledText(tmpDir, sources) {
  const before = readTree(tmpDir);
  compile(path.join(tmpDir, 'compile.yaml'), { diagnostics: new Diagnostics(), sources });
  const after = readTree(tmpDir);
  const output = Object.entries(after).filter(([rel]) => rel.startsWith('output'));
  const inputs = Object.fromEntries(Object.entries(after).filter(([rel]) => !rel.startsWith('output')));
  expect(inputs).toEqual(before);
  return output.map(([, text]) => text).join('\n----\n');
}

describe('compile with source overrides', () => {
  test('an item file override changes the compiled card and leaves the file alone', () => {
    const tmpDir = project();
    const text = compiledText(tmpDir, {
      [path.join(tmpDir, 'items', 'items.yaml')]: [
        '- id: Widget',
        '  name: Widget',
        '  aid: {type: Item, title: Widget}',
        '  render: {template: Item}',
        '  body: {Desc: item from override}',
      ].join('\n'),
    });
    expect(text).toContain('item from override');
    expect(text).not.toContain('item on disk');
  });

  test('a template override changes the compiled card and leaves the file alone', () => {
    const tmpDir = project();
    const text = compiledText(tmpDir, {
      [path.join(tmpDir, 'templates', 'Item.template')]: 'template override: {$body.Desc}',
    });
    expect(text).toContain('template override: item on disk');
  });

  test('a passthrough opening override changes the compiled opening and leaves the file alone', () => {
    const tmpDir = project();
    const text = compiledText(tmpDir, {
      [path.join(tmpDir, 'openings', 'open.md')]: 'Opening from override\n',
    });
    expect(text).toContain('Opening from override');
    expect(text).not.toContain('Opening on disk');
  });

  test('a compile with no sources reads the disk', () => {
    const tmpDir = project();
    const text = compiledText(tmpDir, undefined);
    expect(text).toContain('item on disk');
    expect(text).toContain('Opening on disk');
  });
});
