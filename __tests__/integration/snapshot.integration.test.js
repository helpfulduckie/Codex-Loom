'use strict';

const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { compile } = require('../../src/compile');
const { collectingLog } = require('../helpers/log');

const CLI = path.resolve(__dirname, '../../src/cli.js');

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
    'roles:',
    '  protagonist: Aness',
    'branches:',
    '  main:',
    '    roles:',
    '      protagonist: Aness',
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
    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.library.main.files['note.cl.yaml']).toMatch(/^sha256:/);
  });

  test('--snapshot alone does not also compile', () => {
    const configPath = buildProject();
    const result = spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'output'))).toBe(false);
  });

  test('a role token unresolved anywhere in the snapshot is published as requiresRoles', () => {
    const configPath = buildProject();
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
      '    Tagline: "{$LI} arrives."',
      '',
    ].join('\n'), 'utf8');
    const result = spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });
    expect(result.status).toBe(0);

    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'snapshot', 'manifest.json'), 'utf8'));
    expect(manifest.library.main.requiresRoles).toEqual(['LI']);
  });

  test('a library entry whose own items fail to validate refuses requiresRoles, raises CL0116 and exits non-zero', () => {
    const configPath = buildProject();
    fs.writeFileSync(path.join(tmpDir, 'main-lib', 'note.cl.yaml'), '- id: Note\n  weird: nope\n', 'utf8');
    const result = spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CL0116');

    // Sync still ran: the frozen copy exists even though the role scan was refused.
    expect(fs.existsSync(path.join(tmpDir, 'snapshot', 'main', 'note.cl.yaml'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'snapshot', 'manifest.json'), 'utf8'));
    expect(manifest.library.main).not.toHaveProperty('requiresRoles');
  });

  test('a second freeze with nothing to change still exits non-zero for a library whose items do not validate', () => {
    const configPath = buildProject();
    fs.writeFileSync(path.join(tmpDir, 'main-lib', 'note.cl.yaml'), '- id: Note\n  weird: nope\n', 'utf8');
    spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });
    const again = spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain('CL0116');
  });
});

