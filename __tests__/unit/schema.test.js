'use strict';

const { TYPES, CODES, validate, buildKeyIndex, levenshtein } = require('../../src/schema');
const { Diagnostics } = require('../../src/diag');

const S = { type: TYPES.STRING };

/** A small schema exercising every descriptor feature. */
const SCHEMA = {
  type: TYPES.MAP,
  keys: {
    version: { type: TYPES.NUMBER },
    title: S,
    structure: {
      type: TYPES.MAP,
      keys: {
        output: { type: TYPES.STRING, required: true },
        reports: S,
        input: {
          type: TYPES.MAP,
          keys: {
            items: { type: TYPES.SEQ, of: S },
            canon: { type: TYPES.RECORD, of: S },
          },
        },
      },
    },
    variables: { type: TYPES.RECORD, of: S },
    body: { type: TYPES.ANY },
    future: { type: TYPES.STRING, note: 'Phase 9' },
    legacy: { type: TYPES.STRING, alias: 'title' },
    kind: { type: TYPES.STRING, values: ['story', 'reference'] },
  },
};

function run(value, schema = SCHEMA) {
  const diagnostics = new Diagnostics();
  const result = validate(value, schema, { diagnostics });
  return { diagnostics, result, codes: diagnostics.all.map((d) => d.code) };
}

describe('unknown keys', () => {
  test('an unknown key at the top level is an ERROR', () => {
    const { diagnostics, codes } = run({ nonsense: 1 });
    expect(codes).toContain(CODES.UNKNOWN_KEY);
    expect(diagnostics.hasErrors()).toBe(true);
  });

  test('an unknown key names the block it was found in', () => {
    const { diagnostics } = run({ structure: { output: 'o', bogus: 1 } });
    expect(diagnostics.errors[0].message).toContain('under "structure"');
  });

  test('a declared key is accepted', () => {
    expect(run({ title: 'x' }).diagnostics.isEmpty()).toBe(true);
  });

  test('validation descends into nested maps', () => {
    const { diagnostics } = run({ structure: { output: 'o', input: { nope: [] } } });
    expect(diagnostics.errors[0].message).toContain('under "structure.input"');
  });
});

describe('relocation suggestions — the §4.3 headline', () => {
  test('a valid key at the wrong level suggests where it belongs', () => {
    const { diagnostics, codes } = run({ canon: { a: 'b' }, structure: { output: 'o' } });
    expect(codes).toContain(CODES.MISPLACED_KEY);
    expect(diagnostics.errors[0].hint).toBe('"canon" is valid under "structure.input:" — did you mean to nest it there?');
  });

  test('relocation is preferred over a spelling suggestion', () => {
    // "reports" exists under structure; misplacing it at the top level should relocate,
    // not offer an edit-distance guess at some other top-level key.
    const { diagnostics, codes } = run({ reports: './r', structure: { output: 'o' } });
    expect(codes).toContain(CODES.MISPLACED_KEY);
    expect(diagnostics.errors[0].hint).toContain('nest it there');
  });

  test('a misspelling falls back to edit distance', () => {
    const { diagnostics, codes } = run({ structure: { output: 'o', reprots: './r' } });
    expect(codes).toContain(CODES.UNKNOWN_KEY);
    expect(diagnostics.errors[0].hint).toBe('Did you mean "reports"?');
  });

  test('a transposition is caught — the commonest typo', () => {
    const { diagnostics } = run({ titel: 'x' });
    expect(diagnostics.errors[0].hint).toBe('Did you mean "title"?');
  });

  test('a key resembling nothing gets no hint rather than a nonsense one', () => {
    const { diagnostics } = run({ zzzzqqqq: 'x' });
    expect(diagnostics.errors[0].hint).toBeNull();
  });

  test('open namespaces are never proposed as a relocation target', () => {
    // `body:` accepts any key. Were it indexed as a destination, *every* unknown key
    // anywhere would collect a technically-true, useless "did you mean to nest it under
    // body?". No hint at all is the correct outcome for a key resembling nothing.
    const { diagnostics } = run({ anythingAtAll: 1 });
    expect(diagnostics.errors[0].code).toBe(CODES.UNKNOWN_KEY);
    expect(diagnostics.errors[0].hint).toBeNull();
  });
});

describe('type checking', () => {
  test('a wrong scalar type is an ERROR', () => {
    const { diagnostics, codes } = run({ title: 42 });
    expect(codes).toContain(CODES.WRONG_TYPE);
    expect(diagnostics.errors[0].message).toContain('must be a string');
  });

  test('the message describes what was found', () => {
    const { diagnostics } = run({ title: ['a'] });
    expect(diagnostics.errors[0].message).toContain('is a sequence');
  });

  test('a sequence given a non-empty mapping is an ERROR', () => {
    const { diagnostics } = run({ structure: { output: 'o', input: { items: { a: 1 } } } });
    expect(diagnostics.errors[0].code).toBe(CODES.WRONG_TYPE);
  });

  test('sequence elements are checked', () => {
    const { diagnostics } = run({ structure: { output: 'o', input: { items: ['ok', 42] } } });
    expect(diagnostics.errors[0].message).toContain('structure.input.items.1');
  });

  test('record values are checked', () => {
    const { diagnostics } = run({ variables: { a: 'ok', b: [] } });
    expect(diagnostics.errors[0].message).toContain('variables.b');
  });

  test('a union type accepts either member', () => {
    const schema = { type: TYPES.MAP, keys: { x: { type: [TYPES.STRING, TYPES.SEQ], of: S } } };
    expect(run({ x: 'a' }, schema).diagnostics.isEmpty()).toBe(true);
    expect(run({ x: ['a'] }, schema).diagnostics.isEmpty()).toBe(true);
  });

  test('an open namespace accepts anything', () => {
    expect(run({ body: { any: ['shape', { at: 'all' }] } }).diagnostics.isEmpty()).toBe(true);
  });
});

