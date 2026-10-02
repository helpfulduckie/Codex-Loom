'use strict';

/**
 * Every compile removes the output it owns and did not write, after writing — so stale
 * cards cannot outlive their source, and a compile that throws part-way leaves the
 * previous output where it was.
 */

const fs = require('fs');
const path = require('path');
const { withTmpDir, writeTree } = require('../helpers/project');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');

const config = (branches) => [
  'version: 4',
  'structure:',
  '  input:',
  '    items: [%TMP%/Codex]',
  '    templates: [%TMP%/templates]',
  '  output: %TMP%/output',
  'branches:',
  ...branches.map((b) => `  ${b}: {}`),
].join('\n');

const card = (id, type, extra = '') => [
  `- id: ${id}`,
  `  name: ${id}`,
  `  aid: {type: ${type}, triggers: [${id}]}`,
  '  render: {template: Card}',
  `  body: {Text: ${id} text}`,
  extra,
].join('\n');

function project(items, branches = ['a', 'b']) {
  const tmpDir = withTmpDir();
  writeTree(tmpDir, {
    'templates/Card.template': '{$body.Text}',
    'compile.yaml': config(branches),
    'Codex/items.yaml': items,
  });
  return tmpDir;
}

const run = (tmpDir) => compile(path.join(tmpDir, 'compile.yaml'), { diagnostics: new Diagnostics() });
const out = (tmpDir, ...parts) => path.join(tmpDir, 'output', ...parts);
const setItems = (tmpDir, items) => fs.writeFileSync(path.join(tmpDir, 'Codex', 'items.yaml'), items, 'utf8');

function scriptsConfig(declaration = null, branches = ['  a: {}', '  b: {}']) {
  return [
    'version: 4', 'structure:', '  input:',
    '    items: [%TMP%/Codex]', '    templates: [%TMP%/templates]',
    '  output: %TMP%/output',
    ...(declaration === null ? [] : [`scripts: ${declaration}`]),
    'branches:', ...branches, '',
  ].join('\n');
}

function scriptProject(configText, files = {}) {
  const tmpDir = withTmpDir();
  writeTree(tmpDir, {
    'templates/Card.template': '{$body.Text}',
    'Codex/items.yaml': card('Hero', 'Character'),
    'compile.yaml': configText,
    ...files,
  });
  return tmpDir;
}

function compileSuccessfully(tmpDir) {
  const diagnostics = new Diagnostics();
  let threw = null;
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics });
  } catch (err) {
    threw = err;
  }
  expect(threw).toBe(null);
  expect(diagnostics.errors).toEqual([]);
}

describe('a compile with no flag', () => {
  test('removes a card file whose item is gone', () => {
    const tmpDir = project([card('Elder', 'Character'), card('Guild', 'Faction')].join('\n'));
    run(tmpDir);
    expect(fs.existsSync(out(tmpDir, 'Story Cards', 'faction', 'faction.md'))).toBe(true);

    setItems(tmpDir, card('Elder', 'Character'));
    run(tmpDir);
    expect(fs.existsSync(out(tmpDir, 'Story Cards', 'faction'))).toBe(false);
    expect(fs.existsSync(out(tmpDir, 'Story Cards', 'character', 'character.md'))).toBe(true);
  });

  test('removes a copy left at a leaf when the card moves up the tree', () => {
    const tmpDir = project(card('Elder', 'Character', '  branches: {b: ~}'));
    run(tmpDir);
    expect(fs.existsSync(out(tmpDir, 'Branches', 'a', 'Story Cards', 'character', 'character.md'))).toBe(true);

    setItems(tmpDir, card('Elder', 'Character'));
    run(tmpDir);
    expect(fs.existsSync(out(tmpDir, 'Story Cards', 'character', 'character.md'))).toBe(true);
    expect(fs.existsSync(out(tmpDir, 'Branches', 'a', 'Story Cards'))).toBe(false);
  });

  test("keeps Velvet Lattice's .short_id on a live branch, and archives a dropped branch that has one", () => {
    const tmpDir = project(card('Elder', 'Character'), ['a', 'b']);
    run(tmpDir);
    fs.writeFileSync(out(tmpDir, 'Branches', 'a', '.short_id'), 'live', 'utf8');
    fs.writeFileSync(out(tmpDir, 'Branches', 'b', '.short_id'), 'dropped', 'utf8');

    writeTree(tmpDir, { 'compile.yaml': config(['a']) }); // writeTree fills in %TMP%
    run(tmpDir);
    expect(fs.readFileSync(out(tmpDir, 'Branches', 'a', '.short_id'), 'utf8')).toBe('live');
    expect(fs.existsSync(out(tmpDir, 'Branches', 'b'))).toBe(false);
    const [stamp] = fs.readdirSync(out(tmpDir, 'Archive'));
    expect(fs.readFileSync(out(tmpDir, 'Archive', stamp, 'Branches', 'b', '.short_id'), 'utf8')).toBe('dropped');
  });
});

describe('a compile that throws while writing', () => {
  test('leaves the previous output in place, and the next good compile sweeps it', () => {
    const tmpDir = project([card('Elder', 'Character'), card('Guild', 'Faction')].join('\n'));
    run(tmpDir);
    setItems(tmpDir, card('Elder', 'Character'));

    const realWrite = fs.writeFileSync;
    const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
      if (String(file).includes('Story Cards')) throw new Error('disk full');
      return realWrite(file, ...rest);
    });
    try {
      expect(() => run(tmpDir)).toThrow('disk full');
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(out(tmpDir, 'Story Cards', 'faction', 'faction.md'))).toBe(true);

    run(tmpDir);
    expect(fs.existsSync(out(tmpDir, 'Story Cards', 'faction'))).toBe(false);
  });
});

