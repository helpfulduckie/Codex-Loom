'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CLI = path.resolve(__dirname, '../../src/compile.js');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: cwd || process.cwd(),
  });
}

const MINIMAL_COMPILE_YAML = `
version: 4
structure:
  input:
    items: []
  output: ./output
protagonist: Test
branches:
  only: {}
`.trimStart();

const COMPILE_YAML_WITH_OVERVIEW = `
version: 4
structure:
  input:
    items: []
  output: ./output
  reports: ./my-overviews
protagonist: Test
branches:
  only: {}
`.trimStart();

// ── --leafReview / -l flag ────────────────────────────────────────────────────

describe('CLI --leafReview flag', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true });
  });

  test('--leafReview with path writes one .leaf.md per leaf', () => {
    write(path.join(tmp, 'scenario', 'Branches', 'hero', 'Story Cards', 'Char', 'x.md'), 'content');

    const result = spawnSync(
      process.execPath,
      [CLI, '--leafReview', path.join(tmp, 'scenario')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);

    const outDir = path.join(tmp, 'overview', 'leaf-review');
    const files = fs.readdirSync(outDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every(f => f.endsWith('.leaf.md'))).toBe(true);
  });

  test('-l short flag is accepted', () => {
    write(path.join(tmp, 'scenario', 'Story Cards', 'Char', 'x.md'), 'content');

    const result = spawnSync(
      process.execPath,
      [CLI, '-l', path.join(tmp, 'scenario')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'overview'))).toBe(true);
  });

  test('--leafReview with missing scenario root exits nonzero', () => {
    const result = run(['--leafReview', path.join(tmp, 'no-such-dir')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not found/i);
  });

  test('--leafReview without args and no compile.yaml exits nonzero', () => {
    const emptyDir = path.join(tmp, 'empty');
    fs.mkdirSync(emptyDir);
    const result = run(['--leafReview'], emptyDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/compile\.yaml/i);
  });

  test('--leafReview with no path defaults to <cwd>/overview', () => {
    write(path.join(tmp, 'scenario', 'Story Cards', 'T', 'c.md'), 'c');
    const result = spawnSync(
      process.execPath,
      [CLI, '--leafReview', path.join(tmp, 'scenario')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'overview'))).toBe(true);
  });

  test('--leafReview with compile.yaml uses config output as scenario root', () => {
    const cfgPath = path.join(tmp, 'compile.yaml');
    const outputDir = path.join(tmp, 'output');
    write(path.join(outputDir, 'Branches', 'alpha', 'Story Cards', 'T', 'c.md'), 'c');
    write(cfgPath, MINIMAL_COMPILE_YAML);

    const result = spawnSync(
      process.execPath,
      [CLI, '--leafReview', cfgPath],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    // with no overview field, defaults to {output}/Overview
    expect(fs.existsSync(path.join(outputDir, 'Overview'))).toBe(true);
  });

  test('--leafReview with compile.yaml uses structure.overview when set', () => {
    const cfgPath = path.join(tmp, 'compile.yaml');
    const outputDir = path.join(tmp, 'output');
    write(path.join(outputDir, 'Story Cards', 'T', 'c.md'), 'c');
    write(cfgPath, COMPILE_YAML_WITH_OVERVIEW);

    const result = spawnSync(
      process.execPath,
      [CLI, '--leafReview', cfgPath],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'my-overviews'))).toBe(true);
  });
});

// ── --overview / -o flag ──────────────────────────────────────────────────────

describe('CLI --overview flag', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true });
  });

  test('--overview with path writes a single .overview.md file', () => {
    write(path.join(tmp, 'scenario', 'Branches', 'hero', 'Story Cards', 'Char', 'x.md'), 'content');

    const result = spawnSync(
      process.execPath,
      [CLI, '--overview', path.join(tmp, 'scenario')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);

    const outDir = path.join(tmp, 'overview', 'overview');
    const files = fs.readdirSync(outDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.overview\.md$/);
  });

  test('-o short flag is accepted', () => {
    write(path.join(tmp, 'scenario', 'Story Cards', 'Char', 'x.md'), 'content');

    const result = spawnSync(
      process.execPath,
      [CLI, '-o', path.join(tmp, 'scenario')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'overview'))).toBe(true);
  });

  test('--overview with missing scenario root exits nonzero', () => {
    const result = run(['--overview', path.join(tmp, 'no-such-dir')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not found/i);
  });

  test('--overview without args and no compile.yaml exits nonzero', () => {
    const emptyDir = path.join(tmp, 'empty');
    fs.mkdirSync(emptyDir);
    const result = run(['--overview'], emptyDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/compile\.yaml/i);
  });

  test('--overview with no output-dir defaults to <cwd>/overview', () => {
    write(path.join(tmp, 'scenario', 'Story Cards', 'T', 'c.md'), 'c');
    const result = spawnSync(
      process.execPath,
      [CLI, '--overview', path.join(tmp, 'scenario')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'overview'))).toBe(true);
  });

  test('--overview with compile.yaml uses config output as scenario root', () => {
    const cfgPath = path.join(tmp, 'compile.yaml');
    const outputDir = path.join(tmp, 'output');
    write(path.join(outputDir, 'Branches', 'alpha', 'Story Cards', 'T', 'c.md'), 'c');
    write(cfgPath, MINIMAL_COMPILE_YAML);

    const result = spawnSync(
      process.execPath,
      [CLI, '--overview', cfgPath],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(outputDir, 'Overview'))).toBe(true);
  });

  test('--overview with compile.yaml uses structure.overview when set', () => {
    const cfgPath = path.join(tmp, 'compile.yaml');
    const outputDir = path.join(tmp, 'output');
    write(path.join(outputDir, 'Story Cards', 'T', 'c.md'), 'c');
    write(cfgPath, COMPILE_YAML_WITH_OVERVIEW);

    const result = spawnSync(
      process.execPath,
      [CLI, '--overview', cfgPath],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'my-overviews'))).toBe(true);
  });

  test('no args prints usage and exits nonzero', () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
  });
});

