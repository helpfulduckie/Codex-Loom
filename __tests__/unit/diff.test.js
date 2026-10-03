'use strict';

const {
  buildSharedAndDeltas,
  buildLeafAnnotation,
  buildAnnotationGroups,
  buildAnnotationReport,
  flattenItem,
  diffFlattened,
  collectDeltaKeyPaths,
} = require('../../src/diff');
const { ItemRegistry } = require('../../src/loader/registry');

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

describe('buildAnnotationGroups', () => {
  const registry = new Map();
  const leafAt = label => ({ label, fileBase: label, branchPath: label.split('/') });

  test('merges identical complete records and preserves branch input order', () => {
    const def = { id: 'hero', body: { mood: 'calm' }, variants: { storm: { body: { mood: 'wild' } } },
      branches: { a: 'storm', b: 'storm' } };
    const result = buildAnnotationGroups([leafAt('b'), leafAt('a')], [def], registry);
    expect(result).toHaveLength(1);
    expect(result[0].groups).toEqual([{
      status: 'resolved',
      changes: [{ path: 'body.mood', base: JSON.stringify('calm'), leaf: JSON.stringify('wild'), explainers: ['storm'] }],
      branches: [
        { label: 'b', fileBase: 'b', branchPath: ['b'], variants: ['storm'] },
        { label: 'a', fileBase: 'a', branchPath: ['a'], variants: ['storm'] },
      ],
    }]);
  });

  test('retains applied variants with no change and omits shared unchanged items', () => {
    const def = { id: 'hero', body: { mood: 'calm' }, variants: { quiet: {} },
      branches: { a: 'quiet', b: [] } };
    const result = buildAnnotationGroups([leafAt('a'), leafAt('b')], [def], registry);
    expect(result[0].groups).toHaveLength(1);
    expect(result[0].groups[0]).toMatchObject({ status: 'resolved', changes: [],
      branches: [{ label: 'a', variants: ['quiet'] }] });
    expect(buildAnnotationGroups([leafAt('b')], [def], registry)).toEqual([]);
  });

  test('preserves null dispatch and absent and removed field markers', () => {
    const nulled = { id: 'gone', branches: { a: null }, body: { x: 'y' } };
    const changed = { id: 'fields', body: { old: 'x' }, variants: { edit: { body: { old: null, added: 'y' } } },
      branches: { a: 'edit' } };
    const groups = buildAnnotationGroups([leafAt('a')], [nulled, changed], registry);
    expect(groups[0].groups[0]).toMatchObject({ status: 'nulled', changes: [], branches: [{ variants: [] }] });
    expect(groups[1].groups[0].changes).toEqual([
      { path: 'body.added', base: '(absent)', leaf: JSON.stringify('y'), explainers: ['edit'] },
      { path: 'body.old', base: JSON.stringify('x'), leaf: '(removed)', explainers: ['edit'] },
    ]);
  });

  test('report shows item headings, branch membership, variants, and field values', () => {
    const def = { id: 'hero', body: { mood: 'calm' }, variants: { storm: { body: { mood: 'wild' } } },
      branches: { a: 'storm' } };
    const report = buildAnnotationReport([leafAt('a')], [def], registry, 'Sample');
    expect(report).toContain('# Annotations: Sample');
    expect(report).toContain('## hero');
    expect(report).toContain('### Resolved');
    expect(report).toContain('Variants `storm`: a');
    expect(report).toContain('base: "calm"');
    expect(report).toContain('leaf: "wild"');
  });

  test('import comparisons use the project body override as the base', () => {
    const registry = new ItemRegistry();
    registry.set('canon', { id: 'canon', body: { mood: 'canon' }, variants: {} });
    const def = { id: 'hero', import: 'canon', body: { mood: 'project' },
      variants: { leaf: { body: { mood: 'branch' } } }, branches: { a: 'leaf' } };
    const changes = buildAnnotationGroups([leafAt('a')], [def], registry)[0].groups[0].changes;
    expect(changes).toEqual([{
      path: 'body.mood', base: JSON.stringify('project'), leaf: JSON.stringify('branch'), explainers: ['leaf'],
    }]);
  });

  test('include variants are part of the project base before branch dispatch', () => {
    const def = { id: 'hero', body: { mood: 'original' },
      variants: { included: { body: { mood: 'included' } }, leaf: { body: { mood: 'leaf' } } },
      _include_variants: ['included'], _include_branch_spec: { a: 'leaf' } };
    const group = buildAnnotationGroups([leafAt('a')], [def], registry)[0].groups[0];
    expect(group.branches[0].variants).toEqual(['leaf']);
    expect(group.changes).toEqual([{
      path: 'body.mood', base: JSON.stringify('included'), leaf: JSON.stringify('leaf'), explainers: ['leaf'],
    }]);
  });

  test('arrays and nested paths remain atomic and retain sorted path order', () => {
    const def = { id: 'hero', body: { nested: { value: 'base' } }, aid: { triggers: ['one'] },
      variants: { edit: { body: { nested: { value: 'leaf' } }, aid: { triggers: ['one', 'two'] } } },
      branches: { a: 'edit' } };
    const changes = buildAnnotationGroups([leafAt('a')], [def], registry)[0].groups[0].changes;
    expect(changes.map(({ path }) => path)).toEqual(['aid.triggers', 'body.nested.value']);
    expect(changes[0]).toMatchObject({ base: JSON.stringify(['one']), leaf: JSON.stringify(['one', 'two']) });
    expect(changes[1]).toMatchObject({ base: JSON.stringify('base'), leaf: JSON.stringify('leaf') });
  });

  test('wildcard selections precede exact selections, and equal values with different explainers stay separate', () => {
    const def = { id: 'hero', body: { mood: 'base' },
      variants: {
        common: { body: { mood: 'same' } }, exact: { body: { mood: 'same' } },
        alpha: { body: { mood: 'same' } }, beta: { body: { mood: 'same' } },
      }, branches: { '*': 'common', a: 'exact', b: 'alpha', c: 'beta' } };
    const groups = buildAnnotationGroups([leafAt('a'), leafAt('b'), leafAt('c')], [def], registry)[0].groups;
    expect(groups).toHaveLength(3);
    expect(groups[0].branches[0].variants).toEqual(['common', 'exact']);
    expect(groups[0].changes[0]).toMatchObject({ leaf: JSON.stringify('same'), explainers: ['common', 'exact'] });
    expect(groups.slice(1).map(group => group.changes[0].explainers)).toEqual([['common', 'alpha'], ['common', 'beta']]);
    expect(groups.slice(1).map(group => group.branches[0].label)).toEqual(['b', 'c']);
  });

  test('merges equal field records despite irrelevant variant differences and retains each branch list', () => {
    const def = { id: 'hero', body: { mood: 'base' },
      variants: {
        anchor: { body: { mood: 'same' } }, irrelevant: { render: { storyCard: false } },
        plain: { render: { storyCard: true } },
      },
      branches: { a: ['anchor', 'irrelevant'], b: ['anchor', 'plain'] } };
    const groups = buildAnnotationGroups([leafAt('a'), leafAt('b')], [def], registry)[0].groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].changes).toEqual([{
      path: 'body.mood', base: JSON.stringify('base'), leaf: JSON.stringify('same'), explainers: ['anchor'],
    }]);
    expect(groups[0].branches.map(branch => branch.variants)).toEqual([
      ['anchor', 'irrelevant'], ['anchor', 'plain'],
    ]);
  });

  test('merges no-change records with different variants and renders each application list', () => {
    const def = { id: 'hero', body: { mood: 'calm' },
      variants: { quiet: {}, still: {} }, branches: { a: 'quiet', b: 'still' } };
    const data = [leafAt('a'), leafAt('b')];
    const groups = buildAnnotationGroups(data, [def], registry)[0].groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].branches.map(branch => branch.variants)).toEqual([['quiet'], ['still']]);
    const report = buildAnnotationReport(data, [def], registry, 'Sample');
    expect(report).toContain('Variants `quiet`: a');
    expect(report).toContain('Variants `still`: b');
    expect(report.match(/produced no field change/g)).toHaveLength(1);
  });

  test('controlled resolver deltas without a matching variant path are marked unexplained', () => {
    jest.isolateModules(() => {
      jest.doMock('../../src/model/item', () => ({
        resolveItem: (_def, _registry, branchPath) => ({ body: { mood: branchPath.length ? 'leaf' : 'base' } }),
        collectVariantDeltas: () => [],
      }));
      const { buildAnnotationGroups: mockedGroups } = require('../../src/diff');
      const def = { id: 'hero', branches: { a: 'v' } };
      const groups = mockedGroups([leafAt('a')], [def], registry);
      expect(groups[0].groups[0].changes[0].explainers).toEqual([]);
      jest.dontMock('../../src/model/item');
    });
  });
});
