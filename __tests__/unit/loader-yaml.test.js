'use strict';

const fs = require('fs');
const { loadYaml, loadYamlDocument, parseYaml, SourceMap } = require('../../src/loader/yaml');

afterEach(() => jest.restoreAllMocks());

// ── the preserved v3 contract ────────────────────────────────────────────────
//
// These mirror the assertions util.test.js makes about loadYaml. They are repeated
// here because the implementation moved: the point is that the contract survived the
// parser swap, not merely that some function called loadYaml still exists.

describe('loadYaml — v3 contract', () => {
  test('returns a parsed mapping', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('key: value\nnum: 42\n');
    expect(loadYaml('/some/file.yaml')).toEqual({ key: 'value', num: 42 });
  });

  test('returns a parsed sequence', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('- a\n- b\n');
    expect(loadYaml('/list.yaml')).toEqual(['a', 'b']);
  });

  test('returns undefined for an empty document, as js-yaml did', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('');
    expect(loadYaml('/empty.yaml')).toBeUndefined();
  });

  test('returns undefined for a comment-only document', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('# nothing here\n');
    expect(loadYaml('/comment.yaml')).toBeUndefined();
  });

  test('distinguishes an explicit null from an empty file', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('~\n');
    expect(loadYaml('/tilde.yaml')).toBeNull();
  });

  test('throws a wrapped error naming the path when the file cannot be read', () => {
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => loadYaml('/missing.yaml')).toThrow('Failed to load YAML at /missing.yaml');
  });

  test('throws a wrapped error on malformed YAML', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('key: [unclosed');
    expect(() => loadYaml('/bad.yaml')).toThrow('Failed to load YAML');
  });

  test('reports duplicate keys as an error rather than silently keeping one', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('a: 1\na: 2\n');
    expect(() => loadYaml('/dupe.yaml')).toThrow('Failed to load YAML');
  });
});

// ── YAML 1.2 core schema behavior ────────────────────────────────────────────
//
// The swap would be silently wrong if the new parser resolved scalars differently.

describe('scalar resolution matches the 1.2 core schema', () => {
  const parse = (text) => parseYaml(text, 'x.yaml').value;

  test('yes/no/on/off stay strings', () => {
    expect(parse('a: yes\nb: no\nc: on\nd: off\n')).toEqual({ a: 'yes', b: 'no', c: 'on', d: 'off' });
  });

  test('true/false are booleans', () => {
    expect(parse('a: true\nb: false\n')).toEqual({ a: true, b: false });
  });

  test('unquoted dates stay strings', () => {
    expect(parse('d: 2026-08-04\n')).toEqual({ d: '2026-08-04' });
  });

  test('quoted numerics stay strings', () => {
    expect(parse('v: "42"\n')).toEqual({ v: '42' });
  });

  test('a leading-zero time-like value stays a string', () => {
    expect(parse('t: "9:00 AM"\n')).toEqual({ t: '9:00 AM' });
  });
});

// ── source positions ─────────────────────────────────────────────────────────

describe('SourceMap positions', () => {
  const DOC = [
    'version: 4',          // line 1
    'structure:',          // line 2
    '  input:',            // line 3
    '    items:',          // line 4
    '      - ./Codex',     // line 5
    '      - ./Extra',     // line 6
    '  output: ../out',    // line 7
  ].join('\n');

  let sourceMap;
  beforeEach(() => { ({ sourceMap } = parseYaml(DOC, 'compile.cl.yaml')); });

  test('locates a top-level key', () => {
    expect(sourceMap.at('version')).toEqual({ file: 'compile.cl.yaml', line: 1, col: 1 });
  });

  test('locates a nested key at its own key token', () => {
    expect(sourceMap.at('structure', 'input', 'items')).toEqual({ file: 'compile.cl.yaml', line: 4, col: 5 });
  });

  test('locates a sequence entry by index', () => {
    expect(sourceMap.at('structure', 'input', 'items', 1)).toEqual({ file: 'compile.cl.yaml', line: 6, col: 9 });
  });

  test('accepts a path array as well as varargs', () => {
    expect(sourceMap.at(['structure', 'output'])).toEqual(sourceMap.at('structure', 'output'));
  });

  test('coerces numeric indices to strings', () => {
    expect(sourceMap.at('structure', 'input', 'items', 0)).toEqual(sourceMap.at('structure', 'input', 'items', '0'));
  });

  test('an unknown path still yields the file, so a diagnostic keeps a location', () => {
    expect(sourceMap.at('nope', 'missing')).toEqual({ file: 'compile.cl.yaml' });
  });

  test('has() reports whether an exact path was recorded', () => {
    expect(sourceMap.has('structure', 'input')).toBe(true);
    expect(sourceMap.has('structure', 'absent')).toBe(false);
  });

  test('nearest() falls back to the closest recorded ancestor', () => {
    // `reports` was never written, but the block that should hold it was.
    expect(sourceMap.nearest('structure', 'reports')).toEqual(sourceMap.at('structure'));
  });

  test('nearest() returns the exact position when the path itself exists', () => {
    expect(sourceMap.nearest('structure', 'output')).toEqual(sourceMap.at('structure', 'output'));
  });

  test('nearest() degrades to the file when nothing matches', () => {
    const { sourceMap: empty } = parseYaml('', 'blank.yaml');
    expect(empty.nearest('a', 'b')).toEqual({ file: 'blank.yaml' });
  });
});

describe('SourceMap with awkward keys', () => {
  test('keys containing spaces and dashes address correctly', () => {
    const { sourceMap } = parseYaml('branches:\n  Free Form:\n    title: x\n', 'c.yaml');
    expect(sourceMap.at('branches', 'Free Form', 'title')).toEqual({ file: 'c.yaml', line: 3, col: 5 });
  });

  test('sibling keys are not confused by a shared prefix', () => {
    const { sourceMap } = parseYaml('a:\n  b c: 1\nab:\n  c: 2\n', 'c.yaml');
    expect(sourceMap.at('a', 'b c').line).toBe(2);
    expect(sourceMap.at('ab', 'c').line).toBe(4);
  });

  test('numeric-looking keys do not collide with sequence indices', () => {
    const { sourceMap } = parseYaml('m:\n  0: zero\n', 'c.yaml');
    expect(sourceMap.at('m', '0')).toEqual({ file: 'c.yaml', line: 2, col: 3 });
  });

  test('flow collections are indexed too', () => {
    const { sourceMap } = parseYaml('aid:\n  triggers: [Aness, Vale]\n', 'c.yaml');
    expect(sourceMap.at('aid', 'triggers', 1)).toEqual({ file: 'c.yaml', line: 2, col: 21 });
  });
});

describe('loadYamlDocument', () => {
  test('returns the value and a file-tagged source map together', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('a:\n  b: 1\n');
    const { value, sourceMap } = loadYamlDocument('/real/path.cl.yaml');
    expect(value).toEqual({ a: { b: 1 } });
    expect(sourceMap).toBeInstanceOf(SourceMap);
    expect(sourceMap.at('a', 'b')).toEqual({ file: '/real/path.cl.yaml', line: 2, col: 3 });
  });

  test('wraps load failures the same way loadYaml does', () => {
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => loadYamlDocument('/missing.yaml')).toThrow('Failed to load YAML at /missing.yaml');
  });
});
