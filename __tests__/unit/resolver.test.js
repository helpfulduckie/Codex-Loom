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
    expect(applyFieldOp('red fox', '/{red}/{blue}')).toBe('blue fox');
  });

  test('object op recursion: applies ops to subfields', () => {
    const result = applyFieldOp({ gender: 'male' }, { gender: '/{male}/{female}' });
    expect(result).toEqual({ gender: 'female' });
  });

  test('object op removes subfield with "-"', () => {
    const result = applyFieldOp({ a: 'x', b: 'y' }, { a: '-' });
    expect(result).not.toHaveProperty('a');
    expect(result.b).toBe('y');
  });

  describe('array of operations', () => {
    test('empty array returns current unchanged', () => {
      expect(applyFieldOp('hello', [])).toBe('hello');
    });
    test('single-element array behaves like the scalar op', () => {
      expect(applyFieldOp('red fox', ['/{red}/{blue}'])).toBe('blue fox');
    });
    test('two swap ops applied in sequence', () => {
      expect(applyFieldOp('She said her name', [
        '/{She}/{He}',
        '/{her}/{his}',
      ])).toBe('He said his name');
    });
    test('mixed ops: swap then append', () => {
      expect(applyFieldOp('Hello world', [
        '/{world}/{there}',
        '+{!}',
      ])).toBe('Hello there; !');
    });
    test('mixed ops: append then swap', () => {
      expect(applyFieldOp('foo', ['+{bar}', '/{bar}/{baz}'])).toBe('foo; baz');
    });
    test('delete step short-circuits remaining ops', () => {
      expect(applyFieldOp('hello', ['-', '/{hello}/{goodbye}'])).toBe('__DELETE__');
    });
    test('replace op inside array', () => {
      expect(applyFieldOp('old', ['new value'])).toBe('new value');
    });
    test('null step inside array deletes field', () => {
      expect(applyFieldOp('hello', [null])).toBe('__DELETE__');
    });
    test('array op on subfield via object recursion', () => {
      const result = applyFieldOp(
        { gender: 'She is strong' },
        { gender: ['/{She}/{He}', '/{is}/{was}'] }
      );
      expect(result).toEqual({ gender: 'He was strong' });
    });
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

  describe('import-level field operations on top-level fields', () => {
    const baseCard = {
      id: 'outfit',
      name: 'Outfit',
      type: 'Item',
      triggers: 'clothing, style',
      known: 'base knowledge',
      pronouns: 'they/them',
    };
    const reg = new Map([['outfit', baseCard]]);

    test('triggers: plain string replaces', () => {
      const card = resolveCard({ import: 'outfit', triggers: 'uniform' }, reg, []);
      expect(card.triggers).toBe('uniform');
    });

    test('triggers: +{} appends to existing triggers', () => {
      const card = resolveCard({ import: 'outfit', triggers: '+{, uniform}' }, reg, []);
      expect(card.triggers).toBe('clothing, style, uniform');
    });

    test('triggers: -{} removes substring from triggers', () => {
      const card = resolveCard({ import: 'outfit', triggers: '-{, style}' }, reg, []);
      expect(card.triggers).toBe('clothing');
    });

    test('triggers: - deletes the field', () => {
      const card = resolveCard({ import: 'outfit', triggers: '-' }, reg, []);
      expect(card).not.toHaveProperty('triggers');
    });

    test('known: +{} appends', () => {
      const card = resolveCard({ import: 'outfit', known: '+{ and more}' }, reg, []);
      expect(card.known).toBe('base knowledge and more');
    });

    test('name: /{old}/{new} swaps substring', () => {
      const card = resolveCard({ import: 'outfit', name: '/{Outfit}/{Uniform}' }, reg, []);
      expect(card.name).toBe('Uniform');
    });

    test('name: array of swaps applies all in sequence', () => {
      const base = { id: 'char', name: 'She said her name was Sarah', type: 'Character' };
      const r = new Map([['char', base]]);
      const card = resolveCard(
        { import: 'char', name: ['/{She}/{He}', '/{her}/{his}', '/{Sarah}/{Sam}'] },
        r,
        []
      );
      expect(card.name).toBe('He said his name was Sam');
    });

    test('pronouns: plain string replaces', () => {
      const card = resolveCard({ import: 'outfit', pronouns: 'she/her' }, reg, []);
      expect(card.pronouns).toBe('she/her');
    });
  });

  describe('named group variants', () => {
    const canonCard = {
      id: 'spirit',
      name: 'Spirit',
      type: 'Character',
      fields: { form: 'incorporeal', origin: 'unknown' },
    };
    const reg = new Map([['spirit', canonCard]]);

    test('group fields apply before inner branch fields', () => {
      const cardDef = {
        import: 'spirit',
        variants: {
          Transformed: {
            name: 'Prime',
            fields: { form: 'artificial' },
            variants: {
              'Branch A': { fields: { origin: 'scientist A' } },
              'Branch B': { fields: { origin: 'scientist B' } },
            },
          },
        },
      };

      const cardA = resolveCard(cardDef, reg, ['Branch A']);
      expect(cardA.name).toBe('Prime');
      expect(cardA.fields.form).toBe('artificial');
      expect(cardA.fields.origin).toBe('scientist A');

      const cardB = resolveCard(cardDef, reg, ['Branch B']);
      expect(cardB.name).toBe('Prime');
      expect(cardB.fields.form).toBe('artificial');
      expect(cardB.fields.origin).toBe('scientist B');
    });

    test('direct branch match takes priority over group containing same name', () => {
      const cardDef = {
        import: 'spirit',
        variants: {
          'Branch A': { fields: { form: 'direct' } },
          Group: {
            variants: {
              'Branch A': { fields: { form: 'via group' } },
            },
          },
        },
      };
      const card = resolveCard(cardDef, reg, ['Branch A']);
      expect(card.fields.form).toBe('direct');
    });

    test('branch not in any group yields base card', () => {
      const cardDef = {
        import: 'spirit',
        variants: {
          Group: {
            fields: { form: 'artificial' },
            variants: {
              'Branch A': { fields: { origin: 'a' } },
            },
          },
        },
      };
      const card = resolveCard(cardDef, reg, ['Branch C']);
      expect(card.fields.form).toBe('incorporeal');
      expect(card.fields.origin).toBe('unknown');
    });
  });
});
