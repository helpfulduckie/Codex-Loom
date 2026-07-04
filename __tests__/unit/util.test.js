'use strict';

const fs = require('fs');
const {
  findFiles, loadYaml, deepClone, findKey,
  getCI, setCI, deleteCI, normalizeVarKey, resolveVariables, warnUnexpandedVariables,
  walkCardTextFields, warnUnresolvedFieldTokens, warnMechanicalArtifacts, maskFencedRegions,
} = require('../../src/util');

// ── deepClone ─────────────────────────────────────────────────────────────────

describe('deepClone', () => {
  test('returns null for null input', () => {
    expect(deepClone(null)).toBeNull();
  });

  test('returns primitives unchanged', () => {
    expect(deepClone(42)).toBe(42);
    expect(deepClone('hello')).toBe('hello');
    expect(deepClone(true)).toBe(true);
  });

  test('clones arrays as independent copies', () => {
    const arr = [1, 2, 3];
    const clone = deepClone(arr);
    expect(clone).toEqual([1, 2, 3]);
    clone.push(4);
    expect(arr).toHaveLength(3);
  });

  test('clones nested objects independently', () => {
    const obj = { a: { b: { c: 42 } }, d: [1, 2] };
    const clone = deepClone(obj);
    expect(clone).toEqual(obj);
    clone.a.b.c = 99;
    expect(obj.a.b.c).toBe(42);
  });

  test('clones arrays nested inside objects', () => {
    const obj = { list: [1, 2, 3] };
    const clone = deepClone(obj);
    clone.list.push(4);
    expect(obj.list).toHaveLength(3);
  });
});

// ── findKey ───────────────────────────────────────────────────────────────────

describe('findKey', () => {
  test('returns null for null input', () => {
    expect(findKey(null, 'foo')).toBeNull();
  });

  test('returns null for non-object input', () => {
    expect(findKey('string', 'foo')).toBeNull();
  });

  test('exact-case match returns the key', () => {
    expect(findKey({ Foo: 1 }, 'Foo')).toBe('Foo');
  });

  test('case-insensitive match returns the original-cased key', () => {
    expect(findKey({ Foo: 1 }, 'foo')).toBe('Foo');
    expect(findKey({ FOO: 1 }, 'foo')).toBe('FOO');
  });

  test('returns null when key is absent', () => {
    expect(findKey({ bar: 1 }, 'foo')).toBeNull();
  });
});

// ── getCI ─────────────────────────────────────────────────────────────────────

describe('getCI', () => {
  test('returns value via case-insensitive lookup', () => {
    expect(getCI({ Foo: 'bar' }, 'foo')).toBe('bar');
    expect(getCI({ FOO: 'bar' }, 'Foo')).toBe('bar');
  });

  test('returns undefined when key is missing', () => {
    expect(getCI({ bar: 1 }, 'foo')).toBeUndefined();
  });
});

// ── setCI ─────────────────────────────────────────────────────────────────────

describe('setCI', () => {
  test('updates existing key preserving original casing', () => {
    const obj = { Foo: 'old' };
    setCI(obj, 'foo', 'new');
    expect(obj).toEqual({ Foo: 'new' });
  });

  test('adds new key when not present', () => {
    const obj = {};
    setCI(obj, 'foo', 'value');
    expect(obj).toEqual({ foo: 'value' });
  });
});

// ── deleteCI ──────────────────────────────────────────────────────────────────

describe('deleteCI', () => {
  test('removes key case-insensitively', () => {
    const obj = { Foo: 1, bar: 2 };
    deleteCI(obj, 'foo');
    expect(obj).toEqual({ bar: 2 });
  });

  test('no-op when key is absent', () => {
    const obj = { bar: 2 };
    deleteCI(obj, 'foo');
    expect(obj).toEqual({ bar: 2 });
  });
});

// ── normalizeVarKey ───────────────────────────────────────────────────────────

describe('normalizeVarKey', () => {
  test.each(['v', 'var', 'vars', 'variable', 'variables'])('"%s" normalizes to "v"', (key) => {
    expect(normalizeVarKey(key)).toBe('v');
  });

  test('case-insensitive: "VARS" → "v"', () => {
    expect(normalizeVarKey('VARS')).toBe('v');
    expect(normalizeVarKey('Variable')).toBe('v');
  });

  test('unrelated key passes through unchanged', () => {
    expect(normalizeVarKey('setting')).toBe('setting');
    expect(normalizeVarKey('title')).toBe('title');
  });
});

// ── resolveVariables ──────────────────────────────────────────────────────────

