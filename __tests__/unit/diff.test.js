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
    components: {
      plotEssentials: components.plotEssentials || [],
      aiInstructions: components.aiInstructions || [],
      authorsNote:    components.authorsNote    || [],
    },
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
      leaf('a', 'a', [], { plotEssentials: [pe('genre')('GENRE'), pe('you')('YOU-A')] }),
      leaf('b', 'b', [], { plotEssentials: [pe('genre')('GENRE'), pe('you')('YOU-B')] }),
    ];
    const { shared, deltas } = buildSharedAndDeltas(data);
    expect(shared.components.plotEssentials.map(b => b.key)).toEqual(['genre']);
    expect(deltas.get('a').components.plotEssentials.map(b => b.text)).toEqual(['YOU-A']);
    expect(deltas.get('b').components.plotEssentials.map(b => b.text)).toEqual(['YOU-B']);
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
