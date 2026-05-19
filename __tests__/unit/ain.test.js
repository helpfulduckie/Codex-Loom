'use strict';

const fs = require('fs');
const { loadAINConfig, compileAIN, writeAIN, resolveAINBranches, applyDocumentVariants } = require('../../src/ain');

const registry = new Map();
const ctx = { branchPath: [], branchProtagonist: null, variables: {} };

// ── resolveAINBranches ────────────────────────────────────────────────────────

describe('resolveAINBranches', () => {
  test('null spec → empty result', () => {
    expect(resolveAINBranches(null, [])).toEqual({ ainVariants: [], cardVariantSets: [] });
  });

  test('undefined spec → empty result', () => {
    expect(resolveAINBranches(undefined, ['branch'])).toEqual({ ainVariants: [], cardVariantSets: [] });
  });

  test('scalar string value → ainVariants', () => {
    expect(resolveAINBranches({ main: 'dark' }, ['main'])).toEqual({
      ainVariants: ['dark'], cardVariantSets: [],
    });
  });

  test('array value → ainVariants list', () => {
    expect(resolveAINBranches({ main: ['dark', 'grim'] }, ['main'])).toEqual({
      ainVariants: ['dark', 'grim'], cardVariantSets: [],
    });
  });

  test('null branch value → empty result (exclusion)', () => {
    expect(resolveAINBranches({ main: null }, ['main'])).toEqual({
      ainVariants: [], cardVariantSets: [],
    });
  });

  test('wildcard "*" matches unmatched branches', () => {
    expect(resolveAINBranches({ '*': 'default' }, ['anything'])).toEqual({
      ainVariants: ['default'], cardVariantSets: [],
    });
  });

  test('exact key takes priority over wildcard', () => {
    expect(resolveAINBranches({ main: 'specific', '*': 'default' }, ['main'])).toEqual({
      ainVariants: ['specific'], cardVariantSets: [],
    });
  });

  test('nested two-level branch path', () => {
    expect(resolveAINBranches({ tier1: { tier2: 'deep' } }, ['tier1', 'tier2'])).toEqual({
      ainVariants: ['deep'], cardVariantSets: [],
    });
  });

  test('case-insensitive branch key matching', () => {
    expect(resolveAINBranches({ Main: 'variant' }, ['main'])).toEqual({
      ainVariants: ['variant'], cardVariantSets: [],
    });
  });

  test('ain:/cards: mapping form splits ainVariants and cardVariantSets', () => {
    expect(resolveAINBranches({ main: { ain: 'ainV', cards: 'cardV' } }, ['main'])).toEqual({
      ainVariants: ['ainV'], cardVariantSets: [['cardV']],
    });
  });

  test('ain:/cards: with array cards produces multiple sets', () => {
    expect(resolveAINBranches({ main: { ain: 'ainV', cards: ['c1', 'c2'] } }, ['main'])).toEqual({
      ainVariants: ['ainV'], cardVariantSets: [['c1'], ['c2']],
    });
  });

  test('cards: only (no ain:) → ainVariants empty', () => {
    expect(resolveAINBranches({ main: { cards: 'cardV' } }, ['main'])).toEqual({
      ainVariants: [], cardVariantSets: [['cardV']],
    });
  });

  test('unknown branch path → empty result', () => {
    expect(resolveAINBranches({ main: 'variant' }, ['other'])).toEqual({
      ainVariants: [], cardVariantSets: [],
    });
  });
});

// ── applyDocumentVariants ─────────────────────────────────────────────────────

