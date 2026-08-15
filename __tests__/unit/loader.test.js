'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildRegistry, mergeRegistries, loadTemplates,
  loadItemsFromDir, buildOverlays, loadCompileConfig, CODES,
} = require('../../src/loader');
const { Diagnostics } = require('../../src/diag');

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

  test('a template that still writes a fence is an ERROR naming the file (§8.3)', () => {
    const dir = makeTmpDir();
    writeTemplate(dir, 'Character', '## {$name.full}\n~~~\ntriggers: []\n~~~\nbody');
    const diagnostics = new Diagnostics();
    loadTemplates(dir, { diagnostics });
    expect(diagnostics.errors).toHaveLength(1);
    expect(diagnostics.errors[0].code).toBe(CODES.TEMPLATE_CONTAINS_FENCE);
    expect(diagnostics.errors[0].file).toContain('Character.template');
  });

  test('partials are checked for fences too — the envelope lived in one', () => {
    const dir = makeTmpDir();
    writePartial(dir, 'cardHeader', '## {$name.full}\n~~~\n~~~\n{wrapper}');
    const diagnostics = new Diagnostics();
    loadTemplates(dir, { diagnostics });
    expect(diagnostics.errors.map((d) => d.file.replace(/\\/g, '/')))
      .toEqual([expect.stringContaining('cardHeader.partial')]);
  });

  test('a body-only template loads clean', () => {
    const dir = makeTmpDir();
    writeTemplate(dir, 'Character', '{wrapper}{$body.tagline}{/wrapper}');
    const diagnostics = new Diagnostics();
    loadTemplates(dir, { diagnostics });
    expect(diagnostics.isEmpty()).toBe(true);
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
    const items = [{ name: 'Felicia', type: 'Character', _source: 'x.yaml' }];
    const reg = buildRegistry(items, 'test');
    expect(reg.has('felicia')).toBe(true);
    expect(reg.get('felicia').id).toBe('Felicia');
  });

  test('throws on duplicate id (case-insensitive)', () => {
    const items = [
      { id: 'Zephon', name: 'Zephon', _source: 'a.yaml' },
      { id: 'zephon', name: 'Zephon Alt', _source: 'b.yaml' },
    ];
    expect(() => buildRegistry(items, 'test')).toThrow(/Duplicate item ID/i);
  });

  test('skips import and include entries', () => {
    const items = [
      { import: 'Zephon', _source: 'a.yaml' },
      { include: 'some/file.yaml', _source: 'b.yaml' },
    ];
    const reg = buildRegistry(items, 'test');
    expect(reg.size).toBe(0);
  });

  test('stores multiple distinct items', () => {
    const items = [
      { id: 'Alpha', name: 'Alpha', _source: 'a.yaml' },
      { id: 'Beta', name: 'Beta', _source: 'b.yaml' },
    ];
    const reg = buildRegistry(items, 'test');
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
    const project = new Map([['felicia', { _source: 'items/Felicia.yaml' }]]);
    expect(() => mergeRegistries(canon, project)).toThrow(/felicia/i);
  });

  test('project-only items are included', () => {
    const canon = new Map();
    const project = new Map([['hero', { id: 'hero' }]]);
    const merged = mergeRegistries(canon, project);
    expect(merged.get('hero').id).toBe('hero');
  });
});

// ---------------------------------------------------------------------------
// loadItemsFromDir
// ---------------------------------------------------------------------------

describe('loadItemsFromDir', () => {
  test('returns empty array when directory is empty', () => {
    const dir = makeTmpDir();
    expect(loadItemsFromDir([dir])).toEqual([]);
  });

  test('loads a single-item YAML (non-array) and wraps it', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'item.yaml'), 'id: Aria\nname: Aria Voss\n', 'utf8');
    const items = loadItemsFromDir([dir]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('Aria');
    expect(items[0]._source).toContain('item.yaml');
  });

  test('loads a multi-item YAML (array sequence)', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'items.yaml'), '- id: Alpha\n- id: Beta\n', 'utf8');
    const items = loadItemsFromDir([dir]);
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('Alpha');
    expect(items[1].id).toBe('Beta');
  });

  test('normalizes vars: field to v: on each item', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'item.yaml'), 'id: Hero\nvars:\n  role: knight\n', 'utf8');
    const [item] = loadItemsFromDir([dir]);
    expect(item).toHaveProperty('v');
    expect(item).not.toHaveProperty('vars');
    expect(item.v.role).toBe('knight');
  });

  test('loads from multiple directories', () => {
    const dir1 = makeTmpDir();
    const dir2 = makeTmpDir();
    fs.writeFileSync(path.join(dir1, 'a.yaml'), 'id: Alpha\n', 'utf8');
    fs.writeFileSync(path.join(dir2, 'b.yaml'), 'id: Beta\n', 'utf8');
    expect(loadItemsFromDir([dir1, dir2])).toHaveLength(2);
  });

  test('accepts a scalar string path (not wrapped in array)', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'item.yaml'), 'id: Solo\n', 'utf8');
    const items = loadItemsFromDir(dir);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('Solo');
  });
});

// ---------------------------------------------------------------------------
// buildOverlays
// ---------------------------------------------------------------------------

