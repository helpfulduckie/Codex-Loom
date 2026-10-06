'use strict';

/**
 * Pack findings grouped across leaves, and `lint.scenario: false`.
 *
 * A card that renders identically on many leaves raises the identical finding on each, so a
 * project with a dozen views of one library reported every base-size problem a dozen times.
 * Findings that agree on everything but the branch are reported once and name the branches.
 * Integration because the grouping lives in `compile.js:runPackChecks`, across leaves.
 */

const { compileProject } = require('../helpers/project');

const find = (d, code) => d.all.filter((x) => x.code === code);
const BUDGET = 'CL-duckieConv/0001';
const COUNT = 'CL-duckieConv/0002';

const TEMPLATE = { 'templates/Card.template': '{$body.Text}' };

const config = (branches, lintBlock = ['lint: {packs: {duckieConv: {}}}']) => [
  'version: 4',
  'structure:',
  '  input:',
  '    items: [%TMP%/Codex]',
  '    templates: [%TMP%/templates]',
  '  output: %TMP%/output',
  ...lintBlock,
  'branches:',
  ...branches.map((b) => `  ${b}: {}`),
].join('\n');

/** `long` names the branches on which the card's body runs past the 400 standard budget. */
const item = ({ id = 'npc', long = null, extra = '' } = {}) => [
  `- id: ${id}`,
  `  name: ${id}`,
  `  aid: {type: Character, triggers: [${id}]}`,
  '  render: {template: Card}',
  `  body: {Text: ${long ? 'short' : 'x'.repeat(500)}}`,
  ...(long ? [
    '  variants:',
    `    long: {body: {Text: ${'x'.repeat(500)}}}`,
    `  branches: {${long.map((b) => `${b}: long`).join(', ')}}`,
  ] : []),
  extra,
].join('\n');

describe('a pack finding raised identically on several leaves', () => {
  test('is reported once, naming every branch when all of them raised it', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['a', 'b', 'c']),
      'Codex/items.yaml': item(),
    });
    const hits = find(d, BUDGET);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('card "npc" on all 3 branches:');
    expect(hits[0].message).toContain('this card\'s body is 500');
  });

  test('lists the branches when only some of them raised it', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['a', 'b', 'c']),
      'Codex/items.yaml': item({ long: ['a', 'c'] }),
    });
    const hits = find(d, BUDGET);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('on branches "a", "c":');
  });

  test('keeps the single-branch wording when one leaf raised it', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['a', 'b']),
      'Codex/items.yaml': item({ long: ['b'] }),
    });
    const hits = find(d, BUDGET);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('card "npc" on branch "b":');
  });

  test('stays separate per branch when the finding differs, as a card of another length does', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['a', 'b']),
      'Codex/items.yaml': [
        '- id: npc',
        '  name: npc',
        '  aid: {type: Character, triggers: [npc]}',
        '  render: {template: Card}',
        `  body: {Text: ${'x'.repeat(450)}}`,
        '  variants:',
        `    longer: {body: {Text: ${'x'.repeat(600)}}}`,
        '  branches: {b: longer}',
      ].join('\n'),
    });
    const hits = find(d, BUDGET);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.message).join('\n')).toMatch(/on branch "a".*450/);
    expect(hits.map((h) => h.message).join('\n')).toMatch(/on branch "b".*600/);
  });

  test('an item-rule finding is grouped the same way', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['a', 'b']),
      'Codex/items.yaml': item({ extra: '  meta: {}' }).replace(
        '  body: {Text:',
        '  body: {Tagline: one two three four five six seven, Text:',
      ),
    });
    const hits = find(d, COUNT);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('on all 2 branches');
  });
});

describe('lint.scenario: false', () => {
  const project = (scenario, packs = 'duckieConv: {}, wtg: {}') => compileProject({
    ...TEMPLATE,
    'compile.yaml': config(['a', 'b'], [`lint: {scenario: ${scenario}, packs: {${packs}}}`]),
    'Codex/items.yaml': item(),
  });

  test('drops the per-leaf opening and AI Instructions warnings', () => {
    const d = project(false).diagnostics;
    expect(find(d, 'CL0630')).toHaveLength(0);
    expect(find(d, 'CL0631')).toHaveLength(0);
  });

  test("drops a pack's requireCard existence check", () => {
    expect(find(project(false).diagnostics, 'CL-wtg/0002')).toHaveLength(0);
  });

  test('keeps the per-card pack checks', () => {
    expect(find(project(false).diagnostics, BUDGET)).toHaveLength(1);
  });

  test('true behaves as the default and keeps all three', () => {
    const d = project(true).diagnostics;
    expect(find(d, 'CL0630')).toHaveLength(2);
    expect(find(d, 'CL0631')).toHaveLength(2);
    expect(find(d, 'CL-wtg/0002')).toHaveLength(1);
  });

  test('is a root-only key; a branch declaring it is rejected', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'branches:',
        '  a:',
        '    lint: {scenario: false}',
      ].join('\n'),
      'Codex/items.yaml': item(),
    });
    expect(d.all.some((x) => x.severity === 'error' && /scenario/.test(x.message))).toBe(true);
  });
});
