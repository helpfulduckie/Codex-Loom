'use strict';

const fs = require('fs');
const path = require('path');
const { compileProject } = require('../helpers/project');

const BASE = {
  'templates/Character.template': '{$name}\n',
  'Codex/items.yaml': [
    '- id: Hero', '  name: Hero', '  aid: {type: Character, triggers: [Hero]}',
    '  render: {template: Character, wrapper: none}', '',
  ].join('\n'),
};

function compile(scripts, extra = {}) {
  return compileProject({
    ...BASE,
    'input-source.js': 'mapped input bytes\r\n',
    'library-source.js': 'mapped library bytes',
    'compile.yaml': [
      'version: 4', 'structure:', '  input:', "    items: ['./Codex']",
      "    templates: ['./templates']", "  output: './out'", `scripts: ${scripts}`, '',
    ].join('\n'),
    ...extra,
  });
}

test('hook mappings emit the selected bytes under canonical hook filenames', () => {
  const result = compile('{input: ./input-source.js, library: ./library-source.js}');
  expect(result.threw).toBe(null);
  expect(fs.readFileSync(path.join(result.tmpDir, 'out', 'Scripts', 'input.js'))).toEqual(Buffer.from('mapped input bytes\r\n'));
  expect(fs.readFileSync(path.join(result.tmpDir, 'out', 'Scripts', 'library.js'), 'utf8')).toBe('mapped library bytes');
  expect(fs.existsSync(path.join(result.tmpDir, 'out', 'Scripts', 'input-source.js'))).toBe(false);
});

test('branch mapping hooks inherit the base directory and override named hooks', () => {
  const result = compile('./bundle', {
    'bundle/input.js': 'base input', 'bundle/output.js': 'base output',
    'branch-input.js': 'branch input',
    'compile.yaml': [
      'version: 4', 'structure:', '  input:', "    items: ['./Codex']", "    templates: ['./templates']",
      "  output: './out'", 'scripts: ./bundle', 'branches:', '  alpha:',
      '    scripts: {input: ./branch-input.js}', '  beta: {}', '',
    ].join('\n'),
  });
  expect(result.threw).toBe(null);
  expect(fs.readFileSync(path.join(result.tmpDir, 'out', 'Branches', 'alpha', 'Scripts', 'input.js'), 'utf8')).toBe('branch input');
  expect(fs.readFileSync(path.join(result.tmpDir, 'out', 'Branches', 'alpha', 'Scripts', 'output.js'), 'utf8')).toBe('base output');
  expect(fs.readFileSync(path.join(result.tmpDir, 'out', 'Branches', 'beta', 'Scripts', 'input.js'), 'utf8')).toBe('base input');
});

test('root hook paths resolve against each leaf final variable table', () => {
  const result = compile('./bundle', {
    'root.js': 'root value', 'alpha.js': 'alpha value', 'beta.js': 'beta value',
    'compile.yaml': [
      'version: 4', 'variables: {source: ./root.js}', 'structure:', '  input:',
      "    items: ['./Codex']", "    templates: ['./templates']", "  output: './out'",
      'scripts: {input: "{%source}"}', 'branches:',
      '  alpha:', '    variables: {source: ./alpha.js}',
      '  beta:', '    variables: {source: ./beta.js}', '',
    ].join('\n'),
  });
  expect(result.threw).toBe(null);
  expect(fs.readFileSync(path.join(result.tmpDir, 'out', 'Branches', 'alpha', 'Scripts', 'input.js'), 'utf8')).toBe('alpha value');
  expect(fs.readFileSync(path.join(result.tmpDir, 'out', 'Branches', 'beta', 'Scripts', 'input.js'), 'utf8')).toBe('beta value');
});

test('nested branches restore only hooks named after an ancestor whole-null', () => {
  const result = compile('./bundle', {
    'bundle/input.js': 'input', 'bundle/output.js': 'output', 'restored.js': 'restored library',
    'compile.yaml': [
      'version: 4', 'structure:', '  input:', "    items: ['./Codex']", "    templates: ['./templates']",
      "  output: './out'", 'scripts: ./bundle', 'branches:',
      '  Main:', '    scripts: null', '    branches:',
      '      Restored:', '        scripts: {library: ./restored.js}',
      '      Empty: {}', '',
    ].join('\n'),
  });
  expect(result.threw).toBe(null);
  const restored = path.join(result.tmpDir, 'out', 'Branches', 'Main', 'Branches', 'Restored', 'Scripts');
  const empty = path.join(result.tmpDir, 'out', 'Branches', 'Main', 'Branches', 'Empty', 'Scripts');
  expect(fs.readdirSync(restored)).toEqual(['library.js']);
  expect(fs.readFileSync(path.join(restored, 'library.js'), 'utf8')).toBe('restored library');
  expect(fs.existsSync(empty)).toBe(false);
});
