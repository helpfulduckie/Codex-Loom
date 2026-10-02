'use strict';

const fs = require('fs');
const path = require('path');
const { resolveScriptFiles } = require('../../src/scripts');
const { Diagnostics } = require('../../src/diag');
const { parseYaml } = require('../../src/loader/yaml');
const { attachOrigins } = require('../../src/origin');
const { withTmpDir, writeTree } = require('../helpers/project');

function resolve(source, files, branchPath = []) {
  const base = withTmpDir();
  writeTree(base, files);
  const parsed = parseYaml(source, path.join(base, 'compile.yaml'));
  const config = attachOrigins(parsed.value, parsed.sourceMap.exportOrigins());
  config._base = base;
  const branches = require('../../src/model/branches').walkBranchChain(config.branches, branchPath);
  const diagnostics = new Diagnostics();
  const directoryCache = new Map();
  const resolved = resolveScriptFiles(config, branches, branches.variables, {
    diagnostics, configPath: path.join(base, 'compile.yaml'), directoryCache,
  });
  return { files: resolved, config, branches, diagnostics, directoryCache, base };
}

const contents = (files) => Object.fromEntries([...files].map(([key, value]) => [key, fs.readFileSync(value, 'utf8')]));

describe('script input selection', () => {
  test('directory declarations select all hooks and recursive auxiliary files', () => {
    const result = resolve('scripts: ./bundle\n', {
      'bundle/input.js': 'input', 'bundle/library.js': 'library',
      'bundle/nested/helper.js': 'helper',
    });
    expect(contents(result.files)).toEqual({
      'input.js': 'input', 'library.js': 'library', 'nested/helper.js': 'helper',
    });
  });

  test('partial maps inherit unspecified hooks and replace named hooks', () => {
    const result = resolve([
      'scripts: ./base', 'branches:', '  Main:',
      '    scripts:', '      input: ./replacement.js', '',
    ].join('\n'), {
      'base/input.js': 'base input', 'base/output.js': 'base output',
      'base/note.txt': 'aux', 'replacement.js': 'replacement',
    }, ['main']);
    expect(contents(result.files)).toEqual({
      'input.js': 'replacement', 'output.js': 'base output', 'note.txt': 'aux',
    });
  });

  test('hook null removes one hook while an empty map changes nothing', () => {
    const source = [
      'scripts: ./base', 'branches:', '  remove:', '    scripts: {input: null}',
      '  empty:', '    scripts: {}', '',
    ].join('\n');
    const files = { 'base/input.js': 'input', 'base/output.js': 'output' };
    expect([...resolve(source, files, ['remove']).files.keys()]).toEqual(['output.js']);
    expect(contents(resolve(source, files, ['empty']).files)).toEqual({ 'input.js': 'input', 'output.js': 'output' });
  });

  test('whole null equals four hook removals and keeps the directory auxiliaries', () => {
    const source = [
      'scripts: ./base', 'branches:', '  whole:', '    scripts: null',
      '  separate:', '    scripts: {input: null, output: null, context: null, library: null}', '',
    ].join('\n');
    const files = {
      'base/input.js': 'input', 'base/output.js': 'output',
      'base/helper.txt': 'helper', 'base/nested/tool.js': 'tool',
    };
    const whole = resolve(source, files, ['whole']);
    const separate = resolve(source, files, ['separate']);
    expect([...whole.files.keys()].sort()).toEqual(['helper.txt', 'nested/tool.js']);
    expect(contents(whole.files)).toEqual(contents(separate.files));
  });

  test('directory replacement removes omitted hooks and replaces auxiliaries', () => {
    const result = resolve([
      'scripts: ./base', 'branches:', '  Main:', '    scripts: ./next', '',
    ].join('\n'), {
      'base/input.js': 'old input', 'base/output.js': 'old output', 'base/old.txt': 'old aux',
      'next/context.js': 'new context', 'next/new.txt': 'new aux',
    }, ['main']);
    expect(contents(result.files)).toEqual({ 'context.js': 'new context', 'new.txt': 'new aux' });
  });

  test('a partial map after whole null restores only the named hook', () => {
    const result = resolve([
      'scripts: ./base', 'branches:', '  Main:', '    scripts: null',
      '    branches:', '      Child:', '        scripts: {library: ./replacement.js}', '',
    ].join('\n'), {
      'base/input.js': 'input', 'base/helper.txt': 'aux', 'replacement.js': 'library',
    }, ['main', 'child']);
    expect(contents(result.files)).toEqual({ 'helper.txt': 'aux', 'library.js': 'library' });
  });

  test('resolves variable, absolute, and relative file paths', () => {
    const root = withTmpDir();
    writeTree(root, { 'scripts/by-var.js': 'variable', 'absolute.js': 'absolute', 'relative.js': 'relative' });
    const abs = path.join(root, 'absolute.js').replace(/\\/g, '/');
    const source = `variables: {source: ./scripts/by-var.js}\nscripts: {input: '{%source}', output: '${abs}', context: ./relative.js}\n`;
    const parsed = parseYaml(source, path.join(root, 'compile.yaml'));
    const config = attachOrigins(parsed.value, parsed.sourceMap.exportOrigins());
    config._base = root;
    const branches = require('../../src/model/branches').walkBranchChain(null, []);
    const result = resolveScriptFiles(config, branches, config.variables, { diagnostics: new Diagnostics() });
    expect(contents(result)).toEqual({ 'input.js': 'variable', 'output.js': 'absolute', 'context.js': 'relative' });
  });

  test('empty files remain selected and missing mapped files remove inherited hooks', () => {
    const result = resolve([
      'scripts: ./base', 'branches:', '  Main:',
      '    scripts: {input: ./empty.js, output: ./missing.js}', '',
    ].join('\n'), { 'base/input.js': 'old', 'base/output.js': 'old', 'empty.js': '' }, ['main']);
    expect([...result.files.keys()]).toEqual(['input.js']);
    expect(fs.readFileSync(result.files.get('input.js'), 'utf8')).toBe('');
  });

  test('nested overrides use actual-cased branch keys for origin lookup', () => {
    const result = resolve([
      'scripts: ./base', 'branches:', '  Main:', '    branches:',
      '      Child:', '        scripts: {library: ./library.js}', '',
    ].join('\n'), { 'base/input.js': 'input', 'library.js': 'library' }, ['main', 'child']);
    expect([...result.files.keys()].sort()).toEqual(['input.js', 'library.js']);
  });

  test('source variable diagnostics point to the authored hook mapping', () => {
    const result = resolve([
      'branches:', '  Main:', '    scripts:', '      input: "{%missing}"', '',
    ].join('\n'), {}, ['main']);
    const finding = result.diagnostics.errors.find((entry) => entry.code === 'CL0510');
    expect(finding).toMatchObject({ file: path.join(result.base, 'compile.yaml'), line: 4, col: 7 });
  });

  test('nested source variable diagnostics use every actual-cased ancestor key', () => {
    const result = resolve([
      'branches:', '  Main:', '    branches:', '      Child:',
      '        scripts:', '          library: "{%missing}"', '',
    ].join('\n'), {}, ['main', 'child']);
    const finding = result.diagnostics.errors.find((entry) => entry.code === 'CL0510');
    expect(finding).toMatchObject({ file: path.join(result.base, 'compile.yaml'), line: 6, col: 11 });
  });

  test('a new run directory cache observes changed and deleted bundle files', () => {
    const base = withTmpDir();
    writeTree(base, { 'bundle/input.js': 'first' });
    const config = { _base: base, scripts: './bundle' };
    const chain = { nodes: [], folderPath: [] };
    const first = resolveScriptFiles(config, chain, {}, { directoryCache: new Map() });
    fs.writeFileSync(path.join(base, 'bundle/input.js'), 'second');
    fs.rmSync(path.join(base, 'bundle/input.js'));
    writeTree(base, { 'bundle/output.js': 'new hook' });
    const second = resolveScriptFiles(config, chain, {}, { directoryCache: new Map() });
    expect([...first.keys()]).toEqual(['input.js']);
    expect([...second.keys()]).toEqual(['output.js']);
  });
});
