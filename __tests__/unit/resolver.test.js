'use strict';

const { applyFieldOp } = require('../../src/model/fieldops');
const { collectVariantDeltas, resolveItem } = require('../../src/model/item');
const { enumerateLeaves, resolveBranchSpec } = require('../../src/model/branches');
const { deepClone } = require('../../src/util');
const { ItemRegistry } = require('../../src/loader/registry');
const { parseYaml } = require('../../src/loader/yaml');
const { attachOrigins, nearestOrigin, originAt, copyOrigins } = require('../../src/origin');

function authored(text, file) {
  const { value, sourceMap } = parseYaml(text, file);
  return attachOrigins({ ...value, _source: file }, sourceMap.exportOrigins());
}

describe('authored origins follow item precedence', () => {
  const libraryText = [
    'id: Hero',
    'name: Hero Vale',
    'aid: {type: Character}',
    'body:',
    '  changed: red fox',
    '  sibling: untouched',
    '  nested: {keep: original, remove: old}',
    'variants:',
    '  seed:',
    '    body: {changed: seed}',
    '    variants:',
    '      child:',
    '        body: {changed: nested seed}',
    '  library:',
    '    body: {changed: library branch}',
  ].join('\n');
  const resolve = (text, branch = []) => {
    const library = authored(libraryText, 'library.yaml');
    const local = authored(text, 'project.yaml');
    return { library, local, item: resolveItem(local, new Map([['hero', library]]), branch) };
  };

  test.each([
    ['import: Hero\nbody: {changed: local}', [], 'local', 'project.yaml', 2],
    ['import: Hero\nimportVariants: seed/child', [], 'nested seed', 'library.yaml', 13],
    ['import: Hero\nimportVariants: seed\nbody: {changed: local}', [], 'local', 'project.yaml', 3],
    ['import: Hero\nbody: {changed: local}\nbranches: {main: library}', ['main'], 'library branch', 'library.yaml', 15],
    ['import: Hero\nbranches: {main: local}\nvariants:\n  local:\n    importVariants: seed\n    body: {changed: branch}', ['main'], 'branch', 'project.yaml', 6],
  ])('keeps library siblings after resolving %s', (text, branch, value, file, line) => {
    const { item, library } = resolve(text, branch);
    expect(item.body.changed).toBe(value);
    expect(nearestOrigin(item, ['body', 'changed'])).toMatchObject({ file, line });
    expect(nearestOrigin(item, ['body', 'sibling'])).toEqual(originAt(library, ['body', 'sibling']));
    expect(item._source).toBe('library.yaml');
    expect(JSON.stringify(item)).not.toContain('codexLoomOrigins');
  });

  test.each([
    ['+{blue}', ['red fox', 'blue']], ['-{red}', 'fox'], ['/{red}/{blue}', 'blue fox'],
    ['["/{red}/{blue}", "+{tail}"]', ['blue fox', 'tail']],
  ])('attributes the value produced by %s to the operation', (op, value) => {
    const { item, local, library } = resolve(`import: Hero\nbody:\n  changed: ${op}`);
    expect(item.body.changed).toEqual(value);
    expect(nearestOrigin(item, ['body', 'changed'])).toEqual(originAt(local, ['body', 'changed']));
    expect(nearestOrigin(item, ['body', 'sibling'])).toEqual(originAt(library, ['body', 'sibling']));
  });

  test('nested deletion retains its operation and clears obsolete child origins', () => {
    const { item, library, local } = resolve('import: Hero\nbody:\n  nested:\n    remove: null');
    expect(item.body.nested).toEqual({ keep: 'original' });
    expect(nearestOrigin(item, ['body', 'nested', 'remove'])).toEqual(originAt(local, ['body', 'nested', 'remove']));
    expect(nearestOrigin(item, ['body', 'nested', 'keep'])).toEqual(originAt(library, ['body', 'nested', 'keep']));
    const replaced = resolve('import: Hero\nbody:\n  nested: replaced');
    expect(originAt(replaced.item, ['body', 'nested', 'keep'])).toBeNull();
    expect(nearestOrigin(replaced.item, ['body', 'nested', 'keep'])).toEqual(originAt(replaced.local, ['body', 'nested']));
  });

  test('no-op warnings point at the authored nested operation with its original spelling', () => {
    const library = authored(libraryText, 'library.yaml');
    const local = authored('import: Hero\nbranches: {main: local}\nvariants:\n  local:\n    CHANGED: -{absent}', 'project.yaml');
    const warn = jest.fn();
    const item = resolveItem(local, new Map([['hero', library]]), ['main'], warn);
    expect(warn).toHaveBeenCalledWith('CL0328', expect.any(String), expect.objectContaining({ file: 'project.yaml', line: 5, col: 5 }));
    expect(item.body.changed).toBe('red fox');
    expect(originAt(item, ['body', 'changed'])).toMatchObject({ path: ['variants', 'local', 'CHANGED'], line: 5 });
  });

  test('normalization and copying retain scalar names and variant alias origins', () => {
    const { item, library } = resolve('import: Hero\nbranches: {main: local}\nvariants:\n  local:\n    VARS: {Tone: quiet}\n    description: note');
    const selected = resolveItem(authored('import: Hero\nbranches: {main: local}\nvariants:\n  local:\n    VARS: {Tone: quiet}\n    description: note', 'project.yaml'), new Map([['hero', library]]), ['main']);
    expect(originAt(item, ['name', 'full'])).toEqual(originAt(library, ['name']));
    expect(originAt(item, ['name', 'display'])).toEqual(originAt(library, ['name']));
    const clone = copyOrigins(selected, deepClone(selected));
    expect(originAt(clone, ['v', 'Tone'])).toMatchObject({ path: ['variants', 'local', 'VARS', 'Tone'], line: 5 });
    expect(originAt(clone, ['notes'])).toMatchObject({ path: ['variants', 'local', 'description'], line: 6 });
    expect(originAt(clone, ['render', 'template'])).toEqual(originAt(library, ['aid', 'type']));
  });

  test('a partial name override preserves the inherited full-name origin', () => {
    const library = authored('id: Hero\nname:\n  display: Hero\n  full: Hero Vale', 'library.yaml');
    const local = authored('import: Hero\nname:\n  display: Local', 'project.yaml');
    const item = resolveItem(local, new Map([['hero', library]]), []);
    expect(item.name).toEqual({ display: 'Local', full: 'Hero Vale' });
    expect(originAt(item, ['name', 'display'])).toEqual(originAt(local, ['name', 'display']));
    expect(originAt(item, ['name', 'full'])).toEqual(originAt(library, ['name', 'full']));
  });

  test('an empty name mapping derives its normalized name from the id', () => {
    const source = authored('id: Hero\nname: {display: ""}', 'item.yaml');
    const item = resolveItem(source, new Map(), []);
    expect(item.name).toEqual({ display: 'Hero', full: 'Hero' });
    expect(originAt(item, ['name', 'full'])).toEqual(originAt(source, ['id']));
  });
});

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

  describe('CL0328 — a field op that matched nothing', () => {
    const arm = () => {
      const calls = [];
      return { ctx: { onWarn: (code, message) => calls.push({ code, message }), label: 'Item.field' }, calls };
    };

    test('a standalone -{} whose target is absent warns', () => {
      const { ctx, calls } = arm();
      expect(applyFieldOp('platinum blond hair', '-{in a controlled bun}', ctx)).toBe('platinum blond hair');
      expect(calls.map((c) => c.code)).toEqual(['CL0328']);
      expect(calls[0].message).toContain('in a controlled bun');
    });

    test('a standalone swap whose "from" is absent warns', () => {
      const { ctx, calls } = arm();
      applyFieldOp('she built her reputation', '/{THEY}/{he}', ctx);
      expect(calls.map((c) => c.code)).toEqual(['CL0328']);
    });

    test('a -{} that does hit stays silent', () => {
      const { ctx, calls } = arm();
      expect(applyFieldOp('platinum blond hair in a controlled bun', '-{in a controlled bun}', ctx))
        .toBe('platinum blond hair');
      expect(calls).toEqual([]);
    });

    test('append and replace never warn', () => {
      const { ctx, calls } = arm();
      applyFieldOp('base', '+{ addendum }', ctx);
      applyFieldOp('base', 'a plain replacement', ctx);
      applyFieldOp('anything', null, ctx); // ~ delete
      expect(calls).toEqual([]);
    });

    test('a chain warns once when every op missed', () => {
      const { ctx, calls } = arm();
      applyFieldOp('a plain clause', ['/{She}/{He}', '/{she}/{he}', '/{her}/{his}'], ctx);
      expect(calls.map((c) => c.code)).toEqual(['CL0328']);
      expect(calls[0].message).toContain('every operation in this chain');
    });

    test('a chain stays silent when at least one op hits (the pronoun swap-chain case)', () => {
      const { ctx, calls } = arm();
      applyFieldOp('She met her friend', ['/{She}/{He}', '/{she}/{he}', '/{her}/{his}'], ctx);
      expect(calls).toEqual([]);
    });

    test('a mapping op warns per missed subfield, not for the ones that hit', () => {
      const { ctx, calls } = arm();
      applyFieldOp(
        { hair: 'in a controlled bun', mood: 'clinical' },
        { hair: '-{absent phrase}', mood: '/{clinical}/{warm}' },
        ctx,
      );
      expect(calls.map((c) => c.code)).toEqual(['CL0328']);
      expect(calls[0].message).toContain('Item.field.hair');
    });

    test('no ctx → no warnings and identical output', () => {
      expect(applyFieldOp('x', '-{absent}')).toBe('x');
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
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('is not defined in the variant tree'), expect.any(Object));
  });

  test('an unknown segment is silent when no reporter is supplied', () => {
    expect(collectVariantDeltas(canonItem, 'human/peasant')).toHaveLength(1);
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

  // ── The arity silence rule (§7.6.2a) ───────────────────────────────────────

  describe('options.silent', () => {
    test('suppresses the warning without changing what is applied', () => {
      const onWarn = jest.fn();
      const deltas = collectVariantDeltas(canonItem, 'human/peasant', onWarn, { silent: true });
      expect(deltas).toHaveLength(1);
      expect(deltas[0].body.race).toBe('human');
      expect(onWarn).not.toHaveBeenCalled();
    });

    test('a name matching nothing still returns an empty list, which is how a caller counts', () => {
      // The whole of CL0326's detection: an empty list means no target matched, a non-empty
      // one or a null exclusion means one did. Silence would be unsafe without it.
      expect(collectVariantDeltas(canonItem, 'orc', jest.fn(), { silent: true })).toEqual([]);
    });

    test('a ~ exclusion still returns null under silence', () => {
      const itemWithNullVariant = { id: 'example', variants: { omit: null } };
      expect(collectVariantDeltas(itemWithNullVariant, 'omit', jest.fn(), { silent: true })).toBeNull();
    });

    test('omitting the option leaves the arity-1 warning exactly as it was', () => {
      const onWarn = jest.fn();
      collectVariantDeltas(canonItem, 'human/peasant', onWarn);
      expect(onWarn).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * §7.6.2a's partial-path rule, pinned because it is inherited rather than chosen.
   *
   * The loop pushes each resolved segment *before* testing the next, so a path that breaks
   * halfway applies the half that resolved. Beth confirmed this is correct on 2026-08-20;
   * nothing asserted it, so a refactor to all-or-nothing would have stayed green. Under the
   * silence rule it matters more, not less: the warning that used to accompany the partial
   * application is gone on an arity-N selector, so the applied half is the only evidence.
   */
  describe('a nested path applies partially rather than all-or-nothing', () => {
    test('the segments before the unresolvable one are applied, not discarded', () => {
      expect(collectVariantDeltas(canonItem, 'human/peasant', jest.fn())).toEqual([
        canonItem.variants.human,
      ]);
    });

    test('an unresolvable first segment applies nothing, which is the same rule', () => {
      expect(collectVariantDeltas(canonItem, 'orc/warlord', jest.fn())).toEqual([]);
    });

    test('the rule holds under silence too', () => {
      expect(collectVariantDeltas(canonItem, 'human/peasant', jest.fn(), { silent: true }))
        .toHaveLength(1);
    });
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
  test.each([
    { name: 'null spec → empty array (include with no variants)',
      spec: null, leaf: ['subject'], expected: [] },
    { name: 'exact key match returns its variant names',
      spec: { subject: 'subject-variant' }, leaf: ['subject'], expected: ['subject-variant'] },
    { name: 'exact null key → returns null (excluded)',
      spec: { subject: null }, leaf: ['subject'], expected: null },
    { name: 'wildcard * applies as baseline for any non-excluded branch',
      spec: { '*': 'generic' }, leaf: ['anything'], expected: ['generic'] },
    { name: 'wildcard * applies as baseline for a second non-excluded branch',
      spec: { '*': 'generic' }, leaf: ['other'], expected: ['generic'] },
    { name: 'explicit key stacks on top of wildcard (both apply)',
      spec: { '*': 'generic', Wyvern: 'draconic' }, leaf: ['Wyvern'], expected: ['generic', 'draconic'] },
    { name: 'a branch with only the wildcard gets just the wildcard',
      spec: { '*': 'generic', Wyvern: 'draconic' }, leaf: ['Free Form'], expected: ['generic'] },
    { name: 'explicit null prevents wildcard from applying',
      spec: { '*': 'generic', Wyvern: null }, leaf: ['Wyvern'], expected: null },
    { name: 'wildcard still applies to a non-excluded branch alongside an explicit null',
      spec: { '*': 'generic', Wyvern: null }, leaf: ['Other'], expected: ['generic'] },
    { name: 'array apply form at a branch level',
      spec: { subject: { apply: ['a', 'b'] } }, leaf: ['subject'], expected: ['a', 'b'] },
    { name: 'multi-level descent: [A, X]',
      spec: { A: { apply: 'a-variant', branches: { X: 'x-variant', Y: 'y-variant' } } },
      leaf: ['A', 'X'], expected: ['a-variant', 'x-variant'] },
    { name: 'multi-level descent: [A, Y]',
      spec: { A: { apply: 'a-variant', branches: { X: 'x-variant', Y: 'y-variant' } } },
      leaf: ['A', 'Y'], expected: ['a-variant', 'y-variant'] },
    { name: 'wildcard at first level descends into sub-branches: [Free Form, Aness]',
      spec: { '*': { branches: { Aness: 'aness-shared', Veryn: 'veryn-shared' } } },
      leaf: ['Free Form', 'Aness'], expected: ['aness-shared'] },
    { name: 'wildcard at first level descends into sub-branches: [Wyvern, Veryn]',
      spec: { '*': { branches: { Aness: 'aness-shared', Veryn: 'veryn-shared' } } },
      leaf: ['Wyvern', 'Veryn'], expected: ['veryn-shared'] },
    { name: 'wildcard baseline + explicit sub-branch stack: only */Aness fires',
      spec: { '*': { branches: { Aness: 'shared' } }, Wyvern: { branches: { Aness: 'wyvern-specific' } } },
      leaf: ['Free Form', 'Aness'], expected: ['shared'] },
    { name: 'wildcard baseline + explicit sub-branch stack: */Aness then Wyvern/Aness stacks',
      spec: { '*': { branches: { Aness: 'shared' } }, Wyvern: { branches: { Aness: 'wyvern-specific' } } },
      leaf: ['Wyvern', 'Aness'], expected: ['shared', 'wyvern-specific'] },
  ])('$name', ({ spec, leaf, expected }) => {
    expect(resolveBranchSpec(spec, leaf)).toEqual(expected);
  });
});

// ── _ fallback wildcard ───────────────────────────────────────────────────────

describe('_ fallback wildcard (resolveBranchSpec)', () => {
  test.each([
    { name: '_ applies to branches with no exact key match',
      spec: { '_': 'fallback' }, leaf: ['anything'], expected: ['fallback'] },
    { name: '_ applies to a second branch with no exact key match',
      spec: { '_': 'fallback' }, leaf: ['other'], expected: ['fallback'] },
    { name: '_ does NOT apply when an exact key matches',
      spec: { '_': 'fallback', Felix: 'felix-variant' }, leaf: ['Felix'], expected: ['felix-variant'] },
    { name: '_ stacks on top of * for unmatched branches',
      spec: { '*': 'base', '_': 'extra' }, leaf: ['unmatched'], expected: ['base', 'extra'] },
    { name: '_ does not apply alongside * when exact key matches',
      spec: { '*': 'base', '_': 'extra', Felix: 'felix-only' }, leaf: ['Felix'], expected: ['base', 'felix-only'] },
    { name: '* still applies alongside _ when no exact key matches',
      spec: { '*': 'base', '_': 'extra', Felix: 'felix-only' }, leaf: ['Other'], expected: ['base', 'extra'] },
    { name: '_: ~ (null) excludes unmatched branches',
      spec: { '_': null, Felix: 'felix-variant' }, leaf: ['Other'], expected: null },
    { name: '_: ~ (null) excludes a second unmatched branch',
      spec: { '_': null, Felix: 'felix-variant' }, leaf: ['Unrelated'], expected: null },
    { name: '_: ~ does not affect branches with an exact key',
      spec: { '_': null, Felix: 'felix-variant' }, leaf: ['Felix'], expected: ['felix-variant'] },
    { name: '_ with branches: sub-key descends correctly (fallback path)',
      spec: { '_': { branches: { Aness: 'aness-fallback' } }, Felix: { branches: { Aness: 'aness-felix' } } },
      leaf: ['Other', 'Aness'], expected: ['aness-fallback'] },
    { name: '_ with branches: sub-key descends correctly (exact path)',
      spec: { '_': { branches: { Aness: 'aness-fallback' } }, Felix: { branches: { Aness: 'aness-felix' } } },
      leaf: ['Felix', 'Aness'], expected: ['aness-felix'] },
  ])('$name', ({ spec, leaf, expected }) => {
    expect(resolveBranchSpec(spec, leaf)).toEqual(expected);
  });
});

// ── CL0327 — a null wildcard in a branch spec ─────────────────────────────────

describe('CL0327 — null wildcard (resolveBranchSpec)', () => {
  test("'*': ~ raises CL0327 through onWarn and is still skipped (item stays included)", () => {
    const calls = [];
    const spec = { subject: 'base', '*': null };
    const names = resolveBranchSpec(spec, ['researcher'], (code, message) => calls.push({ code, message }));
    expect(names).toEqual([]); // not excluded — the null wildcard was skipped
    expect(calls.map((c) => c.code)).toEqual(['CL0327']);
    expect(calls[0].message).toContain("'_: ~'");
  });

  test("'_': ~ is the legitimate form and raises nothing", () => {
    const calls = [];
    const spec = { subject: 'base', _: null };
    expect(resolveBranchSpec(spec, ['researcher'], (code) => calls.push(code))).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a null wildcard nested under a branch key is found too', () => {
    const calls = [];
    const spec = { Wyvern: { branches: { '*': null, Veryn: 'v' } } };
    resolveBranchSpec(spec, ['Wyvern', 'Veryn'], (code) => calls.push(code));
    expect(calls).toEqual(['CL0327']);
  });

  test('one warning per spec object however many leaves resolve against it', () => {
    const calls = [];
    const spec = { subject: 'base', '*': null };
    const onWarn = (code) => calls.push(code);
    for (const leaf of [['researcher'], ['flashback'], ['subject']]) {
      resolveBranchSpec(spec, leaf, onWarn);
    }
    expect(calls).toEqual(['CL0327']);
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

    /**
     * §4.8's `kind:` moves like every other top-level field, which is the point: whether an
     * item is narrative or reference material is a property of *this copy*, not of the canon
     * it came from. Importing a narrative item and rendering it into a component as a
     * swappable alternate makes that copy reference material while canon stays narrative.
     */
    test('kind: inherits from canon when the import does not declare it', () => {
      const withKind = new Map([['outfit', { ...baseItem, kind: 'reference' }]]);
      expect(resolveItem({ import: 'outfit' }, withKind, []).kind).toBe('reference');
    });

    test('kind: an import declaring it overrides canon, leaving canon alone', () => {
      const item = resolveItem({ import: 'outfit', kind: 'reference' }, reg, []);
      expect(item.kind).toBe('reference');
      expect(baseItem.kind).toBeUndefined();
    });

    test('kind: a variant can flip it', () => {
      const withVariant = new Map([['outfit', { ...baseItem, variants: { alt: { kind: 'reference' } } }]]);
      expect(resolveItem({ import: 'outfit', importVariants: ['alt'] }, withVariant, []).kind)
        .toBe('reference');
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

  describe('rename-on-import', () => {
    const wyvern = {
      id: 'wyvern',
      name: 'Wyvern',
      aid: { type: 'Creature', title: 'Wyvern' },
      render: { template: 'Creature' },
      body: { size: 'medium' },
    };
    const reg = new Map([['wyvern', wyvern]]);

    test('resolves under the local id, with the canon body and overrides applied', () => {
      const itemDef = { id: 'dragon', import: 'wyvern', v: { size: 'huge' } };
      const item = resolveItem(itemDef, reg, []);
      expect(item.id).toBe('dragon');
      expect(item.body.size).toBe('medium');
      expect(item.v.size).toBe('huge');
    });

    test('the name is still the canon item\'s name — only the id moves', () => {
      const itemDef = { id: 'dragon', import: 'wyvern' };
      const item = resolveItem(itemDef, reg, []);
      expect(item.name.full).toBe('Wyvern');
    });

    test('a qualified import resolves against an ItemRegistry', () => {
      const registry = new ItemRegistry();
      registry.sources.add('bestiary');
      registry.qualified.set('bestiary:wyvern', wyvern);
      const itemDef = { id: 'dragon', import: 'bestiary:wyvern' };
      const item = resolveItem(itemDef, registry, []);
      expect(item.id).toBe('dragon');
      expect(item.body.size).toBe('medium');
    });

    test('an ambiguous import throws with the qualified alternatives named', () => {
      const registry = new ItemRegistry();
      registry.sources.add('a');
      registry.sources.add('b');
      const rivalA = { id: 'magic', _canonSource: 'a', _source: 'a/magic.yaml' };
      const rivalB = { id: 'magic', _canonSource: 'b', _source: 'b/magic.yaml' };
      registry.qualified.set('a:magic', rivalA);
      registry.qualified.set('b:magic', rivalB);
      registry.ambiguous.set('magic', [rivalA, rivalB]);

      const itemDef = { id: 'localmagic', import: 'magic' };
      expect(() => resolveItem(itemDef, registry, [])).toThrow(/^Import failed:/);
      let err;
      try { resolveItem(itemDef, registry, []); } catch (e) { err = e; }
      expect(err.message).toContain('a:magic');
      expect(err.message).toContain('b:magic');
    });
  });
});

/**
 * CL0322 was unconditional until the item/slot flip caught up with it: any item lacking
 * both `aid.type` and `render.template` warned, including one routed only into components,
 * where §7.4 says neither key is owed. The check is now scoped to items that emit a story
 * card — the one output with no verbatim rung to fall through to.
 */
describe('CL0322 — no type and no template', () => {
  const NO_TYPE = 'CL0322';

  function warnCodesFor(render) {
    const onWarn = jest.fn();
    const itemDef = { id: 'Subject', name: 'Subject', body: { Tagline: 'x' } };
    if (render) itemDef.render = render;
    resolveItem(itemDef, new Map(), [], onWarn);
    return onWarn.mock.calls.map(([code]) => code);
  }

  test('a story card with neither key warns', () => {
    // No `render:` at all — storyCard defaults to true, so a card is emitted and nothing
    // can select a template for it.
    expect(warnCodesFor(undefined)).toContain(NO_TYPE);
  });

  test('an item routed only into components does not warn', () => {
    // `Ghost` from the placement fixture: the template sits on the target, which
    // `resolvePlacements` reads as the first rung of the ladder.
    expect(warnCodesFor({
      storyCard: false,
      plotEssential: { slot: 'cast', order: 3, template: 'Character' },
    })).not.toContain(NO_TYPE);
  });

  test('an item with no story card and no target does not warn either', () => {
    // `Silent`. It produces no output at all, which is CL0610's ERROR to report — naming
    // the missing type as well would describe a field that would change nothing.
    expect(warnCodesFor({ storyCard: false })).not.toContain(NO_TYPE);
  });

  test('a story card keeps its warning when a component target carries the template', () => {
    // The target's template does not reach the card, so the card is still unspecified.
    expect(warnCodesFor({
      plotEssential: { slot: 'cast', template: 'Character' },
    })).toContain(NO_TYPE);
  });
});
