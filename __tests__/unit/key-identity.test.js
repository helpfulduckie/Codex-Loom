'use strict';

const { parseYaml } = require('../../src/loader/yaml');
const { validate } = require('../../src/schema');
const { ITEM_SCHEMA } = require('../../src/loader/schema');
const { COMPONENT_SCHEMA } = require('../../src/loader/component-schema');
const { CONFIG_SCHEMA } = require('../../src/config/schema');
const { FIELD_TABLE_SCHEMA } = require('../../src/loader/field-table-schema');
const { Diagnostics, CODES } = require('../../src/diag');

function findings(text, schema) {
  const { value, sourceMap } = parseYaml(text, 'source.yaml');
  const diagnostics = new Diagnostics();
  validate(value, schema, { diagnostics, sourceMap, dropUnknown: true });
  return diagnostics.all.filter((d) => d.code === CODES.DUPLICATE_KEY_CASE);
}

test.each([
  ['nested body fields', 'body: {Traits: {Hair: a, hair: b}}', ITEM_SCHEMA],
  ['item variables', 'v: {Mood: a, mood: b}', ITEM_SCHEMA],
  ['notes fields', 'notes: {Mood: a, mood: b}', ITEM_SCHEMA],
  ['array member fields', 'body: {entries: [{Mood: a, mood: b}]}', ITEM_SCHEMA],
  ['variant selectors', 'variants: {Day: {}, day: {}}', ITEM_SCHEMA],
  ['nested variant selectors', 'variants: {day: {variants: {Wet: {}, wet: {}}}}', ITEM_SCHEMA],
  ['variant body fields', 'variants: {day: {body: {Hair: a, hair: b}}}', ITEM_SCHEMA],
  ['variant bare fields', 'variants: {day: {Hair: a, hair: b}}', ITEM_SCHEMA],
  ['variant nested bare fields', 'variants: {day: {Traits: {Hair: a, hair: b}}}', ITEM_SCHEMA],
  ['dispatch selectors', 'branches: {Road: day, road: day}', ITEM_SCHEMA],
  ['nested dispatch selectors', 'branches: {road: {branches: {Wet: day, wet: day}}}', ITEM_SCHEMA],
  ['library names', 'version: 4\nstructure: {output: out, input: {library: {Main: here, main: there}}}', CONFIG_SCHEMA],
  ['field declarations', 'fields: {Hair: {}, hair: {}}', FIELD_TABLE_SCHEMA],
  ['group declarations', 'groups: {Core: [], core: []}', FIELD_TABLE_SCHEMA],
  ['template declarations', 'templates: {Item: [], item: []}', FIELD_TABLE_SCHEMA],
  ['named component text', 'sections: {premise: {text: {Mood: a, mood: b}}}', COMPONENT_SCHEMA],
  ['component variant selectors', 'sections: {premise: {variants: {Day: {}, day: {}}}}', COMPONENT_SCHEMA],
  ['component variant text', 'sections: {premise: {variants: {day: {text: {Mood: a, mood: b}}}}}', COMPONENT_SCHEMA],
  ['component dispatch selectors', 'branches: {Road: day, road: day}', COMPONENT_SCHEMA],
])('%s reject case-only sibling definitions', (label, text, schema) => {
  const hits = findings(text, schema);
  expect(hits).toHaveLength(1);
  expect(hits[0].severity).toBe('error');
  expect(hits[0].file).toBe('source.yaml');
  expect(hits[0].related).toHaveLength(1);
  expect(hits[0].col).toBeGreaterThan(hits[0].related[0].col);
});

test('declarations in separate namespaces and item layers do not collide', () => {
  expect(findings('fields: {Core: {}}\ngroups: {core: []}', FIELD_TABLE_SCHEMA)).toEqual([]);
  expect(findings('body: {Hair: a}\nvariants: {day: {hair: b}}', ITEM_SCHEMA)).toEqual([]);
});

test('metadata keeps case-distinct keys in base items, variants and components', () => {
  expect(findings('meta: {Mood: a, mood: b}\nvariants: {day: {meta: {Mood: a, mood: b}}}', ITEM_SCHEMA)).toEqual([]);
  expect(findings('metadata: {Mood: a, mood: b}', COMPONENT_SCHEMA)).toEqual([]);
});
