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

function compile(lines, scripts = {}) {
  const { diagnostics, tmpDir, threw } = compileProject({
    ...BASE,
    ...scripts,
    'compile.yaml': [
      'version: 4', 'title: Script Placement Probe', 'structure:', '  input:',
      "    items: ['./Codex']", "    templates: ['./templates']", "  output: './out'",
      ...lines, '',
    ].join('\n'),
  });
  expect(threw).toBe(null);
  expect(diagnostics.errors).toEqual([]);
  return { tmpDir, output: path.join(tmpDir, 'out') };
}

function nodeDir(output, branchPath) {
  return path.join(output, ...branchPath.flatMap((name) => ['Branches', name]));
}

function ownScriptFiles(dir) {
  const files = new Map();
  const walk = (current, prefix = '') => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else files.set(relative, fs.readFileSync(full));
    }
  };
  walk(path.join(dir, 'Scripts'));
  return files;
}

function resolvedScripts(output, branchPath) {
  const resolved = new Map(ownScriptFiles(output));
  for (let depth = 1; depth <= branchPath.length; depth += 1) {
    for (const [name, bytes] of ownScriptFiles(nodeDir(output, branchPath.slice(0, depth)))) {
      resolved.set(name, bytes);
    }
  }
  return resolved;
}

function expectLeafScripts(output, branchPath, expected) {
  const actual = resolvedScripts(output, branchPath);
  const normalized = new Map(Object.entries(expected).map(([name, value]) => [name, Buffer.isBuffer(value) ? value : Buffer.from(value)]));
  expect(actual).toEqual(normalized);
}

test('identical directory bytes share one root copy despite a same-directory branch declaration', () => {
  const result = compile([
    'scripts: ./bundle', 'branches:', '  a: {}', '  b:', '    scripts: ./bundle',
  ], { 'bundle/input.js': 'input\r\n', 'bundle/nested/helper.js': 'helper' });
  expectLeafScripts(result.output, ['a'], { 'input.js': Buffer.from('input\r\n'), 'nested/helper.js': 'helper' });
  expectLeafScripts(result.output, ['b'], { 'input.js': Buffer.from('input\r\n'), 'nested/helper.js': 'helper' });
  expect(fs.existsSync(path.join(result.output, 'Scripts', 'input.js'))).toBe(true);
  expect(fs.existsSync(path.join(nodeDir(result.output, ['a']), 'Scripts'))).toBe(false);
  expect(fs.existsSync(path.join(nodeDir(result.output, ['b']), 'Scripts'))).toBe(false);
});

test('identical bytes from different source directories share one root file', () => {
  const result = compile([
    'branches:', '  a:', '    scripts: ./left', '  b:', '    scripts: ./right',
  ], { 'left/input.js': 'same bytes', 'right/input.js': 'same bytes' });
  expectLeafScripts(result.output, ['a'], { 'input.js': 'same bytes' });
  expectLeafScripts(result.output, ['b'], { 'input.js': 'same bytes' });
  expect(fs.readFileSync(path.join(result.output, 'Scripts', 'input.js'), 'utf8')).toBe('same bytes');
});

test('distinct versions shared by groups are written at the intermediate nodes', () => {
  const result = compile([
    'branches:', '  first:', '    branches:', '      a:', '        scripts: ./first',
    '      b:', '        scripts: ./first', '  second:', '    branches:',
    '      a:', '        scripts: ./second', '      b:', '        scripts: ./second',
  ], { 'first/input.js': 'first group', 'second/input.js': 'second group' });
  for (const leaf of [['first', 'a'], ['first', 'b']]) expectLeafScripts(result.output, leaf, { 'input.js': 'first group' });
  for (const leaf of [['second', 'a'], ['second', 'b']]) expectLeafScripts(result.output, leaf, { 'input.js': 'second group' });
  expect(fs.readFileSync(path.join(nodeDir(result.output, ['first']), 'Scripts', 'input.js'), 'utf8')).toBe('first group');
  expect(fs.readFileSync(path.join(nodeDir(result.output, ['second']), 'Scripts', 'input.js'), 'utf8')).toBe('second group');
  expect(fs.existsSync(path.join(result.output, 'Scripts', 'input.js'))).toBe(false);
});

test('a majority version uses one root copy and one copy-saving leaf override', () => {
  const result = compile([
    'branches:', '  a: {scripts: {input: ./major.js}}',
    '  b: {scripts: {input: ./major.js}}', '  c: {scripts: {input: ./major.js}}',
    '  odd: {scripts: {input: ./odd.js}}',
  ], { 'major.js': 'majority', 'odd.js': 'odd' });
  for (const leaf of ['a', 'b', 'c']) expectLeafScripts(result.output, [leaf], { 'input.js': 'majority' });
  expectLeafScripts(result.output, ['odd'], { 'input.js': 'odd' });
  expect(fs.readFileSync(path.join(result.output, 'Scripts', 'input.js'), 'utf8')).toBe('majority');
  expect(fs.readFileSync(path.join(nodeDir(result.output, ['odd']), 'Scripts', 'input.js'), 'utf8')).toBe('odd');
});

