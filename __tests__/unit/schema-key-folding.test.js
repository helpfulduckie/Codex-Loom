'use strict';

const { TYPES, validate } = require('../../src/schema');
const { parseYaml } = require('../../src/loader/yaml');
const { Diagnostics, CODES } = require('../../src/diag');
const { attachOrigins, originAt } = require('../../src/origin');
const { ITEM_SCHEMA } = require('../../src/loader/schema');
const { CONFIG_SCHEMA } = require('../../src/config/schema');
const { COMPONENT_SCHEMA } = require('../../src/loader/component-schema');
const { FIELD_TABLE_SCHEMA } = require('../../src/loader/field-table-schema');

function check(text, schema, options = {}) {
  const { value, sourceMap } = parseYaml(text, 'source.yaml');
  const diagnostics = new Diagnostics();
  validate(value, schema, { diagnostics, sourceMap, ...options });
  return { value, sourceMap, diagnostics };
}

test.each([
  [CONFIG_SCHEMA, 'Version: 4\nStructure: {Output: out}\nComponents: {AIInstructions: hello}',
    { version: 4, structure: { output: 'out' }, components: { aiInstructions: 'hello' } }],
  [ITEM_SCHEMA, 'Render: {Template: Hero}\nAid: {Type: Character}',
    { render: { template: 'Hero' }, aid: { type: 'Character' } }],
  [COMPONENT_SCHEMA, 'Sections: {Intro: {Text: hello, Render: {Position: 2}}}',
    { sections: { Intro: { text: 'hello', render: { position: 2 } } } }],
  [FIELD_TABLE_SCHEMA, 'Fields: {Hair: {From: Traits.Hair}}',
    { fields: { Hair: { from: 'Traits.Hair' } } }],
])('declared map keys fold silently while record names and values retain spelling', (schema, text, expected) => {
  const { value, diagnostics } = check(text, schema);
  expect(diagnostics.all).toEqual([]);
  expect(value).toEqual(expected);
});

test('normalization satisfies required keys and drops only unknown keys', () => {
  const { value, diagnostics } = check('Structure: {Output: out, Garbage: 1}\n_Comment: keep',
    CONFIG_SCHEMA, { dropUnknown: true });
  expect(value).toEqual({ structure: { output: 'out' }, _Comment: 'keep' });
  expect(diagnostics.all.map((d) => d.code)).toEqual([CODES.UNKNOWN_KEY]);
});

test('folded keys still enforce exact enum values', () => {
  const { value, diagnostics } = check('Kind: Reference', ITEM_SCHEMA);
  expect(value.kind).toBe('Reference');
  expect(diagnostics.all.map((d) => d.code)).toEqual([CODES.VALUE_NOT_ALLOWED]);
});

test('nested diagnostics use canonical paths and authored source lines', () => {
  const { value, sourceMap, diagnostics } = check('Render:\n  PlotEssential:\n    Order: wrong', ITEM_SCHEMA);
  expect(diagnostics.errors[0]).toMatchObject({ code: CODES.WRONG_TYPE, file: 'source.yaml', line: 3, col: 5 });
  expect(diagnostics.errors[0].message).toContain('render.plotEssential.order');
  attachOrigins(value, sourceMap.exportOrigins());
  expect(originAt(value, ['render', 'plotEssential', 'order'])).toMatchObject({
    path: ['Render', 'PlotEssential', 'Order'], line: 3, col: 5,
  });
});

test('validation without a source map preserves previously attached authored origins', () => {
  const { value, sourceMap } = parseYaml('Render:\n  Template: Hero', 'item.yaml');
  attachOrigins(value, sourceMap.exportOrigins());
  validate(value, ITEM_SCHEMA, { diagnostics: new Diagnostics() });
  expect(value).toEqual({ render: { template: 'Hero' } });
  expect(originAt(value, ['render', 'template'])).toMatchObject({ path: ['Render', 'Template'], line: 2 });
});

