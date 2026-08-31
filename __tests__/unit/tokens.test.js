'use strict';

const { resolveVariables } = require('../../src/util');

/**
 * The former `{%}`/`{@}` token expander. `tokens.js`/`expandTokens` was deleted in Phase 17
 * — it only ever adapted an argument shape over `util.resolveVariables`, and its non-string
 * guard was already the first line of that function. These cases now target `resolveVariables`
 * directly.
 *
 * `{@name}` is gone as of §6.1, and with it the second naming system. What this file used
 * to test — component-vs-canon precedence, path mode vs content mode, per-type lookup
 * maps — no longer exists to test. Canon names are exposed as `{%}` variables, so a canon
 * reference now resolves through exactly the same path as any other variable.
 */

describe('resolveVariables — {%variable}', () => {
  const variables = {
    setting: 'The Royal Academy',
    house: '{%setting} — Northern Wing',
    characters: '/canon/_General/Characters',
  };

  test('expands a simple variable', () => {
    expect(resolveVariables('Year {%year}', { year: '1315' })).toBe('Year 1315');
  });

  test('case-insensitive key lookup', () => {
    expect(resolveVariables('{%NAME}', { name: 'Aria' })).toBe('Aria');
  });

  test('recursive expansion (A references B)', () => {
    expect(resolveVariables('{%house}', variables)).toBe('The Royal Academy — Northern Wing');
  });

  test('expands several tokens in one string', () => {
    expect(resolveVariables('{%setting}: {%characters}', variables))
      .toBe('The Royal Academy: /canon/_General/Characters');
  });

  test('a canon name resolves like any other variable — the {@} replacement', () => {
    expect(resolveVariables('{%characters}/Aness.yaml', variables))
      .toBe('/canon/_General/Characters/Aness.yaml');
  });

  test('undeclared variable warns and leaves token literal', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    expect(resolveVariables('{%missing}', {})).toBe('{%missing}');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing'));
    warn.mockRestore();
  });

  test('cycle warns and leaves token literal', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    expect(resolveVariables('{%a}', { a: '{%b}', b: '{%a}' })).toContain('{%');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('returns text unchanged when no variables are supplied', () => {
    expect(resolveVariables('{%setting}', undefined)).toBe('{%setting}');
  });

  test('passes through a string with no tokens', () => {
    expect(resolveVariables('plain text', variables)).toBe('plain text');
  });
});

describe('resolveVariables — non-string input', () => {
  test.each([null, undefined, 42])('returns %p unchanged', (value) => {
    expect(resolveVariables(value, {})).toBe(value);
  });
});

describe('the {@} family is gone (§6.1)', () => {
  test('an {@name} token is left untouched rather than resolved', () => {
    // Nothing consumes it any more; the migrator rewrites these before v4 sees them.
    expect(resolveVariables('{@characters}/Aness.yaml', { characters: '/x' }))
      .toBe('{@characters}/Aness.yaml');
  });
});
