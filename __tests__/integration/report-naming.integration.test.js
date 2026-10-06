'use strict';

const fs = require('fs');
const path = require('path');
const { withTmpDir, writeTree } = require('../helpers/project');
const { main } = require('../../src/cli');
const { runOverviewMode } = require('../../src/overview');
const { runSeedMapMode } = require('../../src/seedmap');
const { runBodySizeMode } = require('../../src/bodysize');
const { runLintMode } = require('../../src/lint');
const { runProvenanceMode } = require('../../src/provenance');
const { runVarianceMode } = require('../../src/variance');
const { ItemRegistry } = require('../../src/loader/registry');

const quiet = { log: jest.fn(), verbose: jest.fn() };

describe('report identity in actual writers and CLI calls', () => {
  let root;
  let consoleSpies;

  beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) =>
      jest.spyOn(console, method).mockImplementation(() => {}));
    root = withTmpDir();
    writeTree(root, {
      'compile.yaml': `version: 4
structure:
  input:
    items: []
  output: ./Garden
title: "{%realm} {$protagonist}"
variables:
  realm: Verdant
roles:
  protagonist: Hero
`,
      'Garden/Label.md': 'Expanded rendered label',
      'Garden/Components/Opening.md': 'A quiet beginning.',
    });
  });

  afterEach(() => consoleSpies.forEach((spy) => spy.mockRestore()));

  test('config-backed CLI reports keep tokens literal and offline writers use the folder despite Label.md', () => {
    const configPath = path.join(root, 'compile.yaml');
    expect(main(['--leafReview', '--overview', '--seed-map', '--body-sizes', '--lint', configPath])).toBe(0);

    const reports = path.join(root, 'Garden', 'Overview');
    const literal = '{%realm} {$protagonist}';
    const literalStem = path.join(reports, 'leaf-review', `${literal}.leaf.md`);
    expect(fs.existsSync(literalStem)).toBe(true);
    expect(fs.readFileSync(literalStem, 'utf8')).toContain(`# ${literal}`);
    expect(fs.existsSync(path.join(reports, 'overview', `${literal}.overview.md`))).toBe(true);
    expect(fs.readFileSync(path.join(reports, 'overview', `${literal}.overview.md`), 'utf8')).toContain(`# ${literal}`);
    expect(fs.existsSync(path.join(reports, 'seed-map', `${literal}.seedmap.md`))).toBe(true);
    expect(fs.existsSync(path.join(reports, 'seed-map', `${literal}.seedmap.csv`))).toBe(true);
    expect(fs.readFileSync(path.join(reports, 'seed-map', `${literal}.seedmap.md`), 'utf8')).toContain(literal);
    expect(fs.existsSync(path.join(reports, 'body-sizes', `${literal}.bodysize.md`))).toBe(true);
    expect(fs.existsSync(path.join(reports, 'body-sizes', `${literal}.bodysize.csv`))).toBe(true);
    expect(fs.existsSync(path.join(reports, 'lint', `${literal}.lint.md`))).toBe(true);

    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      expect(main(['--leafReview', path.join(root, 'Garden')])).toBe(0);
    } finally {
      process.chdir(previousCwd);
    }
    expect(fs.existsSync(path.join(root, 'overview', 'leaf-review', 'Garden.leaf.md'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'Garden', 'Label.md'), 'utf8')).toContain('Expanded rendered label');

    const offline = path.join(root, 'offline');
    fs.mkdirSync(offline);
    const offlineOverview = runOverviewMode(path.join(root, 'Garden'), offline);
    expect(path.basename(offlineOverview.outPath)).toBe('Garden.overview.md');
    expect(fs.readFileSync(offlineOverview.outPath, 'utf8')).toContain('# Garden');
  });

  test('compile dispatch keeps token-bearing report labels literal while Label.md expands them', () => {
    const project = path.join(root, 'dispatch');
    writeTree(project, {
      'compile.yaml': `version: 4
structure:
  input:
    items: [./Codex]
    templates: [./templates]
  output: ./compiled
  reports: ./Review
title: "{%realm} {$protagonist}"
variables:
  realm: Verdant
roles:
  protagonist: Hero
components:
  opening: "You are {$protagonist}."
`,
      'Codex/items.yaml': `- id: Hero
  name: Hero
  aid: {type: Character, triggers: [Hero]}
  render: {template: Card}
  body: {Tagline: "A literal-title probe."}
`,
      'templates/Card.template': '{$body.Tagline}',
    });

    expect(main(['--with-variance', path.join(project, 'compile.yaml')])).toBe(0);
    const renderedLabel = fs.readFileSync(path.join(project, 'compiled', 'Label.md'), 'utf8');
    expect(renderedLabel).toContain('Verdant');
    expect(renderedLabel).not.toContain('{%realm}');
    expect(renderedLabel).not.toContain('{$protagonist}');
    const literal = '{%realm} {$protagonist}';
    const provenancePath = path.join(project, 'Review', `${literal}.provenance.md`);
    const variancePath = path.join(project, 'Review', 'variance', `${literal}.variance.md`);
    expect(fs.existsSync(provenancePath)).toBe(true);
    expect(fs.existsSync(variancePath)).toBe(true);
    expect(fs.readFileSync(provenancePath, 'utf8')).toContain(`# Item Provenance — ${literal}`);
    expect(fs.readFileSync(variancePath, 'utf8')).toContain(`# Variance: ${literal}`);
  });

  test.each([
    ['title: "{%realm} {$protagonist}"', '{%realm} {$protagonist}'],
    ['', 'Garden'],
    ['title: "   "', 'Garden'],
  ])('project-directory CLI input selects report identity for %s', (titleLine, stem) => {
    const configPath = path.join(root, 'compile.yaml');
    const config = fs.readFileSync(configPath, 'utf8')
      .replace('title: "{%realm} {$protagonist}"', titleLine);
    fs.writeFileSync(configPath, config);
    expect(main(['--overview', '--seed-map', root])).toBe(0);
    const reports = path.join(root, 'Garden', 'Overview');
    const overviewPath = path.join(reports, 'overview', `${stem}.overview.md`);
    expect(fs.readFileSync(overviewPath, 'utf8')).toContain(`# ${stem}`);
    expect(fs.existsSync(path.join(reports, 'seed-map', `${stem}.seedmap.md`))).toBe(true);
    expect(fs.existsSync(path.join(reports, 'seed-map', `${stem}.seedmap.csv`))).toBe(true);
  });

  test('a compile load failure before output still writes lint with zero scanned files', () => {
    const failed = path.join(root, 'failed');
    writeTree(failed, {
      'compile.yaml': `version: 4
structure:
  input:
    items: [./Codex]
  output: ./output
  reports: ./Review
title: Broken Load
`,
      'Codex/broken.yaml': '- id: [unfinished\n',
    });
    expect(main(['--compile', '--lint', path.join(failed, 'compile.yaml')])).toBe(1);
    const report = path.join(failed, 'Review', 'lint', 'Broken Load.lint.md');
    expect(fs.existsSync(report)).toBe(true);
    expect(fs.existsSync(path.join(failed, 'output', 'Label.md'))).toBe(false);
    expect(fs.existsSync(path.join(failed, 'output', 'Story Cards'))).toBe(false);
    expect(fs.readFileSync(report, 'utf8')).toContain('broken.yaml');
    expect(console.log.mock.calls.some(([line]) => String(line).includes('across 0 file(s)'))).toBe(true);
  });

  test('dot-only titles use one folder-derived stem across every affected writer', () => {
    const scenario = path.join(root, 'Garden');
    const reports = path.join(root, 'dot-title');
    fs.mkdirSync(reports, { recursive: true });
    const leafDir = path.join(reports, 'leaf');
    const overviewDir = path.join(reports, 'overview');
    const seedDir = path.join(reports, 'seed-map');
    const bodyDir = path.join(reports, 'body-sizes');
    const lintDir = path.join(reports, 'lint');
    for (const dir of [leafDir, overviewDir, seedDir, bodyDir, lintDir]) fs.mkdirSync(dir);

    const leaf = require('../../src/overview').runLeafReviewMode(scenario, leafDir, { title: '...' });
    const overview = runOverviewMode(scenario, overviewDir, { title: '...' });
    const seed = runSeedMapMode(scenario, seedDir, { title: '...' });
    const body = runBodySizeMode(scenario, bodyDir, { title: '...' });
    const lint = runLintMode(scenario, lintDir, { title: '...' });
    const registry = new ItemRegistry();
    const provenanceDir = path.join(reports, 'provenance');
    const varianceDir = path.join(reports, 'variance');
    fs.mkdirSync(provenanceDir);
    fs.mkdirSync(varianceDir);
    const provenance = runProvenanceMode(registry, provenanceDir, 'Garden', root, { title: '...' });
    const variance = runVarianceMode([], [], varianceDir, '...', 'Garden');

    const expectedNames = [
      'Garden.leaf.md', 'Garden.overview.md', 'Garden.seedmap.md', 'Garden.seedmap.csv',
      'Garden.bodysize.md', 'Garden.bodysize.csv', 'Garden.lint.md',
      'Garden.provenance.md', 'Garden.provenance.csv', 'Garden.variance.md',
    ];
    const written = [...leaf.written, ...overview.written, ...seed.written, ...body.written,
      ...lint.written, ...provenance.written, ...variance.written];
    expect(written.map((file) => path.basename(file)).sort()).toEqual(expectedNames.sort());
    expect(written.every((file) => fs.existsSync(file))).toBe(true);
  });

  test('provenance and variance writers use safe paired stems and readable labels', () => {
    const output = path.join(root, 'direct');
    fs.mkdirSync(output);
    const registry = new ItemRegistry();
    registry.set('hero', { id: 'hero', _source: path.join(root, 'hero.yaml') });
    const provenance = runProvenanceMode(registry, output, 'Folder', root, { title: 'CON.' });
    expect(provenance.written.map((file) => path.basename(file)).sort()).toEqual(['_CON.provenance.csv', '_CON.provenance.md']);
    expect(fs.readFileSync(provenance.written.find((file) => file.endsWith('.md')), 'utf8'))
      .toContain('# Item Provenance — CON.');

    const varianceDir = path.join(output, 'variance');
    fs.mkdirSync(varianceDir);
    const variance = runVarianceMode([], [], varianceDir, '...', 'Folder');
    expect(path.basename(variance.written[0])).toBe('Folder.variance.md');
    expect(fs.readFileSync(variance.written[0], 'utf8')).toContain('# Variance: ...');
  });

  test('body-size root labels change without relabeling a branch named after the output folder', () => {
    const scenario = path.join(root, 'Garden');
    writeTree(scenario, { 'Branches/Garden/Components/Opening.md': 'A branch beginning.' });
    const output = path.join(root, 'sizes');
    fs.mkdirSync(output);
    const result = runBodySizeMode(scenario, output, { title: 'Authored Project' });
    const csv = fs.readFileSync(result.csvPath, 'utf8');
    expect(csv).toContain('Authored Project,Opening,Opening.md,framing,');
    expect(csv).toContain('Garden,Opening,Opening.md,leaf,');
    expect(csv).not.toContain('Authored Project,Opening,Opening.md,leaf,');
  });

  test('seed-map branch pairs are isolated from the overall pair and collisions get paired stems', () => {
    const scenario = path.join(root, 'Garden');
    const output = path.join(root, 'seed-map');
    fs.mkdirSync(output, { recursive: true });
    const branchInfos = [
      ['Garden', 'garden-card'], ['garden', 'lower-card'], ['Garden (leaf)', 'suffix-card'],
      ['Alpha:One', 'colon-card'], ['Alpha?One', 'question-card'],
    ].map(([branchName, cardName], index) => {
      const leafDir = path.join(root, 'compiled-leaves', `leaf-${index}`);
      writeTree(leafDir, {
        [`Story Cards/Character/${cardName}.md`]: `## ${cardName}\n~~~\ntriggers: [${cardName}]\n~~~\n${cardName} body`,
      });
      return { branchNames: [branchName], leafDir, cardName };
    });
    jest.resetModules();
    jest.doMock('../../src/overview', () => ({
      discoverLeaves: () => branchInfos,
    }));
    const { runSeedMapMode: writeSeedMap } = require('../../src/seedmap');
    const result = writeSeedMap(scenario, output, { title: 'Garden' });
    jest.dontMock('../../src/overview');
    jest.resetModules();

    expect(result.written).toContain(path.join(output, 'Garden.seedmap.md'));
    const leaves = path.join(output, 'leaves');
    expect(fs.readdirSync(leaves).sort()).toEqual([
      'Alpha_One (leaf).seedmap.csv', 'Alpha_One (leaf).seedmap.md',
      'Alpha_One.seedmap.csv', 'Alpha_One.seedmap.md',
      'Garden (leaf).seedmap.csv', 'Garden (leaf).seedmap.md',
      'Garden.seedmap.csv', 'Garden.seedmap.md',
      'garden (leaf 2).seedmap.csv', 'garden (leaf 2).seedmap.md',
    ].sort());
    expect(fs.readdirSync(output).sort()).toEqual(['Garden.seedmap.csv', 'Garden.seedmap.md', 'leaves']);
    for (const file of fs.readdirSync(leaves)) expect(result.written).toContain(path.join(leaves, file));
    const overallMd = fs.readFileSync(path.join(output, 'Garden.seedmap.md'), 'utf8');
    const overallCsv = fs.readFileSync(path.join(output, 'Garden.seedmap.csv'), 'utf8');
    for (const { cardName } of branchInfos) {
      expect(overallMd).toContain(cardName);
      expect(overallCsv).toContain(cardName);
    }
    for (const { cardName } of branchInfos) {
      const leafMd = fs.readdirSync(path.join(output, 'leaves'))
        .find((file) => file.endsWith('.md')
          && fs.readFileSync(path.join(output, 'leaves', file), 'utf8').includes(cardName));
      expect(leafMd).toBeDefined();
      const markdown = fs.readFileSync(path.join(output, 'leaves', leafMd), 'utf8');
      const csv = fs.readFileSync(path.join(output, 'leaves', leafMd.replace('.md', '.csv')), 'utf8');
      expect(markdown).toContain(cardName);
      expect(csv).toContain(cardName);
      for (const other of branchInfos.filter((entry) => entry.cardName !== cardName)) {
        expect(markdown).not.toContain(other.cardName);
        expect(csv).not.toContain(other.cardName);
      }
    }
  });
});
