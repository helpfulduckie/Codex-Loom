'use strict';

/**
 * The declaration-driven emitter (v4 spec §13.2–§13.3, Phase 12 Step 1).
 *
 * The load-bearing test is byte-identity: the same item rendered through a hand-written
 * `.template` and through the field list that replaces it must produce the same string,
 * character for character — not "the declaration parsed". The fixture's `Character.template`
 * and its `Character` field-list entry are the twin.
 */

const path = require('path');

const { loadTemplates } = require('../../src/loader');
const { render } = require('../../src/template');
const { renderFieldList } = require('../../src/render/field-list');
const { itemContext } = require('../../src/util');

const BASE = path.resolve(__dirname, '../fixtures/field-table/base');

const { templates, fieldTable } = loadTemplates([BASE]);
const twin = templates.get('character').content;

function bothWays(item) {
  const ctx = itemContext(item);
  const viaTemplate = render(twin, ctx, new Map(), null, {});
  const viaFieldList = renderFieldList(fieldTable.templates.Character, fieldTable, ctx, {});
  return { viaTemplate, viaFieldList };
}

const FULL = {
  id: 'Aness',
  name: 'Aness',
  aid: { type: 'Character' },
  body: {
    name: 'Aness Grayls',
    vibe: ['warm', 'unhurried'],
    appearance: ['tall', 'greying'],
    personality: ['patient', 'stubborn'],
    abilities: 'field medicine',
    magic: { affinity: 'restoration', effect: 'mends wounds over minutes' },
    pantheon: { Sun: 'dawn rites', Moon: 'dusk rites' },
    relationships: ['mentor to Veryn', 'wary of Voss'],
    secret: 'was the one who sealed the vault',
  },
};

describe('renderFieldList', () => {
  test('a field list renders byte-identically to its .template twin (full item)', () => {
    const { viaTemplate, viaFieldList } = bothWays(FULL);
    expect(viaFieldList).toBe(viaTemplate);
    // And it is not vacuously empty.
    expect(viaFieldList).toMatch(/Magic: restoration; mends wounds over minutes/);
  });

  test('byte-identical on a sparse item (most conditionals fall away)', () => {
    const sparse = {
      id: 'X', name: 'X', aid: { type: 'Character' },
      body: { name: 'Solia', personality: ['quiet'] },
    };
    const { viaTemplate, viaFieldList } = bothWays(sparse);
    expect(viaFieldList).toBe(viaTemplate);
    expect(viaFieldList).toBe('Name: Solia\nPersonality: quiet');
  });

  test('labelWhen: originalAppearance present flips the label to "Current Appearance"', () => {
    const withOriginal = {
      id: 'Y', name: 'Y', aid: { type: 'Character' },
      body: { appearance: ['scarred'], originalAppearance: ['unmarked'] },
    };
    const { viaTemplate, viaFieldList } = bothWays(withOriginal);
    expect(viaFieldList).toBe(viaTemplate);
    expect(viaFieldList).toMatch(/^Current Appearance: scarred$/m);
  });

  test('labelWhen: originalAppearance absent leaves the plain label', () => {
    const plain = {
      id: 'Z', name: 'Z', aid: { type: 'Character' },
      body: { appearance: ['scarred'] },
    };
    const { viaFieldList } = bothWays(plain);
    expect(viaFieldList).toMatch(/^Appearance: scarred$/m);
    expect(viaFieldList).not.toMatch(/Current Appearance/);
  });

  test('block: true puts the value on its own line beneath the label', () => {
    const withPantheon = {
      id: 'P', name: 'P', aid: { type: 'Character' },
      body: { pantheon: { Sun: 'dawn', Moon: 'dusk' } },
    };
    const { viaTemplate, viaFieldList } = bothWays(withPantheon);
    expect(viaFieldList).toBe(viaTemplate);
    expect(viaFieldList).toBe('Pantheon:\n- Sun: dawn\n- Moon: dusk');
  });

  test('an { include } / { raw } entry is passed through as literal template source', () => {
    const { renderFieldList } = require('../../src/render/field-list');
    const table = { fields: { note: { label: 'Note' } }, groups: {}, templates: {} };
    const ctx = itemContext({ id: 'A', name: 'Cass', aid: { type: 'X' }, body: { note: 'hi' } });
    const out = renderFieldList(
      [{ raw: '{$name}' }, { field: 'note' }, { include: 'ghost' }], table, ctx,
      { partials: new Map([['ghost', { content: 'FOOTER', _source: 'g' }]]) },
    );
    expect(out).toBe('Cass\nNote: hi\nFOOTER');
  });

  test('a group name in a template list expands in place, in declared order', () => {
    const expanded = require('../../src/render/field-list').expandList(
      fieldTable.templates.Character, fieldTable,
    );
    expect(expanded.map((e) => e.name)).toEqual(
      ['name', 'vibe', 'appearance', 'personality', 'abilities', 'magic', 'pantheon', 'relationships', 'secret'],
    );
  });
});
