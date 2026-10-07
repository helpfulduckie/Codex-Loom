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
    ['CL0121', file, 4], ['CL0121', file, 5], ['CL0121', file, 8], ['CL0121', file, 9],
  ]);
  expect(evaluatePack(pack, [card]).map(f => f.code)).toEqual(['CL-test/0002']);
});

test.each(['forbid: null', 'schema: {type: nonsense}', 'schema: {}', 'schema: {type: []}',
  'require: {all: [null]}', '_extra: ignored', 'require: {equals: {value: high}}',
  'count: {fields: {vibe: {max: bad}}}', 'budget: {major: 10, MAJOR: 20}'])
('invalid nested rule data cannot disable a valid sibling: %s', bad => {
  const { pack, diagnostics } = load(`rules:\n  - ${bad}\n  - forbid: {}\n`);
  expect(diagnostics.hasErrors()).toBe(true);
  expect(evaluatePack(pack, [card]).map(f => f.code)).toEqual(['CL-test/0002']);
});

test('hints describe the pack, not a v3 project or the nearest unrelated key', () => {
  const envelope = load('description: mine\nrules: [{forbid: {}}]\n').diagnostics;
  expect(envelope.all.map(d => d.hint)).toEqual([null]);

  const { diagnostics } = load([
    'rules:',
    '  - forbid: {severity: warn}',
    '  - count: {max: 5}',
    '  - schema: {type: map, keys: {rank: }}',
  ].join('\n'));
  const hintFor = key => diagnostics.all.find(d => d.message.includes(`"${key}"`)).hint;
  expect(hintFor('severity')).toContain('valid at the rule level');
  expect(hintFor('max')).toContain('valid under "count.fields.*:"');
  expect(diagnostics.all.find(d => d.line === 4).message).toContain('write {type: any}');
});

test('a card key that shares a v3 project key name gets no migration hint', () => {
  const pack = { name: 'test', rules: [{ code: 'CL-test/0001', severity: 'error', schema: { type: 'map', keys: { rank: { type: 'string' } } } }] };
  const [finding] = evaluatePack(pack, [{ ...card, notes: 'description: text' }]);
  expect(finding.detail).toContain('Unknown key "description"');
  expect(finding.detail).not.toContain('--migrate');
});

