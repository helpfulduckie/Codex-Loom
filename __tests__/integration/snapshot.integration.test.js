'use strict';

const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { compile } = require('../../src/compile');

const CLI = path.resolve(__dirname, '../../src/compile.js');

let tmpDir;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-snapshot-e2e-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeFile(rel, content) {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

/** A compilable project (item, template, library entry) with structure.input.snapshot set. */
function buildProject() {
  writeFile('cards/items.cl.yaml', [
    '- id: hero',
    '  aid:',
    '    type: Character',
    '    title: Hero',
    '    triggers: [Hero]',
    '  render:',
    '    template: Character',
    '    wrapper: none',
    '  body:',
    '    Tagline: "{%main}"',
    '',
  ].join('\n'));
  writeFile('templates/Character.template', '{$aid.title} - {$body.Tagline}\n');
  writeFile('main-lib/note.cl.yaml', 'id: Note\nname: Note\n');
  const configPath = path.join(tmpDir, 'compile.yaml');
  fs.writeFileSync(configPath, [
    'version: 4',
    'structure:',
    '  input:',
    '    items:',
    `      - ${path.join(tmpDir, 'cards')}`,
    '    templates:',
    `      - ${path.join(tmpDir, 'templates')}`,
    '    library:',
    `      main: ${path.join(tmpDir, 'main-lib')}`,
    '    snapshot: ./snapshot',
    `  output: ${path.join(tmpDir, 'output')}`,
    'protagonist: Aness',
    'branches:',
    '  main:',
    '    protagonist: Aness',
    '',
  ].join('\n'), 'utf8');
  return configPath;
}

describe('--snapshot (CLI mode)', () => {
  test('produces snapshot/<name>/ with byte-identical files and a manifest.json', () => {
    const configPath = buildProject();
    const result = spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });
    expect(result.status).toBe(0);

    const copied = path.join(tmpDir, 'snapshot', 'main', 'note.cl.yaml');
    expect(fs.readFileSync(copied, 'utf8')).toBe('id: Note\nname: Note\n');

    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'snapshot', 'manifest.json'), 'utf8'));
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.library.main.files['note.cl.yaml']).toMatch(/^sha256:/);
  });

  test('--snapshot alone does not also compile', () => {
    const configPath = buildProject();
    const result = spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'output'))).toBe(false);
  });
});

describe('drift notice at compile time', () => {
  test('a normal compile against a populated, unmodified snapshot prints nothing about drift', () => {
    const configPath = buildProject();
    spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });

    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    compile(configPath);
    const drifted = spy.mock.calls.some((args) => String(args[0]).includes('changed file(s) since last snapshot'));
    spy.mockRestore();
    expect(drifted).toBe(false);
  });

  test('a normal compile after editing the live library file prints exactly one drift line and exits 0', () => {
    const configPath = buildProject();
    spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });

    fs.writeFileSync(path.join(tmpDir, 'main-lib', 'note.cl.yaml'), 'id: Note\nname: Edited\n', 'utf8');

    const result = spawnSync(process.execPath, [CLI, configPath], { encoding: 'utf8', cwd: tmpDir });
    expect(result.status).toBe(0);
    const driftLines = result.stdout.split('\n').filter((l) => l.includes('changed file(s) since last snapshot'));
    expect(driftLines.length).toBe(1);
    expect(driftLines[0]).toMatch(/^Library "main" has 1 changed file\(s\) since last snapshot \(\d{4}-\d{2}-\d{2}\)\. Run --snapshot to review\.$/);
  });
});