// ── --leafReview + --overview combined ────────────────────────────────────────

describe('CLI --leafReview + --overview combined', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true });
  });

  test('both flags together write both leaf and tree overview files', () => {
    write(path.join(tmp, 'scenario', 'Branches', 'hero', 'Story Cards', 'Char', 'x.md'), 'content');
    write(path.join(tmp, 'scenario', 'Branches', 'villain', 'Story Cards', 'Char', 'y.md'), 'content');

    const result = spawnSync(
      process.execPath,
      [CLI, '--leafReview', '--overview', path.join(tmp, 'scenario')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);

    const outDir = path.join(tmp, 'overview');
    // leaf review: one per leaf (hero, villain); overview: one for whole tree
    const leafFiles = fs.readdirSync(path.join(outDir, 'leaf-review'));
    const overviewFiles = fs.readdirSync(path.join(outDir, 'overview'));
    expect(leafFiles.filter(f => f.endsWith('.leaf.md')).length).toBe(2);
    expect(overviewFiles.filter(f => f.endsWith('.overview.md')).length).toBe(1);
  });

  test('-l -o short flags combined work', () => {
    write(path.join(tmp, 'scenario', 'Story Cards', 'T', 'c.md'), 'c');

    const result = spawnSync(
      process.execPath,
      [CLI, '-l', '-o', path.join(tmp, 'scenario')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
  });

  test('both flags with compile.yaml derive all paths from config', () => {
    const cfgPath = path.join(tmp, 'compile.yaml');
    const outputDir = path.join(tmp, 'output');
    write(path.join(outputDir, 'Branches', 'alpha', 'Story Cards', 'T', 'c.md'), 'c');
    write(cfgPath, COMPILE_YAML_WITH_OVERVIEW);

    const result = spawnSync(
      process.execPath,
      [CLI, '--leafReview', '--overview', cfgPath],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);

    const overviewDir = path.join(tmp, 'my-overviews');
    expect(fs.existsSync(overviewDir)).toBe(true);
    const leafFiles = fs.readdirSync(path.join(overviewDir, 'leaf-review'));
    const overviewFiles = fs.readdirSync(path.join(overviewDir, 'overview'));
    expect(leafFiles.filter(f => f.endsWith('.leaf.md')).length).toBeGreaterThan(0);
    expect(overviewFiles.filter(f => f.endsWith('.overview.md')).length).toBeGreaterThan(0);
  });
});

// ── --compile / -C flag ───────────────────────────────────────────────────────

describe('CLI --compile flag', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true });
  });

  test('-C with compile.yaml compiles the project', () => {
    const cfgPath = path.join(tmp, 'compile.yaml');
    write(cfgPath, MINIMAL_COMPILE_YAML);

    const result = spawnSync(
      process.execPath,
      [CLI, '-C', cfgPath],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'output'))).toBe(true);
  });

  test('-C -l with compile.yaml compiles then writes leaf-review files', () => {
    const cfgPath = path.join(tmp, 'compile.yaml');
    write(cfgPath, MINIMAL_COMPILE_YAML);

    const result = spawnSync(
      process.execPath,
      [CLI, '-C', '-l', cfgPath],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'output'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'output', 'Overview'))).toBe(true);
  });

  test('-C -l -o with compile.yaml compiles then runs all three modes', () => {
    const cfgPath = path.join(tmp, 'compile.yaml');
    write(cfgPath, MINIMAL_COMPILE_YAML);

    const result = spawnSync(
      process.execPath,
      [CLI, '-C', '-l', '-o', cfgPath],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'output'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'output', 'Overview'))).toBe(true);
  });

  test('-C with directory arg auto-detects compile.yaml inside it', () => {
    write(path.join(tmp, 'project', 'compile.yaml'), MINIMAL_COMPILE_YAML);

    const result = spawnSync(
      process.execPath,
      [CLI, '-C', path.join(tmp, 'project')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'project', 'output'))).toBe(true);
  });

  test('-C with no compile.yaml but -l present warns and still runs leaf-review', () => {
    write(path.join(tmp, 'scenario', 'Story Cards', 'T', 'c.md'), 'c');

    const result = spawnSync(
      process.execPath,
      [CLI, '-C', '-l', path.join(tmp, 'scenario')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/compile\.yaml not found/i);
    expect(fs.existsSync(path.join(tmp, 'overview'))).toBe(true);
  });

  test('-C with no compile.yaml and no -l/-o exits nonzero', () => {
    const result = run(['-C', path.join(tmp, 'no-such-dir')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/compile\.yaml/i);
  });
});

