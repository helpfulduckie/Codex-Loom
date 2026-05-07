'use strict';

const { compilePE, blockAppliesTo } = require('../../src/pe');

// ── Shared fixtures ──────────────────────────────────────────────────────────

const registry = new Map();
const branchPath = ['subject'];

const templates = new Map([
  ['character', { content: '{$name}: {$fields.Tagline}', _source: 'x' }],
  ['fenced',    { content: '## Header\n~~~\nBody: {$name}', _source: 'y' }],
]);

// ── blockAppliesTo ───────────────────────────────────────────────────────────

describe('blockAppliesTo', () => {
  test('no filter: always true', () => {
    expect(blockAppliesTo({}, ['subject'])).toBe(true);
  });

  test('only: exact match', () => {
    expect(blockAppliesTo({ only: 'subject' },    ['subject'])).toBe(true);
    expect(blockAppliesTo({ only: 'researcher' }, ['subject'])).toBe(false);
  });

  test('only: prefix match', () => {
    expect(blockAppliesTo({ only: 'subject' }, ['subject', 'A'])).toBe(true);
    expect(blockAppliesTo({ only: 'other'   }, ['subject', 'A'])).toBe(false);
  });

  test('except: excludes matching path', () => {
    expect(blockAppliesTo({ except: 'subject' }, ['subject'])).toBe(false);
    expect(blockAppliesTo({ except: 'other'   }, ['subject'])).toBe(true);
  });

  test('case-insensitive matching', () => {
    expect(blockAppliesTo({ only: 'SUBJECT' }, ['subject'])).toBe(true);
  });
});

// ── compilePE — freeform blocks ──────────────────────────────────────────────

describe('compilePE — freeform block', () => {
  test('renders text field', () => {
    const blocks = [{ text: 'Hello world' }];
    const result = compilePE(blocks, registry, templates, new Map(), branchPath, null);
    expect(result).toBe('Hello world');
  });

  test('empty string text is valid', () => {
    const blocks = [{ text: '' }];
    const result = compilePE(blocks, registry, templates, new Map(), branchPath, null);
    expect(result).toBe('');
  });

  test('wrapper: square wraps freeform output', () => {
    const blocks = [{ text: 'Content', wrapper: 'square' }];
    const result = compilePE(blocks, registry, templates, new Map(), branchPath, null);
    expect(result).toBe('[\nContent\n]');
  });
});

// ── compilePE — template blocks ──────────────────────────────────────────────

describe('compilePE — template block', () => {
  test('renders inline card data through named template', () => {
    const blocks = [{
      template: 'Character',
      name: 'The Stranger',
      fields: { Tagline: 'A wanderer' },
    }];
    const result = compilePE(blocks, registry, templates, new Map(), branchPath, null);
    expect(result).toBe('The Stranger: A wanderer');
  });

  test('type alone resolves template (no explicit template field)', () => {
    const blocks = [{
      type: 'Character',
      name: 'The Stranger',
      fields: { Tagline: 'A wanderer' },
    }];
    const result = compilePE(blocks, registry, templates, new Map(), branchPath, null);
    expect(result).toBe('The Stranger: A wanderer');
  });

  test('explicit template overrides type for lookup', () => {
    const overrideTemplates = new Map([
      ...templates,
      ['npc', { content: 'NPC:{$name}', _source: 'z' }],
    ]);
    const blocks = [{
      template: 'npc',
      type: 'Character',
      name: 'Guard',
      fields: {},
    }];
    const result = compilePE(blocks, registry, overrideTemplates, new Map(), branchPath, null);
    expect(result).toBe('NPC:Guard');
  });

  test('strip_fence: true strips content above last ~~~', () => {
    const blocks = [{
      template: 'fenced',
      name: 'Hero',
      strip_fence: true,
    }];
    const result = compilePE(blocks, registry, templates, new Map(), branchPath, null);
    expect(result).not.toContain('## Header');
    expect(result).toContain('Body: Hero');
  });

  test('wrapper: square wraps template output', () => {
    const blocks = [{
      template: 'Character',
      name: 'X',
      fields: { Tagline: 'Y' },
      wrapper: 'square',
    }];
    const result = compilePE(blocks, registry, templates, new Map(), branchPath, null);
    expect(result).toBe('[\nX: Y\n]');
  });

  test('fields: {} is safe when no fields provided', () => {
    const noFieldTemplate = new Map([
      ['bare', { content: '{$name}', _source: 'b' }],
    ]);
    const blocks = [{ template: 'bare', name: 'Solo' }];
    const result = compilePE(blocks, registry, noFieldTemplate, new Map(), branchPath, null);
    expect(result).toBe('Solo');
  });

  test('missing template logs error and returns null', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const blocks = [{ template: 'NonExistent', name: 'Ghost' }];
    const result = compilePE(blocks, registry, templates, new Map(), branchPath, null);
    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"NonExistent" not found'));
    spy.mockRestore();
  });

  test('block with only filter that does not match is skipped', () => {
    const blocks = [{
      template: 'Character',
      name: 'X',
      fields: { Tagline: 'Y' },
      only: 'other',
    }];
    const result = compilePE(blocks, registry, templates, new Map(), branchPath, null);
    expect(result).toBeNull();
  });
});

// ── compilePE — freeform variants ───────────────────────────────────────────

describe('compilePE — freeform block with variants', () => {
  test('variant overrides top-level text for matching branch', () => {
    const blocks = [{
      text: 'Base text',
      variants: { subject: { text: 'Subject text' } },
    }];
    const result = compilePE(blocks, registry, templates, new Map(), ['subject'], null);
    expect(result).toBe('Subject text');
  });

  test('top-level text used when no matching variant', () => {
    const blocks = [{
      text: 'Base text',
      variants: { researcher: { text: 'Researcher text' } },
    }];
    const result = compilePE(blocks, registry, templates, new Map(), ['subject'], null);
    expect(result).toBe('Base text');
  });

  test('no top-level text, variant provides it for matching branch', () => {
    const blocks = [{
      variants: { subject: { text: 'Only for subject' } },
    }];
    const result = compilePE(blocks, registry, templates, new Map(), ['subject'], null);
    expect(result).toBe('Only for subject');
  });

  test('no top-level text, no matching variant → block skipped', () => {
    const blocks = [{
      variants: { researcher: { text: 'Only for researcher' } },
    }];
    const result = compilePE(blocks, registry, templates, new Map(), ['subject'], null);
    expect(result).toBeNull();
  });

  test('variant can override pronouns and protagonist', () => {
    const blocks = [{
      variants: {
        subject: {
          pronouns: 'female',
          text: '{$She} is here.',
        },
      },
    }];
    const result = compilePE(blocks, registry, templates, new Map(), ['subject'], null);
    expect(result).toBe('She is here.');
  });
});

// ── compilePE — unknown blocks ───────────────────────────────────────────────

describe('compilePE — unknown block', () => {
  test('block with no import, text, or template warns and is skipped', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks = [{ wrapper: 'square' }];
    const result = compilePE(blocks, registry, templates, new Map(), branchPath, null);
    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('no import, text, or template')
    );
    spy.mockRestore();
  });
});
