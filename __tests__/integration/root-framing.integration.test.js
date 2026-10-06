'use strict';


const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics, CODES } = require('../../src/diag');
const { withTmpDir, writeTree, compileProject } = require('../helpers/project');

let tmpDir;
let diagnostics;

const outPath = (...parts) => path.join(tmpDir, 'out', ...parts);
const read = (...parts) => fs.readFileSync(outPath(...parts), 'utf8');

beforeAll(() => {
  tmpDir = withTmpDir();
  writeTree(tmpDir, {
    'templates/Character.template': '{$name}\n',

    'Codex/items.yaml': [
    '- id: Aness',
    '  name: Aness',
    '  pronouns: female',
    '  aid: {type: Character, triggers: [Aness]}',
    '  render: {template: Character, wrapper: none}',
    '',
    '- id: Kaiden',
    '  name: Kaiden',
    '  pronouns: male',
    '  aid: {type: Character, triggers: [Kaiden]}',
    '  render: {template: Character, wrapper: none}',
    '',
    ].join('\n'),

    'components/root-framing.yaml': [
    'sections:',
    '  choice:',
    '    text: |',
    '      Your bond, {$LI}, is waiting near {%main}. Which road do you take?',
    '',
    ].join('\n'),

    'compile.yaml': [
    'version: 4',
    'title: Root Framing Probe',
    'structure:',
    '  input:',
    "    items: ['./Codex']",
    "    templates: ['./templates']",
    '    library:',
    "      main: './canon'",
    "  output: './out'",
    'roles:',
    '  protagonist: Aness',
    '  LI: Kaiden',
    'components:',
    '  branchFraming: ./components/root-framing.yaml',
    'branches:',
    '  subject: {}',
    '',
    ].join('\n'),
  });

  fs.mkdirSync(path.join(tmpDir, 'canon'), { recursive: true });

  diagnostics = new Diagnostics();
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics });
  } catch (err) { /* ERRORs are the subject; the throw carries only a count */ }
});

test('no error-level diagnostic — the project compiles cleanly', () => {
  const errors = diagnostics.all.filter((d) => d.severity === 'error');
  expect(errors).toEqual([]);
});

test('root branchFraming renders the sections document, not a literal sentence', () => {
  expect(read('Components', 'Opening.md')).toBe(
    'Your bond, Kaiden, is waiting near '
    + path.join(tmpDir, 'canon')
    + '. Which road do you take?\n',
  );
});

test('the undeclared-placeholder check runs at root framing, where the old rung skipped it', () => {
  const found = diagnostics.all.filter((d) => d.code === CODES.PLACEHOLDER_UNDECLARED);
  expect(found).toEqual([]);
});

describe('root branchFraming — inline sentence arm', () => {
  let dir;
  let diag;
  const readOut = (...p) => fs.readFileSync(path.join(dir, 'out', ...p), 'utf8');

  beforeAll(() => {
    ({ tmpDir: dir, diagnostics: diag } = compileProject({
      'templates/Character.template': '{$name}\n',
      'Codex/items.yaml': [
        '- id: Aness',
        '  name: Aness',
        '  pronouns: female',
        '  aid: {type: Character, triggers: [Aness]}',
        '  render: {template: Character, wrapper: none}',
        '',
        '- id: Kaiden',
        '  name: Kaiden',
        '  pronouns: male',
        '  aid: {type: Character, triggers: [Kaiden]}',
        '  render: {template: Character, wrapper: none}',
        '',
      ].join('\n'),
      'compile.yaml': [
        'version: 4',
        'title: Inline Root Framing Probe',
        'structure:',
        '  input:',
        "    items: ['./Codex']",
        "    templates: ['./templates']",
        "  output: './out'",
        'roles:',
        '  protagonist: Aness',
        '  LI: Kaiden',
        'components:',
        '  branchFraming: "Your bond, {$LI}, is already at the gate. Which road?"',
        'branches:',
        '  subject: {}',
        '',
      ].join('\n'),
    }));
  });

  test('compiles with no error-level diagnostic', () => {
    expect(diag.all.filter((d) => d.severity === 'error')).toEqual([]);
  });

  test('the {$LI} role resolves to its item, with no leaked-token sweep hit', () => {
    expect(readOut('Components', 'Opening.md')).toBe(
      'Your bond, Kaiden, is already at the gate. Which road?\n',
    );
    expect(diag.all.filter((d) => d.code === CODES.LEAKED_FIELD_TOKEN)).toEqual([]);
  });
});

describe('root branchFraming — undeclared variable in the inline arm', () => {
  let diag;

  beforeAll(() => {
    ({ diagnostics: diag } = compileProject({
      'templates/Character.template': '{$name}\n',
      'Codex/items.yaml': [
        '- id: Aness',
        '  name: Aness',
        '  pronouns: female',
        '  aid: {type: Character, triggers: [Aness]}',
        '  render: {template: Character, wrapper: none}',
        '',
      ].join('\n'),
      'compile.yaml': [
        'version: 4',
        'title: Undeclared Framing Variable Probe',
        'structure:',
        '  input:',
        "    items: ['./Codex']",
        "    templates: ['./templates']",
        "  output: './out'",
        'roles:',
        '  protagonist: Aness',
        'components:',
        '  branchFraming: "The road to {%nowhere} is open."',
        'branches:',
        '  subject: {}',
        '',
      ].join('\n'),
    }));
  });

  test('CL0510 is raised exactly once for the one undeclared token', () => {
    const undeclared = diag.all.filter((d) => d.code === CODES.VARIABLE_UNDECLARED);
    expect(undeclared.map((d) => d.message)).toHaveLength(1);
  });
});