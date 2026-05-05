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

// ── --leafReview / -l flag ────────────────────────────────────────────────────

describe('CLI --leafReview flag', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true });
  });

  test('--leafReview with path writes one .overview.md per leaf', () => {
    write(path.join(tmp, 'scenario', 'Branches', 'hero', 'Story Cards', 'Char', 'x.md'), 'content');
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);

    const result = run(['--leafReview', path.join(tmp, 'scenario'), outDir]);
    expect(result.status).toBe(0);

    const files = fs.readdirSync(outDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every(f => f.endsWith('.overview.md'))).toBe(true);
  });

  test('-l short flag is accepted', () => {
    write(path.join(tmp, 'scenario', 'Story Cards', 'Char', 'x.md'), 'content');
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);

    const result = run(['-l', path.join(tmp, 'scenario'), outDir]);
    expect(result.status).toBe(0);
  });

  test('--leafReview with explicit output dir uses that dir', () => {
    write(path.join(tmp, 'scenario', 'Story Cards', 'T', 'c.md'), 'c');
    const outDir = path.join(tmp, 'custom-out');
    fs.mkdirSync(outDir);

    run(['--leafReview', path.join(tmp, 'scenario'), outDir]);
    expect(fs.readdirSync(outDir).length).toBeGreaterThan(0);
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

  test('--leafReview with no output-dir defaults to <cwd>/leaf-review', () => {
    write(path.join(tmp, 'scenario', 'Story Cards', 'T', 'c.md'), 'c');
    const result = spawnSync(
      process.execPath,
      [CLI, '--leafReview', path.join(tmp, 'scenario')],
      { encoding: 'utf8', cwd: tmp }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'leaf-review'))).toBe(true);
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
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);

    const result = run(['--overview', path.join(tmp, 'scenario'), outDir]);
    expect(result.status).toBe(0);

    const files = fs.readdirSync(outDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.overview\.md$/);
  });

  test('-o short flag is accepted', () => {
    write(path.join(tmp, 'scenario', 'Story Cards', 'Char', 'x.md'), 'content');
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);

    const result = run(['-o', path.join(tmp, 'scenario'), outDir]);
    expect(result.status).toBe(0);
  });

  test('--overview with missing scenario root exits nonzero', () => {
    const result = run(['--overview', path.join(tmp, 'no-such-dir')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not found/i);
  });

  test('--overview without args exits nonzero with usage message', () => {
    const result = run(['--overview']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
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

  test('no args prints usage and exits nonzero', () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
  });
});
