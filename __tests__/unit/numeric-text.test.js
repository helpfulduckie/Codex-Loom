'use strict';

const path = require('path');
const YAML = require('yaml');
const { parseYaml } = require('../../src/loader/yaml');
const { validate } = require('../../src/schema');
const { Diagnostics } = require('../../src/diag');
const { CONFIG_SCHEMA } = require('../../src/config/schema');
const { ITEM_SCHEMA } = require('../../src/loader/schema');
const { COMPONENT_SCHEMA } = require('../../src/loader/component-schema');
const { FIELD_TABLE_SCHEMA } = require('../../src/loader/field-table-schema');
const { loadPack, evaluatePack, evaluatePackItemRules } = require('../../src/lint/packs');
const { withTmpDir, writeTree } = require('../helpers/project');

function normalize(text, schema) {
  const diagnostics = new Diagnostics();
  const { value: doc, sourceMap } = parseYaml(text, 'numeric.yaml');
  const value = validate(doc, schema, { diagnostics, sourceMap });
  return { value, diagnostics };
}

const config = text => normalize(`version: 4\nstructure: {output: ./out}\n${text}`, CONFIG_SCHEMA);

test.each([
  ['6', '6'], ['0', '0'], ['1.50', '1.50'], ['007', '007'], ['1e3', '1e3'], ['-0', '-0'],
  ['0x1F', '0x1F'], ['12345678901234567890', '12345678901234567890'], ['.nan', '.nan'],
  ['"1.50"', '1.50'], ['"007"', '007'],
])('root and nested branch variables keep %s as typed', (scalar, expected) => {
  const { value, diagnostics } = config(`variables: {amount: ${scalar}}\nbranches: {a: {branches: {b: {variables: {amount: ${scalar}}}}}}`);
  expect(diagnostics.errors).toEqual([]);
  expect(value.variables.amount).toBe(expected);
  expect(value.branches.a.branches.b.variables.amount).toBe(expected);
});

test('a number with no recorded spelling falls back to its parsed form', () => {
  const diagnostics = new Diagnostics();
  const bare = validate(YAML.parse('version: 4\nstructure: {output: ./out}\nvariables: {amount: 1.50}'), CONFIG_SCHEMA, { diagnostics });
  expect(bare.variables.amount).toBe('1.5');
  const aliased = config('variables: {first: &n 007, second: *n}').value;
  expect(aliased.variables).toEqual({ first: '007', second: '7' });
  expect(diagnostics.errors).toEqual([]);
});

test('folded keys keep the spelling of the value they were written with', () => {
  const { value, diagnostics } = config('Variables: {amount: 007}\nTitle: 1.50');
  expect(diagnostics.errors).toEqual([]);
  expect(value).toMatchObject({ variables: { amount: '007' }, title: '1.50' });
});

test.each(['true', 'false', '[6]', '{nested: 6}'])('config variables reject nontext value %s', scalar => {
  const { diagnostics } = config(`variables: {amount: ${scalar}}`);
  expect(diagnostics.errors.map(d => d.code)).toEqual(['CL0202']);
});

test('null unbinding and quoted empty variables retain their values', () => {
  const { value, diagnostics } = config('variables: {empty: "", dropped: ~}\nbranches: {a: {variables: {empty: ~}}}');
  expect(diagnostics.errors).toEqual([]);
  expect(value.variables).toEqual({ empty: '', dropped: null });
  expect(value.branches.a.variables).toEqual({ empty: null });
});

test('config literal text converts numbers without converting numeric settings or paths', () => {
  const { value, diagnostics } = config('title: 0\nplaceholders: {year: 2024}\ncomponents: {opening: 6, branchFraming: 0}\nbranches: {a: {title: 7, placeholders: {day: 0}}}');
  expect(diagnostics.errors).toEqual([]);
  expect(value).toMatchObject({ version: 4, title: '0', placeholders: { year: '2024' }, components: { opening: '6', branchFraming: '0' }, branches: { a: { title: '7', placeholders: { day: '0' } } } });
  expect(normalize('version: 4\nstructure: {output: 6}', CONFIG_SCHEMA).diagnostics.errors.some(d => d.code === 'CL0202')).toBe(true);
  expect(config('components: {aiInstructions: 6}').diagnostics.errors.map(d => d.code)).toEqual(['CL0202']);
});

test('item text and rendered item data keep typed numbers while settings and meta stay parsed', () => {
  const { value, diagnostics } = normalize([
    'id: card', 'name: {display: 0, full: 007}', 'aid: {type: Character, title: 1.50, triggers: [0, 1e3]}',
    'render: {plotEssential: {order: 6}}', 'body: {gpa: 3.30, schoolId: 0107420, grade: 12, score: 3.5}',
    'v: {nested: {serial: 12345678901234567890}, enrolled: true, subjects: [6, 06]}', 'vars: {code: 007}',
    'notes: {amount: 6, rate: 1.50}', 'pronouns: {count: 02}', 'meta: {amount: 3.30, code: 007}',
    'variants: {alt: {name: 6, aid: {title: 0, triggers: 007}, variants: {inner: {name: {full: 1.50}}}, body: {gpa: {set: 3.30}}}}',
  ].join('\n'), ITEM_SCHEMA);
  expect(diagnostics.errors).toEqual([]);
  expect(value.name).toEqual({ display: '0', full: '007' });
  expect(value.aid).toMatchObject({ title: '1.50', triggers: ['0', '1e3'] });
  expect(value.render.plotEssential.order).toBe(6);
  expect(value.body).toEqual({ gpa: '3.30', schoolId: '0107420', grade: 12, score: 3.5 });
  expect(value.v).toEqual({ nested: { serial: '12345678901234567890' }, enrolled: true, subjects: [6, '06'] });
  expect(value.vars).toEqual({ code: '007' });
  expect(value.notes).toEqual({ amount: 6, rate: '1.50' });
  expect(value.pronouns).toEqual({ count: '02' });
  expect(value.meta).toEqual({ amount: 3.3, code: 7 });
  expect(value.variants.alt).toMatchObject({ name: '6', aid: { title: '0', triggers: '007' }, variants: { inner: { name: { full: '1.50' } } }, body: { gpa: { set: '3.30' } } });
});

