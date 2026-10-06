'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { withTmpDir } = require('../helpers/project');

const CLI = path.resolve(__dirname, '../../src/cli.js');

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
roles:
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
roles:
  protagonist: Test
branches:
  only: {}
`.trimStart();

// ── --leafReview / -l flag ────────────────────────────────────────────────────

describe('CLI --leafReview flag', () => {
  let tmp;

  beforeEach(() => {
    tmp = withTmpDir();
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
    tmp = withTmpDir();
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
    tmp = withTmpDir();
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
    tmp = withTmpDir();
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

  test('-C with a directory arg auto-detects compile.cl.yaml (the --rename-cl name)', () => {
    write(path.join(tmp, 'project', 'compile.cl.yaml'), MINIMAL_COMPILE_YAML);

    const result = spawnSync(
      process.execPath,
      [CLI, '-C', path.join(tmp, 'project')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'project', 'output'))).toBe(true);
  });

  test('-C with a directory holding two configs errors instead of picking one', () => {
    write(path.join(tmp, 'project', 'compile.yaml'), MINIMAL_COMPILE_YAML);
    write(path.join(tmp, 'project', 'compile.cl.yaml'), MINIMAL_COMPILE_YAML);

    const result = spawnSync(
      process.execPath,
      [CLI, '-C', path.join(tmp, 'project')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/More than one compile config/i);
    expect(fs.existsSync(path.join(tmp, 'project', 'output'))).toBe(false);
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
    tmp = withTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * A card with a leaked `{$she}` (a fact) and a `[does]` (an opinion) in one body. The
   * fact is an ERROR finding, so every `--lint` run over this tree exits 1 — the report is
   * still written, which is what the assertions read.
   */
  function writeLintable() {
    write(
      path.join(tmp, 'scenario', 'Story Cards', 'Char', 'a.md'),
      ['## Aria', '', '~~~', 'triggers: [Aria]', '~~~', '', 'She caught {$she} hair and love[does] it.', ''].join('\n')
    );
  }

  test('--lint-level=off silences the opinions and leaves the facts', () => {
    writeLintable();
    const result = run(['-L', '--lint-level=off', path.join(tmp, 'scenario')], tmp);
    expect(result.status).toBe(1);
    const report = fs.readFileSync(
      path.join(tmp, 'overview', 'lint', 'scenario.lint.md'), 'utf8');
    expect(report).toContain('CL0430');
    expect(report).not.toContain('CL0436');
  });

  test('the space-separated spelling works too, and does not eat the path', () => {
    writeLintable();
    const result = run(['-L', '--lint-level', 'off', path.join(tmp, 'scenario')], tmp);
    // Exit 1 is the ERROR finding, not a swallowed path: the report landed where the path said.
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/Fatal|not found/);
    expect(fs.existsSync(path.join(tmp, 'overview', 'lint'))).toBe(true);
  });

  test('with no flag the opinions are reported as scanned', () => {
    writeLintable();
    const result = run(['-L', path.join(tmp, 'scenario')], tmp);
    expect(result.status).toBe(1);
    const report = fs.readFileSync(
      path.join(tmp, 'overview', 'lint', 'scenario.lint.md'), 'utf8');
    expect(report).toContain('CL0436');
  });

  test('--lint exits 1 on an ERROR finding and 0 on a tree that only has WARNs', () => {
    writeLintable();
    expect(run(['-L', path.join(tmp, 'scenario')], tmp).status).toBe(1);

    fs.rmSync(path.join(tmp, 'scenario'), { recursive: true, force: true });
    write(
      path.join(tmp, 'scenario', 'Story Cards', 'Char', 'a.md'),
      ['## Aria', '', '~~~', 'triggers: [Aria]', '~~~', '', 'She love[does] it.', ''].join('\n')
    );
    const result = run(['-L', path.join(tmp, 'scenario')], tmp);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Lint: 0 error\(s\), 1 warning\(s\)/);
  });

  /**
   * `resolveArgs` already loads the config to find the output and reports directories, so the
   * level is in hand. Without passing it out, `--lint` answered differently from the compile
   * that wrote the tree it is reading, on the same project's own setting.
   */
  test('--lint reads lint.level from compile.cl.yaml when no flag is given', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'),
      MINIMAL_COMPILE_YAML.replace('roles:\n  protagonist: Test', 'lint:\n  level: off\nroles:\n  protagonist: Test'));
    write(
      path.join(tmp, 'proj', 'output', 'Story Cards', 'Char', 'a.md'),
      ['## Aria', '', '~~~', 'triggers: [Aria]', '~~~', '', 'She caught {$she} hair and love[does] it.', ''].join('\n')
    );

    const result = run(['-L', path.join(tmp, 'proj')], tmp);
    expect(result.status).toBe(1);
    const report = fs.readFileSync(
      path.join(tmp, 'proj', 'output', 'Overview', 'lint', 'output.lint.md'), 'utf8');
    expect(report).toContain('CL0430');
    expect(report).not.toContain('CL0436');
  });

  test('the flag wins over the config key, being what someone typed for this run', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'),
      MINIMAL_COMPILE_YAML.replace('roles:\n  protagonist: Test', 'lint:\n  level: off\nroles:\n  protagonist: Test'));
    write(
      path.join(tmp, 'proj', 'output', 'Story Cards', 'Char', 'a.md'),
      ['## Aria', '', '~~~', 'triggers: [Aria]', '~~~', '', 'She love[does] it.', ''].join('\n')
    );

    const result = run(['-L', '--lint-level=warn', path.join(tmp, 'proj')], tmp);
    expect(result.status).toBe(0);
    const report = fs.readFileSync(
      path.join(tmp, 'proj', 'output', 'Overview', 'lint', 'output.lint.md'), 'utf8');
    expect(report).toContain('CL0436');
  });

  test('an unknown level exits nonzero and names the three legal ones', () => {
    writeLintable();
    const result = run(['-L', '--lint-level=loud', path.join(tmp, 'scenario')], tmp);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/off, error, warn/);
  });
});

describe('CLI combined compile and lint diagnostics', () => {
  let tmp;

  beforeEach(() => {
    tmp = withTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true });
  });

  test('-C -L reports compile-only warnings in the lint report and summary', () => {
    write(path.join(tmp, 'compile.yaml'), MINIMAL_COMPILE_YAML);

    const result = run(['-C', '-L', tmp], tmp);
    const reportPath = path.join(tmp, 'output', 'Overview', 'lint', 'output.lint.md');
    const report = fs.readFileSync(reportPath, 'utf8');

    expect(result.status).toBe(0);
    expect(report).toContain('CL0630');
    expect(report).toContain('CL0631');
    expect(result.stdout).toMatch(/Lint: 0 error\(s\), 2 warning\(s\)/);
  });

  test('-C -L includes inline-only pack findings under the item source file', () => {
    write(path.join(tmp, 'compile.yaml'), [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [./Codex]',
      '    templates: [./templates]',
      '  output: ./output',
      'lint: {packs: {duckieConv: {}}}',
      'branches: {only: {}}',
      '',
    ].join('\n'));
    write(path.join(tmp, 'templates', 'Card.template'), '{$body.Tagline}\n');
    const itemPath = path.join(tmp, 'Codex', 'items.cl.yaml');
    write(itemPath, [
      '- id: npc',
      '  name: NPC',
      '  aid: {type: Character, triggers: [NPC]}',
      '  render: {template: Card}',
      '  body:',
      '    Tagline: six words run over this ceiling',
      '',
    ].join('\n'));

    const result = run(['-C', '-L', tmp], tmp);
    const report = fs.readFileSync(
      path.join(tmp, 'output', 'Overview', 'lint', 'output.lint.md'), 'utf8',
    );

    expect(result.status).toBe(0);
    expect(report).toContain('CL-duckieConv/0002');
    expect(report).toContain(`## ${itemPath}`);
  });

  test('-C -L writes loader errors to the report even when no lintable output exists', () => {
    write(path.join(tmp, 'compile.yaml'), MINIMAL_COMPILE_YAML.replace('items: []', 'items: [./Codex]'));
    write(path.join(tmp, 'Codex', 'broken.cl.yaml'), '- body: {Tagline: Missing identity}\n');

    const result = run(['-C', '-L', tmp], tmp);
    const reportPath = path.join(tmp, 'output', 'Overview', 'lint', 'output.lint.md');
    const report = fs.readFileSync(reportPath, 'utf8');

    expect(result.status).toBe(1);
    expect(report).toContain('CL0140');
    expect(result.stdout).toMatch(/Lint: [1-9]\d* error\(s\), \d+ warning\(s\) across 0 file\(s\)/);
  });
});

