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

  test('a mapped hook path that is not a file is an error at the authored hook', () => {
    const result = resolve([
      'scripts: ./base', 'branches:', '  Main:', '    scripts:',
      '      output: ./missing.js', '      input: ./base', '',
    ].join('\n'), { 'base/input.js': 'old', 'base/output.js': 'old' }, ['main']);
    const findings = result.diagnostics.errors.filter((entry) => entry.code === 'CL0636');
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ file: path.join(result.base, 'compile.yaml'), line: 5, col: 7 });
    expect(findings[0].message).toContain('scripts.output names "./missing.js"');
    expect(findings[1].message).toContain('scripts.input names "./base"');
  });

  test('a script directory that does not exist is an error and selects nothing', () => {
    const result = resolve([
      'scripts: ./base', 'branches:', '  Main:', '    scripts: ./nowhere', '',
    ].join('\n'), { 'base/input.js': 'old', 'base/note.txt': 'aux' }, ['main']);
    expect(result.files.size).toBe(0);
    const findings = result.diagnostics.errors.filter((entry) => entry.code === 'CL0636');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: path.join(result.base, 'compile.yaml'), line: 4 });
    expect(findings[0].message).toContain('scripts: names "./nowhere"');
  });

  test('a script path naming a file where a directory belongs is an error', () => {
    const result = resolve('scripts: ./input.js\n', { 'input.js': 'input' });
    expect(result.diagnostics.errors.map((entry) => entry.code)).toEqual(['CL0636']);
  });

  test('an override directory without a hook file removes that hook silently', () => {
    const result = resolve([
      'scripts: ./base', 'branches:', '  Main:', '    scripts: ./override', '',
    ].join('\n'), {
      'base/input.js': 'base input', 'base/output.js': 'base output', 'override/output.js': 'override output',
    }, ['main']);
    expect(contents(result.files)).toEqual({ 'output.js': 'override output' });
    expect(result.diagnostics.all).toEqual([]);
  });

  test('an explicit null and an empty directory report nothing', () => {
    const result = resolve([
      'scripts: ./base', 'branches:', '  Main:', '    scripts: {input: null}', '',
    ].join('\n'), { 'base/input.js': 'old' }, ['main']);
    expect(result.files.size).toBe(0);
    expect(result.diagnostics.all).toEqual([]);
  });

  test('an undeclared variable in a script path is not also reported as a missing source', () => {
    const result = resolve('scripts: {input: "{%missing}"}\nbranches: {Main: {scripts: "{%alsoMissing}"}}\n', {}, ['main']);
    expect(result.diagnostics.errors.map((entry) => entry.code)).toEqual(['CL0510', 'CL0510']);
  });

  test('a shared reported set reports one bad declaration once across leaves', () => {
    const base = withTmpDir();
    const config = { _base: base, scripts: './nowhere' };
    const chain = { nodes: [], folderPath: [] };
    const diagnostics = new Diagnostics();
    const reported = new Set();
    resolveScriptFiles(config, chain, {}, { diagnostics, reported });
    resolveScriptFiles(config, chain, {}, { diagnostics, reported });
    expect(diagnostics.errors).toHaveLength(1);
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
