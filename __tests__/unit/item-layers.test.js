'use strict';

const { resolveItem } = require('../../src/model/item');
const { parseYaml } = require('../../src/loader/yaml');
const { attachOrigins } = require('../../src/origin');

function authored(text, file) {
  const { value, sourceMap } = parseYaml(text, file);
  return attachOrigins({ ...value, _source: file }, sourceMap.exportOrigins());
}

const lines = (...rows) => rows.join('\n');
const at = (item, ...path) => item._layers.filter((e) => e.path.join('.') === path.join('.'));

const localFox = lines(
  'id: Fox',
  'name: {display: Fox, full: Fox Vale}',
  'aid: {type: Character}',
  'body:',
  '  mood: calm',
  '  likes: tea',
  'branches: {main: wild}',
  'variants:',
  '  wild:',
  '    mood: wild',
  '    likes: +{coffee}',
);

describe('layer record for a project-local item', () => {
  test('a branch variant records one project-variant entry per field it writes', () => {
    const def = authored(localFox, 'fox.yaml');
    const item = resolveItem(def, new Map(), ['main'], null, { layers: true });
    expect(item._layers).toHaveLength(2);
    const [mood, likes] = item._layers;
    expect(mood).toMatchObject({
      path: ['body', 'mood'],
      layer: { kind: 'project-variant', name: 'wild', library: null },
      op: 'wild',
      origin: { file: 'fox.yaml', line: 10 },
      before: 'calm',
      after: 'wild',
      deleted: false,
    });
    expect(likes).toMatchObject({
      path: ['body', 'likes'],
      layer: { kind: 'project-variant', name: 'wild', library: null },
      op: '+{coffee}',
      origin: { file: 'fox.yaml', line: 11 },
      before: 'tea',
      after: ['tea', 'coffee'],
      deleted: false,
    });
  });

  test('a mapping op records only the leaves it sets, not their siblings', () => {
    const def = authored(lines(
      'id: Fox',
      'name: {display: Fox, full: Fox Vale}',
      'aid: {type: Character}',
      'branches: {main: wild}',
      'variants:',
      '  wild:',
      '    name: {display: Vix}',
    ), 'fox.yaml');
    const item = resolveItem(def, new Map(), ['main'], null, { layers: true });
    expect(item._layers).toHaveLength(1);
    expect(item._layers[0]).toMatchObject({
      path: ['name', 'display'], before: 'Fox', after: 'Vix', op: 'Vix',
    });
    expect(at(item, 'name', 'full')).toHaveLength(0);
  });

  test('a variant that deletes a field records deleted with no after value', () => {
    const def = authored(localFox.replace('    mood: wild\n    likes: +{coffee}', '    mood: ~'), 'fox.yaml');
    const item = resolveItem(def, new Map(), ['main'], null, { layers: true });
    expect(item._layers).toHaveLength(1);
    expect(item._layers[0]).toMatchObject({
      path: ['body', 'mood'], op: null, before: 'calm', deleted: true,
    });
    expect(item._layers[0].after).toBeUndefined();
    expect(item.body.mood).toBeUndefined();
  });

  test('two variants on one leaf record in application order and the value is the last after', () => {
    const def = authored(lines(
      'id: Fox',
      'name: Fox',
      'aid: {type: Character}',
      'body: {mood: calm}',
      'branches: {main: [one, two]}',
      'variants:',
      '  one: {mood: first}',
      '  two: {mood: second}',
    ), 'fox.yaml');
    const item = resolveItem(def, new Map(), ['main'], null, { layers: true });
    const entries = at(item, 'body', 'mood');
    expect(entries.map((e) => e.layer.name)).toEqual(['one', 'two']);
    expect(entries.map((e) => e.after)).toEqual(['first', 'second']);
    expect(entries[1].before).toBe('first');
    expect(item.body.mood).toBe(entries[1].after);
  });
});

describe('layer record for an imported item', () => {
  const libraryText = lines(
    'id: Hero',
    'name: Hero Vale',
    'aid: {type: Character}',
    'body:',
    '  changed: red fox',
    'variants:',
    '  seed:',
    '    body: {changed: seed}',
  );
  const localText = lines(
    'import: Hero',
    'importVariants: seed',
    'body: {changed: project}',
    'branches: {main: local}',
    'variants:',
    '  local:',
    '    body: {changed: branch}',
  );

  test('library variant, project override and project variant layer in that order', () => {
    const library = authored(libraryText, 'library.yaml');
    library._canonSource = 'lib/set.yaml';
    const local = authored(localText, 'project.yaml');
    const item = resolveItem(local, new Map([['hero', library]]), ['main'], null, { layers: true });
    const entries = at(item, 'body', 'changed');
    expect(entries.map((e) => e.layer)).toEqual([
      { kind: 'library-variant', name: 'seed', library: 'lib/set.yaml' },
      { kind: 'project', name: null, library: null },
      { kind: 'project-variant', name: 'local', library: null },
    ]);
    expect(entries.map((e) => e.after)).toEqual(['seed', 'project', 'branch']);
    expect(entries[0].before).toBe('red fox');
    expect(entries[1].before).toBe(entries[0].after);
    expect(entries[2].before).toBe(entries[1].after);
    expect(entries[0].origin).toMatchObject({ file: 'library.yaml', line: 8 });
    expect(entries[1].origin).toMatchObject({ file: 'project.yaml', line: 3 });
    expect(entries[2].origin).toMatchObject({ file: 'project.yaml', line: 7 });
  });
});

describe('layer option', () => {
  const resolveBoth = () => {
    const def = authored(localFox, 'fox.yaml');
    return {
      off: resolveItem(def, new Map(), ['main']),
      on: resolveItem(def, new Map(), ['main'], null, { layers: true }),
    };
  };

  test('without the option no _layers property exists and the item is otherwise identical', () => {
    const { off, on } = resolveBoth();
    expect(Object.prototype.hasOwnProperty.call(off, '_layers')).toBe(false);
    expect(on).toEqual(off);
  });

  test('_layers stays out of enumeration and serialization', () => {
    const { on } = resolveBoth();
    expect(Object.keys(on)).not.toContain('_layers');
    expect(JSON.stringify(on)).not.toContain('_layers');
    expect(Array.isArray(on._layers)).toBe(true);
  });
});
