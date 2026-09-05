'use strict';

const fs = require('fs');
const path = require('path');
const { Diagnostics, CODES } = require('../../src/diag');
const {
  loadItemsFromDir, buildRegistry, mergeRegistries,
  buildCanonRegistry, resolveIncludes, findConfigEntry,
} = require('../../src/loader/registry');
const { YAML_SUFFIXES, CONFIG_BASENAMES } = require('../../src/util');
const { withTmpDir } = require('../helpers/project');

let tmpDir;
beforeEach(() => { tmpDir = withTmpDir(); });

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

describe('a file that will not load is one coded ERROR, and the walk goes on (CL0101)', () => {
  test('a malformed item file is CL0101 naming the file, and its sibling still loads', () => {
    const bad = write('Codex/bad.cl.yaml', 'id: Bad\nname: [unclosed\n');
    write('Codex/good.cl.yaml', 'id: Good\nname: Good\n');
    const { items, diagnostics } = loadWithDiagnostics();
    expect(items.map((i) => i.id)).toEqual(['Good']);
    const parseFailures = diagnostics.errors.filter((d) => d.code === CODES.YAML_PARSE_FAILED);
    expect(parseFailures).toHaveLength(1);
    expect(parseFailures[0].file).toBe(bad);
    expect(parseFailures[0].message).toContain('Failed to load YAML');
    expect(diagnostics.all.map((d) => d.code)).not.toContain(CODES.YAML_FILE_UNREADABLE);
  });
});

