'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Diagnostics } = require('../../src/diag');
const { loadCompileConfig, CODES } = require('../../src/config/load');
const { syncLibrary, checkDrift, listAllFiles } = require('../../src/snapshot');

let tmpDir;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-snapshot-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeFile(rel, content) {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

/** A minimal project: one library entry ("main") with a .cl.yaml item, a companion .md
 * note (imports:/variants survive a raw-byte copy — a differently-suffixed file beside a
 * component is the sharpest test of "no re-serialization"), and structure.input.snapshot set. */
function buildProject() {
  writeFile('main-lib/thing.cl.yaml', 'id: Thing\nname: Thing\n');
  writeFile('main-lib/thing.notes.md', '# notes\n');
  const cfgPath = path.join(tmpDir, 'compile.cl.yaml');
  fs.writeFileSync(cfgPath, [
    'version: 4',
    'structure:',
    '  output: ./out',
    '  reports: ./reports',
    '  input:',
    '    library:',
    '      main: ./main-lib',
    '    snapshot: ./snapshot',
  ].join('\n') + '\n', 'utf8');
  const diagnostics = new Diagnostics();
  const config = loadCompileConfig(cfgPath, { diagnostics });
  return { config, diagnostics };
}

describe('listAllFiles — the full-tree lister', () => {
  test('is not suffix-filtered: it lists every file type under a directory', () => {
    writeFile('tree/a.cl.yaml', 'a');
    writeFile('tree/b.md', 'b');
    writeFile('tree/sub/c.txt', 'c');
    const files = listAllFiles(path.join(tmpDir, 'tree'));
    expect(files.sort()).toEqual(['a.cl.yaml', 'b.md', 'sub/c.txt']);
  });

  test('.cl.yaml files are included in a snapshot copy (pinning the open question from Step 0)', () => {
    writeFile('tree2/component.cl.yaml', 'x');
    const files = listAllFiles(path.join(tmpDir, 'tree2'));
    expect(files).toContain('component.cl.yaml');
  });
});

describe('syncLibrary — the freeze', () => {
  test('copies every file byte-identical into snapshot/<name>/, including a companion .md', () => {
    const { config } = buildProject();
    const result = syncLibrary(config);

    const yamlOut = path.join(config._resolvedSnapshot, 'main', 'thing.cl.yaml');
    const mdOut = path.join(config._resolvedSnapshot, 'main', 'thing.notes.md');
    expect(fs.readFileSync(yamlOut, 'utf8')).toBe('id: Thing\nname: Thing\n');
    expect(fs.readFileSync(mdOut, 'utf8')).toBe('# notes\n');
    expect(result.filesWritten).toBe(2);
  });

  test('writes a valid manifest.json (manifestVersion, syncedAt, library section, no requiresRoles)', () => {
    const { config } = buildProject();
    syncLibrary(config);

    const manifest = JSON.parse(fs.readFileSync(path.join(config._resolvedSnapshot, 'manifest.json'), 'utf8'));
    expect(manifest.manifestVersion).toBe(1);
    expect(typeof manifest.syncedAt).toBe('string');
    expect(manifest.library.main.source).toBe(path.join(tmpDir, 'main-lib'));
    expect(manifest.library.main.files['thing.cl.yaml']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest).not.toHaveProperty('requiresRoles');
    expect(manifest.library.main).not.toHaveProperty('requiresRoles');
  });

  test('a second sync after a live edit updates the manifest and writes sync-diff.txt describing the change', () => {
    const { config } = buildProject();
    syncLibrary(config);

    fs.writeFileSync(path.join(tmpDir, 'main-lib', 'thing.cl.yaml'), 'id: Thing\nname: Changed\n', 'utf8');
    syncLibrary(config);

    const manifest = JSON.parse(fs.readFileSync(path.join(config._resolvedSnapshot, 'manifest.json'), 'utf8'));
    expect(fs.readFileSync(path.join(config._resolvedSnapshot, 'main', 'thing.cl.yaml'), 'utf8'))
      .toBe('id: Thing\nname: Changed\n');

    const diffReport = fs.readFileSync(path.join(config._resolvedReports, 'snapshot', 'sync-diff.txt'), 'utf8');
    expect(diffReport).toContain('changed: thing.cl.yaml');
    expect(manifest.library.main.files['thing.cl.yaml']).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('first-ever sync (no previous manifest) reports everything as new', () => {
    const { config } = buildProject();
    syncLibrary(config);
    const diffReport = fs.readFileSync(path.join(config._resolvedReports, 'snapshot', 'sync-diff.txt'), 'utf8');
    expect(diffReport).toContain('all new (no previous snapshot entry)');
  });
});

describe('checkDrift — the compile-time notice', () => {
  test('is a complete no-op when structure.input.snapshot is unset', () => {
    writeFile('lib2/thing.cl.yaml', 'id: T\n');
    const cfgPath = path.join(tmpDir, 'compile.cl.yaml');
    fs.writeFileSync(cfgPath, 'version: 4\nstructure:\n  output: ./out\n  input:\n    library:\n      main: ./lib2\n', 'utf8');
    const diagnostics = new Diagnostics();
    const config = loadCompileConfig(cfgPath, { diagnostics });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    checkDrift(config, diagnostics);
    expect(spy).not.toHaveBeenCalled();
    expect(diagnostics.all.length).toBe(0);
    spy.mockRestore();
  });

  test('prints nothing against a populated, unmodified snapshot', () => {
    const { config } = buildProject();
    syncLibrary(config);
    const diagnostics = new Diagnostics();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    checkDrift(config, diagnostics);
    expect(spy).not.toHaveBeenCalled();
    expect(diagnostics.all.length).toBe(0);
    spy.mockRestore();
  });

  test('prints exactly one informational drift line after a live edit, and raises nothing on the bus', () => {
    const { config } = buildProject();
    syncLibrary(config);
    fs.writeFileSync(path.join(tmpDir, 'main-lib', 'thing.cl.yaml'), 'id: Thing\nname: Edited\n', 'utf8');

    const diagnostics = new Diagnostics();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    checkDrift(config, diagnostics);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/Library "main" has 1 changed file\(s\) since last snapshot/);
    expect(diagnostics.all.length).toBe(0);
    spy.mockRestore();
  });

  test('hand-editing a file under snapshot/<name>/ raises CL0115 as an ERROR', () => {
    const { config } = buildProject();
    syncLibrary(config);
    fs.writeFileSync(path.join(config._resolvedSnapshot, 'main', 'thing.cl.yaml'), 'id: Thing\nname: Corrupted\n', 'utf8');

    const diagnostics = new Diagnostics();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    checkDrift(config, diagnostics);
    spy.mockRestore();

    const hashMismatch = diagnostics.all.find((d) => d.code === CODES.SNAPSHOT_HASH_MISMATCH);
    expect(hashMismatch).toBeDefined();
    expect(hashMismatch.severity).toBe('error');
  });

  test('a manifest entry for a config-declared library name that is missing raises CL0113', () => {
    const { config } = buildProject();
    syncLibrary(config);
    const manifestPath = path.join(config._resolvedSnapshot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.library.main;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const diagnostics = new Diagnostics();
    checkDrift(config, diagnostics);
    const missingEntry = diagnostics.all.find((d) => d.code === CODES.SNAPSHOT_MISSING_ENTRY);
    expect(missingEntry).toBeDefined();
    expect(missingEntry.severity).toBe('warn');
  });
});
