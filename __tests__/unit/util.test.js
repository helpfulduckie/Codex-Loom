'use strict';

const fs = require('fs');
const {
  findFiles, loadYaml, deepClone, findKey,
  getCI, setCI, deleteCI, normalizeVarKey, resolveVariables,
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