describe('file discovery across every accepted suffix', () => {
  test.each(YAML_SUFFIXES)('loads %s', (suffix) => {
    write(`Codex/item${suffix}`, 'id: A\n');
    expect(loadItemsFromDir([tmpDir]).map((i) => i.id)).toEqual(['A']);
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

  test('library.cl.yaml is excluded from item loading', () => {
    // Written by hand, ahead of any tooling — a manifest opening with a string `name:`
    // fails the component-shape skip and would otherwise register as a phantom item and
    // raise unknown-key errors on its own `roles:`/`placeholders:`/`requires:` keys.
    write('Esudia/library.cl.yaml', 'name: Esudia\ndescription: Esudia library set.\nroles:\n  LI:\n    description: x\n');
    write('Esudia/Malcolm.cl.yaml', 'id: Malcolm\nname: Malcolm\n');
    const { items, diagnostics } = loadWithDiagnostics();
    expect(items.map((i) => i.id)).toEqual(['Malcolm']);
    expect(diagnostics.all).toHaveLength(0);
  });

  test('the exclusion is case-insensitive on the basename', () => {
    write('Esudia/Library.CL.YAML', 'name: Esudia\nroles:\n  LI: {}\n');
    expect(loadItemsFromDir([tmpDir])).toEqual([]);
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
    expect(codes).toContain(CODES.YAML_EMPTY_FILE);
  });

  test('a null document within a sequence is skipped', () => {
    write('a.cl.yaml', '- id: A\n- ~\n');
    const { items, codes } = loadWithDiagnostics();
    expect(items).toHaveLength(1);
    expect(codes).toContain(CODES.YAML_NULL_DOCUMENT);
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

  test('an id containing ":" reports CL0144 on the diagnostics bus', () => {
    write('a.cl.yaml', 'id: "grim:magic"\n');
    const { diagnostics, codes } = loadWithDiagnostics();
    expect(codes).toContain(CODES.ID_CONTAINS_COLON);
    expect(diagnostics.errors.some((d) => d.code === CODES.ID_CONTAINS_COLON)).toBe(true);
  });

});

describe('item schema validation', () => {
  test('the canonical case: triggers outside aid suggests relocation', () => {
    write('monsters.cl.yaml', '- id: Wyvern\n  aid:\n    type: Race\n  triggers: Wyvern\n');
    const { diagnostics, codes } = loadWithDiagnostics();
    expect(codes).toContain(CODES.MISPLACED_KEY);
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

  test('rename-on-import (id + import) registers under the local id', () => {
    const items = [{ id: 'Dragon', import: 'wyvern', _source: 'a.yaml' }];
    const registry = buildRegistry(items, 'p');
    expect([...registry.keys()]).toEqual(['dragon']);
    expect(registry.get('dragon').import).toBe('wyvern');
  });

  test('a bare import (no id) is still skipped', () => {
    const items = [{ import: 'wyvern', _source: 'a.yaml' }];
    expect(buildRegistry(items, 'p').size).toBe(0);
  });

  test('two renamed imports claiming the same local id raise the existing duplicate error on the bus', () => {
    const items = [
      { id: 'Dragon', import: 'wyvern', _source: 'one.yaml' },
      { id: 'Dragon', import: 'drake', _source: 'two.yaml' },
    ];
    const diagnostics = new Diagnostics();
    const registry = buildRegistry(items, 'proj', { diagnostics });
    expect(registry.get('dragon').import).toBe('wyvern');
    expect(diagnostics.errors.some(
      (d) => d.code === CODES.DUPLICATE_ITEM_ID && /Duplicate item ID "dragon"/.test(d.message)
    )).toBe(true);
  });

  test('mergeRegistries unions library and project', () => {
    const merged = mergeRegistries(buildRegistry([item('A')], 'c'), buildRegistry([item('B')], 'p'));
    expect([...merged.keys()].sort()).toEqual(['a', 'b']);
  });

  test('a duplicate id raises CL0141 on the bus and keeps the first definition', () => {
    const diagnostics = new Diagnostics();
    const registry = buildRegistry(
      [item('A', 'one.yaml'), item('A', 'two.yaml')],
      'proj',
      { diagnostics },
    );
    expect(registry.get('a')._source).toBe('one.yaml');
    expect(diagnostics.errors.some((d) => d.code === CODES.DUPLICATE_ITEM_ID)).toBe(true);
  });

  test('an identity-less item raises CL0140 on the bus and is skipped', () => {
    const diagnostics = new Diagnostics();
    const registry = buildRegistry([{ _source: 'a' }], 'proj', { diagnostics });
    expect(registry.size).toBe(0);
    expect(diagnostics.errors.some((d) => d.code === CODES.ITEM_WITHOUT_IDENTITY)).toBe(true);
  });

  test('mergeRegistries raises CL0141 on a library/project collision and keeps the library item', () => {
    const diagnostics = new Diagnostics();
    const canon = buildRegistry([item('A', 'library.yaml')], 'c');
    const project = buildRegistry([item('A', 'project.yaml')], 'p');
    const merged = mergeRegistries(canon, project, { diagnostics });
    expect(merged.get('a')._source).toBe('library.yaml');
    expect(diagnostics.errors.some((d) => d.code === CODES.DUPLICATE_ITEM_ID)).toBe(true);
  });
});

describe('library registry', () => {
  test('loads every named library directory', () => {
    write('canonA/a.cl.yaml', 'id: A\n');
    write('canonB/b.cl.yaml', 'id: B\n');
    const map = new Map([['a', path.join(tmpDir, 'canonA')], ['b', path.join(tmpDir, 'canonB')]]);
    expect([...buildCanonRegistry(map).keys()].sort()).toEqual(['a', 'b']);
  });

  test('a duplicate id across library sets loads both, unqualified and unreachable', () => {
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

  test('a missing library directory warns and continues', () => {
    const diagnostics = new Diagnostics();
    const map = new Map([['gone', path.join(tmpDir, 'nope')]]);
    expect(buildCanonRegistry(map, { diagnostics }).size).toBe(0);
    expect(diagnostics.warnings).toHaveLength(1);
  });

  test('an absent map yields an empty registry', () => {
    expect(buildCanonRegistry(null).size).toBe(0);
  });
});

describe('config entry-point discovery', () => {
  test('finds each accepted basename', () => {
    for (const name of CONFIG_BASENAMES) {
      const dir = withTmpDir();
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

// ── resolveIncludes — duplicate file detection ────────────────────────────────

describe('resolveIncludes — duplicate file detection', () => {
  const makeConfig = (base) => ({
    _base: base,
    _resolvedComponents: {},
    _resolvedCanon: new Map(),
  });

  test('single include of a file succeeds and returns its items', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: ItemA\n  name: ItemA\n', 'utf8');

    const itemDefs = [{ include: shared, _source: path.join(tmpDir, 'project.yaml') }];
    const result = resolveIncludes(itemDefs, new Map(), makeConfig(tmpDir));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ItemA');
  });

  /** Resolve with a bus and hand back the CL0131 reports beside the result. */
  const includeAll = (itemDefs) => {
    const diagnostics = new Diagnostics();
    const result = resolveIncludes(itemDefs, new Map(), makeConfig(tmpDir), { diagnostics });
    const doubles = diagnostics.errors.filter((d) => d.code === CODES.DOUBLE_INCLUDE);
    return { result, diagnostics, doubles };
  };

  test('duplicate include from two different source files is one CL0131, and the repeat is skipped', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: ItemA\n  name: ItemA\n', 'utf8');

    const source1 = path.join(tmpDir, 'first.yaml');
    const source2 = path.join(tmpDir, 'second.yaml');
    const itemDefs = [
      { include: shared, _source: source1 },
      { include: shared, _source: source2 },
    ];

    const { result, doubles } = includeAll(itemDefs);
    expect(doubles).toHaveLength(1);
    expect(doubles[0].message).toMatch(/File included more than once/);
    expect(doubles[0].file).toBe(source2);
    // The first include still contributes its items; the repeat contributes nothing.
    expect(result.map((i) => i.id)).toEqual(['ItemA']);
  });

  test('the CL0131 message contains the duplicated file path', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: ItemA\n  name: ItemA\n', 'utf8');

    const itemDefs = [
      { include: shared, _source: path.join(tmpDir, 'a.yaml') },
      { include: shared, _source: path.join(tmpDir, 'b.yaml') },
    ];

    const { doubles } = includeAll(itemDefs);
    expect(doubles[0].message).toContain(shared);
  });

  test('the CL0131 message lists both source files that include the duplicate', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: ItemA\n  name: ItemA\n', 'utf8');

    const source1 = path.join(tmpDir, 'a.yaml');
    const source2 = path.join(tmpDir, 'b.yaml');
    const itemDefs = [
      { include: shared, _source: source1 },
      { include: shared, _source: source2 },
    ];

    const { doubles } = includeAll(itemDefs);
    expect(doubles[0].message).toContain(source1);
    expect(doubles[0].message).toContain(source2);
  });

  test('duplicate include within the same source file is CL0131 and names the source', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: ItemA\n  name: ItemA\n', 'utf8');

    const source = path.join(tmpDir, 'items.yaml');
    const itemDefs = [
      { include: shared, _source: source },
      { include: shared, _source: source },
    ];

    const { doubles } = includeAll(itemDefs);
    expect(doubles).toHaveLength(1);
    expect(doubles[0].message).toContain(shared);
    expect(doubles[0].message).toContain(source);
  });

  test('two includes of different files succeeds and returns all items', () => {
    const fileA = path.join(tmpDir, 'a.yaml');
    const fileB = path.join(tmpDir, 'b.yaml');
    fs.writeFileSync(fileA, '- id: ItemA\n  name: ItemA\n', 'utf8');
    fs.writeFileSync(fileB, '- id: ItemB\n  name: ItemB\n', 'utf8');

    const itemDefs = [
      { include: fileA, _source: path.join(tmpDir, 'project.yaml') },
      { include: fileB, _source: path.join(tmpDir, 'project.yaml') },
    ];
    const result = resolveIncludes(itemDefs, new Map(), makeConfig(tmpDir));
    expect(result).toHaveLength(2);
    expect(result.map(c => c.id)).toEqual(expect.arrayContaining(['ItemA', 'ItemB']));
  });

  test('expands a root variable and a canon name in an include path', () => {
    // Canon names are variables now (§6.1), so `{%main}` does what `{@main}` used to.
    const charDir = path.join(tmpDir, 'Characters');
    fs.mkdirSync(charDir);
    fs.writeFileSync(path.join(charDir, 'Aria.yaml'), '- id: Aria\n  name: Aria\n', 'utf8');

    const config = {
      _base: tmpDir,
      _resolvedCanon: new Map([['main', tmpDir]]),
      _variables: { who: 'Aria', main: tmpDir },
      variables: { who: 'Aria' },
    };
    const itemDefs = [{ include: '{%main}/Characters/{%who}.yaml', _source: path.join(tmpDir, 'p.yaml') }];
    const result = resolveIncludes(itemDefs, new Map(), config);
    expect(result.map(c => c.id)).toContain('Aria');
  });

  test('a renamed import (id + import) does not suppress an included item with the imported id', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: Wyvern\n  name: Wyvern\n', 'utf8');

    const itemDefs = [
      { id: 'Dragon', import: 'wyvern', _source: path.join(tmpDir, 'project.yaml') },
      { include: shared, _source: path.join(tmpDir, 'project.yaml') },
    ];
    const result = resolveIncludes(itemDefs, new Map(), makeConfig(tmpDir));
    expect(result.map((c) => c.id)).toEqual(['Wyvern']);
  });

  test('a renamed import DOES suppress an included item with the local id', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: Dragon\n  name: Dragon\n', 'utf8');

    const itemDefs = [
      { id: 'Dragon', import: 'wyvern', _source: path.join(tmpDir, 'project.yaml') },
      { include: shared, _source: path.join(tmpDir, 'project.yaml') },
    ];
    const result = resolveIncludes(itemDefs, new Map(), makeConfig(tmpDir));
    expect(result).toEqual([]);
  });
});