describe('script output is swept from the current file selections', () => {
  test('removes missing sources and changed bundle files, then removes a deleted declaration', () => {
    const tmpDir = scriptProject(scriptsConfig('./oldBundle'), {
      'oldBundle/input.js': 'input before', 'oldBundle/output.js': 'output before',
      'oldBundle/old.txt': 'old helper',
    });
    compileSuccessfully(tmpDir);
    expect(fs.readFileSync(out(tmpDir, 'Scripts', 'input.js'), 'utf8')).toBe('input before');

    fs.rmSync(path.join(tmpDir, 'oldBundle', 'input.js'));
    fs.writeFileSync(path.join(tmpDir, 'oldBundle', 'output.js'), 'output after', 'utf8');
    compileSuccessfully(tmpDir);
    expect(fs.existsSync(out(tmpDir, 'Scripts', 'input.js'))).toBe(false);
    expect(fs.readFileSync(out(tmpDir, 'Scripts', 'output.js'), 'utf8')).toBe('output after');

    writeTree(tmpDir, {
      'compile.yaml': scriptsConfig('./newBundle'),
      'newBundle/context.js': 'new bundle context',
      'newBundle/nested/new.txt': 'new helper',
    });
    compileSuccessfully(tmpDir);
    expect(fs.existsSync(out(tmpDir, 'Scripts', 'input.js'))).toBe(false);
    expect(fs.existsSync(out(tmpDir, 'Scripts', 'output.js'))).toBe(false);
    expect(fs.readFileSync(out(tmpDir, 'Scripts', 'context.js'), 'utf8')).toBe('new bundle context');
    expect(fs.readFileSync(out(tmpDir, 'Scripts', 'nested', 'new.txt'), 'utf8')).toBe('new helper');
    expect(fs.existsSync(out(tmpDir, 'Scripts', 'old.txt'))).toBe(false);

    writeTree(tmpDir, { 'compile.yaml': scriptsConfig(null) });
    compileSuccessfully(tmpDir);
    expect(fs.existsSync(out(tmpDir, 'Scripts'))).toBe(false);
  });

  test('a mapping null removes only its selected hook on the next compile', () => {
    const tmpDir = scriptProject(scriptsConfig('./unusedBundle', [
      '  a: {scripts: {input: ./input.js, output: ./output.js}}',
      '  b: {scripts: {input: ./input.js, output: ./output.js}}',
    ]), { 'input.js': 'input', 'output.js': 'output' });
    compileSuccessfully(tmpDir);
    writeTree(tmpDir, {
      'compile.yaml': scriptsConfig('./unusedBundle', [
        '  a: {scripts: {input: ./input.js, output: null}}',
        '  b: {scripts: {input: ./input.js, output: null}}',
      ]),
    });
    compileSuccessfully(tmpDir);
    expect(fs.existsSync(out(tmpDir, 'Scripts', 'output.js'))).toBe(false);
    expect(fs.readFileSync(out(tmpDir, 'Scripts', 'input.js'), 'utf8')).toBe('input');
  });

  test('script ownership moves from leaves to an ancestor and back to leaves', () => {
    const tmpDir = scriptProject(scriptsConfig(null, [
      '  a: {scripts: {input: ./a.js}}', '  b: {scripts: {input: ./b.js}}',
    ]), { 'a.js': 'a', 'b.js': 'b', 'shared.js': 'shared' });
    compileSuccessfully(tmpDir);
    expect(fs.readFileSync(out(tmpDir, 'Branches', 'a', 'Scripts', 'input.js'), 'utf8')).toBe('a');
    expect(fs.readFileSync(out(tmpDir, 'Branches', 'b', 'Scripts', 'input.js'), 'utf8')).toBe('b');

    writeTree(tmpDir, { 'compile.yaml': scriptsConfig(null, [
      '  a: {scripts: {input: ./shared.js}}', '  b: {scripts: {input: ./shared.js}}',
    ]) });
    compileSuccessfully(tmpDir);
    expect(fs.readFileSync(out(tmpDir, 'Scripts', 'input.js'), 'utf8')).toBe('shared');
    expect(fs.existsSync(out(tmpDir, 'Branches', 'a', 'Scripts'))).toBe(false);
    expect(fs.existsSync(out(tmpDir, 'Branches', 'b', 'Scripts'))).toBe(false);

    writeTree(tmpDir, { 'compile.yaml': scriptsConfig(null, [
      '  a: {scripts: {input: ./a.js}}', '  b: {scripts: {input: ./shared.js}}',
    ]) });
    compileSuccessfully(tmpDir);
    expect(fs.existsSync(out(tmpDir, 'Scripts', 'input.js'))).toBe(false);
    expect(fs.readFileSync(out(tmpDir, 'Branches', 'a', 'Scripts', 'input.js'), 'utf8')).toBe('a');
    expect(fs.readFileSync(out(tmpDir, 'Branches', 'b', 'Scripts', 'input.js'), 'utf8')).toBe('shared');
  });
});
