'use strict';

/** `library-dependencies.json` records every input a stale check must watch. */

const fs = require('fs');
const path = require('path');
const { withTmpDir, writeTree } = require('../helpers/project');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');

const ITEMS = [
  '- id: Widget',
  '  name: Widget',
  '  aid: {type: Item, title: Widget}',
  '  render: {template: Item}',
  '  body: {Desc: item on disk}',
].join('\n');

function project({ templates, library = false }) {
  const dir = withTmpDir();
  writeTree(dir, {
    'shared/templates/Item.template': '{$body.Desc}',
    'shared/templates/Extra.partial': 'extra',
    'shared/templates/fields.cl.yaml': '# no fields\n',
    'shared/templates/notes.txt': 'not a template file',
    'proj/templates/Item.template': '{$body.Desc}',
    'proj/items/items.yaml': ITEMS,
    ...(library ? { 'proj/lib/lib.yaml': ITEMS.replace('Widget', 'Gadget') } : {}),
    'proj/compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [./items]',
      ...(library ? ['    library:', '      main: ./lib'] : []),
      `    templates: [${templates.join(', ')}]`,
      '  output: ./output',
      'branches:',
      '  A: {}',
    ].join('\n'),
  });
  const diagnostics = new Diagnostics();
  try {
    compile(path.join(dir, 'proj', 'compile.yaml'), { diagnostics });
  } catch (e) {
    e.message += `\n${diagnostics.all.map((d) => d.format()).join('\n')}`;
    throw e;
  }
  const manifestPath = path.join(dir, 'proj', 'output', 'library-dependencies.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  return { dir, manifest };
}

describe('library-dependencies.json template entries', () => {
  test('records an out-of-base template dir with the files the loader reads', () => {
    const { dir, manifest } = project({ templates: ['../shared/templates', './templates'] });
    const shared = path.resolve(dir, 'shared', 'templates');
    expect(manifest.templates).toHaveLength(1);
    expect(manifest.templates[0].resolvedPath).toBe(shared);
    expect(manifest.templates[0].expression).toBe(shared);
    expect(manifest.templates[0].files).toEqual([
      path.join(shared, 'Extra.partial'),
      path.join(shared, 'Item.template'),
      path.join(shared, 'fields.cl.yaml'),
    ].sort());
    expect(manifest.templates[0].missing).toBeUndefined();
  });

  test('does not record an in-base template dir', () => {
    const { manifest } = project({ templates: ['./templates'] });
    expect(manifest).toBeNull();
  });

  test('writes the manifest with an empty library when only templates are out of base', () => {
    const { manifest } = project({ templates: ['../shared/templates'] });
    expect(manifest.library).toEqual({});
    expect(manifest.templates).toHaveLength(1);
  });

  test('omits the templates key when no template dir is out of base', () => {
    const { manifest } = project({ templates: ['./templates'], library: true });
    expect(Object.keys(manifest.library)).toEqual(['main']);
    expect(manifest).not.toHaveProperty('templates');
  });

  test('flags a missing out-of-base template dir', () => {
    const { manifest } = project({ templates: ['../shared/templates', '../nowhere/templates'] });
    const missing = manifest.templates.find((t) => t.missing);
    expect(missing.files).toEqual([]);
    expect(manifest.templates.map((t) => Boolean(t.missing))).toEqual([false, true]);
  });
});
