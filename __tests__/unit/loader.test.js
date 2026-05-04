'use strict';

const { buildRegistry, mergeRegistries } = require('../../src/loader');

describe('buildRegistry', () => {
  test('normalizes id keys to lowercase and backfills id from name', () => {
    const cards = [{ name: 'Felicia', type: 'Character', _source: 'x.yaml' }];
    const reg = buildRegistry(cards, 'test');
    expect(reg.has('felicia')).toBe(true);
    expect(reg.get('felicia').id).toBe('Felicia');
  });

  test('throws on duplicate id (case-insensitive)', () => {
    const cards = [
      { id: 'Zephon', name: 'Zephon', _source: 'a.yaml' },
      { id: 'zephon', name: 'Zephon Alt', _source: 'b.yaml' },
    ];
    expect(() => buildRegistry(cards, 'test')).toThrow(/Duplicate card ID/i);
  });

  test('skips import and include entries', () => {
    const cards = [
      { import: 'Zephon', _source: 'a.yaml' },
      { include: 'some/file.yaml', _source: 'b.yaml' },
    ];
    const reg = buildRegistry(cards, 'test');
    expect(reg.size).toBe(0);
  });

  test('stores multiple distinct cards', () => {
    const cards = [
      { id: 'Alpha', name: 'Alpha', _source: 'a.yaml' },
      { id: 'Beta', name: 'Beta', _source: 'b.yaml' },
    ];
    const reg = buildRegistry(cards, 'test');
    expect(reg.size).toBe(2);
    expect(reg.has('alpha')).toBe(true);
    expect(reg.has('beta')).toBe(true);
  });
});

describe('mergeRegistries', () => {
  test('merges disjoint registries', () => {
    const canon = new Map([['a', { id: 'a' }]]);
    const project = new Map([['b', { id: 'b' }]]);
    const merged = mergeRegistries(canon, project);
    expect(merged.size).toBe(2);
    expect(merged.has('a')).toBe(true);
    expect(merged.has('b')).toBe(true);
  });

  test('throws when same id appears in both registries', () => {
    const canon = new Map([['felicia', { _source: 'canon/Felicia.yaml' }]]);
    const project = new Map([['felicia', { _source: 'cards/Felicia.yaml' }]]);
    expect(() => mergeRegistries(canon, project)).toThrow(/felicia/i);
  });

  test('project-only cards are included', () => {
    const canon = new Map();
    const project = new Map([['hero', { id: 'hero' }]]);
    const merged = mergeRegistries(canon, project);
    expect(merged.get('hero').id).toBe('hero');
  });
});
