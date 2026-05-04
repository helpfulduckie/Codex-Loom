'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildRegistry, mergeRegistries, loadTemplates } = require('../../src/loader');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'));
}

function writeTemplate(dir, name, content) {
  fs.writeFileSync(path.join(dir, `${name}.template`), content, 'utf8');
}

function writeTemplateIn(dir, subdir, name, content) {
  const full = path.join(dir, subdir);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, `${name}.template`), content, 'utf8');
}

// ---------------------------------------------------------------------------
// loadTemplates
// ---------------------------------------------------------------------------

describe('loadTemplates', () => {
  test('single directory — loads templates by lowercase name', () => {
    const dir = makeTmpDir();
    writeTemplate(dir, 'Character', 'hello {$name}');
    const map = loadTemplates(dir);
    expect(map.has('character')).toBe(true);
    expect(map.get('character').content).toBe('hello {$name}');
  });

  test('single directory — errors on intra-directory duplicate', () => {
    const dir = makeTmpDir();
    writeTemplateIn(dir, 'A', 'character', 'version A');
    writeTemplateIn(dir, 'B', 'character', 'version B');
    expect(() => loadTemplates(dir)).toThrow(/Duplicate template name "character"/);
  });

  test('multiple directories — all templates loaded when no collision', () => {
    const dir1 = makeTmpDir();
    const dir2 = makeTmpDir();
    writeTemplate(dir1, 'Character', 'char v1');
    writeTemplate(dir2, 'Location', 'loc v1');
    const map = loadTemplates([dir1, dir2]);
    expect(map.has('character')).toBe(true);
    expect(map.has('location')).toBe(true);
  });

  test('multiple directories — later directory overrides earlier on name collision', () => {
    const dir1 = makeTmpDir();
    const dir2 = makeTmpDir();
    writeTemplate(dir1, 'Location', 'base location');
    writeTemplate(dir2, 'Location', 'project location');
    const map = loadTemplates([dir1, dir2]);
    expect(map.get('location').content).toBe('project location');
  });

  test('multiple directories — intra-directory duplicate still throws', () => {
    const dir1 = makeTmpDir();
    const dir2 = makeTmpDir();
    writeTemplateIn(dir1, 'X', 'character', 'version A');
    writeTemplateIn(dir1, 'Y', 'character', 'version B');
    writeTemplate(dir2, 'Location', 'loc');
    expect(() => loadTemplates([dir1, dir2])).toThrow(/Duplicate template name "character"/);
  });

  test('single string still works (no regression)', () => {
    const dir = makeTmpDir();
    writeTemplate(dir, 'Faction', 'faction content');
    const map = loadTemplates(dir);
    expect(map.get('faction').content).toBe('faction content');
  });
});

describe('buildRegistry', () => {
  test('normalizes id keys to lowercase and backfills id from name', () => {
    const cards = [{ name: 'Felicia', type: 'Character', _source: 'x.yaml' }];
    const reg = buildRegistry(cards, 'test');
    expect(reg.has('felicia')).toBe(true);
    expect(reg.get('felicia').id).toBe('Felicia');
  });

  test('throws on duplicate id (case-insensitive)', () => {
    const cards = [
      { id: 'Zephon', name: 'Zephon', _source: 'a.yaml' },
      { id: 'zephon', name: 'Zephon Alt', _source: 'b.yaml' },
    ];
    expect(() => buildRegistry(cards, 'test')).toThrow(/Duplicate card ID/i);
  });

  test('skips import and include entries', () => {
    const cards = [
      { import: 'Zephon', _source: 'a.yaml' },
      { include: 'some/file.yaml', _source: 'b.yaml' },
    ];
    const reg = buildRegistry(cards, 'test');
    expect(reg.size).toBe(0);
  });

  test('stores multiple distinct cards', () => {
    const cards = [
      { id: 'Alpha', name: 'Alpha', _source: 'a.yaml' },
      { id: 'Beta', name: 'Beta', _source: 'b.yaml' },
    ];
    const reg = buildRegistry(cards, 'test');
    expect(reg.size).toBe(2);
    expect(reg.has('alpha')).toBe(true);
    expect(reg.has('beta')).toBe(true);
  });
});

describe('mergeRegistries', () => {
  test('merges disjoint registries', () => {
    const canon = new Map([['a', { id: 'a' }]]);
    const project = new Map([['b', { id: 'b' }]]);
    const merged = mergeRegistries(canon, project);
    expect(merged.size).toBe(2);
    expect(merged.has('a')).toBe(true);
    expect(merged.has('b')).toBe(true);
  });

  test('throws when same id appears in both registries', () => {
    const canon = new Map([['felicia', { _source: 'canon/Felicia.yaml' }]]);
    const project = new Map([['felicia', { _source: 'cards/Felicia.yaml' }]]);
    expect(() => mergeRegistries(canon, project)).toThrow(/felicia/i);
  });

  test('project-only cards are included', () => {
    const canon = new Map();
    const project = new Map([['hero', { id: 'hero' }]]);
    const merged = mergeRegistries(canon, project);
    expect(merged.get('hero').id).toBe('hero');
  });
});