describe('applyDocumentVariants', () => {
  test('empty variantNames → returns doc unchanged', () => {
    const doc = { sections: { intro: { text: 'Hello' } } };
    expect(applyDocumentVariants(doc, [])).toBe(doc);
  });

  test('no doc.variants → returns doc unchanged', () => {
    const doc = { sections: { intro: { text: 'Hello' } } };
    expect(applyDocumentVariants(doc, ['unused'])).toBe(doc);
  });

  test('sections: null removes the named section', () => {
    const doc = {
      sections: { intro: { text: 'Hello' }, removed: { text: 'Gone' } },
      variants: { v1: { sections: { removed: null } } },
    };
    const result = applyDocumentVariants(doc, ['v1']);
    expect(result.sections).toHaveProperty('intro');
    expect(result.sections).not.toHaveProperty('removed');
  });

  test('card: overrides are merged into doc.card', () => {
    const doc = {
      card: { title: 'Old' },
      variants: { v1: { card: { title: 'New', extra: 'value' } } },
    };
    const result = applyDocumentVariants(doc, ['v1']);
    expect(result.card).toEqual({ title: 'New', extra: 'value' });
  });

  test('apply: propagates named section variants to matching sections', () => {
    const doc = {
      sections: {
        s1: { text: 'base', variants: { dark: { text: 'dark text' } } },
      },
      variants: { v1: { apply: 'dark' } },
    };
    const result = applyDocumentVariants(doc, ['v1']);
    expect(result.sections.s1.text).toBe('dark text');
  });

  test('apply: skips sections that do not define the named variant', () => {
    const doc = {
      sections: {
        s1: { text: 'base', variants: { dark: { text: 'dark' } } },
        s2: { text: 'other' },
      },
      variants: { v1: { apply: 'dark' } },
    };
    const result = applyDocumentVariants(doc, ['v1']);
    expect(result.sections.s2.text).toBe('other');
  });

  test('unknown variant name warns and skips', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const doc = { variants: {} };
    applyDocumentVariants(doc, ['nonexistent']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
    warn.mockRestore();
  });

  test('case-insensitive variant name lookup', () => {
    const doc = {
      sections: { s: { text: 'base', variants: { dark: { text: 'dark' } } } },
      variants: { V1: { apply: 'dark' } },
    };
    const result = applyDocumentVariants(doc, ['v1']);
    expect(result.sections.s.text).toBe('dark');
  });
});

// ── compileAIN ────────────────────────────────────────────────────────────────

