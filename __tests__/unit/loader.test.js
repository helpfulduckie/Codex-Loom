'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildRegistry, mergeRegistries, loadTemplates,
  loadCardsFromDir, buildOverlays, loadCompileConfig,
} = require('../../src/loader');

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

function writePartial(dir, name, content) {
  fs.writeFileSync(path.join(dir, `${name}.partial`), content, 'utf8');
}

// ---------------------------------------------------------------------------
// loadTemplates
// ---------------------------------------------------------------------------

describe('loadTemplates', () => {
  test('single directory — loads templates by lowercase name', () => {
    const dir = makeTmpDir();
    writeTemplate(dir, 'Character', 'hello {$name}');
    const { templates: map } = loadTemplates(dir);
    expect(map.has('character')).toBe(true);
    expect(map.get('character').content).toBe('hello {$name}');
  });

  test('single directory — errors on intra-directory duplicate', () => {
    const dir = makeTmpDir();
    writeTemplateIn(dir, 'A', 'character', 'version A');
    writeTemplateIn(dir, 'B', 'character', 'version B');
    expect(() => loadTemplates(dir)).toThrow(/Duplicate .template name "character"/);
  });

  test('multiple directories — all templates loaded when no collision', () => {
    const dir1 = makeTmpDir();
    const dir2 = makeTmpDir();
    writeTemplate(dir1, 'Character', 'char v1');
    writeTemplate(dir2, 'Location', 'loc v1');
    const { templates: map } = loadTemplates([dir1, dir2]);
    expect(map.has('character')).toBe(true);
    expect(map.has('location')).toBe(true);
  });

  test('multiple directories — later directory overrides earlier on name collision', () => {
    const dir1 = makeTmpDir();
    const dir2 = makeTmpDir();
    writeTemplate(dir1, 'Location', 'base location');
    writeTemplate(dir2, 'Location', 'project location');
    const { templates: map } = loadTemplates([dir1, dir2]);
    expect(map.get('location').content).toBe('project location');
  });

  test('multiple directories — intra-directory duplicate still throws', () => {
    const dir1 = makeTmpDir();
    const dir2 = makeTmpDir();
    writeTemplateIn(dir1, 'X', 'character', 'version A');
    writeTemplateIn(dir1, 'Y', 'character', 'version B');
    writeTemplate(dir2, 'Location', 'loc');
    expect(() => loadTemplates([dir1, dir2])).toThrow(/Duplicate .template name "character"/);
  });

  test('single string still works (no regression)', () => {
    const dir = makeTmpDir();
    writeTemplate(dir, 'Faction', 'faction content');
    const { templates: map } = loadTemplates(dir);
    expect(map.get('faction').content).toBe('faction content');
  });

  test('partials are loaded alongside templates', () => {
    const dir = makeTmpDir();
    writeTemplate(dir, 'Character', 'hello');
    writePartial(dir, 'Header', 'HEADER');
    const { templates, partials } = loadTemplates(dir);
    expect(templates.has('character')).toBe(true);
    expect(partials.has('header')).toBe(true);
    expect(partials.get('header').content).toBe('HEADER');
  });

  test('partials errors on intra-directory duplicate', () => {
    const dir = makeTmpDir();
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    writePartial(dir, 'shared', 'v1');
    writePartial(sub, 'shared', 'v2');
    expect(() => loadTemplates(dir)).toThrow(/Duplicate .partial name "shared"/);
  });

  test('empty directory returns empty partials map', () => {
    const dir = makeTmpDir();
    const { partials } = loadTemplates(dir);
    expect(partials.size).toBe(0);
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

// ---------------------------------------------------------------------------
// loadCardsFromDir
// ---------------------------------------------------------------------------

describe('loadCardsFromDir', () => {
  test('returns empty array when directory is empty', () => {
    const dir = makeTmpDir();
    expect(loadCardsFromDir([dir])).toEqual([]);
  });

  test('loads a single-card YAML (non-array) and wraps it', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'card.yaml'), 'id: Aria\nname: Aria Voss\n', 'utf8');
    const cards = loadCardsFromDir([dir]);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('Aria');
    expect(cards[0]._source).toContain('card.yaml');
  });

  test('loads a multi-card YAML (array sequence)', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'cards.yaml'), '- id: Alpha\n- id: Beta\n', 'utf8');
    const cards = loadCardsFromDir([dir]);
    expect(cards).toHaveLength(2);
    expect(cards[0].id).toBe('Alpha');
    expect(cards[1].id).toBe('Beta');
  });

  test('normalizes vars: field to v: on each card', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'card.yaml'), 'id: Hero\nvars:\n  role: knight\n', 'utf8');
    const [card] = loadCardsFromDir([dir]);
    expect(card).toHaveProperty('v');
    expect(card).not.toHaveProperty('vars');
    expect(card.v.role).toBe('knight');
  });

  test('loads from multiple directories', () => {
    const dir1 = makeTmpDir();
    const dir2 = makeTmpDir();
    fs.writeFileSync(path.join(dir1, 'a.yaml'), 'id: Alpha\n', 'utf8');
    fs.writeFileSync(path.join(dir2, 'b.yaml'), 'id: Beta\n', 'utf8');
    expect(loadCardsFromDir([dir1, dir2])).toHaveLength(2);
  });

  test('accepts a scalar string path (not wrapped in array)', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'card.yaml'), 'id: Solo\n', 'utf8');
    const cards = loadCardsFromDir(dir);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('Solo');
  });
});

