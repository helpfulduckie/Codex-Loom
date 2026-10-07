'use strict';

const path = require('path');
const YAML = require('yaml');
const { withTmpDir, writeTree } = require('../helpers/project');
const { Diagnostics } = require('../../src/diag');
const { PACK_SCHEMA } = require('../../src/lint/pack-schema');
const { loadPack, evaluatePack, evaluatePackExistence, evaluatePackItemRules } = require('../../src/lint/packs');

function load(text, name = 'test') {
  const dir = withTmpDir();
  writeTree(dir, { 'pack.yaml': text });
  const diagnostics = new Diagnostics();
  const file = path.join(dir, 'pack.yaml');
  const pack = loadPack(name, { source: file }, { diagnostics });
  return { pack, diagnostics, file };
}

function capitalize(value, schema) {
  if (!schema || schema.type === 'any') return value;
  if (Array.isArray(value)) return value.map(v => capitalize(v, schema.of));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    schema.type === 'map' ? key.toUpperCase() : key,
    capitalize(child, schema.keys && schema.keys[key] || schema.of),
  ]));
}

const card = { title: 'Card', body: 'Rank: low', notes: 'rank: low', meta: { meta: { test: { role: 'major' } } } };

test.each([
  { severity: 'warn', appliesTo: { all: [{ notes: { hasKey: 'rank' } }, { any: [{ titleMatch: 'Card' }] }, { not: { bodyMatch: 'absent' } }] }, forbid: { notesMatch: 'low', match: 'low' } },
  { require: { equals: { key: 'rank', value: 'high' } } },
  { requireCard: { titleMatch: 'Missing' } },
  { over: 'body', schema: { type: 'map', keys: { Rank: { type: 'string', pattern: '^high$', required: true } } } },
  { schema: { type: 'record', keyPattern: '^rank$', of: { type: ['STRING', 'NUMBER'], values: ['high'] } } },
  { over: 'meta', schema: { type: 'map', keys: { role: { type: 'string', values: ['minor'] }, needed: { type: 'number', min: 1, max: 3, required: true } } } },
  { budget: { major: 1, standard: 100 } },
  { count: { default: { max: 1 }, fields: { tagline: { words: { min: 3, max: 4 } }, vibe: { min: 3, max: 4 } } } },
  { mutexHint: { fields: ['vibe', 'tagline'], max: 1, message: 'too many' } },
])('compiler key capitalization preserves rule findings: %j', rule => {
  const doc = { name: 'test', rules: [{ id: 1, message: 'finding', ...rule }] };
  const normal = load(YAML.stringify(doc));
  const folded = load(YAML.stringify(capitalize(doc, PACK_SCHEMA)));
  expect(normal.diagnostics.all).toEqual([]);
  expect(folded.diagnostics.all).toEqual([]);
  const run = pack => [
    ...evaluatePack(pack, [card]), ...evaluatePackExistence(pack, [card]),
    ...evaluatePackItemRules(pack, [{ id: 'item', body: { vibe: ['one'], tagline: 'short', other: ['one', 'two'] } }]),
  ];
  expect(run(normal.pack).length).toBeGreaterThan(0);
  expect(run(folded.pack)).toEqual(run(normal.pack));
});

test('errors at their authored lines skip only their containing rules', () => {
  const { pack, diagnostics, file } = load([
    'name: test', 'rules:',
    '  - AppliesTo: {titelMatch: Card}', '    forbid: {}',
    '  - Severity: warn', '    severity: error', '    forbid: {}',
    '  - over: Body', '    require: {}',
    '  - budget: wrong',
    '  - id: 5', '    severity: warn', '    forbid: {}',
  ].join('\n'));
  expect(diagnostics.errors.map(d => [d.code, d.file, d.line])).toEqual([
    ['CL0201', file, 3], ['CL0211', file, 6], ['CL0206', file, 8], ['CL0202', file, 10],
  ]);
  expect(diagnostics.errors[1].related[0]).toMatchObject({ file, line: 5 });
  expect(evaluatePack(pack, [card]).map(f => [f.code, f.severity])).toEqual([['CL-test/0005', 'warn']]);
});

test('all malformed regexes are reported after key normalization', () => {
  const { pack, diagnostics, file } = load([
    'rules:', '  - Forbid:', '      All:', '        - NotesMatch: "["',
    '        - Not: {BodyMatch: "("}',
    '    Schema:', '      Type: record', '      KeyPattern: "["',
    '      Of: {Type: string, Pattern: "("}',
    '  - id: 2', '    forbid: {}',
  ].join('\n'));
  expect(diagnostics.errors.map(d => [d.code, d.file, d.line])).toEqual([
    ['CL0117', file, 4], ['CL0117', file, 5], ['CL0117', file, 8], ['CL0117', file, 9],
  ]);
  expect(evaluatePack(pack, [card]).map(f => f.code)).toEqual(['CL-test/0002']);
});

test.each(['forbid: null', 'schema: {type: nonsense}', 'require: {equals: {value: high}}',
  'count: {fields: {vibe: {max: bad}}}', 'budget: {major: 10, MAJOR: 20}'])
('invalid nested rule data cannot disable a valid sibling: %s', bad => {
  const { pack, diagnostics } = load(`rules:\n  - ${bad}\n  - forbid: {}\n`);
  expect(diagnostics.hasErrors()).toBe(true);
  expect(evaluatePack(pack, [card]).map(f => f.code)).toEqual(['CL-test/0002']);
});

test.each(['name: other\nrules: [{forbid: {}}]', 'extra: value\nrules: [{forbid: {}}]',
  'rules: nope', '[]'])('invalid pack structure or identity makes the pack unavailable: %s', text => {
  const { pack, diagnostics } = load(text);
  expect(pack).toBeNull();
  expect(diagnostics.hasErrors()).toBe(true);
});

test.each(['wtg', 'duckieConv'])('bundled pack %s loads without diagnostics', name => {
  const diagnostics = new Diagnostics();
  expect(loadPack(name, {}, { diagnostics }).rules.length).toBeGreaterThan(0);
  expect(diagnostics.all).toEqual([]);
});