test.each(['name: other\nrules: [{forbid: {}}]', 'name: null\nrules: [{forbid: {}}]', 'extra: value\nrules: [{forbid: {}}]',
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

test.each(['Starting Date', 'starting date', 'STARTING DATE'])('hasKey and equals.key match card key %s', key => {
  const { pack, diagnostics } = load(YAML.stringify({ rules: [
    { require: { hasKey: 'Starting Date' } },
    { require: { equals: { key: 'STARTING DATE', value: 'Today' } } },
    { forbid: { hasKey: 'starting date' } },
  ] }));
  expect(diagnostics.all).toEqual([]);
  expect(evaluatePack(pack, [{ ...card, notes: `${key}: Today` }]).map(f => f.code)).toEqual(['CL-test/0003']);
  expect(evaluatePack(pack, [{ ...card, notes: `${key}: today` }]).map(f => f.code))
    .toEqual(['CL-test/0002', 'CL-test/0003']);
});

test.each(['major', 'MAJOR', 'Major'])('budget role %s matches preserved authored role names', role => {
  const { pack, diagnostics } = load('rules: [{budget: {Major: 1, STANDARD: 2}}]\n');
  expect(diagnostics.all).toEqual([]);
  const findings = evaluatePack(pack, [{ ...card, body: 'xx', meta: { meta: { test: { role } } } }]);
  expect(findings).toHaveLength(1);
  expect(findings[0].message).toContain('role "Major" targets 1');
  expect(evaluatePack(pack, [{ ...card, body: 'xx', meta: { meta: { test: { role: 'other' } } } }])).toEqual([]);
  expect(evaluatePack(pack, [{ ...card, body: 'xxx', meta: {} }])[0].message).toContain('role "STANDARD" targets 2');
});

test.each([
  ['extra: stray', 'CL0201'],
  ['name: other', 'CL0119'],
  ['extra: stray\nname: other', 'CL0201'],
])('an unavailable pack still reports all rule errors: %s', (envelope, firstCode) => {
  const { pack, diagnostics, file } = load([
    envelope, 'rules:', '  - forbid: {titelMatch: Card}',
    '  - forbid: {notesMatch: "["}', '  - id: empty',
    '  - id: live', '    forbid: {}',
  ].join('\n'));
  expect(pack).toBeNull();
  expect(diagnostics.errors[0].code).toBe(firstCode);
  expect(diagnostics.errors.map(d => d.code)).toEqual([
    ...(envelope.includes('extra') ? ['CL0201'] : []),
    ...(envelope.includes('name') ? ['CL0119'] : []), 'CL0201', 'CL0121', 'CL0121',
  ]);
  const offset = envelope.split('\n').length;
  expect(diagnostics.errors.slice(-3).map(d => [d.file, d.line]))
    .toEqual([[file, offset + 2], [file, offset + 3], [file, offset + 4]]);
  expect(diagnostics.errors.every(d => !d.message.includes('rule skipped'))).toBe(true);
});

test.each([
  ['2', null, 'CL-test/0002'],
  ['2', '"0002"', 'CL-test/0002'],
  ['Check', 'check', 'CL-test/Check'],
])('later repeated final codes are skipped: %s and %s', (firstId, secondId, emittedCode) => {
  const { pack, diagnostics, file } = load([
    'rules:', `  - id: ${firstId}`, '    forbid: {}',
    secondId === null ? '  - forbid: {}' : `  - id: ${secondId}\n    forbid: {}`,
    '  - id: sibling', '    forbid: {}',
  ].join('\n'));
  expect(diagnostics.errors).toEqual([
    expect.objectContaining({ code: 'CL0121', file, line: 4,
      related: [expect.objectContaining({ label: 'first definition', file, line: 2 })] }),
  ]);
  expect(diagnostics.errors[0].message).toContain(emittedCode);
  expect(evaluatePack(pack, [card]).map(f => f.code)).toEqual([emittedCode, 'CL-test/sibling']);
});

test('invalid rules do not reserve codes and checkless rules have located errors', () => {
  const { pack, diagnostics, file } = load([
    'rules:', '  - id: same', '    forbid: {notesMatch: "["}',
    '  - id: same', '    forbid: {}',
    '  - id: noCheck', '    severity: warn', '    message: absent check', '    appliesTo: {titleMatch: Card}',
    '  - id: sibling', '    require: {titleMatch: Missing}',
  ].join('\n'));
  expect(diagnostics.errors.map(d => [d.code, d.file, d.line]))
    .toEqual([['CL0121', file, 3], ['CL0121', file, 6]]);
  expect(evaluatePack(pack, [card]).map(f => f.code)).toEqual(['CL-test/same', 'CL-test/sibling']);
});

test.each(['type', 'pattern', 'match', 'keyPattern'])('budget name %s is not interpreted as a descriptor property', key => {
  const { pack, diagnostics, file } = load(`rules:\n  - budget: {${key}: big}\n  - forbid: {}\n`);
  expect(diagnostics.errors).toEqual([expect.objectContaining({ code: 'CL0202', file, line: 2 })]);
  expect(evaluatePack(pack, [card]).map(f => f.code)).toEqual(['CL-test/0002']);
});

test('author-chosen card keys named type, pattern and match remain ordinary descriptors', () => {
  const { pack, diagnostics } = load(YAML.stringify({ rules: [{ schema: { type: 'map', keys: {
    type: { type: 'string', required: true },
    pattern: { type: 'string', required: true },
    match: { type: 'string', required: true },
  } } }] }));
  expect(diagnostics.all).toEqual([]);
  expect(evaluatePack(pack, [{ ...card, notes: 'type: big\npattern: "["\nmatch: "("' }])).toEqual([]);
});

test.each([
  ['duckieConv', 'role', 'major'],
  ['duckieConv', 'Role', 'major'],
  ['DuckieConv', 'role', 'major'],
  ['DUCKIECONV', 'ROLE', 'Major'],
])('metadata %s.%s budgets and validates role %s consistently without rewriting it', (namespace, key, role) => {
  const diagnostics = new Diagnostics();
  const pack = loadPack('duckieConv', {}, { diagnostics });
  expect(diagnostics.all).toEqual([]);
  const meta = { meta: { [namespace]: { [key]: role }, other: { role: 'boss' } } };
  const original = structuredClone(meta);
  Object.freeze(meta.meta[namespace]);
  Object.freeze(meta.meta);
  expect(evaluatePack(pack, [{ ...card, body: 'x'.repeat(450), meta }])).toEqual([]);
  expect(meta).toEqual(original);
  expect(evaluatePack(pack, [{ ...card, body: 'x'.repeat(550), meta }]).map(f => f.code))
    .toEqual(['CL-duckieConv/0001']);
  expect(meta).toEqual(original);
});

test('a bad role in a differently capitalized metadata namespace produces a pattern finding', () => {
  const pack = loadPack('duckieConv', {}, { diagnostics: new Diagnostics() });
  const findings = evaluatePack(pack, [{ ...card, body: 'short', meta: { meta: { DuckieConv: { Role: 'boss' } } } }]);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ code: 'CL-duckieConv/0004', severity: 'warn' });
  expect(findings[0].detail).toContain('must match');
});