describe('buildOverlays', () => {
  test('returns empty map when no items have import:', () => {
    expect(buildOverlays([{ id: 'Aria', _source: 'items.yaml' }]).size).toBe(0);
  });

  test('maps import: target (lowercased) to the item', () => {
    const item = { import: 'Felicia', _source: 'items.yaml' };
    const overlays = buildOverlays([item]);
    expect(overlays.has('felicia')).toBe(true);
    expect(overlays.get('felicia')).toBe(item);
  });

  test('key is stored lowercase regardless of import: casing', () => {
    const item = { import: 'MYCARD', _source: 'x.yaml' };
    expect(buildOverlays([item]).has('mycard')).toBe(true);
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

  test('ignores non-import items, includes only import items', () => {
    const items = [
      { id: 'Hero', _source: 'a.yaml' },
      { import: 'Villain', _source: 'b.yaml' },
    ];
    expect(buildOverlays(items).size).toBe(1);
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

  /**
   * v4 requires `version:`, `structure:` and `structure.output` (§6). Each fixture below
   * states only the keys it is actually testing, so the scaffolding is injected here —
   * otherwise every case would repeat three lines that have nothing to do with it.
   */
  function writeConfig(yaml) {
    let text = yaml;
    if (!/^version:/m.test(text)) text = `version: 4\n${text}`;
    if (!/^structure:/m.test(text)) text += '\nstructure:\n  output: ./out\n';
    else if (!/^ {2}output:/m.test(text)) text = text.replace(/^structure:\s*(\{\}\s*)?$/m, 'structure:\n  output: ./out');
    const p = path.join(tmpDir, 'compile.yaml');
    fs.writeFileSync(p, text, 'utf8');
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

  test('output is required — v3 silently defaulted it to ./output', () => {
    // The old default wrote a tree somewhere the author was not looking. A missing
    // required key is the better failure (§6).
    const p = path.join(tmpDir, 'compile.yaml');
    fs.writeFileSync(p, 'version: 4\nstructure:\n  input:\n    items: []\n', 'utf8');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadCompileConfig(p)).toThrow(/Configuration has/);
    spy.mockRestore();
  });

  test('version is required — its absence is what identifies a v3 project', () => {
    const p = path.join(tmpDir, 'compile.yaml');
    fs.writeFileSync(p, 'structure:\n  output: ./out\n', 'utf8');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadCompileConfig(p)).toThrow(/Configuration has/);
    spy.mockRestore();
  });

  test('resolves structure.reports relative to config dir', () => {
    // Renamed from `overview:` — the directory now holds diff, seed map, overview, item
    // sizes, leaf review and inventory, so the old name described one of its contents.
    const cfgPath = writeConfig('structure:\n  output: ./out\n  reports: ./reviews\n');
    expect(loadCompileConfig(cfgPath)._resolvedReports).toBe(path.resolve(tmpDir, 'reviews'));
  });

  test('_resolvedReports is null when structure.reports is not specified', () => {
    const cfgPath = writeConfig('structure:\n  output: ./out\n');
    expect(loadCompileConfig(cfgPath)._resolvedReports).toBeNull();
  });

  test('resolves items sequence to absolute paths', () => {
    const cfgPath = writeConfig('structure:\n  input:\n    items:\n      - ./items\n');
    expect(loadCompileConfig(cfgPath)._resolvedItems)
      .toEqual([path.resolve(tmpDir, 'items')]);
  });

  test('expands {%variable} and canon names in items paths', () => {
    // Canon names are auto-exposed as variables (§6.1), so `{%Base}` does what `{@Base}`
    // used to — one naming system instead of two.
    const cfgPath = writeConfig([
      'variables:',
      '  root: shared',
      'structure:',
      '  output: ./out',
      '  input:',
      '    canon:',
      '      Base: ./base',
      '    items:',
      '      - "{%root}/Canon"',
      '      - "{%Base}/extra"',
    ].join('\n') + '\n');
    const { _resolvedItems } = loadCompileConfig(cfgPath);
    expect(_resolvedItems[0]).toBe(path.resolve(tmpDir, 'shared/Canon'));
    expect(_resolvedItems[1]).toBe(path.resolve(tmpDir, 'base/extra'));
  });

  test('resolves canon mapping entries to absolute paths', () => {
    const cfgPath = writeConfig('structure:\n  input:\n    canon:\n      Core: ./canon/core\n');
    const { _resolvedCanon } = loadCompileConfig(cfgPath);
    expect(_resolvedCanon.get('Core')).toBe(path.resolve(tmpDir, 'canon/core'));
  });

  test('a canon entry may reference a sibling canon name', () => {
    // v3 needed a bespoke two-pass resolver for this. Canon names are variables now, so
    // it falls out of ordinary variable resolution.
    const cfgPath = writeConfig([
      'structure:',
      '  output: ./out',
      '  input:',
      '    canon:',
      '      Base: ./base',
      '      Ext: "{%Base}/ext"',
    ].join('\n') + '\n');
    const { _resolvedCanon } = loadCompileConfig(cfgPath);
    const ext = _resolvedCanon.get('Ext');
    expect(ext).toContain('base');
    expect(ext).toContain('ext');
  });

  test('a canon name colliding with a declared variable is an ERROR', () => {
    const p = path.join(tmpDir, 'compile.yaml');
    fs.writeFileSync(p, [
      'version: 4',
      'variables:',
      '  Base: ./somewhere',
      'structure:',
      '  output: ./out',
      '  input:',
      '    canon:',
      '      Base: ./base',
    ].join('\n') + '\n', 'utf8');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadCompileConfig(p)).toThrow(/Configuration has/);
    spy.mockRestore();
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