describe('resolveVariables', () => {
  test('expands {%key} tokens', () => {
    expect(resolveVariables('Hello {%name}', { name: 'World' })).toBe('Hello World');
  });

  test('case-insensitive key lookup', () => {
    expect(resolveVariables('{%NAME}', { name: 'value' })).toBe('value');
    expect(resolveVariables('{%StartDate}', { startdate: '01/01' })).toBe('01/01');
  });

  test('nested expansion: A references B', () => {
    expect(resolveVariables('{%a}', { a: 'hello {%b}', b: 'world' })).toBe('hello world');
  });

  test('multiple tokens in one string', () => {
    expect(resolveVariables('{%x} and {%y}', { x: 'foo', y: 'bar' })).toBe('foo and bar');
  });

  test('undeclared variable: warns and returns token literal', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const result = resolveVariables('{%missing}', {});
    expect(result).toBe('{%missing}');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing'));
    warn.mockRestore();
  });

  test('cycle: warns and returns token literal', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const result = resolveVariables('{%a}', { a: '{%a}' });
    expect(result).toBe('{%a}');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cycle'));
    warn.mockRestore();
  });

  test('non-string text passes through unchanged', () => {
    expect(resolveVariables(42, { name: 'x' })).toBe(42);
    expect(resolveVariables(null, { name: 'x' })).toBeNull();
  });

  test('null variables argument passes text through unchanged', () => {
    expect(resolveVariables('{%key}', null)).toBe('{%key}');
  });

  test('string with no tokens passes through unchanged', () => {
    expect(resolveVariables('plain text', { x: 'y' })).toBe('plain text');
  });
});

// ── warnUnexpandedVariables ───────────────────────────────────────────────────

describe('warnUnexpandedVariables', () => {
  test('warns once per distinct {%token} and returns true', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const found = warnUnexpandedVariables('a {%role} b {%role} c {%era}', 'card "X" (Y)');
    expect(found).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2); // {%role} deduped, {%era}
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('{%role}'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('{%era}'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('card "X" (Y)'));
    warn.mockRestore();
  });

  test('ignores {@name} references and returns false', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const found = warnUnexpandedVariables('see {@main}/x for details', 'component Opening.md');
    expect(found).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('clean text returns false and warns nothing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    expect(warnUnexpandedVariables('fully resolved', 'x')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('non-string input returns false', () => {
    expect(warnUnexpandedVariables(null, 'x')).toBe(false);
    expect(warnUnexpandedVariables(42, 'x')).toBe(false);
  });
});

// ── walkCardTextFields ────────────────────────────────────────────────────────

describe('walkCardTextFields', () => {
  test('visits strings in body, aid, render, and name (incl. arrays + nesting)', () => {
    const card = {
      body: { Tagline: 'a', Traits: { hair: 'b' }, Keywords: ['c', 'd'] },
      aid: { title: 'e', triggers: ['f'] },
      render: { wrapper: 'g' },
      name: { display: 'h', full: 'i' },
    };
    walkCardTextFields(card, s => s.toUpperCase());
    expect(card.body.Tagline).toBe('A');
    expect(card.body.Traits.hair).toBe('B');
    expect(card.body.Keywords).toEqual(['C', 'D']);
    expect(card.aid.title).toBe('E');
    expect(card.aid.triggers).toEqual(['F']);
    expect(card.render.wrapper).toBe('G');
    expect(card.name.full).toBe('I');
  });

  test('leaves non-string values (numbers, booleans) untouched', () => {
    const card = { aid: { encapsulate: true }, render: { position: 5 }, body: {} };
    walkCardTextFields(card, () => 'X');
    expect(card.aid.encapsulate).toBe(true);
    expect(card.render.position).toBe(5);
  });

  test('no-op on missing card / sections', () => {
    expect(() => walkCardTextFields(undefined, s => s)).not.toThrow();
    expect(() => walkCardTextFields({ id: 'x' }, s => s)).not.toThrow();
  });
});

// ── warnUnresolvedFieldTokens ─────────────────────────────────────────────────

