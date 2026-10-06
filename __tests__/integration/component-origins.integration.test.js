'use strict';

/**
 * Where a component or branch-config finding points, through a real compile.
 *
 * Each case pairs a value a branch overrides with one it inherits, because the failure these
 * guard against is plausible either way: a finding that names the config file, or names the
 * branch key for a value the branch never touched, still reads like a location.
 */

const path = require('path');
const { compileProject } = require('../helpers/project');
const { CODES } = require('../../src/diag');

const PROJECT = {
  'compile.yaml': [
    'version: 4',
    'structure:',
    '  input:',
    '    items: [%TMP%/Codex]',
    '    templates: [%TMP%/templates]',
    '  output: %TMP%/output',
    'components:',
    '  plotEssential: ./components/pe.yaml',
    '  opening: "Root %unknown%."',
    'branches:',
    '  main: {}',
    '  alt:',
    '    components:',
    '      plotEssential: ./components/missing.yaml',
    '      opening: "Mind %ghost%."',
    '    variables:',
    '      ghost: ~',
    '  framed:',
    '    components:',
    '      branchFraming: Leaf framing.',
  ].join('\n'),
  'components/pe.yaml': [
    'sections:',
    '  intro:',
    '    text: Intro',
    '  cast:',
    '    slot: true',
  ].join('\n'),
  'templates/Character.template': '{$body.text}',
  'Codex/items.yaml': [
    '- id: Typo',
    '  name: Typo',
    '  aid: {type: Character}',
    '  body: {text: body}',
    '  render:',
    '    plotEssential:',
    '      slot: casst',
  ].join('\n'),
};

let result;
let config;
beforeAll(() => {
  result = compileProject(PROJECT);
  config = path.join(result.tmpDir, 'compile.yaml');
});

const found = (code) => result.diagnostics.all.filter((d) => d.code === code);
const where = (code) => found(code).map((d) => [path.basename(d.file), d.line, d.branch]);

test('a branch component override is reported at the branch key that chose it', () => {
  expect(found(CODES.YAML_FILE_UNREADABLE)).toEqual([
    expect.objectContaining({ file: config, line: 14 }),
  ]);
  const gap = found(CODES.COMPONENT_NO_OUTPUT).find((d) => d.message.startsWith('[alt] Plot Essentials'));
  expect(gap).toMatchObject({ file: config, line: 14 });
});

test('inline prose is located at its config key, the override on its branch and the root elsewhere', () => {
  expect(where(CODES.PLACEHOLDER_UNDECLARED).sort()).toEqual([
    ['compile.yaml', 15, 'alt'],
    ['compile.yaml', 9, 'framed'],
    ['compile.yaml', 9, 'main'],
  ]);
});

test('branch-merged config and framing findings name the branch key', () => {
  expect(where(CODES.VARIABLE_UNBIND_UNKNOWN)).toEqual([['compile.yaml', 17, 'alt']]);
  expect(found(CODES.BRANCH_FRAMING_IGNORED)).toEqual([
    expect.objectContaining({ file: config, line: 20 }),
  ]);
});

test('slot findings point at the slot section and at the item target, with the component related', () => {
  const pe = path.join(result.tmpDir, 'components', 'pe.yaml');
  expect(found(CODES.SLOT_EMPTY).map((d) => [d.file, d.line])).toEqual([[pe, 4], [pe, 4]]);

  const target = found(CODES.TARGET_UNDECLARED_SLOT);
  expect(target.map((d) => d.branch).sort()).toEqual(['framed', 'main']);
  expect(target[0]).toMatchObject({ file: path.join(result.tmpDir, 'Codex', 'items.yaml'), line: 7 });
  expect(target[0].related).toEqual([
    { label: 'Plot Essentials sections', file: pe, line: 1, col: 1 },
  ]);
  expect(target[0].format()).toContain(`Related (Plot Essentials sections): ${pe}:1:1`);
});

describe('findings inside component documents and per-node config values', () => {
  const SCAFFOLD = [
    'version: 4',
    'structure:',
    '  input:',
    '    items: [%TMP%/Codex]',
    '    templates: [%TMP%/templates]',
    '  output: %TMP%/output',
  ];
  const ITEMS = {
    'templates/Character.template': '{$body.text}',
    'Codex/items.yaml': '- id: Hero\n  name: Hero\n  aid: {type: Character}\n  body: {text: body}\n',
  };

  test('entries, metadata, titles, questions and an inline opening point at their own keys', () => {
    const { diagnostics, tmpDir } = compileProject({
      ...ITEMS,
      'compile.yaml': [
        ...SCAFFOLD,
        'placeholders:',
        '  hero: "Hero name?"',
        'components:',
        '  plotEssential: ./components/pe.yaml',
        '  aiInstructions: ./components/ai.yaml',
        'branches:',
        '  main:',
        '    title: "Play as %hero%"',
        '    placeholders:',
        '      rival: "Rival of %nobody%?"',
        '    components:',
        `      opening: "${'x'.repeat(4100)}"`,
      ].join('\n'),
      'components/pe.yaml': [
        'sections:',
        '  intro:',
        '    text: Intro',
        'render:',
        '  storyCards:',
        '    - title: Ref',
        '      sections:',
        '        - intro',
        '        - nope',
      ].join('\n'),
      'components/ai.yaml': 'metadata:\n  tags: [x]\nsections:\n  rule:\n    text: Be kind.\n',
    });
    const config = path.join(tmpDir, 'compile.yaml');
    const one = (code) => {
      const hits = diagnostics.all.filter((d) => d.code === code);
      expect(hits).toHaveLength(1);
      return hits[0];
    };

    expect(one(CODES.STORY_CARD_ENTRY_UNKNOWN_SECTION))
      .toMatchObject({ file: path.join(tmpDir, 'components', 'pe.yaml'), line: 9 });
    expect(one(CODES.COMPONENT_METADATA_UNSUPPORTED))
      .toMatchObject({ file: path.join(tmpDir, 'components', 'ai.yaml'), line: 1 });
    expect(one(CODES.PLACEHOLDER_IN_TITLE)).toMatchObject({ file: config, line: 14 });
    expect(one(CODES.PLACEHOLDER_UNDECLARED)).toMatchObject({ file: config, line: 16 });
    expect(one(CODES.OPENING_OVER_LIMIT)).toMatchObject({ file: config, line: 18 });
  });

  test('a description key collision names the scenario blurb and relates the adventure description', () => {
    const { diagnostics, tmpDir } = compileProject({
      ...ITEMS,
      'compile.yaml': [
        ...SCAFFOLD,
        'components:',
        '  description: ./components/desc.md',
        '  adventureDescription: ./components/adv.md',
      ].join('\n'),
      'components/desc.md': 'The blurb.\n',
      'components/adv.md': 'The adventure.\n',
    });
    const config = path.join(tmpDir, 'compile.yaml');
    const collide = diagnostics.all.find((d) => d.code === CODES.DESCRIPTION_KEYS_COLLIDE);
    expect(collide).toMatchObject({ file: config, line: 8 });
    expect(collide.related).toEqual([
      expect.objectContaining({ label: 'adventureDescription', file: config, line: 9 }),
    ]);
  });
});
