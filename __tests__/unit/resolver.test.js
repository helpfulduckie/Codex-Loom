'use strict';

const {
  applyFieldOp,
  collectVariantDeltas,
  enumerateLeaves,
  resolveCard,
  resolveBranchSpec,
  deepClone,
} = require('../../src/resolver');

describe('applyFieldOp', () => {
  test('replace: returns new value', () => {
    expect(applyFieldOp('old', 'new value')).toBe('new value');
  });

  test('remove: null returns __DELETE__', () => {
    expect(applyFieldOp('anything', null)).toBe('__DELETE__');
  });

  test('bare "-" is a plain replacement (not delete) in v3', () => {
    expect(applyFieldOp('anything', '-')).toBe('-');
  });

  test('object op with null subfield removes the subfield', () => {
    const result = applyFieldOp({ a: 'x', b: 'y' }, { a: null });
    expect(result).not.toHaveProperty('a');
    expect(result.b).toBe('y');
  });

  test('append single-line: converts to two-element array', () => {
    expect(applyFieldOp('hello', '+{world}')).toEqual(['hello', 'world']);
  });

  test('append multiline: converts block scalar to two-element array', () => {
    expect(applyFieldOp('line1\nline2', '+{line3}')).toEqual(['line1\nline2', 'line3']);
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
      ])).toEqual(['Hello there', '!']);
    });
    test('mixed ops: append then swap (swap maps over resulting array)', () => {
      expect(applyFieldOp('foo', ['+{bar}', '/{bar}/{baz}'])).toEqual(['foo', 'baz']);
    });
    test('plain-string array is a value replacement, not ops', () => {
      expect(applyFieldOp('old', ['new value'])).toEqual(['new value']);
    });
    test('array with mixed content is a value array', () => {
      expect(applyFieldOp('old', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    });
    test('replaces an existing array field with a new array', () => {
      expect(applyFieldOp(['x', 'y'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    });
    test('array-typed current: append pushes item', () => {
      expect(applyFieldOp(['a', 'b'], '+{c}')).toEqual(['a', 'b', 'c']);
    });
    test('array-typed current: remove filters matching item', () => {
      expect(applyFieldOp(['a', 'b', 'c'], '-{b}')).toEqual(['a', 'c']);
    });
    test('array-typed current: swap maps over elements', () => {
      expect(applyFieldOp(['red fox', 'red dog'], '/{red}/{blue}')).toEqual(['blue fox', 'blue dog']);
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
        body: { race: 'human' },
        variants: {
          noble: { body: { rank: 'noble' } },
        },
      },
    },
  };

  test('returns deltas in order for nested path', () => {
    const deltas = collectVariantDeltas(canonCard, 'human/noble');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].body.race).toBe('human');
    expect(deltas[1].body.rank).toBe('noble');
  });

  test('returns single delta for single-segment path', () => {
    const deltas = collectVariantDeltas(canonCard, 'human');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].body.race).toBe('human');
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

// ── resolveBranchSpec ─────────────────────────────────────────────────────────

describe('resolveBranchSpec', () => {
  test('null spec → empty array (include with no variants)', () => {
    expect(resolveBranchSpec(null, ['subject'])).toEqual([]);
  });

  test('exact key match returns its variant names', () => {
    const spec = { subject: 'subject-variant' };
    expect(resolveBranchSpec(spec, ['subject'])).toEqual(['subject-variant']);
  });

  test('exact null key → returns null (excluded)', () => {
    const spec = { subject: null };
    expect(resolveBranchSpec(spec, ['subject'])).toBeNull();
  });

  test('wildcard * applies as baseline for any non-excluded branch', () => {
    const spec = { '*': 'generic' };
    expect(resolveBranchSpec(spec, ['anything'])).toEqual(['generic']);
    expect(resolveBranchSpec(spec, ['other'])).toEqual(['generic']);
  });

  test('explicit key stacks on top of wildcard (both apply)', () => {
    const spec = { '*': 'generic', Wyvern: 'draconic' };
    // Wyvern: wildcard fires first, then explicit — both appear
    expect(resolveBranchSpec(spec, ['Wyvern'])).toEqual(['generic', 'draconic']);
    // Free Form: only wildcard
    expect(resolveBranchSpec(spec, ['Free Form'])).toEqual(['generic']);
  });

  test('explicit null prevents wildcard from applying', () => {
    const spec = { '*': 'generic', Wyvern: null };
    expect(resolveBranchSpec(spec, ['Wyvern'])).toBeNull();
    expect(resolveBranchSpec(spec, ['Other'])).toEqual(['generic']);
  });

  test('array apply form at a branch level', () => {
    const spec = { subject: { apply: ['a', 'b'] } };
    expect(resolveBranchSpec(spec, ['subject'])).toEqual(['a', 'b']);
  });

  test('multi-level descent: [A, X]', () => {
    const spec = {
      A: {
        apply: 'a-variant',
        branches: {
          X: 'x-variant',
          Y: 'y-variant',
        },
      },
    };
    expect(resolveBranchSpec(spec, ['A', 'X'])).toEqual(['a-variant', 'x-variant']);
    expect(resolveBranchSpec(spec, ['A', 'Y'])).toEqual(['a-variant', 'y-variant']);
  });

  test('wildcard at first level descends into sub-branches', () => {
    const spec = {
      '*': {
        branches: {
          Aness: 'aness-shared',
          Veryn: 'veryn-shared',
        },
      },
    };
    expect(resolveBranchSpec(spec, ['Free Form', 'Aness'])).toEqual(['aness-shared']);
    expect(resolveBranchSpec(spec, ['Wyvern', 'Veryn'])).toEqual(['veryn-shared']);
  });

  test('wildcard baseline + explicit sub-branch stack', () => {
    const spec = {
      '*': { branches: { Aness: 'shared' } },
      Wyvern: { branches: { Aness: 'wyvern-specific' } },
    };
    // Free Form/Aness: only */Aness fires
    expect(resolveBranchSpec(spec, ['Free Form', 'Aness'])).toEqual(['shared']);
    // Wyvern/Aness: */Aness fires, then Wyvern/Aness stacks on top
    expect(resolveBranchSpec(spec, ['Wyvern', 'Aness'])).toEqual(['shared', 'wyvern-specific']);
  });
});

// ── resolveCard ───────────────────────────────────────────────────────────────

describe('resolveCard', () => {
  const canonCard = {
    id: 'hero',
    name: 'Hero',
    aid:    { type: 'Character', title: 'Hero' },
    render: { template: 'Character' },
    body: { role: 'warrior' },
    variants: {
      mage: { body: { role: 'mage', magic: 'yes' } },
    },
  };

  const registry = new Map([['hero', canonCard]]);

  test('import without importVariants yields base card body', () => {
    const cardDef = { import: 'hero' };
    const card = resolveCard(cardDef, registry, []);
    expect(card.name.full).toBe('Hero');
    expect(card.body.role).toBe('warrior');
  });

  test('importVariants applies variant body fields', () => {
    const cardDef = { import: 'hero', importVariants: ['mage'] };
    const card = resolveCard(cardDef, registry, []);
    expect(card.body.role).toBe('mage');
    expect(card.body.magic).toBe('yes');
  });

  test('body override in cardDef overwrites base body fields', () => {
    const cardDef = { import: 'hero', body: { role: 'rogue' } };
    const card = resolveCard(cardDef, registry, []);
    expect(card.body.role).toBe('rogue');
  });

  test('local card definition (no import) is returned as-is', () => {
    const cardDef = {
      id: 'npc', name: 'Guard',
      aid: { type: 'Character', title: 'Guard' },
      render: { template: 'Character' },
      body: { role: 'guard' },
    };
    const card = resolveCard(cardDef, new Map(), []);
    expect(card.name.full).toBe('Guard');
    expect(card.body.role).toBe('guard');
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

  describe('import-level field operations on aid and top-level fields', () => {
    const baseCard = {
      id: 'outfit',
      name: 'Outfit',
      aid: { type: 'Item', title: 'Outfit', triggers: ['clothing', 'style'] },
      render: { template: 'Item' },
      body: { known: 'base knowledge' },
      pronouns: 'they/them',
    };
    const reg = new Map([['outfit', baseCard]]);

    test('aid.triggers: plain array replaces', () => {
      const card = resolveCard({ import: 'outfit', aid: { triggers: ['uniform'] } }, reg, []);
      expect(card.aid.triggers).toEqual(['uniform']);
    });

    test('aid.triggers: +{} appends to array', () => {
      const card = resolveCard({ import: 'outfit', aid: { triggers: '+{uniform}' } }, reg, []);
      expect(card.aid.triggers).toEqual(['clothing', 'style', 'uniform']);
    });

    test('aid.triggers: -{} removes item from array', () => {
      const card = resolveCard({ import: 'outfit', aid: { triggers: '-{style}' } }, reg, []);
      expect(card.aid.triggers).toEqual(['clothing']);
    });

    test('aid.triggers: null deletes the field', () => {
      const card = resolveCard({ import: 'outfit', aid: { triggers: null } }, reg, []);
      expect(card.aid).not.toHaveProperty('triggers');
    });

    test('body.known: +{} converts scalar to two-element array', () => {
      const card = resolveCard({ import: 'outfit', body: { known: '+{and more}' } }, reg, []);
      expect(card.body.known).toEqual(['base knowledge', 'and more']);
    });

    test('name: /{old}/{new} swaps substring', () => {
      const card = resolveCard({ import: 'outfit', name: '/{Outfit}/{Uniform}' }, reg, []);
      expect(card.name.full).toBe('Uniform');
    });

    test('name: array of swaps applies all in sequence', () => {
      const base = { id: 'char', name: 'She said her name was Sarah', aid: { type: 'Character' }, body: {} };
      const r = new Map([['char', base]]);
      const card = resolveCard(
        { import: 'char', name: ['/{She}/{He}', '/{her}/{his}', '/{Sarah}/{Sam}'] },
        r,
        []
      );
      expect(card.name.full).toBe('He said his name was Sam');
    });

    test('pronouns: plain string replaces', () => {
      const card = resolveCard({ import: 'outfit', pronouns: 'she/her' }, reg, []);
      expect(card.pronouns).toBe('she/her');
    });
  });

  describe('branch-based variant dispatch via branches:', () => {
    const baseCard = {
      id: 'spirit',
      name: 'Spirit',
      aid: { type: 'Character', title: 'Spirit' },
      render: { template: 'Character' },
      body: { form: 'incorporeal', origin: 'unknown' },
    };
    const reg = new Map([['spirit', baseCard]]);

    test('wildcard * applies as baseline for all non-excluded branches', () => {
      const cardDef = {
        import: 'spirit',
        variants: {
          generic: { body: { form: 'generic' } },
        },
        branches: {
          '*': 'generic',
        },
      };
      expect(resolveCard(cardDef, reg, ['Free Form']).body.form).toBe('generic');
      expect(resolveCard(cardDef, reg, ['Wyvern']).body.form).toBe('generic');
    });

    test('explicit branch stacks on wildcard', () => {
      const cardDef = {
        import: 'spirit',
        variants: {
          generic:  { body: { form: 'generic' } },
          draconic: { body: { form: 'draconic' } },
        },
        branches: {
          '*':     'generic',
          Wyvern:  'draconic',
        },
      };
      expect(resolveCard(cardDef, reg, ['Wyvern']).body.form).toBe('draconic');
      expect(resolveCard(cardDef, reg, ['Free Form']).body.form).toBe('generic');
    });

    test('null branch key excludes card for that branch', () => {
      const cardDef = {
        import: 'spirit',
        branches: { Wyvern: null },
      };
      expect(resolveCard(cardDef, reg, ['Wyvern'])).toBeNull();
      expect(resolveCard(cardDef, reg, ['Other'])).not.toBeNull();
    });

    test('multi-level branch applies variants from each level in order', () => {
      const cardDef = {
        import: 'spirit',
        variants: {
          transformed: { name: 'Prime', body: { form: 'artificial' } },
          branchA:     { body: { origin: 'scientist A' } },
          branchB:     { body: { origin: 'scientist B' } },
        },
        branches: {
          'Branch A': { apply: ['transformed', 'branchA'] },
          'Branch B': { apply: ['transformed', 'branchB'] },
        },
      };
      const cardA = resolveCard(cardDef, reg, ['Branch A']);
      expect(cardA.name.full).toBe('Prime');
      expect(cardA.body.form).toBe('artificial');
      expect(cardA.body.origin).toBe('scientist A');

      const cardB = resolveCard(cardDef, reg, ['Branch B']);
      expect(cardB.name.full).toBe('Prime');
      expect(cardB.body.form).toBe('artificial');
      expect(cardB.body.origin).toBe('scientist B');
    });

    test('branch not defined yields base card (no variants applied)', () => {
      const cardDef = {
        import: 'spirit',
        variants: {
          special: { body: { form: 'special' } },
        },
        branches: {
          Wyvern: 'special',
        },
      };
      const card = resolveCard(cardDef, reg, ['Other']);
      expect(card.body.form).toBe('incorporeal');
    });
  });
});
