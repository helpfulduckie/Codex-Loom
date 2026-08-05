'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadDescConfig, extractScriptBanner, writeDescription } = require('../../src/description');

// ── extractScriptBanner ───────────────────────────────────────────────────────

describe('extractScriptBanner', () => {
  afterEach(() => jest.restoreAllMocks());

  function mockScript(content) {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(content);
  }

  test('strips // prefix and returns content lines', () => {
    mockScript('// Hello world\n// Second line\ncode();\n');
    const result = extractScriptBanner('/fake.js');
    expect(result).toContain('Hello world');
    expect(result).toContain('Second line');
  });

  test('pure separator lines are omitted', () => {
    mockScript('// ============================\n// Content line\n// ============================\n');
    const result = extractScriptBanner('/fake.js');
    expect(result).not.toMatch(/={4,}/);
    expect(result).toContain('Content line');
  });

  test('banner title lines are condensed to === title ===', () => {
    mockScript('// ============= Standard Build - 1.0.0 ============\n');
    const result = extractScriptBanner('/fake.js');
    expect(result).toContain('=== Standard Build - 1.0.0 ===');
    expect(result).not.toMatch(/={6,}/);
  });

  test('empty stripped lines are skipped', () => {
    mockScript('// Line one\n//\n// Line two\n');
    const result = extractScriptBanner('/fake.js');
    expect(result).toContain('Line one');
    expect(result).toContain('Line two');
    // No runs of blank lines in output
    expect(result).not.toMatch(/\n\n\n/);
  });

  test('stops at first non-comment line', () => {
    mockScript('// Top comment\nconst x = 1; // not a comment block\n// After code — should NOT be included\n');
    const result = extractScriptBanner('/fake.js');
    expect(result).toContain('Top comment');
    expect(result).not.toContain('After code');
  });

  test('result begins with a leading newline (blank-line separator)', () => {
    mockScript('// Some line\n');
    const result = extractScriptBanner('/fake.js');
    expect(result.startsWith('\n')).toBe(true);
  });

  test('returns empty string when file has no comment block', () => {
    mockScript('const x = 1;\n');
    expect(extractScriptBanner('/fake.js')).toBe('');
  });

  test('full banner round-trip produces expected output', () => {
    const script = [
      '// ============================================================',
      '// ============= Standard Build - 26.9.6 - library ============',
      '// ============================================================',
      '// - UnifiedSettings@1.1.2',
      '// - DuckieDebug@1.0.3',
      '// ============================================================',
      '// Paste this ONLY into the library tab in AI Dungeon scripting',
      '// ============================================================',
      '',
      'const x = 0;',
    ].join('\n');
    mockScript(script);

    const result = extractScriptBanner('/fake.js');
    expect(result).toBe([
      '',
      '=== Standard Build - 26.9.6 - library ===',
      '- UnifiedSettings@1.1.2',
      '- DuckieDebug@1.0.3',
      'Paste this ONLY into the library tab in AI Dungeon scripting',
    ].join('\n'));
  });

  test('stripTrailingInstructions drops final non-list group after list content', () => {
    const script = [
      '// ============================================================',
      '// ============= Standard Build - 26.9.6 - library ============',
      '// ============================================================',
      '// - UnifiedSettings@1.1.2',
      '// - DuckieDebug@1.0.3',
      '// ============================================================',
      '// Paste this ONLY into the library tab in AI Dungeon scripting',
      '// ============================================================',
    ].join('\n');
    mockScript(script);

    const result = extractScriptBanner('/fake.js', { stripTrailingInstructions: true });
    expect(result).toContain('=== Standard Build - 26.9.6 - library ===');
    expect(result).toContain('- UnifiedSettings@1.1.2');
    expect(result).not.toContain('Paste this ONLY');
  });

  test('stripTrailingInstructions: false keeps the trailing group', () => {
    const script = [
      '// - Item one',
      '// ========',
      '// Instruction line',
    ].join('\n');
    mockScript(script);

    const result = extractScriptBanner('/fake.js', { stripTrailingInstructions: false });
    expect(result).toContain('Instruction line');
  });

  test('stripTrailingInstructions does not strip when final group also has list items', () => {
    const script = [
      '// - Item one',
      '// ========',
      '// - Also a list item',
    ].join('\n');
    mockScript(script);

    const result = extractScriptBanner('/fake.js', { stripTrailingInstructions: true });
    expect(result).toContain('- Also a list item');
  });

  test('stripTrailingInstructions does not strip when no group has list items', () => {
    const script = [
      '// Title line',
      '// ========',
      '// Another plain line',
    ].join('\n');
    mockScript(script);

    const result = extractScriptBanner('/fake.js', { stripTrailingInstructions: true });
    expect(result).toContain('Another plain line');
  });
});

// ── loadDescConfig ────────────────────────────────────────────────────────────