describe('warnUnresolvedFieldTokens', () => {
  test('warns once per distinct {$token} and returns true', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const found = warnUnresolvedFieldTokens('{$she} and {$she} and {$Aria}', 'card "X" (Y)');
    expect(found).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('{$she}'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('{$Aria}'));
    warn.mockRestore();
  });

  test('ignores {%…} and {@…} tokens', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    expect(warnUnresolvedFieldTokens('{%role} {@main}/x', 'x')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('clean text and non-string return false', () => {
    expect(warnUnresolvedFieldTokens('resolved text', 'x')).toBe(false);
    expect(warnUnresolvedFieldTokens(null, 'x')).toBe(false);
  });
});

describe('warnMechanicalArtifacts', () => {
  test('flags a guessed verb marker like [does] instead of silently passing it through', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const found = warnMechanicalArtifacts('Aness love[does] magic research', 'card "X" (Y)');
    expect(found).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[does]'));
    warn.mockRestore();
  });

  test('does not flag real verb markers or [e] as suspect', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const found = warnMechanicalArtifacts('[e] Aness love[s] magic', 'card "X" (Y)');
    // [s] itself is still flagged as an unresolved *real* marker, but not as "suspect"
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("isn't a recognized"));
    warn.mockRestore();
  });

  test('does not flag a single-word trigger in the fence as a suspect marker', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const rendered = '## Door\n\n~~~\ntriggers: [door]\nencapsulate: true\n~~~\n\n[e] A plain wooden door.';
    warnMechanicalArtifacts(rendered, 'card "Door" (Location)');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("isn't a recognized"));
    warn.mockRestore();
  });

  test('flags leaked template functions, tags, and JS artifacts', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    warnMechanicalArtifacts('{join("; ", $body.Tagline)} {if $x}{/if} [object Object] undefined', 'card "X" (Y)');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaked render function'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaked template tag'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('JS interpolation artifact'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('possible JS interpolation artifact "undefined"'));
    warn.mockRestore();
  });

  test('clean text returns false', () => {
    expect(warnMechanicalArtifacts('Aness loves magic research.', 'x')).toBe(false);
  });
});

describe('maskFencedRegions', () => {
  test('blanks out fence content, preserving newlines and non-fence text', () => {
    const text = 'before\n~~~\ntriggers: [door]\nencapsulate: true\n~~~\nafter';
    const masked = maskFencedRegions(text);
    expect(masked).not.toContain('[door]');
    expect(masked.split('\n').length).toBe(text.split('\n').length);
    expect(masked.startsWith('before\n')).toBe(true);
    expect(masked.endsWith('\nafter')).toBe(true);
  });

  test('leaves text with no fence unchanged', () => {
    expect(maskFencedRegions('no fence here')).toBe('no fence here');
  });

  test('non-string input passes through', () => {
    expect(maskFencedRegions(null)).toBeNull();
  });
});

// ── findFiles (fs-mocked) ─────────────────────────────────────────────────────

describe('findFiles', () => {
  afterEach(() => jest.restoreAllMocks());

  test('returns empty array when directory does not exist', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(findFiles('/nonexistent', '.yaml')).toEqual([]);
  });

  const file  = (name) => ({ name, isDirectory: () => false, isFile: () => true,  isSymbolicLink: () => false });
  const dir   = (name) => ({ name, isDirectory: () => true,  isFile: () => false, isSymbolicLink: () => false });
  const link  = (name) => ({ name, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true  });

  test('returns files matching extension', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue([
      file('cards.yaml'),
      file('readme.txt'),
    ]);
    const result = findFiles('/dir', '.yaml');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('cards.yaml');
  });

  test('filters by extension case-insensitively', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue([file('CARDS.YAML')]);
    expect(findFiles('/dir', '.yaml')).toHaveLength(1);
  });

  test('recurses into subdirectories', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync')
      .mockReturnValueOnce([dir('sub')])
      .mockReturnValueOnce([file('nested.yaml')]);
    const result = findFiles('/dir', '.yaml');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('nested.yaml');
  });

  test('ignores files with non-matching extension', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue([
      file('file.template'),
      file('file.yaml'),
    ]);
    const result = findFiles('/dir', '.template');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('file.template');
  });

  test('follows symlinks to files', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue([link('linked.yaml')]);
    jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false, isFile: () => true });
    const result = findFiles('/dir', '.yaml');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('linked.yaml');
  });

  test('follows symlinks to directories', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync')
      .mockReturnValueOnce([link('subdir')])
      .mockReturnValueOnce([file('deep.yaml')]);
    jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true, isFile: () => false });
    const result = findFiles('/dir', '.yaml');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('deep.yaml');
  });

  test('skips broken symlinks', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue([link('broken.yaml')]);
    jest.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('ENOENT'); });
    expect(findFiles('/dir', '.yaml')).toHaveLength(0);
  });
});

// ── loadYaml (fs-mocked) ──────────────────────────────────────────────────────

describe('loadYaml', () => {
  afterEach(() => jest.restoreAllMocks());

  test('returns parsed object from YAML content', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('key: value\nnum: 42\n');
    const result = loadYaml('/some/file.yaml');
    expect(result).toEqual({ key: 'value', num: 42 });
  });

  test('returns parsed array from YAML sequence', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('- a\n- b\n');
    const result = loadYaml('/list.yaml');
    expect(result).toEqual(['a', 'b']);
  });

  test('throws wrapped error on read failure', () => {
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => loadYaml('/missing.yaml')).toThrow('Failed to load YAML');
  });

  test('throws wrapped error on invalid YAML syntax', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('key: [unclosed');
    expect(() => loadYaml('/bad.yaml')).toThrow('Failed to load YAML');
  });
});