describe('drift notice at compile time', () => {
  test('a normal compile against a populated, unmodified snapshot prints nothing about drift', () => {
    const configPath = buildProject();
    spawnSync(process.execPath, [CLI, '--snapshot', configPath], { encoding: 'utf8', cwd: tmpDir });

    const log = collectingLog();
    compile(configPath, { log });
    const drifted = log.lines.some((line) => String(line).includes('changed file(s) since last snapshot'));
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

describe('snapshot-preferring resolution (--live escape hatch)', () => {
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

describe('freezeLibraries (the freeze as a call)', () => {
  const { freezeLibraries } = require('../../src/compile');

  test('the first freeze copies every library file and reports the entry as new', () => {
    const configPath = buildProject();
    const result = freezeLibraries(configPath);
    expect(result).toMatchObject({
      status: 'ok', reason: null, filesWritten: 1, snapshot: path.join(tmpDir, 'snapshot'),
      entries: [{ name: 'main', kind: 'library', isNew: true, added: ['note.cl.yaml'], removed: [], changed: [] }],
    });
    expect(fs.existsSync(path.join(tmpDir, 'snapshot', 'main', 'note.cl.yaml'))).toBe(true);
    expect(fs.existsSync(result.manifest)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test('a later freeze names the files that changed, appeared and went', () => {
    const configPath = buildProject();
    freezeLibraries(configPath);
    const note = path.join(tmpDir, 'main-lib', 'note.cl.yaml');
    fs.writeFileSync(note, fs.readFileSync(note, 'utf8').replace('Original', 'Revised'), 'utf8');
    writeFile('main-lib/extra.cl.yaml', '- id: Extra\n  aid: {type: Character, title: Extra}\n  render: {template: Character}\n');
    expect(freezeLibraries(configPath).entries).toEqual([
      { name: 'main', kind: 'library', isNew: false, added: ['extra.cl.yaml'], removed: [], changed: ['note.cl.yaml'] },
    ]);
    expect(fs.readFileSync(path.join(tmpDir, 'snapshot', 'main', 'note.cl.yaml'), 'utf8')).toContain('Revised');

    fs.rmSync(path.join(tmpDir, 'main-lib', 'extra.cl.yaml'));
    expect(freezeLibraries(configPath).entries[0]).toMatchObject({ added: [], removed: ['extra.cl.yaml'], changed: [] });
    expect(fs.existsSync(path.join(tmpDir, 'snapshot', 'main', 'extra.cl.yaml'))).toBe(false);
  });

  test('a freeze with nothing to adopt changes no entry', () => {
    const configPath = buildProject();
    freezeLibraries(configPath);
    expect(freezeLibraries(configPath).entries).toEqual([
      { name: 'main', kind: 'library', isNew: false, added: [], removed: [], changed: [] },
    ]);
  });

  test('a project that declares no snapshot is blocked and nothing is written', () => {
    const configPath = buildProject();
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('    snapshot: ./snapshot\n', ''), 'utf8');
    const result = freezeLibraries(configPath);
    expect(result).toMatchObject({ status: 'blocked', entries: [], filesWritten: 0 });
    expect(result.reason).toMatch(/snapshot is not set/);
    expect(fs.existsSync(path.join(tmpDir, 'snapshot'))).toBe(false);
  });

  test('a config that does not load is blocked with its diagnostics', () => {
    const configPath = buildProject();
    fs.writeFileSync(configPath, 'version: [4', 'utf8');
    const result = freezeLibraries(configPath);
    expect(result.status).toBe('blocked');
    expect(result.diagnostics.some((d) => d.code === 'CL0101')).toBe(true);
  });
});

describe('saved snapshot inspection and confirmation', () => {
  const { inspectSnapshot, freezeLibraries } = require('../../src/compile');
  const { listFilesRelative } = require('../../src/util');
  const diskState = () => listFilesRelative(tmpDir).map((rel) => {
    const file = path.join(tmpDir, rel);
    return [rel, fs.readFileSync(file).toString('hex'), fs.statSync(file).mtimeMs];
  });

  test('inspection reads actual frozen files without writing and a true no-op writes nothing', () => {
    const config = buildProject();
    const before = diskState();
    const first = inspectSnapshot(config);
    expect(first).toMatchObject({ status: 'ok', hasChanges: true, manifestChanged: true });
    expect(first.entries[0]).toMatchObject({ added: ['note.cl.yaml'], frozen: {} });
    expect(diskState()).toEqual(before);
    expect(inspectSnapshot(config).fingerprint).toBe(first.fingerprint);
    freezeLibraries(config, { expectedState: first.fingerprint });
    const saved = diskState();
    const same = inspectSnapshot(config);
    expect(same).toMatchObject({ status: 'ok', hasChanges: false, manifestChanged: false });
    expect(freezeLibraries(config, { expectedState: same.fingerprint }).filesWritten).toBe(0);
    expect(diskState()).toEqual(saved);

    writeFile('snapshot/main/note.cl.yaml', 'manually changed frozen content');
    writeFile('snapshot/main/untracked.js', '1');
    const edited = diskState();
    const actual = inspectSnapshot(config);
    expect(actual.entries[0]).toMatchObject({ changed: ['note.cl.yaml'], removed: ['untracked.js'] });
    expect(actual.fingerprint).not.toBe(same.fingerprint);
    expect(diskState()).toEqual(edited);
    expect(freezeLibraries(config, { expectedState: same.fingerprint })).toMatchObject({ status: 'blocked', filesWritten: 0 });
    expect(diskState()).toEqual(edited);
  });

  test.each(['config', 'live script', 'manifest', 'frozen file'])('%s changes invalidate confirmation before any write', (target) => {
    const config = buildProject();
    writeFile('main-lib/scripts/input.js', '1');
    freezeLibraries(config);
    const expectedState = inspectSnapshot(config).fingerprint;
    if (target === 'config') {
      fs.appendFileSync(config, '\n# saved config edit\n');
    } else if (target === 'live script') writeFile('main-lib/scripts/input.js', '2');
    else if (target === 'manifest') fs.appendFileSync(path.join(tmpDir, 'snapshot/manifest.json'), '\n');
    else writeFile('snapshot/main/scripts/input.js', '2');
    const changed = diskState();
    expect(freezeLibraries(config, { expectedState })).toMatchObject({ status: 'blocked', filesWritten: 0 });
    expect(diskState()).toEqual(changed);
  });

  test('script and external template changes are visible independently of item definitions', () => {
    const config = buildProject();
    const templates = path.join(tmpDir, '../' + path.basename(tmpDir) + '-templates');
    fs.mkdirSync(templates);
    try {
      fs.writeFileSync(path.join(templates, 'Character.template'), 'one');
      fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(path.join(tmpDir, 'templates'), templates));
      writeFile('main-lib/scripts/input.js', '1');
      freezeLibraries(config);
      const before = inspectSnapshot(config);
      writeFile('main-lib/scripts/input.js', '2');
      fs.writeFileSync(path.join(templates, 'Character.template'), 'two');
      const after = inspectSnapshot(config);
      expect(after.fingerprint).not.toBe(before.fingerprint);
      expect(after.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'library', changed: ['scripts/input.js'] }),
        expect.objectContaining({ kind: 'template', changed: ['Character.template'] }),
      ]));
      expect(freezeLibraries(config, { expectedState: before.fingerprint }).status).toBe('blocked');
    } finally { fs.rmSync(templates, { recursive: true, force: true }); }
  });

  test('removing a library declaration reports and removes its owned frozen files', () => {
    const config = buildProject();
    freezeLibraries(config);
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(`      main: ${path.join(tmpDir, 'main-lib')}\n`, ''));
    const inspection = inspectSnapshot(config);
    expect(inspection).toMatchObject({ status: 'ok', hasChanges: true, manifestChanged: true });
    expect(inspection.entries[0]).toMatchObject({ name: 'main', removed: ['note.cl.yaml'] });
    expect(freezeLibraries(config, { expectedState: inspection.fingerprint }).status).toBe('ok');
    expect(fs.existsSync(path.join(tmpDir, 'snapshot/main'))).toBe(false);
    expect(inspectSnapshot(config).hasChanges).toBe(false);
  });
});