// ---------------------------------------------------------------------------
// buildOverlays
// ---------------------------------------------------------------------------

describe('buildOverlays', () => {
  test('returns empty map when no cards have import:', () => {
    expect(buildOverlays([{ id: 'Aria', _source: 'cards.yaml' }]).size).toBe(0);
  });

  test('maps import: target (lowercased) to the card', () => {
    const card = { import: 'Felicia', _source: 'cards.yaml' };
    const overlays = buildOverlays([card]);
    expect(overlays.has('felicia')).toBe(true);
    expect(overlays.get('felicia')).toBe(card);
  });

  test('key is stored lowercase regardless of import: casing', () => {
    const card = { import: 'MYCARD', _source: 'x.yaml' };
    expect(buildOverlays([card]).has('mycard')).toBe(true);
  });

  test('duplicate import: target warns and keeps first', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const first  = { import: 'Felicia', _source: 'a.yaml' };
    const second = { import: 'Felicia', _source: 'b.yaml' };
    const overlays = buildOverlays([first, second]);
    expect(overlays.get('felicia')).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Felicia'));
    warn.mockRestore();
  });

  test('ignores non-import cards, includes only import cards', () => {
    const cards = [
      { id: 'Hero', _source: 'a.yaml' },
      { import: 'Villain', _source: 'b.yaml' },
    ];
    expect(buildOverlays(cards).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// loadCompileConfig
// ---------------------------------------------------------------------------

describe('loadCompileConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function writeConfig(yaml) {
    const p = path.join(tmpDir, 'compile.yaml');
    fs.writeFileSync(p, yaml, 'utf8');
    return p;
  }

  test('_base is set to the directory containing compile.yaml', () => {
    const cfgPath = writeConfig('structure: {}\n');
    expect(loadCompileConfig(cfgPath)._base).toBe(tmpDir);
  });

  test('resolves structure.output relative to config dir', () => {
    const cfgPath = writeConfig('structure:\n  output: ./out\n');
    expect(loadCompileConfig(cfgPath)._resolvedOutput).toBe(path.resolve(tmpDir, 'out'));
  });

  test('defaults output to ./output when not specified', () => {
    const cfgPath = writeConfig('structure: {}\n');
    expect(loadCompileConfig(cfgPath)._resolvedOutput).toBe(path.resolve(tmpDir, 'output'));
  });

  test('resolves structure.overview relative to config dir', () => {
    const cfgPath = writeConfig('structure:\n  output: ./out\n  overview: ./reviews\n');
    expect(loadCompileConfig(cfgPath)._resolvedOverview).toBe(path.resolve(tmpDir, 'reviews'));
  });

  test('_resolvedOverview is null when structure.overview is not specified', () => {
    const cfgPath = writeConfig('structure:\n  output: ./out\n');
    expect(loadCompileConfig(cfgPath)._resolvedOverview).toBeNull();
  });

  test('resolves cards sequence to absolute paths', () => {
    const cfgPath = writeConfig('structure:\n  input:\n    cards:\n      - ./cards\n');
    expect(loadCompileConfig(cfgPath)._resolvedCards)
      .toEqual([path.resolve(tmpDir, 'cards')]);
  });

  test('expands {%variable} and {@canon} in cards paths (parity with templates)', () => {
    const cfgPath = writeConfig([
      'variables:',
      '  root: shared',
      'structure:',
      '  input:',
      '    canon:',
      '      Base: ./base',
      '    cards:',
      '      - "{%root}/Canon"',
      '      - "{@Base}/extra"',
    ].join('\n') + '\n');
    const { _resolvedCards } = loadCompileConfig(cfgPath);
    expect(_resolvedCards[0]).toBe(path.resolve(tmpDir, 'shared/Canon'));
    expect(_resolvedCards[1]).toBe(path.resolve(tmpDir, 'base/extra'));
  });

  test('resolves canon mapping entries to absolute paths', () => {
    const cfgPath = writeConfig('structure:\n  input:\n    canon:\n      Core: ./canon/core\n');
    const { _resolvedCanon } = loadCompileConfig(cfgPath);
    expect(_resolvedCanon.get('Core')).toBe(path.resolve(tmpDir, 'canon/core'));
  });

  test('two-pass canon: entry using {@Name} resolves after first pass', () => {
    const cfgPath = writeConfig([
      'structure:',
      '  input:',
      '    canon:',
      '      Base: ./base',
      '      Ext: "{@Base}/ext"',
    ].join('\n') + '\n');
    const { _resolvedCanon } = loadCompileConfig(cfgPath);
    const ext = _resolvedCanon.get('Ext');
    expect(ext).toContain('base');
    expect(ext).toContain('ext');
  });

  test('passes through protagonist, variables, and branches', () => {
    const cfgPath = writeConfig(
      'protagonist: Aria\nvariables:\n  role: knight\nbranches:\n  main: {}\n'
    );
    const config = loadCompileConfig(cfgPath);
    expect(config.protagonist).toBe('Aria');
    expect(config.variables).toEqual({ role: 'knight' });
    expect(config.branches).toHaveProperty('main');
  });
});
