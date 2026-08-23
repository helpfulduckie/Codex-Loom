'use strict';

const {
  buildSharedAndDeltas,
  buildLeafAnnotation,
  flattenItem,
  diffFlattened,
  collectDeltaKeyPaths,
} = require('../../src/diff');

// ── helpers ──────────────────────────────────────────────────────────────────

function item(id, type, rendered) {
  return [id, { type, rendered }];
}

function leaf(label, fileBase, itemPairs, components = {}) {
  return {
    label,
    fileBase,
    branchPath: label.split('/'),
    items: new Map(itemPairs),
    // Keyed by `SLOTTED_COMPONENTS` descriptor key, and spread rather than enumerated,
    // mirroring what `compile.js` captures: a family absent from a leaf is absent from the
    // object, which is the case `buildSharedAndDeltas` has to tolerate for real leaves too.
    components: { ...components },
  };
}

// ── buildSharedAndDeltas: items ────────────────────────────────────────────────

describe('buildSharedAndDeltas — items', () => {
  test('item identical in every leaf → shared, absent from deltas', () => {
    const data = [
      leaf('a', 'a', [item('felicia', 'Character', 'FELICIA')]),
      leaf('b', 'b', [item('felicia', 'Character', 'FELICIA')]),
    ];
    const { shared, deltas } = buildSharedAndDeltas(data);
    expect(shared.items.map(c => c.id)).toEqual(['felicia']);
    expect(deltas.get('a').items).toEqual([]);
    expect(deltas.get('b').items).toEqual([]);
  });

  test('item differing between leaves → each leaf version in its delta, not shared', () => {
    const data = [
      leaf('a', 'a', [item('aness', 'Character', 'ANESS-A')]),
      leaf('b', 'b', [item('aness', 'Character', 'ANESS-B')]),
    ];
    const { shared, deltas } = buildSharedAndDeltas(data);
    expect(shared.items).toEqual([]);
    expect(deltas.get('a').items[0].rendered).toBe('ANESS-A');
    expect(deltas.get('b').items[0].rendered).toBe('ANESS-B');
  });

  test('item present in only some leaves (~ excluded elsewhere) → varying, omitted where absent', () => {
    const data = [
      leaf('a', 'a', [item('extra', 'Character', 'EXTRA')]),
      leaf('b', 'b', []), // ~-excluded here
    ];
    const { shared, deltas } = buildSharedAndDeltas(data);
    expect(shared.items).toEqual([]);                  // not in every leaf → not shared
    expect(deltas.get('a').items.map(c => c.id)).toEqual(['extra']);
    expect(deltas.get('b').items).toEqual([]);         // silently omitted, not noted
  });
});

// ── buildSharedAndDeltas: component blocks ──────────────────────────────────────

describe('buildSharedAndDeltas — component blocks', () => {
  test('PE block identical everywhere is shared; a divergent block goes to deltas', () => {
    const pe = key => text => ({ key, text });
    const data = [
      leaf('a', 'a', [], { plotEssential: [pe('genre')('GENRE'), pe('you')('YOU-A')] }),
      leaf('b', 'b', [], { plotEssential: [pe('genre')('GENRE'), pe('you')('YOU-B')] }),
    ];
    const { shared, deltas } = buildSharedAndDeltas(data);
    expect(shared.components.plotEssential.map(b => b.key)).toEqual(['genre']);
    expect(deltas.get('a').components.plotEssential.map(b => b.text)).toEqual(['YOU-A']);
    expect(deltas.get('b').components.plotEssential.map(b => b.text)).toEqual(['YOU-B']);
  });

  // The three families the hand-written list dropped. An opening that varies by branch is
  // the most likely thing an author wants a bleed check to catch, and it was the one the
  // report could not see at all.
  test.each(['opening', 'summary', 'adventureDescription'])(
    'a %s that varies by branch reaches the deltas',
    (family) => {
      const block = key => text => ({ key, text });
      const data = [
        leaf('a', 'a', [], { [family]: [block('body')('CALM')] }),
        leaf('b', 'b', [], { [family]: [block('body')('STORM')] }),
      ];
      const { shared, deltas } = buildSharedAndDeltas(data);
      expect(shared.components[family]).toEqual([]);
      expect(deltas.get('a').components[family].map(b => b.text)).toEqual(['CALM']);
      expect(deltas.get('b').components[family].map(b => b.text)).toEqual(['STORM']);
    },
  );

  test('an opening identical in every leaf is shared, not a delta', () => {
    const data = [
      leaf('a', 'a', [], { opening: [{ key: 'Opening', text: 'SAME' }] }),
      leaf('b', 'b', [], { opening: [{ key: 'Opening', text: 'SAME' }] }),
    ];
    const { shared, deltas } = buildSharedAndDeltas(data);
    expect(shared.components.opening.map(b => b.text)).toEqual(['SAME']);
    expect(deltas.get('a').components.opening).toEqual([]);
  });
});

// ── flattenItem / diffFlattened ────────────────────────────────────────────────

describe('flattenItem + diffFlattened', () => {
  test('flattens diff-relevant roots to dot-paths, ignores render/v', () => {
    const flat = flattenItem({
      body: { Tagline: 'T', Physical: { hair: 'silver' } },
      aid: { triggers: ['A', 'B'] },
      render: { template: 'Character' }, // ignored
    });
    expect(flat['body.tagline']).toBe(JSON.stringify('T'));
    expect(flat['body.physical.hair']).toBe(JSON.stringify('silver'));
    expect(flat['aid.triggers']).toBe(JSON.stringify(['A', 'B']));
    expect(Object.keys(flat).some(k => k.startsWith('render'))).toBe(false);
  });

  test('diffFlattened reports only changed paths', () => {
    const base = flattenItem({ body: { hair: 'silver', age: '40s' } });
    const leafC = flattenItem({ body: { hair: 'black',  age: '40s' } });
    const changes = diffFlattened(base, leafC);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('body.hair');
    expect(changes[0].base).toBe(JSON.stringify('silver'));
    expect(changes[0].leaf).toBe(JSON.stringify('black'));
  });
});

// ── collectDeltaKeyPaths ───────────────────────────────────────────────────────

describe('collectDeltaKeyPaths', () => {
  test('normalizes bare keys and explicit body to body.* namespace', () => {
    const paths = collectDeltaKeyPaths({ 'Physical Traits': { hair: '-{silver}' } });
    expect(paths.has('body.physical traits')).toBe(true);
    expect(paths.has('body.physical traits.hair')).toBe(true);
  });

  test('top-level name/aid kept under their own root; variants/_source skipped', () => {
    const paths = collectDeltaKeyPaths({
      name: { full: 'X' },
      aid: { title: 'Y' },
      variants: { nested: {} },
      _source: 'f.yaml',
    });
    expect(paths.has('name.full')).toBe(true);
    expect(paths.has('aid.title')).toBe(true);
    expect([...paths].some(p => p.startsWith('variants'))).toBe(false);
  });
});

// ── buildLeafAnnotation: nulled-item reporting ──────────────────────────────────

describe('buildLeafAnnotation — nulled items', () => {
  const registry = new Map();

  test('~-excluded item is explicitly reported as nulled', () => {
    const itemDef = { id: 'gone', branches: { knight: null }, body: { x: 'y' } };
    const doc = buildLeafAnnotation(
      { label: 'knight', branchPath: ['knight'] },
      [itemDef],
      registry,
    );
    expect(doc).toMatch(/## gone/);
    expect(doc).toMatch(/nulled/);
  });
});
