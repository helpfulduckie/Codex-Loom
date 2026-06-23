'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { expandTokens, lookupReference } = require('../../src/tokens');

// ── {%variable} handling (delegates to util.resolveVariables) ─────────────────

describe('expandTokens — {%variable}', () => {
  test('expands a simple variable', () => {
    expect(expandTokens('Year {%year}', { variables: { year: '1315' } })).toBe('Year 1315');
  });

  test('case-insensitive key lookup', () => {
    expect(expandTokens('{%NAME}', { variables: { name: 'Aria' } })).toBe('Aria');
  });

  test('recursive expansion (A references B)', () => {
    expect(expandTokens('{%a}', { variables: { a: 'x {%b}', b: 'y' } })).toBe('x y');
  });

  test('undeclared variable warns and leaves token literal', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    expect(expandTokens('{%missing}', { variables: {} })).toBe('{%missing}');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing'));
    warn.mockRestore();
  });

  test('cycle warns and leaves token literal', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    expect(expandTokens('{%a}', { variables: { a: '{%a}' } })).toBe('{%a}');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cycle'));
    warn.mockRestore();
  });
});

// ── {@name} handling ──────────────────────────────────────────────────────────

describe('expandTokens — {@name} path mode', () => {
  // Outer key = component TYPE; inner Map key = the NAME that {@name} matches.
  const components = {
    opening: new Map([['op', '/abs/openings']]),
    plotEssential: new Map([['pe', '/abs/pe.yaml']]),
  };
  const canon = new Map([['main', '/abs/canon/main']]);

  test('resolves a component name to its path', () => {
    expect(expandTokens('{@op}/subject.md', { components, mode: 'path' }))
      .toBe('/abs/openings/subject.md');
  });

  test('resolves a canon name to its path', () => {
    expect(expandTokens('{@main}/Characters/Aria.yaml', { components, canon, mode: 'path' }))
      .toBe('/abs/canon/main/Characters/Aria.yaml');
  });

  test('components take precedence over canon for the same name', () => {
    const comps = { x: new Map([['shared', '/from/component']]) };
    const can = new Map([['shared', '/from/canon']]);
    expect(expandTokens('{@shared}', { components: comps, canon: can, mode: 'path' }))
      .toBe('/from/component');
  });

  test('case-insensitive name lookup', () => {
    expect(expandTokens('{@MAIN}', { canon, mode: 'path' })).toBe('/abs/canon/main');
  });

  test('not found: warns and leaves token literal when warnMissing (default)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    expect(expandTokens('{@nope}', { components })).toBe('{@nope}');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nope'));
    warn.mockRestore();
  });

  test('not found: silent passthrough when warnMissing is false', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    expect(expandTokens('{@nope}', { components, warnMissing: false })).toBe('{@nope}');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('accepts a single Map as the components argument', () => {
    const single = new Map([['op', '/abs/op']]);
    expect(expandTokens('{@op}', { components: single, mode: 'path' })).toBe('/abs/op');
  });
});

describe('expandTokens — {@name} content mode', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tokens-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('reads file contents for a name resolving to a file', () => {
    const file = path.join(tmpDir, 'body.md');
    fs.writeFileSync(file, '  Inline body text.  \n');
    const components = { aiInstructions: new Map([['body', file]]) };
    expect(expandTokens('{@body}', { components, mode: 'content' })).toBe('Inline body text.');
  });

  test('returns the path (not contents) for a name resolving to a directory', () => {
    const components = { opening: new Map([['dir', tmpDir]]) };
    expect(expandTokens('{@dir}', { components, mode: 'content' })).toBe(tmpDir);
  });
});

// ── mixed % and @ ─────────────────────────────────────────────────────────────

describe('expandTokens — mixed sigils', () => {
  test('expands both {%var} and {@name} in one string', () => {
    const components = { opening: new Map([['op', '/abs/op']]) };
    const out = expandTokens('{@op}/{%file}.md', {
      variables: { file: 'subject' }, components, mode: 'path',
    });
    expect(out).toBe('/abs/op/subject.md');
  });

  test('non-string input passes through unchanged', () => {
    expect(expandTokens(42, { variables: { a: '1' } })).toBe(42);
    expect(expandTokens(null, {})).toBeNull();
  });
});

// ── lookupReference ───────────────────────────────────────────────────────────

describe('lookupReference', () => {
  test('returns undefined when nothing matches', () => {
    expect(lookupReference('x', undefined, undefined)).toBeUndefined();
    expect(lookupReference('x', { t: new Map() }, new Map())).toBeUndefined();
  });

  test('finds across an object-of-maps then canon', () => {
    const comps = { a: new Map([['k1', 'v1']]), b: new Map([['k2', 'v2']]) };
    const canon = new Map([['k3', 'v3']]);
    expect(lookupReference('k2', comps, canon)).toBe('v2');
    expect(lookupReference('k3', comps, canon)).toBe('v3');
  });
});
