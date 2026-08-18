'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  compile,
  getTemplate, validateCardType, writeOpening, resolveOpeningContent, resolveBranchFolderPath,
  buildBranchOutputDir, buildCompileContext, writeOutput, writeOpeningsRecursive,
  resolveIncludes, resolveNotesTemplateName, resolveBranchItems, cleanAndArchive,
} = require('../../src/compile');
const { buildRegistry } = require('../../src/loader/registry');
const { Diagnostics } = require('../../src/diag');

describe('getTemplate', () => {
  const templates = new Map([
    ['character', { content: 'char template', _source: 'x' }],
    ['npc', { content: 'npc template', _source: 'y' }],
  ]);

  test('returns template by render.template field', () => {
    const item = { render: { template: 'npc' }, aid: { type: 'character' } };
    expect(getTemplate(item, templates)).toBe('npc template');
  });

  test('falls back to aid.type when render.template absent', () => {
    const item = { render: {}, aid: { type: 'Character' } };
    expect(getTemplate(item, templates)).toBe('char template');
  });

  test('type lookup is case-insensitive', () => {
    const item = { aid: { type: 'CHARACTER' } };
    expect(getTemplate(item, templates)).toBe('char template');
  });

  test('returns null when neither render.template nor aid.type found', () => {
    const item = { aid: { type: 'Unknown' } };
    expect(getTemplate(item, templates)).toBeNull();
  });

  test('returns null for item with no type or template', () => {
    expect(getTemplate({}, templates)).toBeNull();
  });
});

describe('resolveOpeningContent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-opening-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('inline text is returned as-is (trimmed)', () => {
    expect(resolveOpeningContent('Which role?  ', tmpDir)).toBe('Which role?');
  });

  test('valid file path returns file content (trimmed)', () => {
    const file = path.join(tmpDir, 'opening.md');
    fs.writeFileSync(file, 'File content\n', 'utf8');
    expect(resolveOpeningContent(file, tmpDir)).toBe('File content');
  });

  test('relative file path resolves from base', () => {
    fs.mkdirSync(path.join(tmpDir, 'openings'));
    const file = path.join(tmpDir, 'openings', 'q.md');
    fs.writeFileSync(file, 'Relative content', 'utf8');
    expect(resolveOpeningContent('./openings/q.md', tmpDir)).toBe('Relative content');
  });

  test('non-existent path returns string as inline text', () => {
    expect(resolveOpeningContent('./does-not-exist.md', tmpDir)).toBe('./does-not-exist.md');
  });

  test('{%variable} in path is expanded before file lookup', () => {
    fs.mkdirSync(path.join(tmpDir, 'openings'));
    const file = path.join(tmpDir, 'openings', 'E-Kaiden.md');
    fs.writeFileSync(file, 'Kaiden opening', 'utf8');
    const spec = path.join(tmpDir, 'openings', 'E-{%pcName}.md');
    expect(resolveOpeningContent(spec, tmpDir, { pcName: 'Kaiden' })).toBe('Kaiden opening');
  });

  test('{%variable} in path that resolves to non-existent file returns expanded path string', () => {
    const spec = path.join(tmpDir, 'openings', 'E-{%pcName}.md');
    const result = resolveOpeningContent(spec, tmpDir, { pcName: 'Kaiden' });
    expect(result).toBe(path.join(tmpDir, 'openings', 'E-Kaiden.md'));
    expect(result).not.toContain('{%');
  });

  test('unresolved {%variable} in path stays as literal when variable undefined', () => {
    const spec = './openings/E-{%pcName}.md';
    const result = resolveOpeningContent(spec, tmpDir, {});
    expect(result).toContain('{%pcName}');
  });
});

describe('writeOpening', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-opening-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates Components/Opening.md with content and trailing newline', () => {
    writeOpening(tmpDir, 'Hello world');
    const outPath = path.join(tmpDir, 'Components', 'Opening.md');
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('Hello world\n');
  });

  test('creates intermediate Components directory', () => {
    const nested = path.join(tmpDir, 'Branches', 'A');
    writeOpening(nested, 'Nested');
    expect(fs.existsSync(path.join(nested, 'Components', 'Opening.md'))).toBe(true);
  });
});

