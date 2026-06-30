'use strict';

const fs = require('fs');
const { loadANConfig, compileAN, writeAN } = require('../../src/an');

const registry = new Map();
const ctx = { branchPath: [], branchProtagonist: null, variables: {} };

// ── compileAN ─────────────────────────────────────────────────────────────────
// resolveANBranches is internal — tested here via compileAN behaviour.

describe('compileAN', () => {
  test('null doc → null', () => {
    expect(compileAN(null, registry, ctx)).toBeNull();
  });

  test('doc with plain text section → rendered string', () => {
    const doc = { sections: { s: { text: 'Write poetically.' } } };
    expect(compileAN(doc, registry, ctx)).toContain('Write poetically.');
  });

  test('empty section text → null', () => {
    const doc = { sections: { s: { text: '' } } };
    expect(compileAN(doc, registry, ctx)).toBeNull();
  });

  test('no sections key → null', () => {
    expect(compileAN({}, registry, ctx)).toBeNull();
  });

  test('applies scalar branch variant before rendering', () => {
    const doc = {
      sections: { s: { text: 'base', variants: { dark: { text: 'dark text' } } } },
      variants: { v1: { apply: 'dark' } },
      branches: { main: 'v1' },
    };
    const ctxBranched = { branchPath: ['main'], branchProtagonist: null, variables: {} };
    expect(compileAN(doc, registry, ctxBranched)).toContain('dark text');
  });

  test('applies array branch variants in order', () => {
    const doc = {
      sections: { s: { text: 'base', variants: { v1: { text: 'step1' }, v2: { text: 'step2' } } } },
      variants: {
        d1: { apply: 'v1' },
        d2: { apply: 'v2' },
      },
      branches: { main: ['d1', 'd2'] },
    };
    const ctxBranched = { branchPath: ['main'], branchProtagonist: null, variables: {} };
    expect(compileAN(doc, registry, ctxBranched)).toContain('step2');
  });

  test('null branch value → renders base content unchanged', () => {
    const doc = {
      sections: { s: { text: 'Base content.' } },
      branches: { main: null },
    };
    const ctxBranched = { branchPath: ['main'], branchProtagonist: null, variables: {} };
    expect(compileAN(doc, registry, ctxBranched)).toContain('Base content.');
  });

  test('wildcard "*" branch applies variant for unmatched branches', () => {
    const doc = {
      sections: { s: { text: 'base', variants: { wild: { text: 'wildcard text' } } } },
      variants: { wv: { apply: 'wild' } },
      branches: { '*': 'wv' },
    };
    const ctxBranched = { branchPath: ['anything'], branchProtagonist: null, variables: {} };
    expect(compileAN(doc, registry, ctxBranched)).toContain('wildcard text');
  });

  test('case-insensitive branch key matching', () => {
    const doc = {
      sections: { s: { text: 'base', variants: { dark: { text: 'dark' } } } },
      variants: { v1: { apply: 'dark' } },
      branches: { Main: 'v1' },
    };
    const ctxBranched = { branchPath: ['main'], branchProtagonist: null, variables: {} };
    expect(compileAN(doc, registry, ctxBranched)).toContain('dark');
  });

  test('accidental ain: key in branches uses ain: value', () => {
    const doc = {
      sections: { s: { text: 'base', variants: { v1: { text: 'applied' } } } },
      variants: { docV: { apply: 'v1' } },
      branches: { main: { ain: 'docV', cards: 'ignored' } },
    };
    const ctxBranched = { branchPath: ['main'], branchProtagonist: null, variables: {} };
    expect(compileAN(doc, registry, ctxBranched)).toContain('applied');
  });

  test('nested two-level branch path', () => {
    const doc = {
      sections: { s: { text: 'base', variants: { deep: { text: 'deep text' } } } },
      variants: { dv: { apply: 'deep' } },
      branches: { tier1: { tier2: 'dv' } },
    };
    const ctxBranched = { branchPath: ['tier1', 'tier2'], branchProtagonist: null, variables: {} };
    expect(compileAN(doc, registry, ctxBranched)).toContain('deep text');
  });

  test('{%variable} tokens resolved from context', () => {
    const doc = { sections: { s: { text: 'Role: {%role}' } } };
    const ctxWithVars = { branchPath: [], branchProtagonist: null, variables: { role: 'mage' } };
    expect(compileAN(doc, registry, ctxWithVars)).toContain('Role: mage');
  });
});

// ── loadANConfig (fs-mocked) ──────────────────────────────────────────────────

describe('loadANConfig', () => {
  afterEach(() => jest.restoreAllMocks());

  test('null spec → null', () => {
    expect(loadANConfig(null)).toBeNull();
  });

  test('missing file → warns and returns null', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(loadANConfig('/missing.yaml')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  test('scalar YAML (string) → throws', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('just a string\n');
    expect(() => loadANConfig('/bad.yaml')).toThrow('AN file must be a YAML mapping');
  });

  test('sequence YAML (array) → throws', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('- item1\n- item2\n');
    expect(() => loadANConfig('/bad.yaml')).toThrow('AN file must be a YAML mapping');
  });

  test('doc with card: block → warns and strips it', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(
      'sections:\n  s:\n    text: Hi\ncard:\n  title: X\n'
    );
    const result = loadANConfig('/an.yaml');
    expect(result).not.toHaveProperty('card');
    expect(result).toHaveProperty('sections');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('card:'));
  });

  test('valid mapping returns parsed doc', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('sections:\n  intro:\n    text: Hello\n');
    expect(loadANConfig('/an.yaml')).toEqual({ sections: { intro: { text: 'Hello' } } });
  });
});

// ── writeAN (fs-mocked) ───────────────────────────────────────────────────────

describe('writeAN', () => {
  afterEach(() => jest.restoreAllMocks());

  test('null content → returns null and does not write', () => {
    const writeFileSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();
    jest.spyOn(fs, 'mkdirSync').mockImplementation();
    expect(writeAN('/output/branch', null)).toBeNull();
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  test("writes to Components/Author Notes.md", () => {
    const writeFileSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();
    jest.spyOn(fs, 'mkdirSync').mockImplementation();
    const outPath = writeAN('/output/branch', 'content');
    expect(outPath).toContain("Author Notes.md");
    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining("Author Notes.md"),
      'content\n',
      'utf8'
    );
  });

  test('creates Components directory', () => {
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation();
    jest.spyOn(fs, 'writeFileSync').mockImplementation();
    writeAN('/output/branch', 'content');
    expect(mkdirSpy).toHaveBeenCalledWith(
      expect.stringContaining('Components'),
      { recursive: true }
    );
  });
});
