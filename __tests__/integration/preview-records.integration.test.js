'use strict';

/** The preview records that describe a project around its items, and `comparePreviews`. */

const path = require('path');
const { withTmpDir, writeTree } = require('../helpers/project');
const { PROJECTS, CONFIG_NAME } = require('../../examples/projects');

const { preview, comparePreviews } = require('../../src/compile');

const LIBRARY = [
  '- id: Hero',
  '  name: Hero',
  '  aid: {type: Item, title: Hero}',
  '  render: {template: Item}',
  '  body: {Desc: library hero, Rank: captain}',
  '- id: Spare',
  '  name: Spare',
  '  aid: {type: Item, title: Spare}',
  '  render: {template: Item}',
  '  body: {Desc: never imported, Rank: none}',
].join('\n');

const FILES = {
  'templates/Item.template': '{$body.Desc}/{$body.Rank}',
  'library/lib.yaml': LIBRARY,
  'items/items.yaml': [
    '- import: core:Hero',
    '  body: {Desc: project hero, Motto: onward}',
    '  branches: {A: {branches: {x: bold}}}',
    '  variants:',
    '    bold: {body: {Desc: bold hero}}',
    '- id: Sidekick',
    '  name: Sidekick',
    '  aid: {type: Item, title: Sidekick}',
    '  render: {template: Item, plotEssential: {slot: party}}',
    '  body: {Desc: side, Rank: squire}',
    '  branches: {B: ~}',
    '- id: Ghost',
    '  name: Ghost',
    '  aid: {type: Item, title: Ghost}',
    '  render: {template: Item}',
    '  body: {Desc: pale, Rank: none}',
    '  branches: {B: gone}',
    '  variants:',
    '    gone: ~',
  ].join('\n'),
  'components/pe.yaml': [
    'sections:',
    '  intro:',
    "    text: 'Set in {%place}.'",
    '    render: {position: 1}',
    '  party:',
    '    slot: true',
    '    render: {position: 2, wrapper: curly}',
    '    branches: {A: {branches: {y: tight}}}',
    '    variants:',
    '      tight: {render: {wrapper: square}}',
    '  extras:',
    '    slot: true',
    '    render: {position: 3}',
    '  secret:',
    '    text: hidden',
    '    branches: {A: {branches: {y: ~}}}',
    '    render: {position: 4}',
  ].join('\n'),
  'components/pe-b.yaml': [
    'imports:',
    '  - from: %TMP%/components/pe.yaml',
    'sections:',
    '  intro:',
    '    render: {position: 9}',
  ].join('\n'),
  'compile.yaml': [
    'version: 4',
    'structure:',
    '  input:',
    '    items: [%TMP%/items]',
    '    library: {core: %TMP%/library}',
    '    templates: [%TMP%/templates]',
    '  output: %TMP%/output',
    'variables:',
    '  place: Harbor',
    "  greeting: 'Welcome to {%place}'",
    'roles:',
    '  guide: Hero',
    'components:',
    '  plotEssential: %TMP%/components/pe.yaml',
    'branches:',
    '  A:',
    '    variables: {place: Summit}',
    '    branches:',
    '      x: {}',
    '      y:',
    '        roles: {guide: Sidekick}',
    '  B:',
    '    components:',
    '      plotEssential: %TMP%/components/pe-b.yaml',
  ].join('\n'),
};

function project() {
  const dir = withTmpDir();
  writeTree(dir, FILES);
  return {
    dir,
    config: path.join(dir, 'compile.yaml'),
    file: (rel) => path.join(dir, ...rel.split('/')),
  };
}

const leafOf = (result, label) => result.leaves.find((leaf) => leaf.label === label);
const itemOf = (result, label, id) => leafOf(result, label).items
  .map((index) => result.items[index]).find((item) => item.id === id);
