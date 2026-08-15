'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Diagnostics } = require('../../src/diag');
const { CODES: SCHEMA_CODES } = require('../../src/schema');
const {
  loadItemsFromDir, buildRegistry, mergeRegistries, buildOverlays,
  buildCanonRegistry, resolveIncludes, findConfigEntry, CODES,
} = require('../../src/loader/registry');
const { YAML_SUFFIXES, CONFIG_BASENAMES } = require('../../src/util');

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-reg-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function write(relPath, content) {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function loadWithDiagnostics(dir = tmpDir) {
  const diagnostics = new Diagnostics();
  const items = loadItemsFromDir([dir], { diagnostics });
  return { items, diagnostics, codes: diagnostics.all.map((d) => d.code) };
}

describe('file discovery across every accepted suffix (§4.6)', () => {
  test.each(YAML_SUFFIXES)('loads %s', (suffix) => {
    write(`Codex/item${suffix}`, 'id: A\n');
    expect(loadItemsFromDir([tmpDir]).map((i) => i.id)).toEqual(['A']);
  });

  test('.yml is no longer silently ignored', () => {
    write('Codex/a.yml', 'id: A\n');
    expect(loadItemsFromDir([tmpDir])).toHaveLength(1);
  });

  test('non-YAML files are not loaded', () => {
    write('Codex/notes.md', 'id: A\n');
    write('Codex/tpl.template', 'x');
    expect(loadItemsFromDir([tmpDir])).toHaveLength(0);
  });

  test('descends into nested directories', () => {
    write('Codex/deep/deeper/a.cl.yaml', 'id: A\n');
    expect(loadItemsFromDir([tmpDir])).toHaveLength(1);
  });

  test('a missing directory yields nothing rather than throwing', () => {
    expect(loadItemsFromDir([path.join(tmpDir, 'nope')])).toEqual([]);
  });
});

describe('item loading', () => {
  test('a sequence file yields one item per entry', () => {
    write('a.cl.yaml', '- id: A\n- id: B\n');
    expect(loadItemsFromDir([tmpDir]).map((i) => i.id)).toEqual(['A', 'B']);
  });

  test('a single-mapping file yields one item', () => {
    write('a.cl.yaml', 'id: A\n');
    expect(loadItemsFromDir([tmpDir]).map((i) => i.id)).toEqual(['A']);
  });

  test('every item is stamped with its source path', () => {
    const file = write('a.cl.yaml', 'id: A\n');
    expect(loadItemsFromDir([tmpDir])[0]._source).toBe(file);
  });

  test('an empty file is skipped with a diagnostic', () => {
    write('empty.cl.yaml', '');
    const { items, codes } = loadWithDiagnostics();
    expect(items).toEqual([]);
    expect(codes).toContain(CODES.EMPTY_FILE);
  });

  test('a null document within a sequence is skipped', () => {
    write('a.cl.yaml', '- id: A\n- ~\n');
    const { items, codes } = loadWithDiagnostics();
    expect(items).toHaveLength(1);
    expect(codes).toContain(CODES.NULL_DOCUMENT);
  });

  test('variable-block aliases collapse to v', () => {
    write('a.cl.yaml', 'id: A\nvars:\n  k: 1\n');
    expect(loadItemsFromDir([tmpDir])[0]).toMatchObject({ v: { k: 1 } });
  });

  test('sibling aliases merge with a diagnostic', () => {
    write('a.cl.yaml', 'id: A\nvars:\n  k: 1\nvariables:\n  j: 2\n');
    const { items, codes } = loadWithDiagnostics();
    expect(items[0].v).toEqual({ k: 1, j: 2 });
    expect(codes).toContain(CODES.MULTIPLE_VAR_ALIASES);
  });

  test('an id containing ":" reports CL0144 on the diagnostics bus (§17.2)', () => {
    write('a.cl.yaml', 'id: "grim:magic"\n');
    const { diagnostics, codes } = loadWithDiagnostics();
    expect(codes).toContain(CODES.ID_CONTAINS_COLON);
    expect(diagnostics.errors.some((d) => d.code === CODES.ID_CONTAINS_COLON)).toBe(true);
  });

  test('an id containing ":" throws when no diagnostics bus is supplied', () => {
    write('a.cl.yaml', 'id: "grim:magic"\n');
    expect(() => loadItemsFromDir([tmpDir])).toThrow(/contains ":"/);
  });
});

describe('item schema validation (§4.3)', () => {
  test('the canonical case: triggers outside aid suggests relocation', () => {
    write('monsters.cl.yaml', '- id: Wyvern\n  aid:\n    type: Race\n  triggers: Wyvern\n');
    const { diagnostics, codes } = loadWithDiagnostics();
    expect(codes).toContain(SCHEMA_CODES.MISPLACED_KEY);
    expect(diagnostics.errors[0].hint).toContain('"triggers" is valid under "aid:"');
  });

  test('the diagnostic names the item, not the array index', () => {
    write('monsters.cl.yaml', '- id: Wyvern\n  triggers: Wyvern\n');
    expect(loadWithDiagnostics().diagnostics.errors[0].message).toContain('in item "Wyvern"');
  });

  test('the diagnostic points at the offending line', () => {
    write('monsters.cl.yaml', '- id: Wyvern\n  aid:\n    type: Race\n  triggers: Wyvern\n');
    expect(loadWithDiagnostics().diagnostics.errors[0].line).toBe(4);
  });

  test('a misspelled key suggests the right spelling', () => {
    write('a.cl.yaml', 'id: A\nvarients: []\n');
    expect(loadWithDiagnostics().diagnostics.errors[0].hint).toBe('Did you mean "variants"?');
  });

  test('a misplaced nested key is caught too', () => {
    write('a.cl.yaml', 'id: A\naid:\n  type: X\n  template: Y\n');
    const { diagnostics } = loadWithDiagnostics();
    expect(diagnostics.errors[0].hint).toContain('"template" is valid under "render:"');
  });

  test('open namespaces accept arbitrary keys', () => {
    write('a.cl.yaml', 'id: A\nbody:\n  Anything: 1\n  At All: 2\nv:\n  x: 1\npronouns:\n  she: her\n');
    expect(loadWithDiagnostics().diagnostics.hasErrors()).toBe(false);
  });

  test('the full v4 item surface validates clean', () => {
    write('a.cl.yaml', [
      'id: A',
      'name: {display: A, full: A Vale}',
      'aid: {type: Character, title: T, triggers: [a, b]}',
      "notes: '[e]'",
      'render: {template: Character, wrapper: none}',
      'body: {Tagline: x}',
      'variants: {alt: {body: {Tagline: y}}}',
      'branches: {subject: alt}',
      'pronouns: {she: her}',
      'v: {k: 1}',
      '',
    ].join('\n'));
    expect(loadWithDiagnostics().diagnostics.hasErrors()).toBe(false);
  });

  test('aid.known and aid.encapsulate are gone, not silently accepted', () => {
    // Both left with the envelope (§8.2.1, §8.4). A project that still declares one is
    // half-migrated, and an unknown-key ERROR naming the key is the useful answer.
    write('a.cl.yaml', 'id: A\naid: {type: Character, known: true, encapsulate: false}\n');
    const { diagnostics } = loadWithDiagnostics();
    expect(diagnostics.hasErrors()).toBe(true);
    const messages = diagnostics.errors.map((d) => d.message).join(' ');
    expect(messages).toContain('known');
    expect(messages).toContain('encapsulate');
  });

  test('later-phase item keys are recognized rather than rejected', () => {
    write('a.cl.yaml', 'id: A\nkind: reference\nnotes:\n  marker: "[e]"\n');
    const { diagnostics } = loadWithDiagnostics();
    expect(diagnostics.hasErrors()).toBe(false);
    expect(diagnostics.warnings.every((d) => d.message.includes('not yet implemented'))).toBe(true);
  });

  test('validation is skipped when no bus is supplied, preserving the old call shape', () => {
    write('a.cl.yaml', 'id: A\nbogusKey: 1\n');
    expect(() => loadItemsFromDir([tmpDir])).not.toThrow();
  });
});

describe('registries', () => {
  const item = (id, source) => ({ id, _source: source || `${id}.yaml` });

  test('keys by lowercased id', () => {
    expect([...buildRegistry([item('Aness')], 'p').keys()]).toEqual(['aness']);
  });

  test('falls back to name when there is no id', () => {
    expect(buildRegistry([{ name: 'Voss', _source: 'a' }], 'p').has('voss')).toBe(true);
  });

  test('import and include defs are skipped', () => {
    const items = [{ import: 'X', _source: 'a' }, { include: './y', _source: 'b' }];
    expect(buildRegistry(items, 'p').size).toBe(0);
  });

  test('an item with neither id nor name throws', () => {
    expect(() => buildRegistry([{ _source: 'a' }], 'proj')).toThrow('missing both id and name');
  });

  test('a duplicate id throws, naming both sources', () => {
    expect(() => buildRegistry([item('A', 'one.yaml'), item('A', 'two.yaml')], 'proj'))
      .toThrow(/one\.yaml[\s\S]*two\.yaml/);
  });

  test('rename-on-import (id + import) registers under the local id (§17.4)', () => {
    const items = [{ id: 'Dragon', import: 'wyvern', _source: 'a.yaml' }];
    const registry = buildRegistry(items, 'p');
    expect([...registry.keys()]).toEqual(['dragon']);
    expect(registry.get('dragon').import).toBe('wyvern');
  });

  test('a bare import (no id) is still skipped', () => {
    const items = [{ import: 'wyvern', _source: 'a.yaml' }];
    expect(buildRegistry(items, 'p').size).toBe(0);
  });

  test('two renamed imports claiming the same local id throw the existing duplicate error', () => {
    const items = [
      { id: 'Dragon', import: 'wyvern', _source: 'one.yaml' },
      { id: 'Dragon', import: 'drake', _source: 'two.yaml' },
    ];
    expect(() => buildRegistry(items, 'proj')).toThrow(/Duplicate item ID "dragon"/);
  });

  test('mergeRegistries unions canon and project', () => {
    const merged = mergeRegistries(buildRegistry([item('A')], 'c'), buildRegistry([item('B')], 'p'));
    expect([...merged.keys()].sort()).toEqual(['a', 'b']);
  });

  test('mergeRegistries throws on a canon/project collision', () => {
    expect(() => mergeRegistries(buildRegistry([item('A')], 'c'), buildRegistry([item('A')], 'p')))
      .toThrow('exists in both canon and project');
  });
});

describe('overlays', () => {
  test('collects import-only defs keyed by target', () => {
    const overlays = buildOverlays([{ import: 'Aness', _source: 'a' }]);
    expect(overlays.get('aness')).toBeDefined();
  });

  test('ignores defs with no import', () => {
    expect(buildOverlays([{ id: 'A', _source: 'a' }]).size).toBe(0);
  });

  test('keeps the first of a duplicate pair and reports it', () => {
    const diagnostics = new Diagnostics();
    const overlays = buildOverlays(
      [{ import: 'A', _source: 'one' }, { import: 'A', _source: 'two' }],
      { diagnostics }
    );
    expect(overlays.get('a')._source).toBe('one');
    expect(diagnostics.warnings[0].code).toBe(CODES.DUPLICATE_OVERLAY);
  });

  test('a renamed import (id + import) is not collected as an overlay (§17.4)', () => {
    const overlays = buildOverlays([{ id: 'Dragon', import: 'wyvern', _source: 'a' }]);
    expect(overlays.size).toBe(0);
  });

  test('a bare import alongside a renamed one still captures the bare one', () => {
    const overlays = buildOverlays([
      { id: 'Dragon', import: 'wyvern', _source: 'a' },
      { import: 'wyvern', _source: 'b' },
    ]);
    expect(overlays.get('wyvern')._source).toBe('b');
  });
});

describe('canon registry', () => {
  test('loads every named canon directory', () => {
    write('canonA/a.cl.yaml', 'id: A\n');
    write('canonB/b.cl.yaml', 'id: B\n');
    const map = new Map([['a', path.join(tmpDir, 'canonA')], ['b', path.join(tmpDir, 'canonB')]]);
    expect([...buildCanonRegistry(map).keys()].sort()).toEqual(['a', 'b']);
  });

  test('a duplicate id across canon sources loads both, unqualified and unreachable (§17.3)', () => {
    write('canonA/a.cl.yaml', 'id: Dup\n');
    write('canonB/b.cl.yaml', 'id: Dup\n');
    const map = new Map([['a', path.join(tmpDir, 'canonA')], ['b', path.join(tmpDir, 'canonB')]]);
    const registry = buildCanonRegistry(map);

    expect(registry.has('dup')).toBe(false);
    expect(registry.ambiguous.get('dup')).toHaveLength(2);
    expect(registry.qualified.get('a:dup')).toBeTruthy();
    expect(registry.qualified.get('b:dup')).toBeTruthy();
    expect(registry.itemCount).toBe(2);
  });

  test('a missing canon directory warns and continues', () => {
    const diagnostics = new Diagnostics();
    const map = new Map([['gone', path.join(tmpDir, 'nope')]]);
    expect(buildCanonRegistry(map, { diagnostics }).size).toBe(0);
    expect(diagnostics.warnings).toHaveLength(1);
  });

  test('an absent map yields an empty registry', () => {
    expect(buildCanonRegistry(null).size).toBe(0);
  });
});

describe('config entry-point discovery (§4.6)', () => {
  test('finds each accepted basename', () => {
    for (const name of CONFIG_BASENAMES) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-entry-'));
      fs.writeFileSync(path.join(dir, name), 'x: 1\n');
      expect(findConfigEntry(dir, CONFIG_BASENAMES)).toBe(path.join(dir, name));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when there is no config', () => {
    expect(findConfigEntry(tmpDir, CONFIG_BASENAMES)).toBeNull();
  });

  test('two configs in one directory is an error, not a silent preference', () => {
    write('compile.cl.yaml', 'x: 1\n');
    write('compile.yaml', 'x: 1\n');
    expect(() => findConfigEntry(tmpDir, CONFIG_BASENAMES)).toThrow('More than one compile config');
  });

  test('the error names every candidate it found', () => {
    write('compile.cl.yaml', 'x: 1\n');
    write('compile.yml', 'x: 1\n');
    expect(() => findConfigEntry(tmpDir, CONFIG_BASENAMES)).toThrow(/compile\.cl\.yaml[\s\S]*compile\.yml/);
  });
});
