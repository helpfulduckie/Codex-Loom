'use strict';

const fs = require('fs');
const path = require('path');
const { withTmpDir, writeTree, compileProject } = require('../helpers/project');
const { preview } = require('../../src/compile');
const { CODES, Diagnostics } = require('../../src/diag');
const { loadFieldTable } = require('../../src/loader/field-table');
const { originAt } = require('../../src/origin');
const { mergeUnbindable } = require('../../src/model/branches');

const config = (extra = []) => [
  'version: 4',
  'structure:',
  '  input:',
  '    items: [%TMP%/items]',
  '    templates: [%TMP%/templates]',
  '  output: %TMP%/output',
  ...extra,
].join('\n');

function previewProject(files) {
  const dir = withTmpDir();
  writeTree(dir, files);
  return { dir, result: preview(path.join(dir, 'compile.yaml')) };
}

const diagnosticsWith = (result, code) => result.diagnostics.filter((d) => d.code === code);
const expectNoErrors = (result) => {
  expect(result.diagnostics.filter((d) => String(d.severity).toLowerCase() === 'error')).toEqual([]);
};

describe('case-insensitive key identity across YAML source layers', () => {
  test('a project item body collision blocks tolerant preview', () => {
    const { result } = previewProject({
      'templates/Item.template': '{$body.Name}',
      'items/items.yaml': [
        '- id: item', '  name: Item', '  aid: {type: Item}',
        '  body:', '    Name: one', '    name: two',
      ].join('\n'),
      'compile.yaml': config(),
    });
    expect(result.status).toBe('blocked');
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(1);
  });

  test('a config collision blocks tolerant preview', () => {
    const { result } = previewProject({
      'compile.yaml': config(['variables:', '  Mood: bright', '  mood: dark']),
    });
    expect(result.status).toBe('blocked');
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(1);
  });

  test('case-only keys collide recursively in variants and branch dispatch', () => {
    const { result } = previewProject({
      'items/items.yaml': [
        '- id: item', '  name: Item', '  aid: {type: Item}',
        '  variants:', '    First:', '      body: {Name: one, name: two}',
        '    first:', '      body: {Name: three}',
        '  branches:', '    plain: {Name: one, name: two}',
      ].join('\n'),
      'templates/Item.template': '{$body.Name}',
      'compile.yaml': config(['branches:', '  plain: {}']),
    });
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(2);
  });

  test('case-only collisions are checked in nested config scopes', () => {
    const { result } = previewProject({
      'compile.yaml': [
        'version: 4', 'structure:', '  input:', '    items: [%TMP%/items]',
        '    templates: [%TMP%/templates]', '    library: {Shared: ./library, shared: ./other-library}',
        '  output: %TMP%/output', 'variables: {Mood: bright, mood: dark}',
        'roles: {Guide: guide, guide: other-guide}',
        'branches:', '  Plain: {variables: {Tone: calm, tone: loud}}',
      ].join('\n'),
    });
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE).length).toBeGreaterThanOrEqual(4);
  });

  const collidingSections = [
    'sections:', '  premise:', '    text: First', '  Premise:', '    text: Second',
  ].join('\n');

  test('a component section collision blocks the load', () => {
    const { result } = previewProject({
      'components/ai.cl.yaml': collidingSections,
      'compile.yaml': config(['components:', '  aiInstructions: ./components/ai.cl.yaml']),
    });
    expect(result.status).toBe('blocked');
    expect(result.files).toEqual([]);
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(1);
  });

  test('every colliding component is reported in one run, the description included', () => {
    const { result } = previewProject({
      'components/ai.cl.yaml': collidingSections,
      'components/description.cl.yaml': collidingSections,
      'compile.yaml': config([
        'components:', '  aiInstructions: ./components/ai.cl.yaml',
        '  description: ./components/description.cl.yaml',
      ]),
    });
    expect(result.status).toBe('blocked');
    expect(result.files).toEqual([]);
    const files = diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE).map((d) => path.basename(d.file));
    expect(files.sort()).toEqual(['ai.cl.yaml', 'description.cl.yaml']);
  });

  test('a collision in an imported component blocks the load once', () => {
    const { result } = previewProject({
      'components/shared.cl.yaml': collidingSections,
      'components/ai.cl.yaml': ['imports:', '  - from: ./components/shared.cl.yaml'].join('\n'),
      'components/note.cl.yaml': ['imports:', '  - from: ./components/shared.cl.yaml'].join('\n'),
      'compile.yaml': config([
        'components:', '  aiInstructions: ./components/ai.cl.yaml',
        '  authorsNote: ./components/note.cl.yaml',
      ]),
    });
    expect(result.status).toBe('blocked');
    const found = diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE);
    expect(found).toHaveLength(1);
    expect(path.basename(found[0].file)).toBe('shared.cl.yaml');
  });

  test('a collision in a component a branch names through its own variable blocks the load', () => {
    const { result } = previewProject({
      'components/loud.cl.yaml': collidingSections,
      'components/quiet.cl.yaml': ['sections:', '  premise:', '    text: Fine'].join('\n'),
      'compile.yaml': config([
        'variables: {Tone: quiet}',
        'components:', "  aiInstructions: './components/{%Tone}.cl.yaml'",
        'branches:', '  plain: {}', '  other:', '    variables: {tone: loud}',
        "    components: {aiInstructions: './components/{%Tone}.cl.yaml'}",
      ]),
    });
    expect(result.status).toBe('blocked');
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(1);
  });

  test('a collision in an inherited component path a branch variable redirects blocks the load', () => {
    const { result } = previewProject({
      'components/loud.cl.yaml': collidingSections,
      'components/quiet.cl.yaml': ['sections:', '  premise:', '    text: Fine'].join('\n'),
      'compile.yaml': config([
        'variables: {Tone: quiet}',
        'components:', "  aiInstructions: './components/{%Tone}.cl.yaml'",
        'branches:', '  plain: {}', '  group:', '    variables: {tone: loud}',
        '    branches:', '      deep: {}',
      ]),
    });
    expect(result.status).toBe('blocked');
    expect(result.files).toEqual([]);
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(1);
  });

  test('branch variable overrides expand in the emitted Placeholders.yaml', () => {
    const { result } = previewProject({
      'compile.yaml': [
        'version: 4', 'structure:', '  input:', '    items: [%TMP%/items]',
        '    templates: [%TMP%/templates]', '  output: %TMP%/output',
        'variables: {Mood: calm}', 'branches:', '  override:',
        '    variables: {mood: bright}', '    placeholders: {ask: "What is {%Mood}?"}',
      ].join('\n'),
    });
    const placeholderFiles = result.files.filter((file) => file.path.endsWith('Placeholders.yaml'));
    expect(placeholderFiles.some((file) => file.path.includes('override')
      && file.content.includes('What is bright?'))).toBe(true);
  });

  test('templateFor collisions include the earlier key location', () => {
    const { result } = previewProject({
      'templates/slot.cl.yaml': [
        'templates:', '  Item: [name]', '  item: [name]',
      ].join('\n'),
      'compile.yaml': config(['templateFor:', '  base: ./templates/slot.cl.yaml']),
    });
    const [diagnostic] = diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE);
    expect(diagnostic).toBeDefined();
    expect(diagnostic.file).toMatch(/slot\.cl\.yaml$/);
    expect(diagnostic.line).toBe(3);
    expect(diagnostic.related).toHaveLength(1);
    expect(diagnostic.related[0].line).toBe(2);
  });

  test('field table collisions block tolerant preview', () => {
    const { result } = previewProject({
      'templates/fields.cl.yaml': [
        'fields:', '  Name: {label: Name}', '  name: {label: Other}',
      ].join('\n'),
      'compile.yaml': config(),
    });
    expect(result.status).toBe('blocked');
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(1);
  });

  test('field, group, and template references resolve case-insensitively across layers', () => {
    const { result } = previewProject({
      'shared/fields.cl.yaml': [
        'fields:', '  Name: {label: Shared Name}',
        'groups:', '  Core: [NAME]',
        'templates:', '  Character: [core]',
      ].join('\n'),
      'templates/fields.cl.yaml': [
        'fields:', '  name: {label: Project Name}',
        'groups:', '  CORE: [name]',
        'templates:', '  character:', '    - {field: NAME, label: Project Name}', '    - CORE',
      ].join('\n'),
      'items/items.yaml': [
        '- id: item', '  name: Item', '  aid: {type: CHARACTER}',
        '  render: {template: CHARACTER}', '  body: {NAME: Ada}',
      ].join('\n'),
      'compile.yaml': [
        'version: 4', 'structure:', '  input:', '    items: [%TMP%/items]',
        '    templates: [%TMP%/shared, %TMP%/templates]', '  output: %TMP%/output',
      ].join('\n'),
    });
    expect(result.status).toBe('ok');
    expectNoErrors(result);
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(0);
    expect(result.files.some((file) => file.content.includes('Project Name: Ada'))).toBe(true);
  });

  test('templateFor role and type keys override inherited lists case-insensitively', () => {
    const { result } = previewProject({
      'templates/fields.cl.yaml': [
        'fields:', '  name: {label: Name}', '  detail: {label: Detail}',
        'templates:', '  Character: [name, detail]',
      ].join('\n'),
      'templates/full.cl.yaml': ['templates:', '  Character: [NAME, detail]'].join('\n'),
      'templates/terse.cl.yaml': ['templates:', '  character: [Name]'].join('\n'),
      'items/items.yaml': [
        '- id: hero', '  name: Hero', '  aid: {type: CHARACTER}',
        '  body: {NAME: Ada, detail: "Keeps the gate"}',
      ].join('\n'),
      'compile.yaml': [
        'version: 4', 'structure:', '  input:', '    items: [%TMP%/items]',
        '    templates: [%TMP%/templates]', '  output: %TMP%/output',
        'templateFor:', '  Base: ./templates/full.cl.yaml',
        'branches:', '  full: {}', '  terse:', '    templateFor:', '      base: ./templates/terse.cl.yaml',
      ].join('\n'),
    });
    expect(result.status).toBe('ok');
    expectNoErrors(result);
    const cards = result.files.filter((file) => file.path.endsWith('Story Cards/character/character.md'));
    expect(cards.some((file) => file.content.includes('Detail: Keeps the gate'))).toBe(true);
    expect(cards.some((file) => !file.content.includes('Detail: Keeps the gate'))).toBe(true);
  });

  test('an inherited variable override matches its declaration case-insensitively', () => {
    const { result } = previewProject({
      'items/items.yaml': [
        '- id: guide', '  name: Guide', '  aid: {type: Item}', '  body: {Name: Guide}',
        '- id: hero', '  name: Hero', '  aid: {type: Item}', '  body: {Name: Hero}',
      ].join('\n'),
      'templates/Item.template': '{$body.Name} ({%Mood})',
      'compile.yaml': [
        'version: 4', 'structure:', '  input:', '    items: [%TMP%/items]',
        '    templates: [%TMP%/templates]', '  output: %TMP%/output',
        'variables: {Mood: calm}',
        'branches:', '  override:', '    variables: {mood: bright}',
      ].join('\n'),
    });
    expect(result.status).toBe('ok');
    expectNoErrors(result);
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(0);
    expect(result.files.some((file) => file.content.includes('Hero (bright)'))).toBe(true);
  });

  test('role casing overrides and unbinds inherited bindings', () => {
    const { result } = previewProject({
      'items/items.yaml': [
        '- id: guide', '  name: Guide', '  aid: {type: Item}', '  body: {Name: Guide}',
        '- id: hero', '  name: Hero', '  aid: {type: Item}', '  body: {Name: Hero}',
      ].join('\n'),
      'templates/Item.template': '{$body.Name}',
      'compile.yaml': [
        'version: 4', 'structure:', '  input:', '    items: [%TMP%/items]',
        '    templates: [%TMP%/templates]', '  output: %TMP%/output',
        'roles: {Helper: guide}', 'branches:',
        '  override: {roles: {helper: hero}}',
        '  removed: {roles: {helper: ~}}',
      ].join('\n'),
    });
    expect(result.status).toBe('ok');
    expectNoErrors(result);
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(0);
    expect(result.leaves.find((leaf) => leaf.label === 'override').roles.Helper).toBe('hero');
    expect(result.leaves.find((leaf) => leaf.label === 'removed').roles).not.toHaveProperty('Helper');
    expect(result.diagnostics.some((d) => d.code === CODES.ROLE_UNBIND_UNKNOWN)).toBe(false);
  });

  test('field table tilde unbinds case-insensitively and keeps the surviving origin spelling', () => {
    const dir = withTmpDir();
    writeTree(dir, {
      'shared/fields.cl.yaml': 'fields:\n  Name: {label: Shared Name}\n',
      'removed/fields.cl.yaml': 'fields:\n  name: ~\n',
      'project/fields.cl.yaml': 'fields:\n  naMe: {label: Project Name}\n',
    });
    const diagnostics = new Diagnostics();
    const shared = loadFieldTable([
      path.join(dir, 'shared'), path.join(dir, 'removed'),
    ], { diagnostics });
    expect(shared.fields.Name).toBeNull();
    const table = loadFieldTable([
      path.join(dir, 'shared'), path.join(dir, 'removed'), path.join(dir, 'project'),
    ], { diagnostics });
    expect(table.fields).toHaveProperty('Name');
    expect(table.fields.Name.label).toBe('Project Name');
    expect(originAt(table, ['fields', 'Name'])).toMatchObject({
      file: path.join(dir, 'project', 'fields.cl.yaml'),
      path: ['fields', 'naMe'],
    });
    expect(diagnostics.errors).toHaveLength(0);
  });

  test('variable tilde unbinds an inherited key case-insensitively', () => {
    expect(mergeUnbindable({ Mood: 'calm' }, { mood: null }, {
      kind: 'variable', onWarn: null,
    })).toEqual({});
  });

  test('item v and vars aliases share one case-insensitive namespace', () => {
    const { result } = previewProject({
      'items/items.yaml': [
        '- id: item', '  name: Item', '  aid: {type: Item}',
        '  v: {Tone: one}', '  vars: {tone: two}',
      ].join('\n'),
      'templates/Item.template': '{$v.Tone}',
      'compile.yaml': config(),
    });
    expect(result.status).toBe('ok');
    expectNoErrors(result);
    expect(result.files.some((file) => file.content.includes('two'))).toBe(true);
  });

  test('a case-changed inherited pack unbind produces no unknown-unbind diagnostic', () => {
    const { diagnostics } = compileProject({
      'templates/Card.template': '{$body.Text}',
      'items/items.yaml': [
        '- id: gate', '  name: Gate', '  aid: {type: Character}', '  render: {template: Card}',
        '  body: {Text: "[e] /]"}',
      ].join('\n'),
      'compile.yaml': [
        'version: 4', 'structure:', '  input:', '    items: [%TMP%/items]',
        '    templates: [%TMP%/templates]', '  output: %TMP%/output',
        'lint: {packs: {wtg: {}}}', 'branches:',
        '  bound: {}', '  freed: {lint: {packs: {WTG: ~}}}',
      ].join('\n'),
    });
    expect(diagnostics.all.some((d) => d.code === 'CL0118')).toBe(false);
    const findings = diagnostics.all.filter((d) => d.code === 'CL-wtg/0001');
    expect(findings).toHaveLength(1);
    expect(findings[0].branches).toEqual(['bound']);
  });

  test('a case-changed pack level off disables the inherited pack on that branch', () => {
    const { diagnostics } = compileProject({
      'templates/Card.template': '{$body.Text}',
      'items/items.yaml': [
        '- id: gate', '  name: Gate', '  aid: {type: Character}', '  render: {template: Card}',
        '  body: {Text: "[e] /]"}',
      ].join('\n'),
      'compile.yaml': [
        'version: 4', 'structure:', '  input:', '    items: [%TMP%/items]',
        '    templates: [%TMP%/templates]', '  output: %TMP%/output',
        'lint: {packs: {wtg: {}}}', 'branches:',
        '  active: {}', '  quiet: {lint: {packs: {WTG: {level: off}}}}',
      ].join('\n'),
    });
    const findings = diagnostics.all.filter((d) => d.code === 'CL-wtg/0001');
    expect(findings).toHaveLength(1);
    expect(findings[0].branches).toEqual(['active']);
  });

  test('case-only sibling convention pack keys are a duplicate-key error', () => {
    const { result } = previewProject({
      'compile.yaml': config(['lint:', '  packs:', '    wtg: {}', '    WTG: {}']),
    });
    expect(result.status).toBe('blocked');
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(1);
  });

  test('case-distinct metadata keys are not treated as identities', () => {
    const { result } = previewProject({
      'items/items.yaml': [
        '- id: item', '  name: Item', '  aid: {type: Item}',
        '  meta: {Color: blue, color: green}',
      ].join('\n'),
      'templates/Item.template': '{$body.Name}',
      'compile.yaml': config(),
    });
    expect(diagnosticsWith(result, CODES.DUPLICATE_KEY_CASE)).toHaveLength(0);
  });

  test('same-spelling duplicates remain YAML parse errors', () => {
    const { diagnostics } = compileProject({
      'compile.yaml': config(),
      'items/items.yaml': [
        '- id: item', '  name: Item', '  aid: {type: Item}',
        '  body:', '    Name: one', '    Name: two',
      ].join('\n'),
      'templates/Item.template': '{$body.Name}',
    });
    expect(diagnostics.all.map((d) => d.code)).toContain(CODES.YAML_PARSE_FAILED);
    expect(diagnostics.all.map((d) => d.code)).not.toContain(CODES.DUPLICATE_KEY_CASE);
  });
});
