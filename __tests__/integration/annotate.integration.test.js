'use strict';

const fs = require('fs');
const path = require('path');
const { withTmpDir, writeTree } = require('../helpers/project');
const { main } = require('../../src/cli');

describe('aggregate annotation report compilation', () => {
  let root;
  let consoleSpies;

  beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map(method =>
      jest.spyOn(console, method).mockImplementation(() => {}));
    root = withTmpDir();
  });

  afterEach(() => consoleSpies.forEach(spy => spy.mockRestore()));

  function project(name, { titleLine = 'title: Sample', branches = '  north: {}\n  south: {}',
    itemBranches = '    north: anchor\n    south: anchor', itemVariants = '    anchor:\n      body: { Tagline: shared changed }',
    includeBody = '  body: {Tagline: base}', additionalFiles = {} } = {}) {
    const dir = path.join(root, name);
    writeTree(dir, {
      'compile.yaml': `version: 4
structure:
  input:
    items: [./Codex]
    templates: [./templates]
  output: ./compiled
  reports: ./Review
${titleLine}
variables: {realm: Verdant}
roles: {protagonist: Hero}
components:
  opening: "The story begins."
branches:
${branches}
`,
      'Codex/items.yaml': `- id: Hero
  name: Hero
  aid: {type: Character, triggers: [Hero]}
  render: {template: Card}
${includeBody}
  variants:
${itemVariants}
  branches:
${itemBranches}
`,
      'templates/Card.template': '{$body.Tagline}',
      ...additionalFiles,
    });
    return dir;
  }

  function compileAnnotate(dir) {
    expect(main(['--with-annotate', path.join(dir, 'compile.yaml')])).toBe(0);
    return path.join(dir, 'Review', 'annotate');
  }

  test('writes one named aggregate with shared changes and literal authored title', () => {
    const dir = project('TokenTitle', { titleLine: 'title: "{%realm} {$protagonist}"' });
    const reportDir = compileAnnotate(dir);
    const files = fs.readdirSync(reportDir);
    expect(files).toEqual(['{%realm} {$protagonist}.annotate.md']);
    const report = fs.readFileSync(path.join(reportDir, files[0]), 'utf8');
    expect(report).toContain('# Annotations: {%realm} {$protagonist}');
    expect(report).toContain('Variants `anchor`: north, south');
    expect(report.match(/`body\.tagline`/g)).toHaveLength(1);
    const label = fs.readFileSync(path.join(dir, 'compiled', 'Label.md'), 'utf8');
    expect(label).toContain('Verdant');
    expect(label).not.toContain('{%realm}');
    const old = path.join(reportDir, 'north.annotate.md');
    fs.writeFileSync(old, 'previous report');
    compileAnnotate(dir);
    expect(fs.readFileSync(old, 'utf8')).toBe('previous report');
  });

  test.each([
    ['unsafe', 'title: "CON."', '_CON'],
    ['missing', '', null],
    ['blank', 'title: "   "', null],
  ])('uses a safe stem or the output-folder fallback for %s title', (name, titleLine, expectedStem) => {
    const dir = project(`Fallback-${name}`, { titleLine });
    const reportDir = compileAnnotate(dir);
    const stem = expectedStem || 'compiled';
    expect(fs.readdirSync(reportDir)).toEqual([`${stem}.annotate.md`]);
  });

  test('single named leaf lists its applied no-change variant', () => {
    const dir = project('Single', {
      branches: '  only: {}',
      itemBranches: '    only: quiet',
      itemVariants: '    quiet: {}',
    });
    const reportDir = compileAnnotate(dir);
    const report = fs.readFileSync(path.join(reportDir, 'Sample.annotate.md'), 'utf8');
    expect(report).toContain('Variants `quiet`: only');
    expect(report).toContain('produced no field change vs base');
  });

  test('writes an explicit no-differences report', () => {
    const dir = project('NoDiff', {
      branches: '  north: {}\n  south: {}',
      itemBranches: '    north: []\n    south: []',
      itemVariants: '    unused: {}',
    });
    const reportDir = compileAnnotate(dir);
    const report = fs.readFileSync(path.join(reportDir, 'Sample.annotate.md'), 'utf8');
    expect(report).toContain('_No item differs from its project base in any branch._');
  });
});
