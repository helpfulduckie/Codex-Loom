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

/**
 * A compilable project (item, template, library entry) with structure.input.snapshot set.
 *
 * `main-lib/note.cl.yaml` is itself a renderable item, included into the project via
 * `{%main}/note.cl.yaml` (§7.6.2a's `include:`), so its `body.Tagline` reaches compiled
 * output directly — resolution tests can edit that file and read the difference back out
 * of `output/`, not just infer it from a path string.
 */
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
    "- include: '{%main}/note.cl.yaml'",
    '',
  ].join('\n'));
  writeFile('templates/Character.template', '{$aid.title} - {$body.Tagline}\n');
  writeFile('main-lib/note.cl.yaml', [
    '- id: Note',
    '  aid:',
    '    type: Character',
    '    title: Note',
    '    triggers: [Note]',
    '  render:',
    '    template: Character',
    '    wrapper: none',
    '  body:',
    '    Tagline: Original',
    '',
  ].join('\n'));
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
    expect(fs.readFileSync(copied, 'utf8')).toBe(fs.readFileSync(path.join(tmpDir, 'main-lib', 'note.cl.yaml'), 'utf8'));

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

    fs.writeFileSync(path.join(tmpDir, 'main-lib', 'note.cl.yaml'), '- id: Note\n  name: Edited\n', 'utf8');

    const result = spawnSync(process.execPath, [CLI, configPath], { encoding: 'utf8', cwd: tmpDir });
    expect(result.status).toBe(0);
    const driftLines = result.stdout.split('\n').filter((l) => l.includes('changed file(s) since last snapshot'));
    expect(driftLines.length).toBe(1);
    expect(driftLines[0]).toMatch(/^Library "main" has 1 changed file\(s\) since last snapshot \(\d{4}-\d{2}-\d{2}\)\. Run --snapshot to review\.$/);
  });
});

describe('snapshot-preferring resolution (Phase 7 Session B, --live escape hatch)', () => {
  const read = (tmp, ...parts) => fs.readFileSync(path.join(tmp, 'output', ...parts), 'utf8');

  test('a non-`--live` compile reads the frozen snapshot copy, not a live edit', () => {
    const configPath = buildProject();
    spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });

    fs.writeFileSync(path.join(tmpDir, 'main-lib', 'note.cl.yaml'), [
      '- id: Note',
      '  aid:',
      '    type: Character',
      '    title: Note',
      '    triggers: [Note]',
      '  render:',
      '    template: Character',
      '    wrapper: none',
      '  body:',
      '    Tagline: Edited',
      '',
    ].join('\n'), 'utf8');

    const frozen = spawnSync(process.execPath, [CLI, '--compile', configPath], { encoding: 'utf8', cwd: tmpDir });
    expect(frozen.status).toBe(0);
    const frozenCard = read(tmpDir, 'Branches', 'main', 'Story Cards', 'Character', 'Character.md');
    expect(frozenCard).toContain('Note - Original');
    expect(frozenCard).not.toContain('Note - Edited');

    fs.rmSync(path.join(tmpDir, 'output'), { recursive: true, force: true });
    const live = spawnSync(process.execPath, [CLI, '--compile', '--live', configPath], { encoding: 'utf8', cwd: tmpDir });
    expect(live.status).toBe(0);
    const liveCard = read(tmpDir, 'Branches', 'main', 'Story Cards', 'Character', 'Character.md');
    expect(liveCard).toContain('Note - Edited');
    expect(liveCard).not.toContain('Note - Original');
  });

  test('an `imports:` inside a frozen library file cannot reach a live sibling through `{%main}`', () => {
    // A component document (top-level `sections:`, no `id`/`name`) is expected content
    // inside a mixed-purpose library directory (`loader/registry.js`'s `loadItemsFromDir`
    // skips it silently rather than treating it as a malformed item), so `main-lib/` can
    // carry both `note.cl.yaml` (an item) and this pair of component files.
    //
    // `main-lib/world.cl.yaml` is itself inside the frozen library and reaches a sibling,
    // `main-lib/base.cl.yaml`, only through its own `imports: - from: '{%main}/base.cl.yaml'`
    // (§7.6's chain, `resolveImports` in `loader/component.js`) — so `{%main}` has to resolve
    // through the same frozen redirection there as it does at the project's own top level.
    writeFile('main-lib/base.cl.yaml', [
      'sections:',
      '  greeting:',
      '    text: Original',
      '',
    ].join('\n'));
    writeFile('main-lib/world.cl.yaml', [
      'imports:',
      "  - from: '{%main}/base.cl.yaml'",
      // `loadItemsFromDir`'s "this is a component doc, not a malformed item" skip keys
      // on a top-level `sections:`, so an imports-only file needs the empty mapping to be
      // recognized inside a canon-scanned library directory (unlike a project-level
      // component file, which is never scanned as canon in the first place).
      'sections: {}',
      '',
    ].join('\n'));
    writeFile('components/pe.cl.yaml', [
      'imports:',
      "  - from: '{%main}/world.cl.yaml'",
      '',
    ].join('\n'));

    const configPath = buildProject();
    // Add `components.plotEssential` to the config `buildProject()` wrote, pointed at the
    // project-level component file above — the one thing this test needs beyond the shared
    // fixture, since `buildProject()`'s own project carries no component.
    fs.appendFileSync(configPath, [
      'components:',
      `  plotEssential: ${path.join(tmpDir, 'components', 'pe.cl.yaml')}`,
      '',
    ].join('\n'), 'utf8');

    spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });

    fs.writeFileSync(path.join(tmpDir, 'main-lib', 'base.cl.yaml'), [
      'sections:',
      '  greeting:',
      '    text: Edited',
      '',
    ].join('\n'), 'utf8');

    const frozen = spawnSync(process.execPath, [CLI, '--compile', configPath], { encoding: 'utf8', cwd: tmpDir });
    expect(frozen.status).toBe(0);
    const plotEssentials = read(tmpDir, 'Branches', 'main', 'Components', 'Plot Essentials.md');
    expect(plotEssentials).toContain('Original');
    expect(plotEssentials).not.toContain('Edited');
  });
});
