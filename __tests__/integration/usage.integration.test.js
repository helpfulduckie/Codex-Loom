'use strict';

jest.mock('../../src/usage', () => {
  const actual = jest.requireActual('../../src/usage');
  return { ...actual, createUsage: jest.fn(actual.createUsage), usageOf: jest.fn(actual.usageOf) };
});
jest.mock('../../src/loader/component', () => {
  const actual = jest.requireActual('../../src/loader/component');
  return { ...actual, loadComponentDocument: jest.fn(actual.loadComponentDocument) };
});

const fs = require('fs');
const path = require('path');
const { withTmpDir, writeTree } = require('../helpers/project');
const { compile, preview } = require('../../src/compile');
const { main } = require('../../src/cli');
const usage = require('../../src/usage');
const { loadComponentDocument } = require('../../src/loader/component');
const { Diagnostics } = require('../../src/diag');

let root;
let config;
let spies;
beforeEach(() => {
  root = withTmpDir();
  config = path.join(root, 'compile.yaml');
  writeTree(root, {
    'compile.yaml': `version: 4
title: "Usage: fixture"
structure:
  input:
    items: [./items]
    templates: [./templates]
  output: ./output
  reports: ./reports
variables: {place: Harbor, folder: components}
roles: {guide: Hero}
components:
  plotEssential: './{%folder}/pe.yaml'
  opening: 'Welcome to {%place}, {$guide.display}.'
branches: {A: {}, B: {}}
`,
    'items/hero.yaml': `id: Hero
name: Hero
aid: {type: Item}
render: {template: Item}
body: {Desc: 'Lives in {%place}.'}
`,
    'templates/Item.template': '{$body.Desc}',
    'components/base.yaml': 'sections:\n  intro:\n    text: "Visit {%place}, {$guide.display}."\n',
    'components/pe.yaml': 'imports:\n  - from: ./components/base.yaml\nsections:\n  intro:\n    heading: Intro\n',
  });
  spies = ['log', 'warn', 'error'].map((key) => jest.spyOn(console, key).mockImplementation(() => {}));
  jest.clearAllMocks();
});
afterEach(() => spies.forEach((spy) => spy.mockRestore()));

// A preview gives each loaded section record a `_layers` history; an ordinary compile gives none.
const sectionRecords = (component) => Object.values(component.rawSections || {}).filter((def) => def && typeof def === 'object');
const hasHistory = (component) => sectionRecords(component).some((def) => Array.isArray(def._layers));
const layersRecorded = (component) => sectionRecords(component).reduce((n, def) => n + (def._layers || []).length, 0);

test.each([{}, { diff: true, annotate: true, variance: true, inventory: true, schemaTables: true }])('ordinary compilation and existing reports do not allocate usage or histories (%j)', (options) => {
  compile(config, options);
  expect(usage.createUsage).toHaveBeenCalled();
  expect(usage.usageOf).toHaveBeenCalled();
  expect(loadComponentDocument).toHaveBeenCalled();
  expect(usage.createUsage.mock.results.every((r) => r.value === null)).toBe(true);
  expect(usage.usageOf.mock.results.every((r) => r.value === null)).toBe(true);
  expect(loadComponentDocument.mock.results.filter((r) => r.value).every((r) => !hasHistory(r.value))).toBe(true);
  expect(fs.existsSync(path.join(root, 'reports/usage'))).toBe(false);
});

test('preview retains usage and recursive component histories', () => {
  const result = preview(config);
  expect(result.status).toBe('ok');
  expect(usage.createUsage.mock.results.some((r) => r.value !== null)).toBe(true);
  expect(loadComponentDocument.mock.results.some((r) => r.value && hasHistory(r.value) && layersRecorded(r.value) > 0)).toBe(true);
  expect(fs.existsSync(path.join(root, 'output'))).toBe(false);
});

test('standalone usage CLI captures exact reads, groups leaves, and keeps histories disabled', () => {
  expect(main(['--with-usage', config])).toBe(0);
  const report = fs.readFileSync(path.join(root, 'reports/usage/Usage_ fixture.usage.md'), 'utf8');
  expect(report.split('\n').filter((line) => line.startsWith('| role') || line.startsWith('| variable'))).toEqual([
    '| role | guide | A, B | prose: opening; section: plotEssential/intro |',
    '| variable | folder | A, B | component-path: plotEssential |',
    '| variable | place | A, B | item: Hero; prose: opening; section: plotEssential/intro |',
  ]);
  expect(report).toContain('An absent read does not establish');
  expect(loadComponentDocument.mock.results.filter((r) => r.value).every((r) => !hasHistory(r.value))).toBe(true);
  expect(fs.existsSync(path.join(root, 'output'))).toBe(true);
});

test('usage capture preserves diagnostics and forces compilation alongside an offline report mode', () => {
  const ordinary = new Diagnostics();
  const traced = new Diagnostics();
  compile(config, { diagnostics: ordinary });
  compile(config, { usage: true, diagnostics: traced });
  const values = (bus) => bus.all.map(({ code, severity, message }) => ({ code, severity, message }));
  expect(values(traced)).toEqual(values(ordinary));
  fs.rmSync(path.join(root, 'output'), { recursive: true });
  expect(main(['--with-usage', '--lint', config])).toBe(0);
  expect(fs.existsSync(path.join(root, 'output'))).toBe(true);
});