// ── --migrate flag (§14.2, Decision 4) ────────────────────────────────────────

const V3_COMPILE_YAML = `
structure:
  input:
    items: []
  output: ./output
protagonist: Test
branches:
  only: {}
`.trimStart();

describe('CLI --migrate flag', () => {
  let tmp;

  beforeEach(() => {
    tmp = withTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true });
  });

  test('does not trip the version: 4 requirement a v3 project cannot meet', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'), V3_COMPILE_YAML);
    const result = run(['--migrate', path.join(tmp, 'proj')], tmp);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('rewrites protagonist: to roles.protagonist: and adds version: 4', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'), V3_COMPILE_YAML);
    run(['--migrate', path.join(tmp, 'proj')], tmp);
    const config = fs.readFileSync(path.join(tmp, 'proj', 'compile.yaml'), 'utf8');
    expect(config).toContain('version: 4');
    expect(config).toMatch(/roles:\s*\n\s*protagonist: Test/);
    expect(config).not.toMatch(/^protagonist:/m);
  });

  test('writes migration-report.md beside the config', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'), V3_COMPILE_YAML);
    run(['--migrate', path.join(tmp, 'proj')], tmp);
    const report = fs.readFileSync(path.join(tmp, 'proj', 'migration-report.md'), 'utf8');
    expect(report).toContain('# Migration report');
    expect(report).toContain('## Review queue');
  });

  test('does not compile — no output tree is written', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'), V3_COMPILE_YAML);
    run(['--migrate', path.join(tmp, 'proj')], tmp);
    expect(fs.existsSync(path.join(tmp, 'proj', 'output'))).toBe(false);
  });

  test('with no v3 config anywhere, exits nonzero rather than silently doing nothing', () => {
    const result = run(['--migrate', path.join(tmp, 'nowhere')], tmp);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No v3 compile\.yaml found/);
  });

  test('finds compile.yaml in the current directory when no path is given', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'), V3_COMPILE_YAML);
    const result = run(['--migrate'], path.join(tmp, 'proj'));
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'proj', 'migration-report.md'))).toBe(true);
  });

  test.each([4, 5])('refuses a project already at version %i without writing migration files', (version) => {
    const configPath = path.join(tmp, 'proj', 'compile.yaml');
    const source = `version: ${version}\n${V3_COMPILE_YAML}`;
    write(configPath, source);

    const result = run(['--migrate', path.join(tmp, 'proj')], tmp);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(new RegExp(`already declares version: ${version}`));
    expect(fs.readFileSync(configPath, 'utf8')).toBe(source);
    expect(fs.existsSync(path.join(tmp, 'proj', 'migration-report.md'))).toBe(false);
  });
});

