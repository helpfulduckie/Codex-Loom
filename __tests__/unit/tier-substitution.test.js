'use strict';

/**
 * Same-label substitution in a terse tier list (v4 spec §13.4, Decision 1 / Decision 2).
 *
 * A terse list may swap a full-length field for a shorter same-label sibling: `background`
 * (a paragraph) becomes `backgroundBrief` (a sentence), both declared with `label:
 * Background`. The corpus-wide guard (`tier-correctness.test.js`) proves such a swap is
 * *sanctioned* — declared, same label, no invented field. This test proves the swap
 * actually renders the shorter value: it is a property of one field declaration and one
 * item, not of the whole compiled tree, so per Decision 2 it lives here.
 */

const { renderFieldList } = require('../../src/render/field-list');
const { itemContext } = require('../../src/util');

const table = {
  fields: {
    background: { label: 'Background' },
    backgroundBrief: { label: 'Background' },
  },
  groups: {},
  templates: {},
};

const item = {
  id: 'Aness',
  body: {
    background: 'She trained at the Academy for six years before the vault sealed.',
    backgroundBrief: 'Academy-trained researcher.',
  },
};

function label(stanza) {
  return stanza.slice(0, stanza.indexOf(':'));
}
function value(stanza) {
  return stanza.slice(stanza.indexOf(':') + 1).trim();
}

test('the full and terse entries share a label but render different bodies', () => {
  const ctx = itemContext(item);
  const full = renderFieldList([{ field: 'background', label: 'Background' }], table, ctx).trim();
  const terse = renderFieldList([{ field: 'backgroundBrief', label: 'Background' }], table, ctx).trim();

  expect(label(full)).toBe('Background');
  expect(label(terse)).toBe('Background');
  expect(value(full)).toBe('She trained at the Academy for six years before the vault sealed.');
  expect(value(terse)).toBe('Academy-trained researcher.');
  expect(value(full)).not.toBe(value(terse));
});

test('a bare field name whose declared label already matches needs no inline override', () => {
  const ctx = itemContext(item);
  const terse = renderFieldList(['backgroundBrief'], table, ctx).trim();
  expect(label(terse)).toBe('Background');
  expect(value(terse)).toBe('Academy-trained researcher.');
});
