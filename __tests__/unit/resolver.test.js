'use strict';

const {
  applyFieldOp,
  collectVariantDeltas,
  enumerateLeaves,
  resolveItem,
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

  describe('mapping-typed current with string op', () => {
    test('append: extracts values and appends', () => {
      expect(applyFieldOp({ a: 'foo', b: 'bar' }, '+{baz}')).toEqual(['foo', 'bar', 'baz']);
    });
    test('append to empty mapping: returns single-element array', () => {
      expect(applyFieldOp({}, '+{baz}')).toEqual(['baz']);
    });
    test('remove: filters matching value from extracted values', () => {
      expect(applyFieldOp({ a: 'foo', b: 'bar' }, '-{foo}')).toEqual(['bar']);
    });
    test('swap: applies to each extracted value', () => {
      expect(applyFieldOp({ a: 'red fox', b: 'red dog' }, '/{red}/{blue}')).toEqual(['blue fox', 'blue dog']);
    });
    test('replace: still replaces entirely', () => {
      expect(applyFieldOp({ a: 'foo' }, 'new value')).toBe('new value');
    });
  });
});

describe('collectVariantDeltas', () => {
  const canonItem = {
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
    const deltas = collectVariantDeltas(canonItem, 'human/noble');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].body.race).toBe('human');
    expect(deltas[1].body.rank).toBe('noble');
  });

  test('returns single delta for single-segment path', () => {
    const deltas = collectVariantDeltas(canonItem, 'human');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].body.race).toBe('human');
  });

  test('unknown segment warns and returns partial deltas', () => {
    // model/ is pure (§3.3): it reports through the caller's onWarn rather than printing.
    const onWarn = jest.fn();
    const deltas = collectVariantDeltas(canonItem, 'human/peasant', onWarn);
    expect(deltas).toHaveLength(1);
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('not found in variant tree'));
  });

  test('an unknown segment is silent when no reporter is supplied', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(collectVariantDeltas(canonItem, 'human/peasant')).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('empty path returns empty array', () => {
    expect(collectVariantDeltas(canonItem, '')).toEqual([]);
  });

  test('null path returns empty array', () => {
    expect(collectVariantDeltas(canonItem, null)).toEqual([]);
  });

  test('null variant (~) returns null to signal item exclusion', () => {
    const itemWithNullVariant = {
      id: 'example',
      variants: { omit: null },
    };
    expect(collectVariantDeltas(itemWithNullVariant, 'omit')).toBeNull();
  });

  test('null variant at nested path returns null', () => {
    const itemWithNullVariant = {
      id: 'example',
      variants: {
        human: {
          body: { race: 'human' },
          variants: { ghost: null },
        },
      },
    };
    expect(collectVariantDeltas(itemWithNullVariant, 'human/ghost')).toBeNull();
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

// ── _ fallback wildcard ───────────────────────────────────────────────────────

describe('_ fallback wildcard (resolveBranchSpec)', () => {
  test('_ applies to branches with no exact key match', () => {
    const spec = { '_': 'fallback' };
    expect(resolveBranchSpec(spec, ['anything'])).toEqual(['fallback']);
    expect(resolveBranchSpec(spec, ['other'])).toEqual(['fallback']);
  });

  test('_ does NOT apply when an exact key matches', () => {
    const spec = { '_': 'fallback', Felix: 'felix-variant' };
    expect(resolveBranchSpec(spec, ['Felix'])).toEqual(['felix-variant']);
  });

  test('_ stacks on top of * for unmatched branches', () => {
    const spec = { '*': 'base', '_': 'extra' };
    expect(resolveBranchSpec(spec, ['unmatched'])).toEqual(['base', 'extra']);
  });

  test('_ does not apply alongside * when exact key matches', () => {
    const spec = { '*': 'base', '_': 'extra', Felix: 'felix-only' };
    expect(resolveBranchSpec(spec, ['Felix'])).toEqual(['base', 'felix-only']);
    expect(resolveBranchSpec(spec, ['Other'])).toEqual(['base', 'extra']);
  });

  test('_: ~ (null) excludes unmatched branches', () => {
    const spec = { '_': null, Felix: 'felix-variant' };
    expect(resolveBranchSpec(spec, ['Other'])).toBeNull();
    expect(resolveBranchSpec(spec, ['Unrelated'])).toBeNull();
  });

  test('_: ~ does not affect branches with an exact key', () => {
    const spec = { '_': null, Felix: 'felix-variant' };
    expect(resolveBranchSpec(spec, ['Felix'])).toEqual(['felix-variant']);
  });

  test('_ with branches: sub-key descends correctly', () => {
    const spec = {
      '_': {
        branches: {
          Aness: 'aness-fallback',
        },
      },
      Felix: {
        branches: {
          Aness: 'aness-felix',
        },
      },
    };
    expect(resolveBranchSpec(spec, ['Other', 'Aness'])).toEqual(['aness-fallback']);
    expect(resolveBranchSpec(spec, ['Felix', 'Aness'])).toEqual(['aness-felix']);
  });
});

// ── resolveItem ───────────────────────────────────────────────────────────────

describe('resolveItem', () => {
  const canonItem = {
    id: 'hero',
    name: 'Hero',
    aid:    { type: 'Character', title: 'Hero' },
    render: { template: 'Character' },
    body: { role: 'warrior' },
    variants: {
      mage: { body: { role: 'mage', magic: 'yes' } },
    },
  };

  const registry = new Map([['hero', canonItem]]);

  test('import without importVariants yields base item body', () => {
    const itemDef = { import: 'hero' };
    const item = resolveItem(itemDef, registry, []);
    expect(item.name.full).toBe('Hero');
    expect(item.body.role).toBe('warrior');
  });

  test('importVariants applies variant body fields', () => {
    const itemDef = { import: 'hero', importVariants: ['mage'] };
    const item = resolveItem(itemDef, registry, []);
    expect(item.body.role).toBe('mage');
    expect(item.body.magic).toBe('yes');
  });

  test('importVariants with null variant (~) excludes the item', () => {
    const canonWithNull = {
      id: 'ghost',
      name: 'Ghost',
      aid: { type: 'Character' },
      render: { template: 'Character' },
      body: { role: 'spirit' },
      variants: { omit: null },
    };
    const reg = new Map([['ghost', canonWithNull]]);
    const itemDef = { import: 'ghost', importVariants: ['omit'] };
    expect(resolveItem(itemDef, reg, [])).toBeNull();
  });

  test('branch dispatch to null variant (~) excludes the item', () => {
    const canonWithNull = {
      id: 'ghost',
      name: 'Ghost',
      aid: { type: 'Character' },
      render: { template: 'Character' },
      body: { role: 'spirit' },
      variants: { hidden: null },
    };
    const reg = new Map([['ghost', canonWithNull]]);
    const itemDef = { import: 'ghost', branches: { stealth: 'hidden', '*': [] } };
    expect(resolveItem(itemDef, reg, ['stealth'])).toBeNull();
    expect(resolveItem(itemDef, reg, ['other'])).not.toBeNull();
  });

  test('body override in itemDef overwrites base body fields', () => {
    const itemDef = { import: 'hero', body: { role: 'rogue' } };
    const item = resolveItem(itemDef, registry, []);
    expect(item.body.role).toBe('rogue');
  });

  test('local item definition (no import) is returned as-is', () => {
    const itemDef = {
      id: 'npc', name: 'Guard',
      aid: { type: 'Character', title: 'Guard' },
      render: { template: 'Character' },
      body: { role: 'guard' },
    };
    const item = resolveItem(itemDef, new Map(), []);
    expect(item.name.full).toBe('Guard');
    expect(item.body.role).toBe('guard');
  });

  test('import of unknown id throws', () => {
    const itemDef = { import: 'unknown' };
    expect(() => resolveItem(itemDef, new Map(), [])).toThrow(/unknown/i);
  });

  test('compiler metadata (variants) is stripped from resolved item', () => {
    const itemDef = { import: 'hero' };
    const item = resolveItem(itemDef, registry, []);
    expect(item).not.toHaveProperty('variants');
    expect(item).not.toHaveProperty('_source');
  });

  describe('import-level field operations on aid and top-level fields', () => {
    const baseItem = {
      id: 'outfit',
      name: 'Outfit',
      aid: { type: 'Item', title: 'Outfit', triggers: ['clothing', 'style'] },
      render: { template: 'Item' },
      body: { known: 'base knowledge' },
      pronouns: 'they/them',
    };
    const reg = new Map([['outfit', baseItem]]);

    test('aid.triggers: plain array replaces', () => {
      const item = resolveItem({ import: 'outfit', aid: { triggers: ['uniform'] } }, reg, []);
      expect(item.aid.triggers).toEqual(['uniform']);
    });

    test('aid.triggers: +{} appends to array', () => {
      const item = resolveItem({ import: 'outfit', aid: { triggers: '+{uniform}' } }, reg, []);
      expect(item.aid.triggers).toEqual(['clothing', 'style', 'uniform']);
    });

    test('aid.triggers: -{} removes item from array', () => {
      const item = resolveItem({ import: 'outfit', aid: { triggers: '-{style}' } }, reg, []);
      expect(item.aid.triggers).toEqual(['clothing']);
    });

    test('aid.triggers: null deletes the field', () => {
      const item = resolveItem({ import: 'outfit', aid: { triggers: null } }, reg, []);
      expect(item.aid).not.toHaveProperty('triggers');
    });

    test('body.known: +{} converts scalar to two-element array', () => {
      const item = resolveItem({ import: 'outfit', body: { known: '+{and more}' } }, reg, []);
      expect(item.body.known).toEqual(['base knowledge', 'and more']);
    });

    test('name: /{old}/{new} swaps substring', () => {
      const item = resolveItem({ import: 'outfit', name: '/{Outfit}/{Uniform}' }, reg, []);
      expect(item.name.full).toBe('Uniform');
    });

    test('name: array of swaps applies all in sequence', () => {
      const base = { id: 'char', name: 'She said her name was Sarah', aid: { type: 'Character' }, body: {} };
      const r = new Map([['char', base]]);
      const item = resolveItem(
        { import: 'char', name: ['/{She}/{He}', '/{her}/{his}', '/{Sarah}/{Sam}'] },
        r,
        []
      );
      expect(item.name.full).toBe('He said his name was Sam');
    });

    test('pronouns: plain string replaces', () => {
      const item = resolveItem({ import: 'outfit', pronouns: 'she/her' }, reg, []);
      expect(item.pronouns).toBe('she/her');
    });
  });

  describe('branch-based variant dispatch via branches:', () => {
    const baseItem = {
      id: 'spirit',
      name: 'Spirit',
      aid: { type: 'Character', title: 'Spirit' },
      render: { template: 'Character' },
      body: { form: 'incorporeal', origin: 'unknown' },
    };
    const reg = new Map([['spirit', baseItem]]);

    test('wildcard * applies as baseline for all non-excluded branches', () => {
      const itemDef = {
        import: 'spirit',
        variants: {
          generic: { body: { form: 'generic' } },
        },
        branches: {
          '*': 'generic',
        },
      };
      expect(resolveItem(itemDef, reg, ['Free Form']).body.form).toBe('generic');
      expect(resolveItem(itemDef, reg, ['Wyvern']).body.form).toBe('generic');
    });

    test('explicit branch stacks on wildcard', () => {
      const itemDef = {
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
      expect(resolveItem(itemDef, reg, ['Wyvern']).body.form).toBe('draconic');
      expect(resolveItem(itemDef, reg, ['Free Form']).body.form).toBe('generic');
    });

    test('null branch key excludes item for that branch', () => {
      const itemDef = {
        import: 'spirit',
        branches: { Wyvern: null },
      };
      expect(resolveItem(itemDef, reg, ['Wyvern'])).toBeNull();
      expect(resolveItem(itemDef, reg, ['Other'])).not.toBeNull();
    });

    test('multi-level branch applies variants from each level in order', () => {
      const itemDef = {
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
      const itemA = resolveItem(itemDef, reg, ['Branch A']);
      expect(itemA.name.full).toBe('Prime');
      expect(itemA.body.form).toBe('artificial');
      expect(itemA.body.origin).toBe('scientist A');

      const itemB = resolveItem(itemDef, reg, ['Branch B']);
      expect(itemB.name.full).toBe('Prime');
      expect(itemB.body.form).toBe('artificial');
      expect(itemB.body.origin).toBe('scientist B');
    });

    test('branch not defined yields base item (no variants applied)', () => {
      const itemDef = {
        import: 'spirit',
        variants: {
          special: { body: { form: 'special' } },
        },
        branches: {
          Wyvern: 'special',
        },
      };
      const item = resolveItem(itemDef, reg, ['Other']);
      expect(item.body.form).toBe('incorporeal');
    });
  });
});