// ── --rename-cl as a standalone mode ─────────────────────────────────────────

describe('CLI --rename-cl flag (standalone)', () => {
  let tmp;
  beforeEach(() => { tmp = withTmpDir(); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true }); });

  const V4 = `
version: 4
title: T
structure:
  input:
    items: [./Codex]
  output: ./output
components:
  plotEssential: ./components/pe.yaml
`.trimStart();

  function proj() {
    write(path.join(tmp, 'proj', 'compile.yaml'), V4);
    write(path.join(tmp, 'proj', 'Codex', 'characters.yaml'), '- id: a\n  name: A\n');
    write(path.join(tmp, 'proj', 'components', 'pe.yaml'), 'sections:\n  main: hi\n');
    return path.join(tmp, 'proj');
  }

  test('renames the project without --migrate and exits 0', () => {
    const result = run(['--rename-cl', proj()], tmp);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'proj', 'compile.cl.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'proj', 'Codex', 'characters.cl.yaml'))).toBe(true);
  });

  test('refuses a project that is not yet v4', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'), V3_COMPILE_YAML);
    const result = run(['--rename-cl', path.join(tmp, 'proj')], tmp);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a v4 project/);
  });

  test('with no config anywhere, exits nonzero rather than doing nothing', () => {
    const result = run(['--rename-cl', path.join(tmp, 'nowhere')], tmp);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No compile\.yaml or compile\.cl\.yaml/);
  });

  test('a project already fully on .cl.yaml says so and exits 0', () => {
    const dir = proj();
    run(['--rename-cl', dir], tmp);
    const again = run(['--rename-cl', dir], tmp);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/[Nn]othing to rename/);
  });
});