describe('empty-collection normalization (§3.3)', () => {
  test('{} is accepted where a sequence is expected, and normalized to []', () => {
    const { diagnostics, result } = run({ structure: { output: 'o', input: { items: {} } } });
    expect(diagnostics.isEmpty()).toBe(true);
    expect(result.structure.input.items).toEqual([]);
  });

  test('[] is accepted where a mapping is expected, and normalized to {}', () => {
    const { diagnostics, result } = run({ variables: [] });
    expect(diagnostics.isEmpty()).toBe(true);
    expect(result.variables).toEqual({});
  });

  test('a non-empty value of the wrong type is still an ERROR', () => {
    expect(run({ variables: ['a'] }).codes).toContain(CODES.WRONG_TYPE);
  });

  test('null is left alone — `~` means delete, not empty (§6.4)', () => {
    const { diagnostics, result } = run({ variables: null });
    expect(diagnostics.isEmpty()).toBe(true);
    expect(result.variables).toBeNull();
  });
});

describe('required keys', () => {
  test('a missing required key is an ERROR', () => {
    const { codes } = run({ structure: {} });
    expect(codes).toContain(CODES.MISSING_REQUIRED);
  });

  test('present satisfies it', () => {
    expect(run({ structure: { output: 'o' } }).diagnostics.isEmpty()).toBe(true);
  });

  test('a required key inside an absent parent is not reported', () => {
    expect(run({ title: 'x' }).diagnostics.isEmpty()).toBe(true);
  });
});

describe('later-phase and superseded keys', () => {
  test('a key with a note is recognized and WARNs', () => {
    const { diagnostics, codes } = run({ future: 'x' });
    expect(codes).toEqual([CODES.NOT_YET_IMPLEMENTED]);
    expect(diagnostics.hasErrors()).toBe(false);
    expect(diagnostics.warnings[0].message).toContain('Phase 9');
  });

  test('a superseded key WARNs and names its replacement', () => {
    const { diagnostics, codes } = run({ legacy: 'x' });
    expect(codes).toEqual([CODES.SUPERSEDED_KEY]);
    expect(diagnostics.warnings[0].message).toContain('"title"');
  });
});

/**
 * `values:` — a closed set, added for §4.8's `kind:`.
 *
 * It reports after the type test rather than instead of it, because "must be a string" is
 * the more actionable message when a value is both wrong-typed and unlisted.
 */
describe('closed value sets', () => {
  test('a listed value passes', () => {
    expect(run({ kind: 'reference' }).codes).toEqual([]);
  });

  test('an unlisted value is an ERROR naming the whole set', () => {
    const { diagnostics, codes } = run({ kind: 'refrence' });
    expect(codes).toEqual([CODES.VALUE_NOT_ALLOWED]);
    expect(diagnostics.errors[0].message).toContain('"story" or "reference"');
  });

  test('case matters — the set is keywords, not prose', () => {
    expect(run({ kind: 'Reference' }).codes).toEqual([CODES.VALUE_NOT_ALLOWED]);
  });

  test('a wrong-typed value reports as a type error, not an unlisted one', () => {
    expect(run({ kind: 42 }).codes).toEqual([CODES.WRONG_TYPE]);
  });

  test('an absent key is not a violation — `values:` does not imply required', () => {
    expect(run({ title: 'x' }).codes).toEqual([]);
  });
});

describe('buildKeyIndex', () => {
  test('indexes nested keys by their dotted path', () => {
    expect(buildKeyIndex(SCHEMA).get('canon')).toEqual(['structure.input.canon']);
  });

  test('terminates on a self-referential schema', () => {
    const node = { type: TYPES.MAP, keys: { title: S } };
    node.keys.branches = { type: TYPES.RECORD, of: node };
    expect(() => buildKeyIndex({ type: TYPES.MAP, keys: { branches: node.keys.branches } })).not.toThrow();
  });

  test('does not index open namespaces', () => {
    expect(buildKeyIndex(SCHEMA).has('any')).toBe(false);
  });
});

describe('levenshtein', () => {
  test.each([
    ['abc', 'abc', 0],
    ['abc', 'abd', 1],
    ['titel', 'title', 1],
    ['abc', '', 3],
    ['', 'abc', 3],
    ['reprots', 'reports', 1],
    ['kitten', 'sitting', 3],
  ])('distance(%s, %s) === %i', (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected);
  });
});

describe('validation without a diagnostics bus', () => {
  test('normalizes without throwing when no bus is supplied', () => {
    const value = { variables: [] };
    expect(() => validate(value, SCHEMA, {})).not.toThrow();
    expect(value.variables).toEqual({});
  });
});