describe('loadDescConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('null spec → empty object', () => {
    expect(loadDescConfig(null)).toEqual({});
  });

  test('missing file → warns and returns empty object', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    expect(loadDescConfig(path.join(tmpDir, 'missing.yaml'))).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  test('array YAML → throws', () => {
    const f = path.join(tmpDir, 'bad.yaml');
    fs.writeFileSync(f, '- item\n');
    expect(() => loadDescConfig(f)).toThrow('must be a YAML mapping');
  });

  test('body path is resolved relative to configBase (compile.yaml dir)', () => {
    const f = path.join(tmpDir, 'sub', 'desc.yaml');
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.writeFileSync(f, 'body: ./text.md\n');
    const result = loadDescConfig(f, tmpDir);
    expect(result.bodyPath).toBe(path.resolve(tmpDir, 'text.md'));
  });

  test('script path is resolved relative to configBase (compile.yaml dir)', () => {
    const f = path.join(tmpDir, 'sub', 'desc.yaml');
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.writeFileSync(f, 'script: ./lib.js\n');
    const result = loadDescConfig(f, tmpDir);
    expect(result.scriptPath).toBe(path.resolve(tmpDir, 'lib.js'));
  });

  test('body path falls back to config file dir when no configBase provided', () => {
    const f = path.join(tmpDir, 'desc.yaml');
    fs.writeFileSync(f, 'body: ./text.md\n');
    const result = loadDescConfig(f);
    expect(result.bodyPath).toBe(path.resolve(tmpDir, 'text.md'));
  });

  // `{@Key}` is gone (§6.1); canon names are exposed as variables, so every reference a
  // description file can make now goes through `{%}` and one lookup.

  test('{%variable} in body path is expanded before resolution', () => {
    const f = path.join(tmpDir, 'desc.yaml');
    fs.writeFileSync(f, 'body: ./{%folder}/text.md\n');
    const result = loadDescConfig(f, tmpDir, { folder: 'components' });
    expect(result.bodyPath).toBe(path.resolve(tmpDir, './components/text.md'));
  });

  test('a canon name in a body path resolves as a variable', () => {
    const f = path.join(tmpDir, 'desc.yaml');
    fs.writeFileSync(f, "body: '{%bodyKey}'\n");
    const result = loadDescConfig(f, tmpDir, { bodyKey: path.join(tmpDir, 'components', 'body.md') });
    expect(result.bodyPath).toBe(path.join(tmpDir, 'components', 'body.md'));
  });

  test('a directory variable in a script path takes a path suffix', () => {
    const f = path.join(tmpDir, 'desc.yaml');
    const scriptsDir = path.join(tmpDir, 'scripts', 'lib');
    fs.writeFileSync(f, "script: '{%scripts}/library.js'\n");
    const result = loadDescConfig(f, tmpDir, { scripts: scriptsDir });
    expect(result.scriptPath).toBe(path.resolve(tmpDir, `${scriptsDir}/library.js`));
  });

  test('two variables expand in the same value', () => {
    const f = path.join(tmpDir, 'desc.yaml');
    fs.writeFileSync(f, 'body: ./{%sub}/{%bodyKey}\n');
    const result = loadDescConfig(f, tmpDir, { sub: 'components', bodyKey: 'text.md' });
    expect(result.bodyPath).toBe(path.resolve(tmpDir, './components/text.md'));
  });

  test('stripTrailingInstructions true is preserved', () => {
    const f = path.join(tmpDir, 'desc.yaml');
    fs.writeFileSync(f, 'stripTrailingInstructions: true\n');
    expect(loadDescConfig(f).stripTrailingInstructions).toBe(true);
  });

  test('stripTrailingInstructions defaults to false when absent', () => {
    const f = path.join(tmpDir, 'desc.yaml');
    fs.writeFileSync(f, 'body: ./text.md\n');
    expect(loadDescConfig(f).stripTrailingInstructions).toBe(false);
  });

  test('missing body/script keys → null paths', () => {
    const f = path.join(tmpDir, 'desc.yaml');
    fs.writeFileSync(f, 'stripTrailingInstructions: false\n');
    const result = loadDescConfig(f);
    expect(result.bodyPath).toBeNull();
    expect(result.scriptPath).toBeNull();
  });
});

// ── writeDescription ──────────────────────────────────────────────────────────

describe('writeDescription', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desc-write-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('null content → returns null and does not write', () => {
    expect(writeDescription(tmpDir, null)).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'Description.md'))).toBe(false);
  });

  test('empty string content → returns null and does not write', () => {
    expect(writeDescription(tmpDir, '')).toBeNull();
  });

  test('writes Description.md directly in outputDir (not Components/)', () => {
    writeDescription(tmpDir, 'Hello');
    expect(fs.existsSync(path.join(tmpDir, 'Description.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'Components', 'Description.md'))).toBe(false);
  });

  test('written content has trailing newline', () => {
    writeDescription(tmpDir, 'My description');
    expect(fs.readFileSync(path.join(tmpDir, 'Description.md'), 'utf8')).toBe('My description\n');
  });

  test('returns the written file path', () => {
    const result = writeDescription(tmpDir, 'content');
    expect(result).toBe(path.join(tmpDir, 'Description.md'));
  });

  test('creates outputDir recursively if needed', () => {
    const nested = path.join(tmpDir, 'deep', 'nested');
    writeDescription(nested, 'content');
    expect(fs.existsSync(path.join(nested, 'Description.md'))).toBe(true);
  });
});