test('an equal-cost two-version split keeps one copy at each leaf', () => {
  const result = compile([
    'branches:', '  a: {scripts: {input: ./a.js}}', '  b: {scripts: {input: ./b.js}}',
  ], { 'a.js': 'a', 'b.js': 'b' });
  expectLeafScripts(result.output, ['a'], { 'input.js': 'a' });
  expectLeafScripts(result.output, ['b'], { 'input.js': 'b' });
  expect(fs.existsSync(path.join(result.output, 'Scripts', 'input.js'))).toBe(false);
});

test('absence on any leaf blocks inherited hooks and retains only authored files', () => {
  const result = compile([
    'scripts: ./bundle', 'branches:', '  present: {}',
    '  missingHook: {scripts: ./partial}',
    '  allRemoved: {scripts: null}',
    '  oneRemoved: {scripts: {input: null}}',
  ], {
    'bundle/input.js': 'input', 'bundle/output.js': 'output',
    'bundle/aux.txt': 'aux', 'partial/output.js': 'partial output',
  });
  expectLeafScripts(result.output, ['present'], { 'input.js': 'input', 'output.js': 'output', 'aux.txt': 'aux' });
  expectLeafScripts(result.output, ['missingHook'], { 'output.js': 'partial output' });
  expectLeafScripts(result.output, ['allRemoved'], { 'aux.txt': 'aux' });
  expectLeafScripts(result.output, ['oneRemoved'], { 'output.js': 'output', 'aux.txt': 'aux' });
});

test('a leaf with no script declaration blocks a sibling file from the root', () => {
  const result = compile([
    'branches:', '  scripted: {scripts: {input: ./input.js}}', '  noBundle: {}',
  ], { 'input.js': 'only one leaf' });
  expectLeafScripts(result.output, ['scripted'], { 'input.js': 'only one leaf' });
  expectLeafScripts(result.output, ['noBundle'], {});
  expect(fs.existsSync(path.join(result.output, 'Scripts', 'input.js'))).toBe(false);
});

test('a mapping override and a null hook preserve auxiliaries without restoring removed hooks', () => {
  const result = compile([
    'scripts: ./bundle', 'branches:',
    '  override: {scripts: {input: ./replacement.js}}',
    '  removed: {scripts: {output: null}}',
  ], {
    'bundle/input.js': 'base input', 'bundle/output.js': 'base output',
    'bundle/nested/tool.js': 'auxiliary', 'replacement.js': 'new input',
  });
  expectLeafScripts(result.output, ['override'], {
    'input.js': 'new input', 'output.js': 'base output', 'nested/tool.js': 'auxiliary',
  });
  expectLeafScripts(result.output, ['removed'], { 'input.js': 'base input', 'nested/tool.js': 'auxiliary' });
});

test('empty hook files remain present and nested auxiliary files keep their bytes', () => {
  const result = compile([
    'scripts: ./bundle', 'branches:', '  a: {}', '  b: {}',
  ], {
    'bundle/input.js': '', 'bundle/nested/deep/helper.js': 'zero\r\n',
  });
  expectLeafScripts(result.output, ['a'], { 'input.js': Buffer.alloc(0), 'nested/deep/helper.js': Buffer.from('zero\r\n') });
  expectLeafScripts(result.output, ['b'], { 'input.js': Buffer.alloc(0), 'nested/deep/helper.js': Buffer.from('zero\r\n') });
  expect(fs.readFileSync(path.join(result.output, 'Scripts', 'input.js'))).toEqual(Buffer.alloc(0));
});

test('one branched leaf stays at its leaf and an unbranched script stays at root', () => {
  const branched = compile(['scripts: ./bundle', 'branches:', '  only: {}'], { 'bundle/input.js': 'branch leaf' });
  expectLeafScripts(branched.output, ['only'], { 'input.js': 'branch leaf' });
  expect(fs.existsSync(path.join(nodeDir(branched.output, ['only']), 'Scripts', 'input.js'))).toBe(true);

  const unbranched = compile(['scripts: ./bundle'], { 'bundle/input.js': 'root leaf' });
  expectLeafScripts(unbranched.output, [], { 'input.js': 'root leaf' });
  expect(fs.existsSync(path.join(unbranched.output, 'Scripts', 'input.js'))).toBe(true);
});