describe('compileAIN', () => {
  test('null doc → { ain: null, storyCard: null }', () => {
    expect(compileAIN(null, registry, ctx)).toEqual({ ain: null, storyCard: null });
  });

  test('doc with plain text section → string output', () => {
    const doc = { sections: { s: { text: 'Write in second person.' } } };
    const { ain } = compileAIN(doc, registry, ctx);
    expect(ain).toContain('Write in second person.');
  });

  test('doc with heading → heading prepended at level 2', () => {
    const doc = { sections: { s: { heading: 'Style', text: 'Keep it terse.' } } };
    const { ain } = compileAIN(doc, registry, ctx);
    expect(ain).toContain('## Style');
    expect(ain).toContain('Keep it terse.');
  });

  test('headingLevel overrides default level', () => {
    const doc = { sections: { s: { heading: 'Tone', headingLevel: 3, text: 'Dark.' } } };
    const { ain } = compileAIN(doc, registry, ctx);
    expect(ain).toContain('### Tone');
  });

  test('headingLevel 0 → heading without hashes', () => {
    const doc = { sections: { s: { heading: 'Flat', headingLevel: 0, text: 'Text.' } } };
    const { ain } = compileAIN(doc, registry, ctx);
    expect(ain).toContain('Flat');
    expect(ain).not.toContain('# Flat');
  });

  test('render.bullet: true prefixes text with "- "', () => {
    const doc = { sections: { s: { text: 'Rule one.', render: { bullet: true } } } };
    const { ain } = compileAIN(doc, registry, ctx);
    expect(ain).toContain('- Rule one.');
  });

  test('sections sorted by render.position', () => {
    const doc = {
      sections: {
        second: { text: 'B', render: { position: 2 } },
        first:  { text: 'A', render: { position: 1 } },
      },
    };
    const { ain } = compileAIN(doc, registry, ctx);
    expect(ain.indexOf('A')).toBeLessThan(ain.indexOf('B'));
  });

  test('mapping text renders each entry', () => {
    const doc = { sections: { rules: { text: { r1: 'Rule A', r2: 'Rule B' } } } };
    const { ain } = compileAIN(doc, registry, ctx);
    expect(ain).toContain('Rule A');
    expect(ain).toContain('Rule B');
  });

  test('no cardVariantSets → storyCard: null', () => {
    const doc = { sections: { s: { text: 'Text.' } }, card: { title: 'Card' } };
    const { storyCard } = compileAIN(doc, registry, ctx);
    expect(storyCard).toBeNull();
  });

  test('cardVariantSets + card block → storyCard returned', () => {
    const doc = {
      sections: { s: { text: 'Text.' } },
      card: { title: 'MyCard' },
      branches: { main: { cards: 'cardVariant' } },
    };
    const ctxBranched = { branchPath: ['main'], branchProtagonist: null, variables: {} };
    const { storyCard } = compileAIN(doc, registry, ctxBranched);
    expect(storyCard).toEqual({ title: 'MyCard' });
  });

  test('all sections empty → ain: null', () => {
    const doc = { sections: { s: { text: '' } } };
    const { ain } = compileAIN(doc, registry, ctx);
    expect(ain).toBeNull();
  });

  test('no sections key → ain: null', () => {
    const { ain } = compileAIN({}, registry, ctx);
    expect(ain).toBeNull();
  });

  test('{%variable} tokens resolved from context', () => {
    const doc = { sections: { s: { text: 'Branch: {%role}' } } };
    const ctxWithVars = { branchPath: [], branchProtagonist: null, variables: { role: 'knight' } };
    const { ain } = compileAIN(doc, registry, ctxWithVars);
    expect(ain).toContain('Branch: knight');
  });
});

// ── loadAINConfig (fs-mocked) ─────────────────────────────────────────────────

describe('loadAINConfig', () => {
  afterEach(() => jest.restoreAllMocks());

  test('null spec → null', () => {
    expect(loadAINConfig(null)).toBeNull();
  });

  test('missing file → warns and returns null', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(loadAINConfig('/missing.yaml')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  test('scalar YAML (string) → throws', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('just a string\n');
    expect(() => loadAINConfig('/bad.yaml')).toThrow('AIN file must be a YAML mapping');
  });

  test('sequence YAML (array) → throws', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('- item1\n- item2\n');
    expect(() => loadAINConfig('/bad.yaml')).toThrow('AIN file must be a YAML mapping');
  });

  test('valid mapping → returns parsed doc', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('sections:\n  intro:\n    text: Hello\n');
    expect(loadAINConfig('/ain.yaml')).toEqual({ sections: { intro: { text: 'Hello' } } });
  });
});

// ── writeAIN (fs-mocked) ──────────────────────────────────────────────────────

describe('writeAIN', () => {
  afterEach(() => jest.restoreAllMocks());

  test('null content → returns null and does not write', () => {
    const writeFileSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();
    jest.spyOn(fs, 'mkdirSync').mockImplementation();
    expect(writeAIN('/output/branch', null)).toBeNull();
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  test('writes to Components/AI Instructions.md', () => {
    const writeFileSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();
    jest.spyOn(fs, 'mkdirSync').mockImplementation();
    const outPath = writeAIN('/output/branch', 'content');
    expect(outPath).toContain('AI Instructions.md');
    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining('AI Instructions.md'),
      'content\n',
      'utf8'
    );
  });

  test('creates Components directory', () => {
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation();
    jest.spyOn(fs, 'writeFileSync').mockImplementation();
    writeAIN('/output/branch', 'content');
    expect(mkdirSpy).toHaveBeenCalledWith(
      expect.stringContaining('Components'),
      { recursive: true }
    );
  });
});
