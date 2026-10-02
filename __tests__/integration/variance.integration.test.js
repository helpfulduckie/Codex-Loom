'use strict';

/**
 * The variance report, end to end: versions grouped by item across leaves, labeled by the
 * variants that produced them, diffed along that chain, with role bindings named where they
 * are what tells two versions apart.
 */

const fs = require('fs');
const path = require('path');
const { withTmpDir, writeTree } = require('../helpers/project');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');

const FILES = {
  'templates/Card.template': '{$body.Tagline}\nSkills: {$body.Skills}',
  'compile.yaml': [
    'version: 4',
    'title: Probe',
    'structure:',
    '  input:',
    '    items: [%TMP%/Codex]',
    '    templates: [%TMP%/templates]',
    '  output: %TMP%/output',
    '  reports: %TMP%/Review',
    'branches:',
    '  standard: {}',
    '  major: {}',
    '  anchor:',
    '    branches:',
    '      plain: {}',
    '      hero:',
    '        roles: {protagonist: Melli}',
    '      exile: {}',
  ].join('\n'),
  'Codex/items.yaml': [
    '- id: Melli',
    '  name: Melli Brekhari',
    '  pronouns: female',
    '  aid: {type: Character, triggers: [Melli]}',
    '  render: {template: Card}',
    '  body:',
    '    Tagline: "{$Melli.she} tame[s] monsters"',
    '    Skills: taming',
    '  variants:',
    '    major:',
    '      body: {Skills: taming; spores}',
    '      variants:',
    '        anchor: {body: {Skills: taming; spores; hyphae}}',
    '    exile: {name: Melli Brambel}',
    '  branches:',
    '    major: major',
    '    anchor:',
    '      apply: [major/anchor]',
    '      branches: {exile: exile}',
    '- id: Hermit',
    '  name: Hermit',
    '  aid: {type: Character, triggers: [Hermit]}',
    '  render: {template: Card}',
    '  body: {Tagline: Lives alone, Skills: none}',
    '  branches: {standard: ~}',
    '- id: Guard',
    '  name: Guard',
    '  aid: {type: Character, triggers: [Guard]}',
    '  render: {template: Card}',
    '  body: {Tagline: Watches, Skills: none}',
  ].join('\n'),
};

let doc;
beforeAll(() => {
  const tmpDir = withTmpDir();
  writeTree(tmpDir, FILES);
  compile(path.join(tmpDir, 'compile.yaml'), { diagnostics: new Diagnostics(), variance: true });
  doc = fs.readFileSync(path.join(tmpDir, 'Review', 'variance', 'Probe.variance.md'), 'utf8');
});

const section = (heading) => {
  const start = doc.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`no section ${heading}`);
  const next = doc.indexOf('\n### ', start + heading.length + 2);
  const nextItem = doc.indexOf('\n## ', start + heading.length + 2);
  const ends = [next, nextItem].filter((n) => n > 0);
  return doc.slice(start, ends.length ? Math.min(...ends) : undefined);
};

describe('the variance report', () => {
  test('groups a card renamed by a variant under one item entry', () => {
    expect(doc).toContain('## Melli Brekhari / Melli Brambel');
    expect(doc).toContain('one item, `melli`, renamed by its variants');
  });

  test('lists each version once with the branches that receive it, in lineage order', () => {
    const rows = doc.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Version'));
    const melli = rows.slice(0, 5).map((r) => r.split(' | ')[0].replace('| ', ''));
    expect(melli).toEqual([
      'base', 'major', 'major/anchor', 'major/anchor · protagonist: Melli', 'major/anchor + exile',
    ]);
  });

  test('prints the base in full', () => {
    expect(section('### base')).toContain('she tames monsters');
  });

  test('diffs a nested path against its parent path, marking only what changed', () => {
    const s = section('### major/anchor');
    expect(s).toContain('_against major_');
    expect(s).toContain('Skills: taming; spores; **hyphae**');
    expect(s).not.toContain('tames monsters');
  });

  test('omits the meta block, which never reaches AID', () => {
    expect(doc).not.toContain('meta:');
  });

  test('shows the protagonist rendering word by word, conjugation included', () => {
    const s = section('### major/anchor · protagonist: Melli');
    expect(s).toContain('_against major/anchor_');
    expect(s).toContain('~~she tames~~ **you tame** monsters');
    expect(s).not.toContain('encapsulate');
  });

  test('names the branches an item is absent from', () => {
    expect(doc).toMatch(/## Hermit[\s\S]*?\| — \| standard \|/);
  });

  test('counts an item that renders the same everywhere without listing it', () => {
    expect(doc).not.toContain('## Guard');
    expect(doc).toContain('2 items vary; 1 render the same on every branch.');
  });
});