describe('resolveBranchFolderPath', () => {
  test('returns id path when no branches config', () => {
    expect(resolveBranchFolderPath(null, ['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });

  test('returns id path when no title on nodes', () => {
    const branches = {
      alpha: { branches: { beta: {} } },
    };
    expect(resolveBranchFolderPath(branches, ['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });

  test('ignores title when present on a node, uses key instead', () => {
    const branches = {
      alpha: { title: 'The Alpha Path', branches: { beta: {} } },
    };
    expect(resolveBranchFolderPath(branches, ['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });

  test('ignores title on nested node, uses key instead', () => {
    const branches = {
      alpha: { branches: { beta: { title: 'Beta Run' } } },
    };
    expect(resolveBranchFolderPath(branches, ['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });

  test('ignores title at all levels when both present, uses keys instead', () => {
    const branches = {
      alpha: { title: 'Alpha Stage', branches: { beta: { title: 'Beta Stage' } } },
    };
    expect(resolveBranchFolderPath(branches, ['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });

  test('falls back to key when title is empty string', () => {
    const branches = {
      alpha: { title: '' },
    };
    expect(resolveBranchFolderPath(branches, ['alpha'])).toEqual(['alpha']);
  });

  test('falls back to key when title is null', () => {
    const branches = {
      alpha: { title: null },
    };
    expect(resolveBranchFolderPath(branches, ['alpha'])).toEqual(['alpha']);
  });

  test('returns id for unknown keys not in branches map', () => {
    const branches = {
      alpha: {},
    };
    expect(resolveBranchFolderPath(branches, ['alpha', 'unknown'])).toEqual(['alpha', 'unknown']);
  });

  test('id lookup is case-insensitive, returns actual key casing', () => {
    const branches = {
      Alpha: { title: 'The Alpha Path' },
    };
    expect(resolveBranchFolderPath(branches, ['alpha'])).toEqual(['Alpha']);
  });

  test('empty id path returns empty folder path', () => {
    expect(resolveBranchFolderPath({}, [])).toEqual([]);
  });
});

// ── buildBranchOutputDir ──────────────────────────────────────────────────────

describe('buildBranchOutputDir', () => {
  test('empty branchPath returns baseOutput unchanged', () => {
    expect(buildBranchOutputDir('/output', [])).toBe('/output');
  });

  test('single-level path inserts Branches/{name}', () => {
    expect(buildBranchOutputDir('/output', ['knight']))
      .toBe(path.join('/output', 'Branches', 'knight'));
  });

  test('two-level path interleaves Branches between each level', () => {
    expect(buildBranchOutputDir('/output', ['tier1', 'alpha']))
      .toBe(path.join('/output', 'Branches', 'tier1', 'Branches', 'alpha'));
  });
});

// ── buildCompileContext ───────────────────────────────────────────────────────

const baseCtxConfig = {
  _base: '/project',
  _resolvedComponents: {},
  variables: {},
  components: {},
  branches: null,
};

describe('buildCompileContext', () => {
  test('empty branchPath returns root variables', () => {
    const config = { ...baseCtxConfig, variables: { theme: 'dark' } };
    const { variables } = buildCompileContext(config, []);
    expect(variables).toEqual({ theme: 'dark' });
  });

  test('branch variables are merged over root', () => {
    const config = {
      ...baseCtxConfig,
      variables: { a: '1', b: '2' },
      branches: { main: { variables: { b: 'branch', c: '3' } } },
    };
    const { variables } = buildCompileContext(config, ['main']);
    expect(variables).toEqual({ a: '1', b: 'branch', c: '3' });
  });

  test('two-level nested path merges variables in order', () => {
    const config = {
      ...baseCtxConfig,
      variables: { a: 'root' },
      branches: {
        tier1: {
          variables: { b: 'tier1' },
          branches: { tier2: { variables: { c: 'tier2' } } },
        },
      },
    };
    const { variables } = buildCompileContext(config, ['tier1', 'tier2']);
    expect(variables).toEqual({ a: 'root', b: 'tier1', c: 'tier2' });
  });

  test('unknown branch key stops at root variables', () => {
    const config = {
      ...baseCtxConfig,
      variables: { a: 'root' },
      branches: { main: { variables: { b: 'branch' } } },
    };
    const { variables } = buildCompileContext(config, ['nonexistent']);
    expect(variables).toEqual({ a: 'root' });
  });

  test('branch key lookup is case-insensitive', () => {
    const config = {
      ...baseCtxConfig,
      branches: { Main: { variables: { role: 'knight' } } },
    };
    const { variables } = buildCompileContext(config, ['main']);
    expect(variables.role).toBe('knight');
  });

  test('all componentRefs are null when components block is empty', () => {
    const { componentRefs } = buildCompileContext(baseCtxConfig, []);
    for (const val of Object.values(componentRefs)) {
      expect(val).toBeNull();
    }
  });
});

// ── writeOutput ───────────────────────────────────────────────────────────────

describe('writeOutput', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-writeout-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes items joined by \\n\\n with trailing newline', () => {
    writeOutput(tmpDir, 'Character', ['Item A', 'Item B']);
    const outPath = path.join(tmpDir, 'Story Cards', 'Character', 'Character.md');
    expect(fs.readFileSync(outPath, 'utf8')).toBe('Item A\n\nItem B\n');
  });

  test('creates Story Cards/{type}/ directory recursively', () => {
    writeOutput(tmpDir, 'Location', ['Item']);
    expect(fs.existsSync(path.join(tmpDir, 'Story Cards', 'Location'))).toBe(true);
  });

  test('returns the output file path', () => {
    const result = writeOutput(tmpDir, 'NPC', ['Item']);
    expect(result).toBe(path.join(tmpDir, 'Story Cards', 'NPC', 'NPC.md'));
  });
});

// ── writeOpeningsRecursive — branch variable merging ─────────────────────────

describe('writeOpeningsRecursive — branch variable merging', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('branch variable overrides are used when resolving opening path', () => {
    // Setup: two opening files, one per branch
    const openingsDir = path.join(tmpDir, 'openings');
    fs.mkdirSync(openingsDir, { recursive: true });
    fs.writeFileSync(path.join(openingsDir, 'E-Kaiden.md'), 'Kaiden opening content', 'utf8');
    fs.writeFileSync(path.join(openingsDir, 'E-Zephon.md'), 'Zephon opening content', 'utf8');

    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    // opening spec uses {%opening} (dir) and {%pcName} (per-branch)
    const openingSpec = path.join(openingsDir, 'E-{%pcName}.md');

    const branches = {
      kaiden: {
        title: 'Kaiden',
        variables: { pcName: 'Kaiden' },
        components: { opening: openingSpec },
      },
      zephon: {
        title: 'Zephon',
        variables: { pcName: 'Zephon' },
        components: { opening: openingSpec },
      },
    };

    // Root variables have no pcName — each branch must supply its own
    writeOpeningsRecursive(branches, outputDir, tmpDir, null, {});

    const kaidenOut = path.join(outputDir, 'Branches', 'Kaiden', 'Components', 'Opening.md');
    const zephonOut = path.join(outputDir, 'Branches', 'Zephon', 'Components', 'Opening.md');

    expect(fs.readFileSync(kaidenOut, 'utf8').trim()).toBe('Kaiden opening content');
    expect(fs.readFileSync(zephonOut, 'utf8').trim()).toBe('Zephon opening content');
  });

  test('nested branch variables accumulate correctly', () => {
    const openingsDir = path.join(tmpDir, 'openings');
    fs.mkdirSync(openingsDir, { recursive: true });
    fs.writeFileSync(path.join(openingsDir, 'PM-Felix-Pet.md'), 'Felix pet opening', 'utf8');

    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    const branches = {
      personalMage: {
        title: 'Personal Mage',
        branches: {
          felix: {
            title: 'Felix',
            variables: { employerName: 'Felix' },
            branches: {
              pet: {
                title: 'Pet',
                components: { opening: path.join(openingsDir, 'PM-{%employerName}-Pet.md') },
              },
            },
          },
        },
      },
    };

    writeOpeningsRecursive(branches, outputDir, tmpDir, null, {});

    const petOut = path.join(
      outputDir, 'Branches', 'personalMage', 'Branches', 'felix', 'Branches', 'pet',
      'Components', 'Opening.md'
    );
    expect(fs.readFileSync(petOut, 'utf8').trim()).toBe('Felix pet opening');
  });
});

// ── resolveIncludes — duplicate file detection ────────────────────────────────

describe('resolveIncludes — duplicate file detection', () => {
  let tmpDir;

  const makeConfig = (base) => ({
    _base: base,
    _resolvedComponents: {},
    _resolvedCanon: new Map(),
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-includes-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('single include of a file succeeds and returns its items', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: ItemA\n  name: ItemA\n', 'utf8');

    const itemDefs = [{ include: shared, _source: path.join(tmpDir, 'project.yaml') }];
    const result = resolveIncludes(itemDefs, new Map(), makeConfig(tmpDir));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ItemA');
  });

  test('duplicate include from two different source files throws an error', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: ItemA\n  name: ItemA\n', 'utf8');

    const source1 = path.join(tmpDir, 'first.yaml');
    const source2 = path.join(tmpDir, 'second.yaml');
    const itemDefs = [
      { include: shared, _source: source1 },
      { include: shared, _source: source2 },
    ];

    expect(() => resolveIncludes(itemDefs, new Map(), makeConfig(tmpDir)))
      .toThrow(/File included more than once/);
  });

  test('error message contains the duplicated file path', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: ItemA\n  name: ItemA\n', 'utf8');

    const itemDefs = [
      { include: shared, _source: path.join(tmpDir, 'a.yaml') },
      { include: shared, _source: path.join(tmpDir, 'b.yaml') },
    ];

    let err;
    try { resolveIncludes(itemDefs, new Map(), makeConfig(tmpDir)); }
    catch (e) { err = e; }

    expect(err.message).toContain(shared);
  });

  test('error message lists both source files that include the duplicate', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: ItemA\n  name: ItemA\n', 'utf8');

    const source1 = path.join(tmpDir, 'a.yaml');
    const source2 = path.join(tmpDir, 'b.yaml');
    const itemDefs = [
      { include: shared, _source: source1 },
      { include: shared, _source: source2 },
    ];

    let err;
    try { resolveIncludes(itemDefs, new Map(), makeConfig(tmpDir)); }
    catch (e) { err = e; }

    expect(err.message).toContain(source1);
    expect(err.message).toContain(source2);
  });

  test('duplicate include within the same source file throws and lists the source', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: ItemA\n  name: ItemA\n', 'utf8');

    const source = path.join(tmpDir, 'items.yaml');
    const itemDefs = [
      { include: shared, _source: source },
      { include: shared, _source: source },
    ];

    let err;
    try { resolveIncludes(itemDefs, new Map(), makeConfig(tmpDir)); }
    catch (e) { err = e; }

    expect(err.message).toContain(shared);
    expect(err.message).toContain(source);
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

  test('a renamed import (id + import) does not suppress an included item with the imported id (§17.4)', () => {
    const shared = path.join(tmpDir, 'shared.yaml');
    fs.writeFileSync(shared, '- id: Wyvern\n  name: Wyvern\n', 'utf8');

    const itemDefs = [
      { id: 'Dragon', import: 'wyvern', _source: path.join(tmpDir, 'project.yaml') },
      { include: shared, _source: path.join(tmpDir, 'project.yaml') },
    ];
    const result = resolveIncludes(itemDefs, new Map(), makeConfig(tmpDir));
    expect(result.map(c => c.id)).toEqual(['Wyvern']);
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

// ── token coverage: % in component specs + @ canon in specs ───────────────────

describe('buildCompileContext — % and @ in component specs', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-spec-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const makeConfig = (over) => ({
    _base: tmpDir,
    _resolvedComponents: {},
    _resolvedCanon: new Map(),
    variables: {},
    components: {},
    branches: null,
    ...over,
  });

  test('{%var} in a component spec resolves to the matching file path', () => {
    fs.writeFileSync(path.join(tmpDir, 'pe-knight.yaml'), 'x\n', 'utf8');
    const config = makeConfig({
      variables: { role: 'pe-knight' },
      components: { plotEssential: '{%role}.yaml' },
    });
    const { componentRefs } = buildCompileContext(config, []);
    expect(componentRefs.plotEssential).toBe(path.join(tmpDir, 'pe-knight.yaml'));
  });

  test('branch variable overrides root in a component spec', () => {
    fs.writeFileSync(path.join(tmpDir, 'pe-mage.yaml'), 'x\n', 'utf8');
    const config = makeConfig({
      variables: { role: 'pe-knight' },
      components: { plotEssential: '{%role}.yaml' },
      branches: { mage: { variables: { role: 'pe-mage' } } },
    });
    const { componentRefs } = buildCompileContext(config, ['mage']);
    expect(componentRefs.plotEssential).toBe(path.join(tmpDir, 'pe-mage.yaml'));
  });

  test('a canon name resolves in a component spec', () => {
    const peDir = path.join(tmpDir, 'shared');
    fs.mkdirSync(peDir);
    fs.writeFileSync(path.join(peDir, 'pe.yaml'), 'x\n', 'utf8');
    const config = makeConfig({
      _resolvedCanon: new Map([['lore', peDir]]),
      _variables: { lore: peDir },
      components: { plotEssential: '{%lore}/pe.yaml' },
    });
    const { componentRefs } = buildCompileContext(config, []);
    expect(componentRefs.plotEssential).toBe(path.join(peDir, 'pe.yaml'));
  });
});

// ── token coverage: {%var} in branch title is not expanded (title is ignored) ─

describe('resolveBranchFolderPath — {%var} in title', () => {
  test('does not expand {%var} in a branch title; key is used unchanged', () => {
    const branches = { knight: { title: 'The {%era} Knight' } };
    expect(resolveBranchFolderPath(branches, ['knight'], { era: 'Iron Age' }))
      .toEqual(['knight']);
  });

  test('ancestor and leaf folder names come from keys regardless of title/variables', () => {
    const branches = {
      tier: {
        title: '{%era} Tier',
        variables: { era: 'Bronze' },
        branches: {
          a: { title: 'A', variables: { era: 'Gold' } },
          b: { title: 'B' },
        },
      },
    };
    expect(resolveBranchFolderPath(branches, ['tier', 'a'], {})).toEqual(['tier', 'a']);
    expect(resolveBranchFolderPath(branches, ['tier', 'b'], {})).toEqual(['tier', 'b']);
  });

  test('falls back to key when no title and leaves plain names unchanged', () => {
    const branches = { plain: {} };
    expect(resolveBranchFolderPath(branches, ['plain'], {})).toEqual(['plain']);
  });
});

// ── validateCardType (aid.type must be a legal folder/file name) ──────────────

describe('validateCardType', () => {
  const item = (type) => ({ id: 'X', _source: 'items.yaml', aid: { type } });

  test('accepts a normal type', () => {
    expect(() => validateCardType(item('Character'))).not.toThrow();
  });

  test('accepts a type containing spaces', () => {
    expect(() => validateCardType(item('Story Card'))).not.toThrow();
  });

  test('no-op when aid.type is absent', () => {
    expect(() => validateCardType({ id: 'X', aid: {} })).not.toThrow();
    expect(() => validateCardType({ id: 'X' })).not.toThrow();
  });

  test.each(['a/b', 'a\\b', 'con:', 'a*b', 'a?b', 'a|b', '<x>', '"q"'])(
    'throws on illegal path character: %s', (bad) => {
      expect(() => validateCardType(item(bad))).toThrow(/Invalid aid\.type/);
    }
  );

  test('throws on "." and ".."', () => {
    expect(() => validateCardType(item('.'))).toThrow(/Invalid aid\.type/);
    expect(() => validateCardType(item('..'))).toThrow(/Invalid aid\.type/);
  });

  test('throws on trailing space or period (Windows-hostile)', () => {
    expect(() => validateCardType(item('Character '))).toThrow(/Invalid aid\.type/);
    expect(() => validateCardType(item('Character.'))).toThrow(/Invalid aid\.type/);
  });

  test('error names the offending type and the item', () => {
    expect(() => validateCardType(item('a/b'))).toThrow(/"a\/b".*"X"/);
  });
});

// ── config-loading errors abort before any filesystem work ────────────────────
//
// A schema violation in compile.yaml itself — here, a missing required structure.output —
// must stop the compile before mkdirSync, template loading, or item/canon loading ever
// run. It used to be checked only after all of that had already happened, so the output
// directory was created (into the wrong, defaulted location) before the throw arrived.

describe('config errors abort before filesystem work', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-abort-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a missing structure.output throws and never creates an output directory', () => {
    const configPath = path.join(tmpDir, 'compile.yaml');
    fs.writeFileSync(configPath, 'version: 4\nstructure:\n  input:\n    items: [./Codex]\n', 'utf8');

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => compile(configPath)).toThrow(/error/i);
    } finally {
      errorSpy.mockRestore();
    }

    // The fallback default the config loader computes when output: is absent.
    expect(fs.existsSync(path.join(tmpDir, 'output'))).toBe(false);
  });
});

// ── the emitter owns the envelope (§8.2) ─────────────────────────────────────

describe('compile writes the VL envelope through emit/vl.js', () => {
  let tmpDir;
  let quiet;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-emit-'));
    fs.mkdirSync(path.join(tmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
    quiet = ['log', 'warn', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
  });

  afterEach(() => {
    quiet.forEach((spy) => spy.mockRestore());
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Compile a one-item project and return its compiled Item.md.
   *
   * `options.config` splices extra root-level config lines; `options.branches` replaces
   * the branch block; `options.leaf` picks which leaf's output to read back.
   */
  function compileItem(itemLines, templateContent, extraTemplates = {}, options = {}) {
    const { config = [], branches = ['  main: {}'], leaf = ['main'] } = options;
    fs.writeFileSync(path.join(tmpDir, 'items', 'items.yaml'), itemLines.join('\n'), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'templates', 'Item.template'), templateContent, 'utf8');
    for (const [name, content] of Object.entries(extraTemplates)) {
      fs.writeFileSync(path.join(tmpDir, 'templates', `${name}.template`), content, 'utf8');
    }
    fs.writeFileSync(path.join(tmpDir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      `  input: { items: [${tmpDir}/items], templates: [${tmpDir}/templates] }`,
      `  output: ${tmpDir}/output`,
      ...config,
      'branches:',
      ...branches,
    ].join('\n'), 'utf8');
    compile(path.join(tmpDir, 'compile.yaml'));
    const leafDir = leaf.reduce((acc, segment) => path.join(acc, 'Branches', segment),
      path.join(tmpDir, 'output'));
    return fs.readFileSync(path.join(leafDir, 'Story Cards', 'Item', 'Item.md'), 'utf8');
  }

  const ITEM = [
    '- id: Widget',
    '  name: { display: Widget, full: Widget of Power }',
    '  aid: { type: Item, triggers: [widget, _gizmo_] }',
    '  render: { template: Item }',
    '  body: { Desc: a widget }',
  ];

  test('the heading, fence and encapsulate come from the emitter, not the template', () => {
    const output = compileItem(ITEM, '{$body.Desc}');
    expect(output).toBe([
      '## Widget of Power',
      '~~~',
      "triggers: [widget, ' gizmo ']",
      'encapsulate: false',
      '~~~',
      'a widget',
      '',
    ].join('\n'));
  });

  test('notes: reaches the fence through §4.5\'s default rendering', () => {
    const output = compileItem([...ITEM, "  notes: '[e]'"], '{$body.Desc}');
    expect(output).toContain("notes: '[e]'");
  });

  test('render.notesTemplate renders the notes text', () => {
    const item = [...ITEM.slice(0, 3), '  render: { template: Item, notesTemplate: Marker }',
      '  body: { Desc: a widget }', '  notes: { known: true }'];
    const output = compileItem(item, '{$body.Desc}', { Marker: '{if $notes.known}[e]{/if}' });
    expect(output).toContain("notes: '[e]'");
  });

  test('an empty notes template emits no notes line at all', () => {
    const item = [...ITEM.slice(0, 3), '  render: { template: Item, notesTemplate: Marker }',
      '  body: { Desc: a widget }', '  notes: { known: false }'];
    const output = compileItem(item, '{$body.Desc}', { Marker: '{if $notes.known}[e]{/if}' });
    expect(output).not.toContain('notes:');
  });

  test('the wrapper is applied to the body and stays out of the fence', () => {
    const item = [...ITEM.slice(0, 3), '  render: { template: Item, wrapper: curly }',
      '  body: { Desc: a widget }'];
    const output = compileItem(item, '{$body.Desc}');
    expect(output).toContain('~~~\n{\na widget\n}');
  });
});

// ── the notes template ladder (§4.5) ─────────────────────────────────────────

describe('resolveNotesTemplateName', () => {
  const templates = new Map([
    ['item', { content: 'body' }],
    ['item.notes', { content: 'type notes' }],
    ['character', { content: 'body' }],
    ['explicit', { content: 'explicit notes' }],
    ['projectnotes', { content: 'project notes' }],
  ]);

  const item = (render, type) => ({ render, aid: { type } });

  test('rung 1 — the item names its own template', () => {
    expect(resolveNotesTemplateName(item({ template: 'Item', notesTemplate: 'Explicit' }, 'Item'), templates, 'ProjectNotes'))
      .toBe('Explicit');
  });

  test('rung 1 wins even when it names a template that does not exist', () => {
    // Falling through on a typo would render the wrong notes silently. The render-time
    // ERR that follows is the better failure.
    expect(resolveNotesTemplateName(item({ template: 'Item', notesTemplate: 'Nope' }, 'Item'), templates, 'ProjectNotes'))
      .toBe('Nope');
  });

  test('rung 2 — the body template gets its .notes sibling', () => {
    expect(resolveNotesTemplateName(item({ template: 'Item' }, 'Item'), templates, 'ProjectNotes'))
      .toBe('Item.notes');
  });

  test('rung 2 follows the template that actually resolved the body', () => {
    // render.template overrides aid.type for the body, so the notes must follow it there
    // rather than picking up Item.notes from the type.
    expect(resolveNotesTemplateName(item({ template: 'Character' }, 'Item'), templates, null))
      .toBeNull();
  });

  test('rung 2 resolves through aid.type when there is no render.template', () => {
    expect(resolveNotesTemplateName(item({}, 'Item'), templates, null)).toBe('Item.notes');
  });

  test('rung 3 — the project default, when no .notes sibling exists', () => {
    expect(resolveNotesTemplateName(item({ template: 'Character' }, 'Character'), templates, 'ProjectNotes'))
      .toBe('ProjectNotes');
  });

  test('rung 4 — nothing at all, leaving §4.5\'s default rule', () => {
    expect(resolveNotesTemplateName(item({ template: 'Character' }, 'Character'), templates, null))
      .toBeNull();
  });
});

describe('the notes ladder end to end', () => {
  let tmpDir;
  let quiet;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-notes-'));
    fs.mkdirSync(path.join(tmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
    quiet = ['log', 'warn', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
  });

  afterEach(() => {
    quiet.forEach((spy) => spy.mockRestore());
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const ITEM = [
    '- id: Widget',
    '  name: Widget',
    '  aid: { type: Item, triggers: [widget] }',
    '  body: { Desc: a widget }',
    '  notes: { known: true }',
  ];

  function build({ templates = {}, config = [], branches = ['  main: {}'] }) {
    fs.writeFileSync(path.join(tmpDir, 'items', 'items.yaml'), ITEM.join('\n'), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'templates', 'Item.template'), '{$body.Desc}', 'utf8');
    for (const [name, content] of Object.entries(templates)) {
      fs.writeFileSync(path.join(tmpDir, 'templates', `${name}.template`), content, 'utf8');
    }
    fs.writeFileSync(path.join(tmpDir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      `  input: { items: [${tmpDir}/items], templates: [${tmpDir}/templates] }`,
      `  output: ${tmpDir}/output`,
      ...config,
      'branches:',
      ...branches,
    ].join('\n'), 'utf8');
    compile(path.join(tmpDir, 'compile.yaml'));
    return (...segments) => fs.readFileSync(
      path.join(tmpDir, 'output', ...segments.flatMap((s) => ['Branches', s]),
        'Story Cards', 'Item', 'Item.md'), 'utf8',
    );
  }

  test('a type template named Item.notes renders the notes without any declaration', () => {
    const read = build({ templates: { 'Item.notes': '{if $notes.known}[e]{/if}' } });
    expect(read('main')).toContain("notes: '[e]'");
  });

  test('the project default applies when no type template exists', () => {
    const read = build({
      templates: { ProjectNotes: '{if $notes.known}[e]{/if}' },
      config: ['render:', '  notesTemplate: ProjectNotes'],
    });
    expect(read('main')).toContain("notes: '[e]'");
  });

  test('a branch turns the marker off by pointing at a blank template', () => {
    // The mod-loading case: the marker means something on the branch that loads the mod
    // and nothing on the branch that does not, and no item changes.
    const read = build({
      templates: { ProjectNotes: '{if $notes.known}[e]{/if}', NoNotes: '' },
      config: ['render:', '  notesTemplate: ProjectNotes'],
      branches: ['  wtg: {}', '  vanilla:', '    render:', '      notesTemplate: NoNotes'],
    });
    expect(read('wtg')).toContain("notes: '[e]'");
    expect(read('vanilla')).not.toContain('notes:');
  });

  test('~ unbinds the project default, falling through to §4.5 rather than suppressing', () => {
    // Worth pinning down, because the two readings differ in output rather than in
    // tidiness: `~` removes the binding, and rung 4 then renders the notes value itself.
    // For a mapping that means `known: true` reaching AID as text — which is why the
    // idiom for "off" is a blank template, not `~`.
    const read = build({
      templates: { ProjectNotes: '{if $notes.known}[e]{/if}' },
      config: ['render:', '  notesTemplate: ProjectNotes'],
      branches: ['  wtg: {}', '  vanilla:', '    render:', '      notesTemplate: ~'],
    });
    expect(read('wtg')).toContain("notes: '[e]'");
    expect(read('vanilla')).toContain("notes: 'known: true'");
  });

  test('a branch swaps the project default for its own template', () => {
    const read = build({
      templates: {
        ProjectNotes: '{if $notes.known}[e]{/if}',
        OtherNotes: '{if $notes.known}[x]{/if}',
      },
      config: ['render:', '  notesTemplate: ProjectNotes'],
      branches: ['  a: {}', '  b:', '    render:', '      notesTemplate: OtherNotes'],
    });
    expect(read('a')).toContain("notes: '[e]'");
    expect(read('b')).toContain("notes: '[x]'");
  });

  test('the branch default is inherited by nested leaves', () => {
    const read = build({
      templates: { OtherNotes: '{if $notes.known}[x]{/if}' },
      branches: ['  outer:', '    render:', '      notesTemplate: OtherNotes',
        '    branches:', '      inner: {}'],
    });
    expect(read('outer', 'inner')).toContain("notes: '[x]'");
  });

  test('a project notesTemplate naming no loaded template is a load-time ERROR', () => {
    expect(() => build({ config: ['render:', '  notesTemplate: Missing'] }))
      .toThrow(/error/i);
  });

  test('a branch notesTemplate naming no loaded template is a load-time ERROR', () => {
    expect(() => build({
      branches: ['  a:', '    render:', '      notesTemplate: AlsoMissing'],
    })).toThrow(/error/i);
  });
});

/**
 * A project def carrying `import:` and no `id:` of its own (§17.4).
 *
 * [[2026-08-17 The Document Layer Goes]] recorded such a def as having become *silently
 * inert* when `buildOverlays` was deleted, and asked for a diagnostic. The symptom has
 * changed shape since: Phase 3's `resolveBranchItems` iterates every def including bare
 * imports, so the def renders — under the id of the item it names, which is the behavior
 * `documentation/04-imports-and-includes.md` documents throughout and the one an author
 * wants. Nothing is inert.
 *
 * What replaced it is a duplicate. `buildRegistry` skips a bare import by design, so two
 * of them naming one canon item never meet in the registry and its duplicate-id check
 * never runs — while the resolver produces two items with the same id, one story card
 * name and one trigger list. These tests pin both halves, so the day a duplicate check
 * lands it is the second of them that changes.
 */
describe('a bare import def carries no id of its own', () => {
  const canon = () => buildRegistry([{
    id: 'aness', name: 'Aness', aid: { type: 'Character', triggers: ['Aness'] },
    body: { text: 'canon body' }, _source: 'canon.cl.yaml',
  }], 'canon');

  test('it resolves and renders, under the id of the item it imports', () => {
    const defs = [{ import: 'Aness', _source: 'project.cl.yaml' }];
    const items = resolveBranchItems(defs, canon(), [], {}, new Diagnostics());
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('aness');
    expect(items[0].body.text).toBe('canon body');
  });

  test('it claims no registry id, which is what keeps rename-on-import a rename', () => {
    expect([...buildRegistry([
      { import: 'Aness', _source: 'project.cl.yaml' },
      { id: 'dragon', import: 'Aness', _source: 'project.cl.yaml' },
    ], 'project').keys()]).toEqual(['dragon']);
  });

  test('two of them emit one id twice, and report nothing — the open case', () => {
    const defs = [
      { import: 'Aness', body: { text: 'first' }, _source: 'a.cl.yaml' },
      { import: 'Aness', body: { text: 'second' }, _source: 'b.cl.yaml' },
    ];
    const diagnostics = new Diagnostics();
    const items = resolveBranchItems(defs, canon(), [], {}, diagnostics);

    expect(items.map((i) => i.id)).toEqual(['aness', 'aness']);
    expect(diagnostics.all).toHaveLength(0);
  });

  test('the same collision through explicit ids is caught at load', () => {
    expect(() => buildRegistry([
      { id: 'aness', name: 'Aness', _source: 'a.cl.yaml' },
      { id: 'aness', name: 'Aness', _source: 'b.cl.yaml' },
    ], 'project')).toThrow(/Duplicate item ID/i);
  });
});

/**
 * The clean sweep visits branch *nodes*, not branch leaves.
 *
 * It swept only leaves until Phase 4's `Placeholders.yaml` made the hole visible. An
 * interior node owns a `Label.md` — and now a `Placeholders.yaml` — and Velvet Lattice
 * reads both and inherits them down the subtree, so a declaration deleted from an interior
 * node survived in the output and went on being inherited. The root had the same hole from
 * the other end: it entered the expected set only when the project had no branches at all.
 */
describe('cleanAndArchive sweeps every node, not just leaves', () => {
  let outDir;

  /** An output tree: root, one interior node, two leaves under it. */
  function buildTree() {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-clean-'));
    const nodes = {
      root: outDir,
      interior: path.join(outDir, 'Branches', 'tier'),
      alpha: path.join(outDir, 'Branches', 'tier', 'Branches', 'alpha'),
      beta: path.join(outDir, 'Branches', 'tier', 'Branches', 'beta'),
    };
    for (const dir of Object.values(nodes)) {
      fs.mkdirSync(path.join(dir, 'Story Cards'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Story Cards', 'Character.md'), 'stale card', 'utf8');
      fs.writeFileSync(path.join(dir, 'Label.md'), 'stale label', 'utf8');
      fs.writeFileSync(path.join(dir, 'Placeholders.yaml'), 'stale: placeholder\n', 'utf8');
    }
    return nodes;
  }

  const config = (branches) => ({ _resolvedOutput: outDir, branches });
  const TIER = { tier: { branches: { alpha: {}, beta: {} } } };

  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => {
    console.log.mockRestore();
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('an interior node is swept — the case Phase 4 raised', () => {
    const nodes = buildTree();
    cleanAndArchive(config(TIER), [['tier', 'alpha'], ['tier', 'beta']]);

    expect(fs.existsSync(path.join(nodes.interior, 'Placeholders.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(nodes.interior, 'Label.md'))).toBe(false);
    expect(fs.existsSync(path.join(nodes.interior, 'Story Cards'))).toBe(false);
  });

  test('the root of a branched project is swept too', () => {
    const nodes = buildTree();
    cleanAndArchive(config(TIER), [['tier', 'alpha'], ['tier', 'beta']]);

    expect(fs.existsSync(path.join(nodes.root, 'Placeholders.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(nodes.root, 'Label.md'))).toBe(false);
  });

  test('leaves are still swept, and the tree itself survives', () => {
    const nodes = buildTree();
    cleanAndArchive(config(TIER), [['tier', 'alpha'], ['tier', 'beta']]);

    expect(fs.existsSync(path.join(nodes.alpha, 'Placeholders.yaml'))).toBe(false);
    expect(fs.existsSync(nodes.alpha)).toBe(true);
    expect(fs.existsSync(nodes.beta)).toBe(true);
    expect(fs.existsSync(nodes.interior)).toBe(true);
  });

  test('a dropped leaf is removed, its siblings untouched', () => {
    // Nothing but compiler output, so there is nothing to keep. Archiving is for what the
    // compiler does not own; see the next test.
    const nodes = buildTree();
    cleanAndArchive(config({ tier: { branches: { alpha: {} } } }), [['tier', 'alpha']]);

    expect(fs.existsSync(nodes.beta)).toBe(false);
    expect(fs.existsSync(nodes.alpha)).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'Archive'))).toBe(false);
  });

  test('a dropped node holding a hand-added file is archived, not deleted', () => {
    const nodes = buildTree();
    fs.writeFileSync(path.join(nodes.beta, 'notes.txt'), 'written by hand', 'utf8');

    cleanAndArchive(config({ tier: { branches: { alpha: {} } } }), [['tier', 'alpha']]);

    const archive = path.join(outDir, 'Archive');
    const stamp = fs.readdirSync(archive)[0];
    expect(fs.readFileSync(
      path.join(archive, stamp, 'Branches', 'tier', 'Branches', 'beta', 'notes.txt'), 'utf8',
    )).toBe('written by hand');
  });

  test('a dropped interior node takes its whole subtree with it', () => {
    // Ancestors of a live leaf are live, so a stale node can never hold one — which is
    // what makes taking an interior node whole safe rather than destructive.
    buildTree();
    cleanAndArchive(config({ other: {} }), [['other']]);

    expect(fs.existsSync(path.join(outDir, 'Branches', 'tier'))).toBe(false);
  });

  test('an emptied interior node does not survive as a shell around its lost children', () => {
    // The `Branches` container is what would keep it: its children are gone, so it holds
    // nothing, but an existing directory reads as content and would get the parent
    // archived rather than removed.
    const nodes = buildTree();
    fs.writeFileSync(path.join(nodes.alpha, 'notes.txt'), 'written by hand', 'utf8');

    cleanAndArchive(config({ other: {} }), [['other']]);

    const archive = path.join(outDir, 'Archive');
    const stamp = fs.readdirSync(archive)[0];
    expect(fs.readdirSync(path.join(archive, stamp, 'Branches'))).toEqual(['tier']);
    expect(fs.existsSync(path.join(outDir, 'Branches', 'tier'))).toBe(false);
  });
});
