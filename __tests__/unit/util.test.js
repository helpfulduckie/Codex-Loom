'use strict';

const fs = require('fs');
const {
  findFiles, loadYaml, deepClone, findKey,
  getCI, setCI, deleteCI, normalizeVarKey, resolveVariables, checkUnexpandedVariables,
  walkItemTextFields, checkUnresolvedFieldTokens, checkMechanicalArtifacts, maskFencedRegions,
} = require('../../src/util');
const { Diagnostics } = require('../../src/diag');

/**
 * The leak detectors report onto the bus rather than to the console (§12.5), so what these
 * assert on is `{ severity, code, message }` — the three things a caller downstream can act
 * on. Severity in particular is the point of the change: six of the eight patterns are now
 * ERRORs that fail the run, where every one of them used to print a flat `WARN:` and gate
 * nothing.
 */
function collect(run) {
  const diagnostics = new Diagnostics();
  const found = run({ diagnostics });
  return {
    found,
    rows: diagnostics.all.map((d) => ({ severity: d.severity, code: d.code, message: d.message })),
  };
}

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

// ── checkUnexpandedVariables ──────────────────────────────────────────────────

describe('checkUnexpandedVariables', () => {
  test('reports CL0431 once per distinct {%token}, at ERROR, and returns true', () => {
    const { found, rows } = collect((sink) =>
      checkUnexpandedVariables('a {%role} b {%role} c {%era}', 'item "X" (Y)', sink));
    expect(found).toBe(true);
    expect(rows).toHaveLength(2); // {%role} deduped, {%era}
    expect(rows.every((r) => r.code === 'CL0431' && r.severity === 'error')).toBe(true);
    expect(rows[0].message).toContain('{%role}');
    expect(rows[1].message).toContain('{%era}');
    expect(rows[0].message).toContain('item "X" (Y)');
  });

  test('ignores {@name} references and returns false', () => {
    const { found, rows } = collect((sink) =>
      checkUnexpandedVariables('see {@main}/x for details', 'component Opening.md', sink));
    expect(found).toBe(false);
    expect(rows).toEqual([]);
  });

  test('clean text returns false and reports nothing', () => {
    const { found, rows } = collect((sink) => checkUnexpandedVariables('fully resolved', 'x', sink));
    expect(found).toBe(false);
    expect(rows).toEqual([]);
  });

  test('non-string input returns false', () => {
    expect(checkUnexpandedVariables(null, 'x')).toBe(false);
    expect(checkUnexpandedVariables(42, 'x')).toBe(false);
  });

  test('reports nothing and prints nothing when no bus is passed', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    expect(checkUnexpandedVariables('a {%role}', 'x')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ── walkItemTextFields ────────────────────────────────────────────────────────

describe('walkItemTextFields', () => {
  test('visits strings in body, aid, render, and name (incl. arrays + nesting)', () => {
    const item = {
      body: { Tagline: 'a', Traits: { hair: 'b' }, Keywords: ['c', 'd'] },
      aid: { title: 'e', triggers: ['f'] },
      render: { wrapper: 'g' },
      name: { display: 'h', full: 'i' },
    };
    walkItemTextFields(item, s => s.toUpperCase());
    expect(item.body.Tagline).toBe('A');
    expect(item.body.Traits.hair).toBe('B');
    expect(item.body.Keywords).toEqual(['C', 'D']);
    expect(item.aid.title).toBe('E');
    expect(item.aid.triggers).toEqual(['F']);
    expect(item.render.wrapper).toBe('G');
    expect(item.name.full).toBe('I');
  });

  test('leaves non-string values (numbers, booleans) untouched', () => {
    const item = { aid: { encapsulate: true }, render: { position: 5 }, body: {} };
    walkItemTextFields(item, () => 'X');
    expect(item.aid.encapsulate).toBe(true);
    expect(item.render.position).toBe(5);
  });

  test('no-op on missing item / sections', () => {
    expect(() => walkItemTextFields(undefined, s => s)).not.toThrow();
    expect(() => walkItemTextFields({ id: 'x' }, s => s)).not.toThrow();
  });
});

// ── checkUnresolvedFieldTokens ────────────────────────────────────────────────

describe('checkUnresolvedFieldTokens', () => {
  test('reports CL0430 once per distinct {$token}, at ERROR, and returns true', () => {
    const { found, rows } = collect((sink) =>
      checkUnresolvedFieldTokens('{$she} and {$she} and {$Aria}', 'item "X" (Y)', sink));
    expect(found).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.code === 'CL0430' && r.severity === 'error')).toBe(true);
    expect(rows[0].message).toContain('{$she}');
    expect(rows[1].message).toContain('{$Aria}');
  });

  test('ignores {%…} and {@…} tokens', () => {
    const { found, rows } = collect((sink) =>
      checkUnresolvedFieldTokens('{%role} {@main}/x', 'x', sink));
    expect(found).toBe(false);
    expect(rows).toEqual([]);
  });

  test('clean text and non-string return false', () => {
    expect(checkUnresolvedFieldTokens('resolved text', 'x')).toBe(false);
    expect(checkUnresolvedFieldTokens(null, 'x')).toBe(false);
  });
});

describe('checkMechanicalArtifacts', () => {
  test('a guessed verb marker like [does] is CL0436 at WARN — an opinion, not a fact', () => {
    const { found, rows } = collect((sink) =>
      checkMechanicalArtifacts('Aness love[does] magic research', 'item "X" (Y)', sink));
    expect(found).toBe(true);
    const suspect = rows.filter((r) => r.code === 'CL0436');
    expect(suspect).toHaveLength(1);
    expect(suspect[0].severity).toBe('warn');
    expect(suspect[0].message).toContain('[does]');
  });

  test('does not flag real verb markers or [e] as suspect', () => {
    const { rows } = collect((sink) =>
      checkMechanicalArtifacts('[e] Aness love[s] magic', 'item "X" (Y)', sink));
    // [s] is still an unresolved *real* marker (CL0434, ERROR), but nothing is "suspect".
    expect(rows.map((r) => r.code)).toContain('CL0434');
    expect(rows.map((r) => r.code)).not.toContain('CL0436');
  });

  test('does not flag a single-word trigger in the fence as a suspect marker', () => {
    const rendered = [
      '## Door', '', '~~~', 'triggers: [door]', 'encapsulate: true', '~~~', '',
      '[e] A plain wooden door.',
    ].join('\n');
    const { rows } = collect((sink) =>
      checkMechanicalArtifacts(rendered, 'item "Door" (Location)', sink));
    expect(rows.map((r) => r.code)).not.toContain('CL0436');
  });

  test('leaked functions, tags and artifacts are ERRORs; a bare "undefined" is a WARN', () => {
    const { rows } = collect((sink) => checkMechanicalArtifacts(
      '{join("; ", $body.Tagline)} {if $x}{/if} [object Object] undefined', 'item "X" (Y)', sink));
    const by = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(by.CL0432.severity).toBe('error');
    expect(by.CL0432.message).toContain('leaked render function');
    expect(by.CL0433.severity).toBe('error');
    expect(by.CL0433.message).toContain('leaked template tag');
    expect(by.CL0435.severity).toBe('error');
    expect(by.CL0435.message).toContain('JS interpolation artifact');
    expect(by.CL0437.severity).toBe('warn');
    expect(by.CL0437.message).toContain('possible JS interpolation artifact "undefined"');
  });

  test('clean text returns false', () => {
    expect(checkMechanicalArtifacts('Aness loves magic research.', 'x')).toBe(false);
  });

  test('lint.level reaches the two opinions and cannot reach the six facts', () => {
    const diagnostics = new Diagnostics({ lintLevel: 'off' });
    checkMechanicalArtifacts(
      'love[does] it {if $x}{/if} undefined', 'item "X" (Y)', { diagnostics });
    const codes = diagnostics.all.map((d) => d.code);
    expect(codes).toContain('CL0433');   // fact — survives `level: off`
    expect(codes).not.toContain('CL0436');
    expect(codes).not.toContain('CL0437');
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
      file('items.yaml'),
      file('readme.txt'),
    ]);
    const result = findFiles('/dir', '.yaml');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('items.yaml');
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