// ── --lint-level ─────────────────────────────────────────────────────────────
//
// The flag exists because §12.5 asks for a runtime control that is not `--verbose`:
// verbosity is about compile progress, this is about which diagnostics an author wants to
// hear. It takes a value, so it is parsed apart from the boolean flag table.

describe('CLI --lint-level flag', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cli-lintlevel-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A card with a leaked `{$she}` (a fact) and a `[does]` (an opinion) in one body. */
  function writeLintable() {
    write(
      path.join(tmp, 'scenario', 'Story Cards', 'Char', 'a.md'),
      ['## Aria', '', '~~~', 'triggers: [Aria]', '~~~', '', 'She caught {$she} hair and love[does] it.', ''].join('\n')
    );
  }

  test('--lint-level=off silences the opinions and leaves the facts', () => {
    writeLintable();
    const result = run(['-L', '--lint-level=off', path.join(tmp, 'scenario')], tmp);
    expect(result.status).toBe(0);
    const report = fs.readFileSync(
      path.join(tmp, 'overview', 'lint', 'scenario.lint.md'), 'utf8');
    expect(report).toContain('unresolved-field-token');
    expect(report).not.toContain('suspect-verb-marker');
  });

  test('the space-separated spelling works too, and does not eat the path', () => {
    writeLintable();
    const result = run(['-L', '--lint-level', 'off', path.join(tmp, 'scenario')], tmp);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'overview', 'lint'))).toBe(true);
  });

  test('with no flag the opinions are reported as scanned', () => {
    writeLintable();
    const result = run(['-L', path.join(tmp, 'scenario')], tmp);
    expect(result.status).toBe(0);
    const report = fs.readFileSync(
      path.join(tmp, 'overview', 'lint', 'scenario.lint.md'), 'utf8');
    expect(report).toContain('suspect-verb-marker');
  });

  /**
   * `resolveArgs` already loads the config to find the output and reports directories, so the
   * level is in hand. Without passing it out, `--lint` answered differently from the compile
   * that wrote the tree it is reading, on the same project's own setting.
   */
  test('--lint reads lint.level from compile.cl.yaml when no flag is given', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'),
      MINIMAL_COMPILE_YAML.replace('protagonist: Test', 'lint:\n  level: off\nprotagonist: Test'));
    write(
      path.join(tmp, 'proj', 'output', 'Story Cards', 'Char', 'a.md'),
      ['## Aria', '', '~~~', 'triggers: [Aria]', '~~~', '', 'She caught {$she} hair and love[does] it.', ''].join('\n')
    );

    const result = run(['-L', path.join(tmp, 'proj')], tmp);
    expect(result.status).toBe(0);
    const report = fs.readFileSync(
      path.join(tmp, 'proj', 'output', 'Overview', 'lint', 'output.lint.md'), 'utf8');
    expect(report).toContain('unresolved-field-token');
    expect(report).not.toContain('suspect-verb-marker');
  });

  test('the flag wins over the config key, being what someone typed for this run', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'),
      MINIMAL_COMPILE_YAML.replace('protagonist: Test', 'lint:\n  level: off\nprotagonist: Test'));
    write(
      path.join(tmp, 'proj', 'output', 'Story Cards', 'Char', 'a.md'),
      ['## Aria', '', '~~~', 'triggers: [Aria]', '~~~', '', 'She love[does] it.', ''].join('\n')
    );

    const result = run(['-L', '--lint-level=warn', path.join(tmp, 'proj')], tmp);
    expect(result.status).toBe(0);
    const report = fs.readFileSync(
      path.join(tmp, 'proj', 'output', 'Overview', 'lint', 'output.lint.md'), 'utf8');
    expect(report).toContain('suspect-verb-marker');
  });

  test('an unknown level exits nonzero and names the three legal ones', () => {
    writeLintable();
    const result = run(['-L', '--lint-level=loud', path.join(tmp, 'scenario')], tmp);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/off, error, warn/);
  });
});
