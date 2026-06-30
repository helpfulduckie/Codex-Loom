'use strict';

const {
  buildSharedAndDeltas,
  buildLeafAnnotation,
  flattenCard,
  diffFlattened,
  collectDeltaKeyPaths,
} = require('../../src/diff');

// ── helpers ──────────────────────────────────────────────────────────────────

function card(id, type, rendered) {
  return [id, { type, rendered }];
}

function leaf(label, fileBase, cardPairs, components = {}) {
  return {
    label,
    fileBase,
    branchPath: label.split('/'),
    cards: new Map(cardPairs),
    components: {
      plotEssentials: components.plotEssentials || [],
      aiInstructions: components.aiInstructions || [],
      authorsNote:    components.authorsNote    || [],
    },
  };
}

// ── buildSharedAndDeltas: cards ────────────────────────────────────────────────

describe('buildSharedAndDeltas — cards', () => {
  test('card identical in every leaf → shared, absent from deltas', () => {
    const data = [
      leaf('a', 'a', [card('felicia', 'Character', 'FELICIA')]),
      leaf('b', 'b', [card('felicia', 'Character', 'FELICIA')]),
    ];
    const { shared, deltas } = buildSharedAndDeltas(data);
    expect(shared.cards.map(c => c.id)).toEqual(['felicia']);
    expect(deltas.get('a').cards).toEqual([]);
    expect(deltas.get('b').cards).toEqual([]);
  });

  test('card differing between leaves → each leaf version in its delta, not shared', () => {
    const data = [
      leaf('a', 'a', [card('aness', 'Character', 'ANESS-A')]),
      leaf('b', 'b', [card('aness', 'Character', 'ANESS-B')]),
    ];
    const { shared, deltas } = buildSharedAndDeltas(data);
    expect(shared.cards).toEqual([]);
    expect(deltas.get('a').cards[0].rendered).toBe('ANESS-A');
    expect(deltas.get('b').cards[0].rendered).toBe('ANESS-B');
  });

  test('card present in only some leaves (~ excluded elsewhere) → varying, omitted where absent', () => {
    const data = [
      leaf('a', 'a', [card('extra', 'Character', 'EXTRA')]),
      leaf('b', 'b', []), // ~-excluded here
    ];
    const { shared, deltas } = buildSharedAndDeltas(data);
    expect(shared.cards).toEqual([]);                  // not in every leaf → not shared
    expect(deltas.get('a').cards.map(c => c.id)).toEqual(['extra']);
    expect(deltas.get('b').cards).toEqual([]);         // silently omitted, not noted
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

// ── flattenCard / diffFlattened ────────────────────────────────────────────────

describe('flattenCard + diffFlattened', () => {
  test('flattens diff-relevant roots to dot-paths, ignores render/v', () => {
    const flat = flattenCard({
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
    const base = flattenCard({ body: { hair: 'silver', age: '40s' } });
    const leafC = flattenCard({ body: { hair: 'black',  age: '40s' } });
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

// ── buildLeafAnnotation: nulled-card reporting ──────────────────────────────────

describe('buildLeafAnnotation — nulled cards', () => {
  const registry = new Map();

  test('~-excluded card is explicitly reported as nulled', () => {
    const cardDef = { id: 'gone', branches: { knight: null }, body: { x: 'y' } };
    const doc = buildLeafAnnotation(
      { label: 'knight', branchPath: ['knight'] },
      [cardDef],
      registry,
    );
    expect(doc).toMatch(/## gone/);
    expect(doc).toMatch(/nulled/);
  });
});