test('validation at a source-map offset remaps attached origins relative to the value root', () => {
  const { value, sourceMap } = parseYaml('- Render: {Template: Hero}', 'items.yaml');
  attachOrigins(value[0], sourceMap.exportOrigins(['0']));
  validate(value[0], ITEM_SCHEMA, { diagnostics: new Diagnostics(), sourceMap, path: ['0'] });
  expect(originAt(value[0], ['render', 'template'])).toMatchObject({ path: ['Render', 'Template'] });
  const exported = {};
  attachOrigins(exported, sourceMap.exportOrigins(['0']));
  expect(originAt(exported, ['render', 'template'])).toMatchObject({ path: ['Render', 'Template'] });
});

test.each([
  ['Render: {}\nrender: {}', ITEM_SCHEMA, 2, 1],
  ['Aid:\n  Type: Character\n  type: Location', ITEM_SCHEMA, 3, 2],
  ['Structure:\n  Output: out\n  output: other', CONFIG_SCHEMA, 3, 2],
])('declared map collisions report both positions once', (text, schema, line, firstLine) => {
  const { diagnostics } = check(text, schema);
  expect(diagnostics.all).toHaveLength(1);
  expect(diagnostics.all[0]).toMatchObject({ code: CODES.DUPLICATE_KEY_CASE, line,
    related: [{ label: 'first definition', file: 'source.yaml', line: firstLine }] });
});

test.each([
  'Body: {Hair: one, hair: two}',
  'Variants: {day: {Body: {Hair: one, hair: two}}}',
  'Variants: {day: {Variants: {Wet: {}, wet: {}}}}',
  'Branches: {road: {Branches: {Wet: day, wet: day}}}',
])('capitalized structural blocks retain custom collision checks', (text) => {
  const { diagnostics } = check(text, ITEM_SCHEMA);
  expect(diagnostics.all.map((d) => d.code)).toEqual([CODES.DUPLICATE_KEY_CASE]);
});

test.each([
  ['Card: {}', 'render.storyCards', CODES.UNKNOWN_KEY],
  ['Structure: {Output: out, Input: {Cards: []}}', 'items', CODES.UNKNOWN_KEY],
  ['OpeningChoice: x', 'branchFraming', CODES.UNKNOWN_KEY],
  ['AIInstructions: x', 'components:', CODES.MISPLACED_KEY],
])('capitalized unsupported keys keep migration and relocation hints', (text, hint, code) => {
  const { diagnostics } = check(text, CONFIG_SCHEMA);
  const finding = diagnostics.all.find((d) => d.code === code);
  expect(finding.hint).toContain(hint);
  expect(finding.message).toMatch(/Card|Cards|OpeningChoice|AIInstructions/);
});

test('record declared keys retain exact authored-name semantics', () => {
  const { value, diagnostics } = check('Name: untouched', {
    type: TYPES.RECORD, keys: { name: { type: TYPES.STRING, required: true } },
  });
  expect(value).toEqual({ Name: 'untouched' });
  expect(diagnostics.all.map((d) => d.code)).toEqual([CODES.MISSING_REQUIRED]);
});

test('folding preserves ignored prototype-named own properties as data', () => {
  const { value, diagnostics } = check('Render: {}\n__proto__: {safe: value}', ITEM_SCHEMA);
  expect(diagnostics.all).toEqual([]);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
  expect(value.__proto__).toEqual({ safe: 'value' });
});

test.each(['Parts', 'Try'])('nested %s field declarations preserve authored origin paths', (key) => {
  const { value, sourceMap, diagnostics } = check(`Fields:\n  Hair:\n    ${key}:\n      - From: Traits.Hair`, FIELD_TABLE_SCHEMA);
  expect(diagnostics.all).toEqual([]);
  attachOrigins(value, sourceMap.exportOrigins());
  expect(originAt(value, ['fields', 'Hair', key.toLowerCase(), '0', 'from']))
    .toMatchObject({ path: ['Fields', 'Hair', key, '0', 'From'], line: 4 });
});
