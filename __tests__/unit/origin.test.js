'use strict';

const {
  createOriginIndex, attachOrigins, getOrigins, originAt, nearestOrigin,
  copyOrigins, overlayOriginIndexes, remapOrigins,
} = require('../../src/origin');

const index = () => createOriginIndex([
  { file: 'items.cl.yaml', path: [], line: 1, col: 1 },
  { file: 'items.cl.yaml', path: ['body'], line: 3, col: 3 },
  { file: 'items.cl.yaml', path: ['body', 'text'], line: 4, col: 5 },
]);

test('attaches origins privately without entering authored traversal', () => {
  const item = attachOrigins({ id: 'A' }, index());
  expect(Object.keys(item)).toEqual(['id']);
  expect(JSON.stringify(item)).toBe('{"id":"A"}');
  expect(getOrigins(item)).not.toBeNull();
});

test('exact lookup returns a fresh plain origin record', () => {
  const item = attachOrigins({}, index());
  const first = originAt(item, 'body', 'text');
  expect(first).toEqual({ file: 'items.cl.yaml', path: ['body', 'text'], line: 4, col: 5 });
  first.path.push('changed');
  expect(originAt(item, 'body', 'text').path).toEqual(['body', 'text']);
  expect(originAt(item, 'missing')).toBeNull();
});

test('nearest lookup falls back through authored ancestors', () => {
  const item = attachOrigins({}, index());
  expect(nearestOrigin(item, 'body', 'missing')).toMatchObject({ path: ['body'], line: 3 });
  expect(nearestOrigin(item, 'missing')).toMatchObject({ path: [], line: 1 });
});

test('a runtime key path retains the overriding authored spelling', () => {
  const table = attachOrigins({}, createOriginIndex([
    { file: 'project.cl.yaml', path: ['fields', 'appearance'], keyPath: ['fields', 'Appearance'], line: 3, col: 3 },
  ]));
  expect(originAt(table, 'fields', 'Appearance')).toEqual({
    file: 'project.cl.yaml', path: ['fields', 'appearance'], line: 3, col: 3,
  });
  expect(originAt(table, 'fields', 'appearance')).toBeNull();
});

test('copying preserves a private independent index', () => {
  const source = attachOrigins({}, index());
  const target = copyOrigins(source, { id: 'copy' });
  expect(originAt(target, 'body')).toEqual(originAt(source, 'body'));
  expect(Object.keys(target)).toEqual(['id']);
  expect(getOrigins(target)).not.toBe(getOrigins(source));
});

test('remapping an origin subtree changes runtime keys and retains authored paths', () => {
  const item = attachOrigins({}, createOriginIndex([
    { file: 'item.yaml', path: ['Render'], line: 2 },
    { file: 'item.yaml', path: ['Render', 'Template'], line: 3 },
    { file: 'item.yaml', path: ['Render.extra'], line: 4 },
  ]));
  remapOrigins(item, ['Render'], ['render']);
  remapOrigins(item, ['render', 'Template'], ['render', 'template']);
  expect(originAt(item, ['render', 'template'])).toMatchObject({
    path: ['Render', 'Template'], file: 'item.yaml', line: 3,
  });
  expect(originAt(item, ['render'])).toMatchObject({ path: ['Render'], line: 2 });
  expect(originAt(item, ['Render'])).toBeNull();
  expect(originAt(item, ['Render.extra'])).toMatchObject({ path: ['Render.extra'], line: 4 });
});

test('overlay replaces matching paths and retains untouched paths', () => {
  const over = createOriginIndex([
    { file: 'local.cl.yaml', path: ['body', 'text'], line: 8, col: 5 },
  ]);
  const item = attachOrigins({}, overlayOriginIndexes(index(), over));
  expect(originAt(item, 'body', 'text').file).toBe('local.cl.yaml');
  expect(originAt(item, 'body').file).toBe('items.cl.yaml');
});