const fieldOf = (item, dotted) => item.fields.find((field) => field.path.join('.') === dotted);
const baseOf = (result, at) => path.basename(result.sourceFiles[at.file]);
// Bindings, sections and output files are tables; these read a leaf's entries through them.
const contextOf = (result, label) => {
  const { variables, roles } = leafOf(result, label).context;
  const rows = (indexes) => indexes.map((index) => result.bindings[index]);
  return { variables: rows(variables), roles: rows(roles) };
};
const componentOf = (result, label, key) => {
  const component = leafOf(result, label).components[key];
  return {
    ...component,
    sections: component.sections.map((index) => result.sections[index]),
    output: result.outputs[component.output],
  };
};

describe('preview records around the items', () => {
  let proj;
  let result;
  beforeAll(() => {
    proj = project();
    result = preview(proj.config);
  });

  test('the result compiles and survives a JSON round trip', () => {
    expect(result.status).toBe('ok');
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test('project names the config and the directories it resolves to', () => {
    expect(result.project).toEqual({
      config: proj.config,
      title: null,
      base: proj.dir,
      items: [proj.file('items')],
      templates: [proj.file('templates')],
      output: proj.file('output'),
      reports: null,
      snapshot: null,
    });
  });

  test('branches is the branch tree with a path on every node', () => {
    expect(result.branches).toEqual([
      {
        name: 'A', branchPath: ['A'], leaf: false, children: [
          { name: 'x', branchPath: ['A', 'x'], leaf: true, children: [] },
          { name: 'y', branchPath: ['A', 'y'], leaf: true, children: [] },
        ],
      },
      { name: 'B', branchPath: ['B'], leaf: true, children: [] },
    ]);
  });

  test('libraries lists every library item and whether the project imports it', () => {
    expect(result.libraries).toHaveLength(1);
    const [core] = result.libraries;
    expect(core).toMatchObject({ name: 'core', frozen: false });
    expect(core.files).toHaveLength(1);
    expect(baseOf(result, core.files[0])).toBe('lib.yaml');
    expect(core.files[0].items).toEqual([
      expect.objectContaining({ id: 'Hero', name: 'Hero', line: 1, imported: true }),
      expect.objectContaining({ id: 'Spare', name: 'Spare', line: 6, imported: false }),
    ]);
  });

  test('an imported item names its library definition and the project entry that imports it', () => {
    const hero = itemOf(result, 'A/x', 'Hero');
    expect(hero.definition).toMatchObject({ line: 1, library: 'core' });
    expect(baseOf(result, hero.definition)).toBe('lib.yaml');
    expect(hero.importedAt).toMatchObject({ line: 1, library: null });
    expect(baseOf(result, hero.importedAt)).toBe('items.yaml');

    const sidekick = itemOf(result, 'A/x', 'Sidekick');
    expect(sidekick.definition).toMatchObject({ line: 6, library: null });
    expect(sidekick.importedAt).toBeNull();
  });

  test('a layer names where the value it replaced was authored', () => {
    const layers = fieldOf(itemOf(result, 'A/x', 'Hero'), 'body.Desc').layers;
    expect(layers.map((layer) => layer.kind)).toEqual(['project', 'project-variant']);
    expect(layers[0]).toMatchObject({ before: 'library hero', beforeAbsent: false });
    expect(layers[0].beforeOrigin).toMatchObject({ line: 5, library: 'core' });
    expect(baseOf(result, layers[0].beforeOrigin)).toBe('lib.yaml');
    expect(layers[1]).toMatchObject({ before: 'project hero', beforeAbsent: false });
    expect(layers[1].beforeOrigin).toMatchObject({ line: 2, library: null });
  });

  test('a layer that adds a field says the field was absent before it', () => {
    const [layer] = fieldOf(itemOf(result, 'A/x', 'Hero'), 'body.Motto').layers;
    expect(layer).toMatchObject({ before: null, beforeAbsent: true, beforeOrigin: null });
  });

  test('a leaf lists the items excluded on it, with the reason and the key that excluded them', () => {
    expect(leafOf(result, 'A/x').excluded).toEqual([]);
    const excluded = leafOf(result, 'B').excluded;
    expect(excluded).toEqual([
      expect.objectContaining({ id: 'Sidekick', reason: 'branches', variant: null }),
      expect.objectContaining({ id: 'Ghost', reason: 'variant', variant: 'gone' }),
    ]);
    expect(excluded[0].at).toMatchObject({ line: 11 });
    expect(baseOf(result, excluded[0].at)).toBe('items.yaml');
  });

  test('context gives each variable its bindings from the root down and its resolved text', () => {
    const { variables } = contextOf(result, 'A/x');
    const place = variables.find((row) => row.name === 'place');
    expect(place).toMatchObject({ value: 'Summit', resolved: 'Summit', bound: true, derived: false });
    expect(place.layers).toEqual([
      expect.objectContaining({ branchPath: [], before: null, after: 'Harbor', removed: false }),
      expect.objectContaining({ branchPath: ['A'], before: 'Harbor', after: 'Summit', removed: false }),
    ]);
    expect(place.layers[0].at).toMatchObject({ line: 9 });
    expect(place.layers[1].at).toMatchObject({ line: 17 });

    const greeting = variables.find((row) => row.name === 'greeting');
    expect(greeting).toMatchObject({ value: 'Welcome to {%place}', resolved: 'Welcome to Summit' });
    expect(contextOf(result, 'B').variables.find((row) => row.name === 'greeting').resolved)
      .toBe('Welcome to Harbor');
  });

  test('context marks a variable the compiler supplies as derived', () => {
    const core = contextOf(result, 'B').variables.find((row) => row.name === 'core');
    expect(core).toMatchObject({ derived: true, layers: [], resolved: proj.file('library') });
  });

  test('context gives each role its bindings and the item it resolves to', () => {
    const [guide] = contextOf(result, 'A/y').roles;
    expect(guide).toMatchObject({ name: 'guide', value: 'Sidekick', resolved: 'Sidekick' });
    expect(guide.layers.map((layer) => [layer.branchPath, layer.after])).toEqual([
      [[], 'Hero'], [['A', 'y'], 'Sidekick'],
    ]);
    expect(contextOf(result, 'A/x').roles[0]).toMatchObject({ resolved: 'Hero' });
  });

  test('a binding that is the same on several leaves is held once', () => {
    const greeting = (label) => leafOf(result, label).context.variables
      .find((index) => result.bindings[index].name === 'greeting');
    expect(greeting('A/x')).toBe(greeting('A/y'));
    expect(greeting('A/x')).not.toBe(greeting('B'));
  });
});

describe('preview component records', () => {
  let result;
  const pe = (label) => componentOf(result, label, 'plotEssential');
  const section = (label, name) => pe(label).sections.find((s) => s.name === name);
  beforeAll(() => { result = preview(project().config); });

  test('a component names the branch node whose components entry selects it', () => {
    expect(pe('A/x').selectedOn).toEqual([]);
    expect(pe('A/x').selectedAt).toMatchObject({ line: 14 });
    expect(pe('B').selectedOn).toEqual(['B']);
    expect(pe('B').selectedAt).toMatchObject({ line: 24 });
  });

  test('a component names the output file the leaf reads and the node that owns it', () => {
    expect(pe('A/x').output).toEqual({
      path: 'Branches/A/Branches/x/Components/Plot Essentials.md', branchPath: ['A', 'x'],
    });
    const paths = new Set(result.files.map((file) => file.path));
    for (const leaf of result.leaves) expect(paths.has(pe(leaf.label).output.path)).toBe(true);
  });

  test('a section that is the same on several leaves is held once', () => {
    const extras = (label) => leafOf(result, label).components.plotEssential.sections
      .find((index) => result.sections[index].name === 'extras');
    expect(extras('A/x')).toBe(extras('A/y'));
  });

  test('sections come in render order with their state on the leaf', () => {
    expect(pe('A/x').sections.map((s) => [s.name, s.state])).toEqual([
      ['intro', 'rendered'], ['party', 'rendered'], ['extras', 'empty'], ['secret', 'rendered'],
    ]);
    expect(section('A/y', 'secret')).toMatchObject({ state: 'gated', text: null });
    expect(section('B', 'party')).toMatchObject({ state: 'empty', occupants: [] });
    expect(pe('B').sections.map((s) => s.name)).toEqual(['party', 'extras', 'secret', 'intro']);
  });

  test('a slot lists its occupants with the text each contributes', () => {
    expect(section('A/x', 'party')).toMatchObject({
      slot: true,
      occupants: [{ id: 'Sidekick', order: 5, template: 'Item', text: 'side/squire' }],
    });
    expect(section('A/x', 'intro')).toMatchObject({ slot: false, text: 'Set in Summit.' });
  });

  test('a setting an importing component overrides names the importing file, and the section its own', () => {
    const intro = section('B', 'intro');
    expect(baseOf(result, intro.source)).toBe('pe.yaml');
    const position = intro.settings.find((s) => s.path.join('.') === 'render.position');
    expect(position).toMatchObject({ value: 9 });
    expect(baseOf(result, position.origin)).toBe('pe-b.yaml');
    const wrap = intro.settings.find((s) => s.path.join('.') === 'render.wrap');
    expect(wrap).toMatchObject({ value: 'each', origin: null });
  });

  const setting = (label, name, dotted) => section(label, name).settings
    .find((s) => s.path.join('.') === dotted);
  const layersOf = (s) => s.layers.map((layer) => [baseOf(result, layer.at), layer.variant, layer.value]);

  test('a setting an importing component overrides lists the imported value before its own', () => {
    expect(layersOf(setting('B', 'intro', 'render.position'))).toEqual([
      ['pe.yaml', null, 1], ['pe-b.yaml', null, 9],
    ]);
    expect(setting('B', 'intro', 'render.position').layers[0].at).toMatchObject({ line: 4 });
  });

  test('a setting a section variant changes on the leaf lists the variant after the declaration', () => {
    expect(setting('A/y', 'party', 'render.wrapper')).toMatchObject({ value: 'square' });
    expect(layersOf(setting('A/y', 'party', 'render.wrapper'))).toEqual([
      ['pe.yaml', null, 'curly'], ['pe.yaml', 'tight', 'square'],
    ]);
  });

  test('a setting only one record writes has no layers', () => {
    expect(setting('A/x', 'intro', 'render.position').layers).toEqual([]);
    expect(setting('A/x', 'party', 'render.wrapper')).toMatchObject({ value: 'curly', layers: [] });
  });
});

describe('preview card files', () => {
  test('a card names the file its leaf reads it from, at the node that owns it', () => {
    const result = preview(project().config);
    const fileOf = (label, name) => {
      const leaf = leafOf(result, label);
      return result.outputs[leaf.cardFiles[leaf.cards.findIndex((index) => result.cards[index].name === name)]];
    };
    expect(fileOf('A/x', 'Hero')).toEqual({
      path: 'Branches/A/Branches/x/Story Cards/Item/Item.md', branchPath: ['A', 'x'],
    });
    expect(fileOf('B', 'Hero')).toEqual({ path: 'Story Cards/Item/Item.md', branchPath: [] });
    expect(fileOf('A/y', 'Sidekick')).toEqual({
      path: 'Branches/A/Story Cards/Item/Item.md', branchPath: ['A'],
    });
  });

  test.each(PROJECTS.map((p) => p.dir))('every card of %s is in the file its leaf names', (dir) => {
    const result = preview(path.resolve(__dirname, '../../examples', dir, CONFIG_NAME), { live: true });
    expect(result.status).toBe('ok');
    const content = new Map(result.files.map((file) => [file.path, file.content]));
    let checked = 0;
    for (const leaf of result.leaves) {
      expect(leaf.cardFiles).toHaveLength(leaf.cards.length);
      leaf.cards.forEach((index, i) => {
        expect(content.get(result.outputs[leaf.cardFiles[i]].path)).toContain(result.cards[index].rendered);
        checked += 1;
      });
      for (const component of Object.values(leaf.components)) {
        expect(content.has(result.outputs[component.output].path)).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('preview of a blocked project', () => {
  test('the records around the items are empty', () => {
    const proj = project();
    const result = preview(proj.config, { sources: { [proj.file('items/items.yaml')]: '- [unclosed' } });
    expect(result.status).toBe('blocked');
    expect(result).toMatchObject({
      project: null, branches: [], libraries: [], sections: [], bindings: [], outputs: [],
    });
  });
});

describe('comparePreviews', () => {
  let proj;
  let base;
  const withLibrary = (text) => preview(proj.config, { sources: { [proj.file('library/lib.yaml')]: text } });
  beforeAll(() => {
    proj = project();
    base = preview(proj.config);
  });

  test('a preview compared with itself differs in nothing', () => {
    const diff = comparePreviews(base, base);
    expect(diff.status).toBe('ok');
    expect(diff.leaves.map((leaf) => [leaf.a, leaf.b])).toEqual([['A/x', 'A/x'], ['A/y', 'A/y'], ['B', 'B']]);
    for (const leaf of diff.leaves) {
      expect(leaf).toMatchObject({ items: [], cards: [], components: [] });
    }
    expect(diff).toMatchObject({ items: [], libraries: [], unpaired: { a: [], b: [] } });
  });

  test('a library edit that reaches a card is counted on the item and marked as reaching output', () => {
    const diff = comparePreviews(base, withLibrary(LIBRARY.replace('captain', 'major')));
    expect(diff.items).toEqual([
      { id: 'Hero', outputLeaves: [['A/x', 'A/x'], ['A/y', 'A/y'], ['B', 'B']], fieldLeaves: [] },
    ]);
    expect(diff.leaves[0].items).toEqual([
      { id: 'Hero', change: 'changed', fields: [['body', 'Rank']], output: true },
    ]);
    expect(diff.leaves[0].cards).toEqual([
      { name: 'Hero', type: 'Item', itemId: 'Hero', change: 'changed' },
    ]);
    expect(diff.libraries).toEqual([
      expect.objectContaining({
        library: 'core', id: 'Hero', change: 'changed', imported: true,
        compiledAs: ['hero'], reachesOutput: true,
      }),
    ]);
    expect(diff.files.changed).toContain('Story Cards/Item/Item.md');
  });

  test('a library edit the project overrides or never imports changes no item and reaches nothing', () => {
    const edited = LIBRARY.replace('library hero', 'library champion').replace('never imported', 'still unused');
    const diff = comparePreviews(base, withLibrary(edited));
    expect(diff.items).toEqual([]);
    expect(diff.libraries).toEqual([
      expect.objectContaining({ id: 'Hero', change: 'changed', imported: true, reachesOutput: false }),
      expect.objectContaining({ id: 'Spare', change: 'changed', imported: false, compiledAs: [], reachesOutput: false }),
    ]);
  });

  test('a field change that moves no output is listed apart from one that does', () => {
    const items = proj.file('items/items.yaml');
    const edited = FILES['items/items.yaml'].replace('Motto: onward', 'Motto: forward');
    const diff = comparePreviews(base, preview(proj.config, { sources: { [items]: edited } }));
    expect(diff.items).toEqual([
      { id: 'Hero', outputLeaves: [], fieldLeaves: [['A/x', 'A/x'], ['A/y', 'A/y'], ['B', 'B']] },
    ]);
  });

  test('two leaves of one preview compare through pairs', () => {
    const diff = comparePreviews(base, base, { pairs: [['A/x', 'B']] });
    expect(diff.unpaired).toEqual({ a: ['A/y', 'B'], b: ['A/x', 'A/y'] });
    const [leaf] = diff.leaves;
    expect(leaf.items).toEqual(expect.arrayContaining([
      { id: 'Hero', change: 'changed', fields: [['body', 'Desc']], output: true },
      { id: 'Sidekick', change: 'removed', fields: [], output: true },
      { id: 'Ghost', change: 'removed', fields: [], output: true },
    ]));
    expect(leaf.cards).toEqual(expect.arrayContaining([
      { name: 'Sidekick', type: 'Item', itemId: 'Sidekick', change: 'removed' },
    ]));
    expect(leaf.components).toEqual([{
      key: 'plotEssential', change: 'changed',
      sections: [{ name: 'intro', change: 'changed' }, { name: 'party', change: 'changed' }],
    }]);
  });

  test('a blocked preview on either side blocks the comparison', () => {
    const blocked = preview(proj.config, { sources: { [proj.file('items/items.yaml')]: '- [unclosed' } });
    expect(comparePreviews(base, blocked).status).toBe('blocked');
  });
});
