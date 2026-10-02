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

function resolved(tmpDir, branchPath) {
  const output = path.join(tmpDir, 'out');
  const files = new Map();
  const readNode = (dir) => {
    const scriptsDir = path.join(dir, 'Scripts');
    if (!fs.existsSync(scriptsDir)) return;
    const walk = (current, prefix = '') => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full, relative);
        else files.set(relative, fs.readFileSync(full));
      }
    };
    walk(scriptsDir);
  };
  readNode(output);
  for (let depth = 1; depth <= branchPath.length; depth += 1) {
    readNode(path.join(output, ...branchPath.slice(0, depth).flatMap((name) => ['Branches', name])));
  }
  return files;
}

function expectResolved(tmpDir, branchPath, expected) {
  expect(resolved(tmpDir, branchPath)).toEqual(new Map(Object.entries(expected)
    .map(([name, value]) => [name, Buffer.isBuffer(value) ? value : Buffer.from(value)])));
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
  expectResolved(result.tmpDir, ['alpha'], { 'input.js': 'branch input', 'output.js': 'base output' });
  expectResolved(result.tmpDir, ['beta'], { 'input.js': 'base input', 'output.js': 'base output' });
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
  expectResolved(result.tmpDir, ['alpha'], { 'input.js': 'alpha value' });
  expectResolved(result.tmpDir, ['beta'], { 'input.js': 'beta value' });
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
  expectResolved(result.tmpDir, ['Main', 'Restored'], { 'library.js': 'restored library' });
  expect(fs.existsSync(restored)).toBe(true);
  expect(fs.existsSync(empty)).toBe(false);
});
