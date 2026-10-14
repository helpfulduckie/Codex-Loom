'use strict';

const { resolveItem } = require('../../src/model/item');
const { originLocation } = require('../../src/origin');

const resolve = (def, branch = []) => resolveItem(def, new Map(), branch);

describe('aid.title and name fill each other', () => {
  test('a name with no aid.title fills aid.title from name.full', () => {
    const item = resolve({ id: 'a', name: 'Aness Rozen', aid: { type: 'Character' } });
    expect(item.aid.title).toBe('Aness Rozen');
  });

  test('a mapping name fills aid.title from its full form', () => {
    const item = resolve({ id: 'a', name: { display: 'Aness', full: 'Aness Rozen' }, aid: { type: 'Character' } });
    expect(item.aid.title).toBe('Aness Rozen');
  });

  test('an aid.title with no name fills name display and full', () => {
    const item = resolve({ id: 'a', aid: { type: 'Character', title: 'Aness Rozen' } });
    expect(item.name).toEqual({ display: 'Aness', full: 'Aness Rozen' });
  });

  test('a numeric aid.title fills name as text', () => {
    const item = resolve({ id: 'a', aid: { type: 'Character', title: 1.5 } });
    expect(item.name).toEqual({ display: '1.5', full: '1.5' });
  });

  test('a blank aid.title is treated as unset', () => {
    const item = resolve({ id: 'a', name: 'Aness', aid: { type: 'Character', title: '  ' } });
    expect(item.aid.title).toBe('Aness');
  });

  test('both present are left untouched', () => {
    const item = resolve({ id: 'a', name: 'Aness Rozen', aid: { type: 'Character', title: 'The Stranger' } });
    expect(item.aid.title).toBe('The Stranger');
    expect(item.name).toEqual({ display: 'Aness', full: 'Aness Rozen' });
  });

  test('neither present leaves both unset', () => {
    const item = resolve({ id: 'a', aid: { type: 'Character' } });
    expect(item.aid.title).toBeUndefined();
    expect(item.name).toBeUndefined();
  });

  test('a variant that sets only aid.title fills name on that branch only', () => {
    const def = {
      id: 'a',
      aid: { type: 'Character' },
      variants: { alt: { aid: { title: 'Felix Grayls' } } },
    };
    const registry = new Map([['a', def]]);
    const withVariant = resolveItem({ import: 'a', importVariants: ['alt'] }, registry, []);
    const without = resolveItem({ import: 'a' }, registry, []);
    expect(withVariant.name).toEqual({ display: 'Felix', full: 'Felix Grayls' });
    expect(without.name).toBeUndefined();
  });

  test('a filled aid.title points at the authored name', () => {
    const item = resolve({ id: 'a', name: 'Aness Rozen', aid: { type: 'Character' } });
    expect(originLocation(item, ['aid', 'title'])).toEqual(originLocation(item, ['name', 'full']));
  });

  test('a filled name points at the authored aid.title', () => {
    const item = resolve({ id: 'a', aid: { type: 'Character', title: 'Aness Rozen' } });
    const authored = originLocation(item, ['aid', 'title']);
    expect(originLocation(item, ['name', 'display'])).toEqual(authored);
    expect(originLocation(item, ['name', 'full'])).toEqual(authored);
  });
});
