'use strict';

const {
  applyFieldOp,
  collectVariantDeltas,
  enumerateLeaves,
  resolveCard,
  deepClone,
} = require('../../src/resolver');

describe('applyFieldOp', () => {
  test('replace: returns new value', () => {
    expect(applyFieldOp('old', 'new value')).toBe('new value');
  });

  test('remove: "-" returns __DELETE__', () => {
    expect(applyFieldOp('anything', '-')).toBe('__DELETE__');
  });

  test('remove: null returns __DELETE__', () => {
    expect(applyFieldOp('anything', null)).toBe('__DELETE__');
  });

  test('append single-line: joins with "; "', () => {
    expect(applyFieldOp('hello', '+{world}')).toBe('hello; world');
  });

  test('append multiline: joins with newline', () => {
    expect(applyFieldOp('line1\nline2', '+{line3}')).toBe('line1\nline2\nline3');
  });

  test('append to empty string: returns just the value', () => {
    expect(applyFieldOp('', '+{world}')).toBe('world');
  });

  test('remove substring: strips matched text', () => {
    expect(applyFieldOp('hello world', '-{world}')).toBe('hello');
  });

  test('swap substring: replaces first occurrence', () => {
    expect(applyFieldOp('red fox', '/red/blue')).toBe('blue fox');
  });

  test('object op recursion: applies ops to subfields', () => {
    const result = applyFieldOp({ gender: 'male' }, { gender: '/male/female' });
    expect(result).toEqual({ gender: 'female' });
  });

  test('object op removes subfield with "-"', () => {
    const result = applyFieldOp({ a: 'x', b: 'y' }, { a: '-' });
    expect(result).not.toHaveProperty('a');
    expect(result.b).toBe('y');
  });
});

describe('collectVariantDeltas', () => {
  const canonCard = {
    id: 'zephon',
    variants: {
      human: {
        fields: { race: 'human' },
        variants: {
          noble: { fields: { rank: 'noble' } },
        },
      },
    },
  };

  test('returns deltas in order for nested path', () => {
    const deltas = collectVariantDeltas(canonCard, 'human/noble');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].fields.race).toBe('human');
    expect(deltas[1].fields.rank).toBe('noble');
  });

  test('returns single delta for single-segment path', () => {
    const deltas = collectVariantDeltas(canonCard, 'human');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].fields.race).toBe('human');
  });

  test('unknown segment warns and returns partial deltas', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const deltas = collectVariantDeltas(canonCard, 'human/peasant');
    expect(deltas).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('empty path returns empty array', () => {
    expect(collectVariantDeltas(canonCard, '')).toEqual([]);
  });

  test('null path returns empty array', () => {
    expect(collectVariantDeltas(canonCard, null)).toEqual([]);
  });
});

describe('enumerateLeaves', () => {
  test('flat branches produce one leaf each', () => {
    const leaves = enumerateLeaves({ subject: {}, researcher: {} });
    expect(leaves).toHaveLength(2);
    expect(leaves).toContainEqual(['subject']);
    expect(leaves).toContainEqual(['researcher']);
  });

  test('nested branches produce leaf arrays with full path', () => {
    const leaves = enumerateLeaves({
      subject: { branches: { A: {}, B: {} } },
      researcher: {},
    });
    expect(leaves).toHaveLength(3);
    expect(leaves).toContainEqual(['subject', 'A']);
    expect(leaves).toContainEqual(['subject', 'B']);
    expect(leaves).toContainEqual(['researcher']);
  });

  test('null branches returns [[]]', () => {
    expect(enumerateLeaves(null)).toEqual([[]]);
  });

  test('empty branches object returns [[]]', () => {
    expect(enumerateLeaves({})).toEqual([[]]);
  });
});

describe('resolveCard', () => {
  const canonCard = {
    id: 'hero',
    name: 'Hero',
    type: 'Character',
    fields: { role: 'warrior' },
    variants: {
      mage: { fields: { role: 'mage', magic: 'yes' } },
    },
  };

  const registry = new Map([['hero', canonCard]]);

  test('import without variant yields base card fields', () => {
    const cardDef = { import: 'hero' };
    const card = resolveCard(cardDef, registry, []);
    expect(card.name).toBe('Hero');
    expect(card.fields.role).toBe('warrior');
  });

  test('import with variant path applies variant fields', () => {
    const cardDef = { import: 'hero/mage' };
    const card = resolveCard(cardDef, registry, []);
    expect(card.fields.role).toBe('mage');
    expect(card.fields.magic).toBe('yes');
  });

  test('fields override in cardDef overwrites base fields', () => {
    const cardDef = { import: 'hero', fields: { role: 'rogue' } };
    const card = resolveCard(cardDef, registry, []);
    expect(card.fields.role).toBe('rogue');
  });

  test('local card definition (no import) is returned as-is', () => {
    const cardDef = { id: 'npc', name: 'Guard', type: 'Character', fields: { role: 'guard' } };
    const card = resolveCard(cardDef, new Map(), []);
    expect(card.name).toBe('Guard');
    expect(card.fields.role).toBe('guard');
  });

  test('import of unknown id throws', () => {
    const cardDef = { import: 'unknown' };
    expect(() => resolveCard(cardDef, new Map(), [])).toThrow(/unknown/i);
  });

  test('compiler metadata (variants) is stripped from resolved card', () => {
    const cardDef = { import: 'hero' };
    const card = resolveCard(cardDef, registry, []);
    expect(card).not.toHaveProperty('variants');
    expect(card).not.toHaveProperty('_source');
  });
});