test('component text and nested variants keep typed numbers while ordering stays numeric', () => {
  const { value, diagnostics } = normalize([
    'sections:', '  intro:', '    heading: 0', '    headingLevel: 2', '    text: {first: 007, second: 1.50}',
    '    render: {position: 6}', '    variants: {alt: {heading: 6, text: 0, variants: {inner: {text: 1e3}}}}',
    'render: {storyCards: [{title: 0, type: Character}]}', 'metadata: {grade: 12, code: 007}',
  ].join('\n'), COMPONENT_SCHEMA);
  expect(diagnostics.errors).toEqual([]);
  expect(value.sections.intro).toMatchObject({ heading: '0', headingLevel: 2, text: { first: '007', second: '1.50' }, render: { position: 6 }, variants: { alt: { heading: '6', text: '0', variants: { inner: { text: '1e3' } } } } });
  expect(value.render.storyCards[0].title).toBe('0');
  expect(value.metadata).toEqual({ grade: 12, code: 7 });
});

test('field-table literal text keeps typed numbers in declarations and template entries', () => {
  const { value, diagnostics } = normalize('fields: {grade: {label: 0, join: 6, labelWhen: {present: 007}}}\ntemplates: {Card: [{raw: 1.50}, {field: grade, label: 1e3}]}', FIELD_TABLE_SCHEMA);
  expect(diagnostics.errors).toEqual([]);
  expect(value.fields.grade).toEqual({ label: '0', join: '6', labelWhen: { present: '007' } });
  expect(value.templates.Card).toEqual([{ raw: '1.50' }, { field: 'grade', label: '1e3' }]);
});

test('pack text operands keep typed numbers', () => {
  const { value, diagnostics } = pack('rules:\n  - id: typed\n    forbid: {hasKey: 007}\n    message: 1.50');
  expect(diagnostics.errors).toEqual([]);
  expect(evaluatePack(value, [{ title: 'Card', notes: '"007": present', body: '' }]).map(f => f.detail)).toEqual(['1.50']);
});

function pack(text) {
  const dir = withTmpDir();
  writeTree(dir, { 'pack.yaml': text });
  const diagnostics = new Diagnostics();
  return { value: loadPack('numeric', { source: path.join(dir, 'pack.yaml') }, { diagnostics }), diagnostics };
}

test.each(['hasKey', 'notesMatch', 'bodyMatch', 'match', 'titleMatch'])('numeric %s predicates execute, including zero', predicate => {
  const { value, diagnostics } = pack(`rules:\n  - id: check\n    forbid: {${predicate}: 0}\n    message: 6`);
  expect(diagnostics.errors).toEqual([]);
  const card = { title: '0', body: '0', notes: '0: present' };
  expect(evaluatePack(value, [card])).toMatchObject([{ code: 'CL-numeric/check', message: '[numeric] card "0": 6' }]);
});

test('numeric mutexHint field names load and count the fields they name', () => {
  const { value, diagnostics } = pack('rules:\n  - id: mutex\n    mutexHint: {fields: [2024, 2025, other], max: 1}');
  expect(diagnostics.errors).toEqual([]);
  expect(value.rules[0].mutexHint.fields).toEqual(['2024', '2025', 'other']);
  const item = { id: 'card', body: { 2024: 'a', 2025: 'b' } };
  expect(evaluatePackItemRules(value, [item]).map(f => f.code)).toEqual(['CL-numeric/mutex']);
});

test('numeric equality keys execute and equality values retain parsed-number comparison', () => {
  const { value, diagnostics } = pack('rules:\n  - id: equal\n    forbid: {equals: {key: 0, value: 3.30}}');
  expect(diagnostics.errors).toEqual([]);
  expect(evaluatePack(value, [{ title: 'Card', notes: '0: 3.3', body: '' }]).map(f => f.code)).toEqual(['CL-numeric/equal']);
  expect(value.rules[0].forbid.equals.value).toBe(3.3);
});

test('numeric schema regexes execute while numeric bounds stay numbers', () => {
  const { value, diagnostics } = pack('rules:\n  - id: shape\n    schema: {type: record, keyPattern: 0, of: {type: string, pattern: 6}}\n  - id: bound\n    schema: {type: map, keys: {grade: {type: number, min: 1, max: 12}}}\n  - id: mutex\n    mutexHint: {fields: [grade, gpa], max: 1, message: 0}');
  expect(diagnostics.errors).toEqual([]);
  const findings = evaluatePack(value, [{ title: 'Card', notes: 'other: wrong', body: '' }]);
  expect(findings.some(f => f.code === 'CL-numeric/shape')).toBe(true);
  expect(value.rules[1].schema.keys.grade).toEqual({ type: 'number', min: 1, max: 12 });
  expect(value.rules[2].mutexHint).toEqual({ fields: ['grade', 'gpa'], max: 1, message: '0' });
});
