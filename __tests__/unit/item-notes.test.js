'use strict';

/**
 * `notes:` as a first-class top-level item field (v4 spec §4.5).
 *
 * §4.5 asks for four properties, and three of them were not true before Phase 2 Step 3:
 * `notes:` is variant- and branch-addressable, field ops apply to it, `description:` is
 * an accepted alias, and declaring both names on one item is an ERROR. The addressability
 * half failed because two hardcoded lists of top-level fields — one in `model/item.js`
 * for import-level overrides, one in `model/fieldops.js` for variant deltas — did not
 * mention `notes`, so a variant that set it was silently dropped.
 */

const { resolveItem } = require('../../src/model/item');
const { applyFieldsDelta } = require('../../src/model/fieldops');
const { ITEM_TOP_LEVEL_FIELDS } = require('../../src/util');

const canon = () => ({
  id: 'hero',
  name: 'Hero',
  aid: { type: 'Character', triggers: ['Hero'] },
  render: { template: 'Character' },
  body: { role: 'warrior' },
  notes: { marker: '[e]', mood: 'stoic' },
  variants: {
    grim: { notes: { mood: 'grim' } },
    silent: { notes: null },
    configured: { notes: { startTime: '9:00 PM' } },
  },
});

const registry = () => new Map([['hero', canon()]]);

describe('notes is addressable like any other top-level field', () => {
  test('the top-level field list includes notes exactly once', () => {
    expect(ITEM_TOP_LEVEL_FIELDS).toContain('notes');
    expect(new Set(ITEM_TOP_LEVEL_FIELDS).size).toBe(ITEM_TOP_LEVEL_FIELDS.length);
  });

  test('an import carries canon notes through', () => {
    const item = resolveItem({ import: 'hero' }, registry(), []);
    expect(item.notes).toEqual({ marker: '[e]', mood: 'stoic' });
  });

  test('a variant overrides one key and leaves the rest of the config alone', () => {
    // A mapping delta merges subfield-wise, the same treatment aid: and render: get.
    // This is what §4.5 means by canon defining a base config a project appends to.
    const item = resolveItem({ import: 'hero', importVariants: ['grim'] }, registry(), []);
    expect(item.notes).toEqual({ marker: '[e]', mood: 'grim' });
  });

  test('a variant adds a key without disturbing the inherited ones', () => {
    const item = resolveItem({ import: 'hero', importVariants: ['configured'] }, registry(), []);
    expect(item.notes).toEqual({ marker: '[e]', mood: 'stoic', startTime: '9:00 PM' });
  });

  test('an import-level override reaches notes', () => {
    // The model/item.js list — the one that did not mention notes, so this was dropped.
    const item = resolveItem({ import: 'hero', notes: { marker: '/]' } }, registry(), []);
    expect(item.notes).toEqual({ marker: '/]', mood: 'stoic' });
  });

  test('a branch dispatches to a variant that changes notes', () => {
    const def = { import: 'hero', branches: { dark: 'grim' } };
    expect(resolveItem(def, registry(), ['dark']).notes).toEqual({ marker: '[e]', mood: 'grim' });
    expect(resolveItem(def, registry(), ['light']).notes).toEqual({ marker: '[e]', mood: 'stoic' });
  });

  test('~ deletes notes, as it does any field', () => {
    const item = resolveItem({ import: 'hero', importVariants: ['silent'] }, registry(), []);
    expect(item.notes).toBeUndefined();
  });
});

describe('field ops apply to notes', () => {
  test('a subfield swap rewrites one value in place', () => {
    const item = { id: 'a', notes: { marker: '[e]', mood: 'clinical' } };
    applyFieldsDelta(item, { notes: { mood: '/{clinical}/{warm}' } });
    expect(item.notes).toEqual({ marker: '[e]', mood: 'warm' });
  });

  test('~ on a subfield deletes just that key', () => {
    const item = { id: 'a', notes: { marker: '[e]', mood: 'clinical' } };
    applyFieldsDelta(item, { notes: { mood: null } });
    expect(item.notes).toEqual({ marker: '[e]' });
  });

  test('a scalar notes value is replaced outright', () => {
    const item = { id: 'a', notes: '[e]' };
    applyFieldsDelta(item, { notes: '/]' });
    expect(item.notes).toBe('/]');
  });
});

describe('description is an accepted alias', () => {
  test('description on an item resolves to notes', () => {
    const item = resolveItem({ id: 'a', description: '[e]' }, new Map(), []);
    expect(item.notes).toBe('[e]');
    expect(item.description).toBeUndefined();
  });

  test('a variant may write description against an item that declared notes', () => {
    const item = { id: 'a', notes: '[e]' };
    applyFieldsDelta(item, { description: '/]' });
    expect(item.notes).toBe('/]');
    expect(item.description).toBeUndefined();
  });

  test('declaring both names on one item is an ERROR', () => {
    const seen = [];
    const item = resolveItem(
      { id: 'a', notes: '[e]', description: '/]' },
      new Map(), [], (code, message) => seen.push({ code, message }),
    );
    const finding = seen.find((d) => d.code === 'CL0323');
    expect(finding).toBeDefined();
    expect(finding.message).toContain('"notes"');
    expect(finding.message).toContain('"description"');
    // The declared `notes:` wins, so output stays deterministic while the author fixes it.
    expect(item.notes).toBe('[e]');
  });

  test('one name alone raises nothing', () => {
    const seen = [];
    resolveItem({ id: 'a', description: '[e]' }, new Map(), [], (c) => seen.push(c));
    expect(seen).not.toContain('CL0323');
  });
});
