'use strict';

const fs = require('fs');
const { compilePE, loadPEConfig, writePE } = require('../../src/pe');

// ── Shared fixtures ──────────────────────────────────────────────────────────

const registry = new Map();
const ctx = { branchPath: ['subject'], branchProtagonist: null };

const templates = new Map([
  ['character', { content: '{$aid.title}: {$body.Tagline}', _source: 'x' }],
  ['fenced',    { content: '## Header\n~~~\nBody: {$aid.title}', _source: 'y' }],
]);

// ── compilePE — inline blocks (no import) ────────────────────────────────────

describe('compilePE — inline body block', () => {
  test('renders body.text field', () => {
    const blocks = [{ body: { text: 'Hello world' } }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('Hello world');
  });

  test('empty body.text is valid', () => {
    const blocks = [{ body: { text: '' } }];
    // empty text → block is skipped (no output)
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBeNull();
  });

  test('block excluded by null branch spec returns null', () => {
    const blocks = [{ body: { text: 'Content' }, branches: { subject: null } }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBeNull();
  });

  test('block included by wildcard branch spec', () => {
    const blocks = [{ body: { text: 'Wildcard content' }, branches: { '*': '' } }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('Wildcard content');
  });

  test('render.wrapper square wraps inline output', () => {
    const blocks = [{ body: { text: 'Content' }, render: { wrapper: 'square' } }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('[\nContent\n]');
  });

  test('render.wrapper curly wraps inline output', () => {
    const blocks = [{ body: { text: 'Content' }, render: { wrapper: 'curly' } }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('{\nContent\n}');
  });

  test('resolves {%variable} tokens in body.text', () => {
    const ctxWithVars = { branchPath: [], branchProtagonist: null, variables: { startDate: '03/14/2726' } };
    const blocks = [{ body: { text: 'Memory wipe on {%startDate}' } }];
    expect(compilePE(blocks, registry, templates, new Map(), ctxWithVars)).toBe('Memory wipe on 03/14/2726');
  });

  test('{%variable} tokens without matching variable are left untouched', () => {
    const ctxWithVars = { branchPath: [], branchProtagonist: null, variables: {} };
    const blocks = [{ body: { text: 'Date: {%startDate}' } }];
    // warn is expected; token remains literal
    expect(compilePE(blocks, registry, templates, new Map(), ctxWithVars)).toBe('Date: {%startDate}');
  });
});

// ── compilePE — inline blocks with template ───────────────────────────────────

describe('compilePE — inline block with template', () => {
  test('renders item data through named template', () => {
    const blocks = [{
      id:     'Stranger',
      aid:    { title: 'The Stranger', type: 'Character' },
      render: { template: 'Character' },
      body:   { Tagline: 'A wanderer' },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('The Stranger: A wanderer');
  });

  test('render.stripFence strips content above last ~~~', () => {
    const blocks = [{
      id:     'Hero',
      aid:    { title: 'Hero' },
      render: { template: 'fenced', stripFence: true },
      body:   {},
    }];
    const result = compilePE(blocks, registry, templates, new Map(), ctx);
    expect(result).not.toContain('## Header');
    expect(result).toContain('Body: Hero');
  });

  test('render.wrapper square wraps template output', () => {
    const blocks = [{
      id:     'X',
      aid:    { title: 'X', type: 'Character' },
      render: { template: 'Character', wrapper: 'square' },
      body:   { Tagline: 'Y' },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('[\nX: Y\n]');
  });

  test('missing template warns and skips block', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks = [{
      id:     'Ghost',
      aid:    { title: 'Ghost' },
      render: { template: 'NonExistent' },
      body:   {},
    }];
    const result = compilePE(blocks, registry, templates, new Map(), ctx);
    expect(result).toBeNull();
    spy.mockRestore();
  });
});

// ── compilePE — import blocks ─────────────────────────────────────────────────

describe('compilePE — import block', () => {
  const aness = {
    id: 'aness',
    name: { display: 'Aness', full: 'Aness Rozen' },
    pronouns: 'female',
    aid:    { title: 'Aness Rozen', type: 'Character', triggers: ['Aness', 'Rozen'], encapsulate: true },
    render: { template: 'Character', wrapper: 'none' },
    body:   { Tagline: 'Healer' },
  };
  const importRegistry = new Map([['aness', aness]]);

  test('imports item and renders via its template', () => {
    const blocks = [{ import: 'aness' }];
    const result = compilePE(blocks, importRegistry, templates, new Map(), ctx);
    expect(result).toBe('Aness Rozen: Healer');
  });

  test('body overrides apply on top of imported item', () => {
    const blocks = [{
      import: 'aness',
      body:   { Tagline: 'Overridden Tagline' },
    }];
    const result = compilePE(blocks, importRegistry, templates, new Map(), ctx);
    expect(result).toBe('Aness Rozen: Overridden Tagline');
  });

  test('missing import id logs error and returns null', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const blocks = [{ import: 'unknown-id' }];
    const result = compilePE(blocks, importRegistry, templates, new Map(), ctx);
    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"unknown-id"'));
    spy.mockRestore();
  });

  test('block excluded by null branch spec is skipped', () => {
    const blocks = [{
      import: 'aness',
      branches: { subject: null },
    }];
    const result = compilePE(blocks, importRegistry, templates, new Map(), ctx);
    expect(result).toBeNull();
  });

  describe('item branch inheritance', () => {
    const branchItem = {
      id: 'target',
      name: { display: 'Target', full: 'Target Item' },
      pronouns: 'female',
      aid:    { title: 'Target Item', type: 'Character' },
      render: { template: 'Character', wrapper: 'none' },
      body:   { Tagline: 'Base Tagline' },
      branches: { subject: null },
    };
    const branchRegistry = new Map([['target', branchItem]]);

    test('item excluded by its own branch spec is skipped when PE block has no branches', () => {
      const blocks = [{ import: 'target' }];
      const result = compilePE(blocks, branchRegistry, templates, new Map(), ctx);
      expect(result).toBeNull();
    });

    test('item excluded by specific branch, included by wildcard: skipped on excluded branch', () => {
      const item = { ...branchItem, branches: { subject: null, '*': '' } };
      const reg = new Map([['target', item]]);
      const blocks = [{ import: 'target' }];
      expect(compilePE(blocks, reg, templates, new Map(), ctx)).toBeNull();
    });

    test('item excluded by specific branch, included by wildcard: renders on other branch', () => {
      const item = { ...branchItem, branches: { subject: null, '*': '' } };
      const reg = new Map([['target', item]]);
      const blocks = [{ import: 'target' }];
      const otherCtx = { branchPath: ['other'], branchProtagonist: null };
      expect(compilePE(blocks, reg, templates, new Map(), otherCtx)).toBe('Target Item: Base Tagline');
    });

    test('explicit PE branches: null overrides item include', () => {
      const item = { ...branchItem, branches: { '*': '' } };
      const reg = new Map([['target', item]]);
      const blocks = [{ import: 'target', branches: { subject: null } }];
      expect(compilePE(blocks, reg, templates, new Map(), ctx)).toBeNull();
    });

    test('explicit PE branches take precedence over item exclude', () => {
      const blocks = [{ import: 'target', branches: { subject: '' } }];
      expect(compilePE(blocks, branchRegistry, templates, new Map(), ctx)).toBe('Target Item: Base Tagline');
    });

    test('item branch-dispatched variant applies via inherited branches', () => {
      const item = {
        ...branchItem,
        branches: { subject: 'alt' },
        variants: { alt: { body: { Tagline: 'Alt Tagline' } } },
      };
      const reg = new Map([['target', item]]);
      const blocks = [{ import: 'target' }];
      expect(compilePE(blocks, reg, templates, new Map(), ctx)).toBe('Target Item: Alt Tagline');
    });
  });

  test('Codex overlay v: fields are applied to PE import (regression: $v.field resolved against canon, not overlay)', () => {
    const vTemplates = new Map([
      ['character', { content: '{$aid.title}: {$v.affiliation} {$v.role}', _source: 'x' }],
    ]);
    const canonItem = {
      id: 'employee',
      name: { display: 'Eve', full: 'Eve Smith' },
      aid:    { title: 'Eve Smith', type: 'Character' },
      render: { template: 'Character', wrapper: 'none' },
      v:      { affiliation: 'Academy', role: 'Researcher' },
      body:   {},
    };
    const reg = new Map([['employee', canonItem]]);

    // Overlay from the project Codex (e.g. grayls.yaml) overrides v:
    const overlay = new Map([['employee', {
      import:         'employee',
      importVariants: [],
      v:              { affiliation: 'Helix Industries', role: 'Lead Researcher' },
    }]]);

    const blocks = [{ import: 'employee' }];
    const result = compilePE(blocks, reg, vTemplates, new Map(), ctx, overlay);
    expect(result).toBe('Eve Smith: Helix Industries Lead Researcher');
  });
});

// ── compilePE — multi-block ordering ─────────────────────────────────────────

describe('compilePE — position ordering', () => {
  test('blocks are sorted by render.position (default 5)', () => {
    const blocks = [
      { body: { text: 'B' }, render: { position: 7 } },
      { body: { text: 'A' }, render: { position: 3 } },
    ];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('A\n\nB');
  });

  test('same position preserves definition order', () => {
    const blocks = [
      { body: { text: 'First' }, render: { position: 5 } },
      { body: { text: 'Second' }, render: { position: 5 } },
    ];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('First\n\nSecond');
  });
});

// ── compilePE — style: skip ───────────────────────────────────────────────────

describe('compilePE — style: skip', () => {
  test('skipped block produces no output', () => {
    const blocks = [{ body: { text: 'Invisible' }, render: { style: 'skip' } }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBeNull();
  });

  test('null result when all blocks skipped', () => {
    const blocks = [
      { body: { text: 'A' }, render: { style: 'skip' } },
      { body: { text: 'B' }, render: { style: 'skip' } },
    ];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBeNull();
  });
});

// ── compilePE — section blocks ────────────────────────────────────────────────

describe('compilePE — section block', () => {
  test('two freeform children are joined and wrapped', () => {
    const blocks = [{
      blocks: [
        { body: { text: 'Line A' } },
        { body: { text: 'Line B' } },
      ],
      render: { wrapper: 'square', position: 1 },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx))
      .toBe('[\nLine A\nLine B\n]');
  });

  test('section with headingLevel 0 renders plain text heading inside wrapper', () => {
    const blocks = [{
      blocks: [{ body: { text: 'Content' } }],
      heading: 'My Section',
      headingLevel: 0,
      render: { wrapper: 'curly', compact: false },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx))
      .toBe('{\nMy Section\n\nContent\n}');
  });

  test('section with headingLevel 2 renders markdown heading inside wrapper', () => {
    const blocks = [{
      blocks: [{ body: { text: 'Content' } }],
      heading: 'My Section',
      headingLevel: 2,
      render: { wrapper: 'none', compact: false },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx))
      .toBe('## My Section\n\nContent');
  });

  test('compact: true omits blank line after heading', () => {
    const blocks = [{
      blocks: [{ body: { text: 'Content' } }],
      heading: 'Title',
      headingLevel: 0,
      render: { wrapper: 'none', compact: true },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx))
      .toBe('Title\nContent');
  });

  test('empty blocks array produces no output', () => {
    const blocks = [{ blocks: [], render: { wrapper: 'square' } }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBeNull();
  });

  test('section excluded by null branch spec is skipped', () => {
    const blocks = [{
      blocks: [{ body: { text: 'Hello' } }],
      render: { wrapper: 'square' },
      branches: { subject: null },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBeNull();
  });

  test('child excluded by its own branches is removed from section', () => {
    const blocks = [{
      blocks: [
        { body: { text: 'Kept' } },
        { body: { text: 'Excluded' }, branches: { subject: null } },
      ],
      render: { wrapper: 'none' },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('Kept');
  });

  test('children sorted by render.position within section', () => {
    const blocks = [{
      blocks: [
        { body: { text: 'B' }, render: { position: 7 } },
        { body: { text: 'A' }, render: { position: 2 } },
      ],
      render: { wrapper: 'none' },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('A\nB');
  });

  test('child render.wrapper is ignored; section wrapper applies', () => {
    const blocks = [{
      blocks: [{ body: { text: 'Inner' }, render: { wrapper: 'curly' } }],
      render: { wrapper: 'square' },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('[\nInner\n]');
  });

  test('section and regular block coexist, sorted by outer position', () => {
    const blocks = [
      {
        blocks: [{ body: { text: 'SectionContent' } }],
        render: { wrapper: 'square', position: 2 },
      },
      { body: { text: 'RegularBlock' }, render: { position: 1 } },
    ];
    expect(compilePE(blocks, registry, templates, new Map(), ctx))
      .toBe('RegularBlock\n\n[\nSectionContent\n]');
  });

  test('nested section warns and is skipped', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks = [{
      blocks: [
        { blocks: [{ body: { text: 'Nested' } }], render: {} },
        { body: { text: 'Valid' } },
      ],
      render: { wrapper: 'none' },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('Valid');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('nested sections'));
    spy.mockRestore();
  });

  test('all children excluded produces null section output', () => {
    const blocks = [{
      blocks: [
        { body: { text: 'A' }, branches: { subject: null } },
        { body: { text: 'B' }, branches: { subject: null } },
      ],
      render: { wrapper: 'square' },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBeNull();
  });

  test('child render.style: skip is excluded from section', () => {
    const blocks = [{
      blocks: [
        { body: { text: 'Shown' } },
        { body: { text: 'Hidden' }, render: { style: 'skip' } },
      ],
      render: { wrapper: 'none' },
    }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBe('Shown');
  });
});

// ── loadPEConfig ──────────────────────────────────────────────────────────────

describe('loadPEConfig', () => {
  afterEach(() => jest.restoreAllMocks());

  test('null spec → returns empty array', () => {
    expect(loadPEConfig(null)).toEqual([]);
  });

  test('missing file → warns and returns empty array', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(loadPEConfig('/missing.yaml')).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  test('non-array YAML (mapping) → throws', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('key: value\n');
    expect(() => loadPEConfig('/bad.yaml')).toThrow('PE file must be a YAML sequence');
  });

  test('valid array YAML → returns parsed array', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('- body:\n    text: Hello\n');
    expect(loadPEConfig('/pe.yaml')).toEqual([{ body: { text: 'Hello' } }]);
  });
});

// ── writePE ───────────────────────────────────────────────────────────────────

describe('writePE', () => {
  afterEach(() => jest.restoreAllMocks());

  test('null content → returns null and does not write', () => {
    const writeFileSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();
    jest.spyOn(fs, 'mkdirSync').mockImplementation();
    expect(writePE('/output/branch', null)).toBeNull();
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  test('writes to Components/Plot Essentials.md', () => {
    const writeFileSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();
    jest.spyOn(fs, 'mkdirSync').mockImplementation();
    const outPath = writePE('/output/branch', 'content');
    expect(outPath).toContain('Plot Essentials.md');
    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plot Essentials.md'),
      'content\n',
      'utf8'
    );
  });

  test('creates Components directory', () => {
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation();
    jest.spyOn(fs, 'writeFileSync').mockImplementation();
    writePE('/output/branch', 'content');
    expect(mkdirSpy).toHaveBeenCalledWith(
      expect.stringContaining('Components'),
      { recursive: true }
    );
  });
});