// ── version: 4 detection on the compile path (§14.1, CL0209) ──────────────────
//
// --migrate above proves a v3 config is *accepted* there; here the same config compiled
// (not migrated) must be refused with the detection ERROR rather than an unknown-key wall.

describe('CLI version: 4 detection', () => {
  let tmp;

  beforeEach(() => {
    tmp = withTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true });
  });

  test('compiling a v3 project (no version:) exits nonzero and names --migrate', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'), V3_COMPILE_YAML);
    const result = run(['-C', path.join(tmp, 'proj')], tmp);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--migrate/);
  });

  test('an unknown version exits nonzero without the migrate hint', () => {
    write(path.join(tmp, 'proj', 'compile.yaml'),
      MINIMAL_COMPILE_YAML.replace('version: 4', 'version: 99'));
    const result = run(['-C', path.join(tmp, 'proj')], tmp);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsupported/i);
  });
});

// ── unknown options ───────────────────────────────────────────────────────────

describe('CLI unknown options', () => {
  let tmp;

  beforeEach(() => {
    tmp = withTmpDir();
    write(path.join(tmp, 'proj', 'compile.yaml'), MINIMAL_COMPILE_YAML);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a dash-led typo is rejected rather than read as the config path', () => {
    const result = run(['--wildly-wrong', path.join(tmp, 'proj')], tmp);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown option --wildly-wrong');
    expect(result.stderr).not.toMatch(/No compile\.yaml found/);
  });

  test('a near miss names the flag it was probably meant to be', () => {
    const result = run(['--card-sizes', path.join(tmp, 'proj')], tmp);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Did you mean --body-sizes?');
  });

  test('a typo far from every flag is reported without a guess', () => {
    const result = run(['--zzzzzzzzzzzz', path.join(tmp, 'proj')], tmp);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown option --zzzzzzzzzzzz');
    expect(result.stderr).not.toMatch(/Did you mean/);
  });

  test('every unknown option is listed, not just the first', () => {
    const result = run(['--nope-one', '--nope-two', path.join(tmp, 'proj')], tmp);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown option --nope-one');
    expect(result.stderr).toContain('Unknown option --nope-two');
  });

  test('a repeated known flag is consumed, not mistaken for an unknown one', () => {
    const result = run(['-C', '-C', path.join(tmp, 'proj')], tmp);
    expect(result.stderr).not.toMatch(/Unknown option/);
    expect(result.status).toBe(0);
  });

  test('a bare path still compiles', () => {
    const result = run([path.join(tmp, 'proj')], tmp);
    expect(result.stderr).not.toMatch(/Unknown option/);
    expect(result.status).toBe(0);
  });
});
