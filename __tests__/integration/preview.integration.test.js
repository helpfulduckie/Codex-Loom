'use strict';

/** `preview` runs a whole compile in memory and returns it as plain data. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { withTmpDir, writeTree } = require('../helpers/project');
const { listFilesRelative } = require('../../src/util');
const { PROJECTS, CONFIG_NAME, OUTPUT_SUBDIR } = require('../../examples/projects');

const EXAMPLES = path.resolve(__dirname, '../../examples');
const configOf = (dir) => path.join(EXAMPLES, dir, CONFIG_NAME);

// Stamped with a fresh time and absolute paths, which the baseline harness also compares
// only after normalizing.
const NOT_BYTE_COMPARABLE = new Set(['library-dependencies.json']);

const diagnosticCodes = (result) => result.diagnostics.map((d) => d.code);

function treeHashes(root) {
  const out = {};
  for (const rel of listFilesRelative(root)) {
    out[rel] = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(root, ...rel.split('/')))).digest('hex');
  }
  return out;
}

const BASE_PROJECT = {
  'templates/Item.template': '{$body.Desc}',
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
};

const widget = (renderLine = '  render: {template: Item}', desc = 'item on disk') => [
  '- id: Widget',
  '  name: Widget',
  '  aid: {type: Item, title: Widget}',
  renderLine,
  `  body: {Desc: ${desc}}`,
].join('\n');

function smallProject(files = {}) {
  const dir = withTmpDir();
  writeTree(dir, { ...BASE_PROJECT, 'items/items.yaml': widget(), ...files });
  return { dir, config: path.join(dir, 'compile.yaml') };
}

describe('preview of the example projects', () => {
  const { preview } = require('../../src/compile');

  describe.each(PROJECTS.map((p) => p.dir))('%s', (dir) => {
    let result;
    beforeAll(() => { result = preview(configOf(dir), { live: true }); }, 120000);

    test('returns an ok status and a result that survives a JSON round trip unchanged', () => {
      expect(result.status).toBe('ok');
      expect(result.leaves.length).toBeGreaterThan(0);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });

    test('lists exactly the compiled files of the committed baseline, with their bytes', () => {
      const baselineDir = path.join(EXAMPLES, dir, OUTPUT_SUBDIR);
      const baseline = listFilesRelative(baselineDir);
      expect(result.files.map((f) => f.path).sort()).toEqual([...baseline].sort());

      const mismatched = [];
      for (const file of result.files) {
        if (NOT_BYTE_COMPARABLE.has(path.basename(file.path))) continue;
        if (file.binary) continue;
        const expected = path.join(baselineDir, ...file.path.split('/'));
        if (!fs.existsSync(expected)
          || !Buffer.from(file.content, 'utf8').equals(fs.readFileSync(expected))) {
          mismatched.push(file.path);
        }
      }
      expect(mismatched).toEqual([]);
    });
  });
});

describe('preview leaves the disk alone', () => {
  const { preview } = require('../../src/compile');

  test('an already compiled project tree is identical afterwards', () => {
    const copy = withTmpDir();
    fs.cpSync(path.join(EXAMPLES, 'variants-and-fieldops'), path.join(copy, 'variants-and-fieldops'), {
      recursive: true,
    });
    // The compile config reaches up to ../library for the shared libraries.
    fs.cpSync(path.join(EXAMPLES, 'library'), path.join(copy, 'library'), { recursive: true });
    const before = treeHashes(copy);
    const result = preview(path.join(copy, 'variants-and-fieldops', CONFIG_NAME), { live: true });
    expect(result.status).toBe('ok');
    expect(treeHashes(copy)).toEqual(before);
  });

  test('a project that was never compiled gets no output directory', () => {
    const { dir, config } = smallProject();
    const result = preview(config);
    expect(result.status).toBe('ok');
    expect(fs.existsSync(path.join(dir, 'output'))).toBe(false);
  });
});

describe('preview field provenance on variants-and-fieldops', () => {
  const { preview } = require('../../src/compile');
  const source = fs.readFileSync(
    path.join(EXAMPLES, 'library', 'core', 'characters.cl.yaml'), 'utf8',
  ).split(/\r?\n/);
  const lineOf = (text, from = 0) => source.findIndex((l, i) => i >= from && l.includes(text)) + 1;

  let result;
  beforeAll(() => { result = preview(configOf('variants-and-fieldops'), { live: true }); }, 120000);

  const tagline = (label) => {
    const leaf = result.leaves.find((l) => l.label === label);
    const item = leaf.items.map((i) => result.items[i]).find((i) => i.id === 'Zephon');
    return item.fields.find((f) => f.path.join('.') === 'body.Tagline');
  };

  test('an item that resolves the same on several leaves is held once', () => {
    const references = result.leaves.flatMap((l) => l.items);
    expect(references.every((i) => Number.isInteger(i) && i >= 0 && i < result.items.length)).toBe(true);
    expect(new Set(references).size).toBe(result.items.length);
    expect(references.length).toBeGreaterThan(result.items.length);
    expect(new Set(result.items.map((i) => JSON.stringify(i))).size).toBe(result.items.length);
  });

  test('an item a variant changes on one leaf is a different entry there', () => {
    const zephonOn = (label) => result.leaves.find((l) => l.label === label).items
      .find((i) => result.items[i].id === 'Zephon');
    expect(zephonOn('medieval/mundane')).not.toBe(zephonOn('medieval/magical'));
  });

  test('a card is held once and each leaf lists the cards it carries', () => {
    const references = result.leaves.flatMap((l) => l.cards);
    expect(references.every((i) => Number.isInteger(i) && i >= 0 && i < result.cards.length)).toBe(true);
    expect(new Set(references).size).toBe(result.cards.length);
    expect(new Set(result.cards.map((c) => JSON.stringify(c))).size).toBe(result.cards.length);
  });

  test('an origin names its file by position in sourceFiles', () => {
    const field = tagline('medieval/mundane');
    expect(Number.isInteger(field.origin.file)).toBe(true);
    expect(fs.existsSync(result.sourceFiles[field.origin.file])).toBe(true);
    expect(field.layers[0].file).toBe(field.origin.file);
    expect(new Set(result.sourceFiles).size).toBe(result.sourceFiles.length);
  });

  test('a field a variant supplies points into the variant block and records each layer', () => {
    const field = tagline('medieval/mundane');
    const zephonStart = lineOf('- id: Zephon');
    const variantLine = lineOf('Tagline: /{Archivist turned courier}', zephonStart);
    const baseLine = lineOf('Tagline: Archivist turned courier', zephonStart);

    expect(field.origin.line).toBe(variantLine);
    expect(field.origin.line).toBeGreaterThan(baseLine);
    expect(field.origin.library).toBe('core');
    expect(field.layers.length).toBeGreaterThan(0);
    expect(field.layers[0].before).toBe('Archivist turned courier');
    expect(field.layers[field.layers.length - 1].after).toBe('Courier; former archivist');
    expect(field.value).toBe('Courier; former archivist');
  });

  test('the same field on a leaf without the variant has no layers and the base line', () => {
    const field = tagline('medieval/magical');
    const baseLine = lineOf('Tagline: Archivist turned courier', lineOf('- id: Zephon'));
    expect(field.layers).toEqual([]);
    expect(field.origin.line).toBe(baseLine);
    expect(field.value).toBe('Archivist turned courier');
  });
});

describe('preview of a project with problems', () => {
  const { preview } = require('../../src/compile');

  test('an unknown key is dropped and counted by default', () => {
    const { config } = smallProject({
      'items/items.yaml': widget('  render: {template: Item, wraper: curly}'),
    });
    const result = preview(config);
    expect(result.status).toBe('ok');
    expect(result.droppedKeys).toBe(1);
    expect(diagnosticCodes(result)).toContain('CL0201');
    expect(result.leaves.length).toBeGreaterThan(0);
  });

  test('an unknown key blocks the preview when tolerant is false', () => {
    const { config } = smallProject({
      'items/items.yaml': widget('  render: {template: Item, wraper: curly}'),
    });
    const result = preview(config, { tolerant: false });
    expect(result.status).toBe('blocked');
    expect(result.leaves).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.droppedKeys).toBe(0);
    expect(diagnosticCodes(result)).toContain('CL0201');
  });

  test('a syntax error blocks the preview and reports its position', () => {
    const { config } = smallProject({ 'items/items.yaml': '- id: Widget\n  name: [Widget\n' });
    const result = preview(config);
    expect(result.status).toBe('blocked');
    const finding = result.diagnostics.find((d) => d.code === 'CL0101');
    expect(finding).toBeDefined();
    expect(typeof finding.line).toBe('number');
    expect(typeof finding.col).toBe('number');
    expect(result.leaves).toEqual([]);
  });

  test('a compile-phase error does not block and is reported beside the compiled leaves', () => {
    const { config } = smallProject({
      'components/pe.yaml': 'sections:\n  cast:\n    slot: true\n',
      'compile.yaml': BASE_PROJECT['compile.yaml'].replace(
        'branches:', 'components:\n  plotEssential: ./components/pe.yaml\nbranches:',
      ),
      'items/items.yaml': widget('  render: {template: Item, plotEssential: {slot: casts}}'),
    });
    const result = preview(config);
    expect(result.status).toBe('ok');
    const finding = result.diagnostics.find((d) => d.code === 'CL0611');
    expect(finding).toMatchObject({ severity: 'error' });
    expect(result.leaves.length).toBeGreaterThan(0);
  });

  test('a duplicate template name blocks the preview with its coded error', () => {
    const { config } = smallProject({
      'templates/sub/Item.template': 'second',
    });
    const result = preview(config);
    expect(result.status).toBe('blocked');
    expect(result.diagnostics.some((d) => d.code.startsWith('CL'))).toBe(true);
  });
});

describe('preview with source overrides', () => {
  const { preview } = require('../../src/compile');

  test('an item file override changes the card and leaves the file on disk unchanged', () => {
    const { dir, config } = smallProject();
    const itemFile = path.join(dir, 'items', 'items.yaml');
    const onDisk = fs.readFileSync(itemFile, 'utf8');

    const plain = preview(config);
    const overridden = preview(config, {
      sources: { [itemFile]: widget('  render: {template: Item}', 'item from override') },
    });

    const firstCard = (result) => result.cards[result.leaves[0].cards[0]];
    expect(firstCard(plain).rendered).toContain('item on disk');
    expect(firstCard(overridden).rendered).toContain('item from override');
    expect(firstCard(overridden).rendered).not.toContain('item on disk');
    expect(fs.readFileSync(itemFile, 'utf8')).toBe(onDisk);
  });
});

describe('the compile module exports', () => {
  test('exposes compile and preview', () => {
    const exported = require('../../src/compile');
    expect(typeof exported.compile).toBe('function');
    expect(typeof exported.preview).toBe('function');
  });
});
