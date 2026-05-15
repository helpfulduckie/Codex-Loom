'use strict';

const { compilePE } = require('../../src/pe');

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
});

// ── compilePE — inline blocks with template ───────────────────────────────────

describe('compilePE — inline block with template', () => {
  test('renders card data through named template', () => {
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

  test('imports card and renders via its template', () => {
    const blocks = [{ import: 'aness' }];
    const result = compilePE(blocks, importRegistry, templates, new Map(), ctx);
    expect(result).toBe('Aness Rozen: Healer');
  });

  test('body overrides apply on top of imported card', () => {
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
    const blocks = [{ body: { text: 'Invisible' }, style: 'skip' }];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBeNull();
  });

  test('null result when all blocks skipped', () => {
    const blocks = [
      { body: { text: 'A' }, style: 'skip' },
      { body: { text: 'B' }, style: 'skip' },
    ];
    expect(compilePE(blocks, registry, templates, new Map(), ctx)).toBeNull();
  });
});
