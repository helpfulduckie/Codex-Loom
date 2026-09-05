'use strict';

/**
 * Phase 7 Session B — snapshot-preferring resolution, decided once at config load.
 *
 * `loadCompileConfig` now computes two library/template maps: `_resolvedLibrarySource` /
 * `_resolvedTemplatesSource` (always live) and `_resolvedLibrary` / `_resolvedTemplates`
 * (the "active" maps every consumer reads). This file covers stop condition 3 from the
 * session plan — that the active/live split is decided once, at load time, rather than
 * re-read by each consumer on every access.
 */

const fs = require('fs');
const path = require('path');
const { Diagnostics } = require('../../src/diag');
const { loadCompileConfig } = require('../../src/config/load');
const { withTmpDir, writeTree } = require('../helpers/project');

let tmpDir;

beforeEach(() => { tmpDir = withTmpDir(); });

/** A project with one library entry, `main`, already synced into `snapshot/main/`. */
function buildSyncedProject() {
  writeTree(tmpDir, {
    'main-lib/note.cl.yaml': 'id: Note\nname: Note\n',
    'snapshot/main/note.cl.yaml': 'id: Note\nname: Note\n',
    'snapshot/manifest.json': JSON.stringify({
      manifestVersion: 1,
      syncedAt: new Date().toISOString(),
      library: {
        main: {
          source: path.join(tmpDir, 'main-lib'),
          files: { 'note.cl.yaml': 'sha256:whatever' },
        },
      },
    }, null, 2),
  });

  const cfgPath = path.join(tmpDir, 'compile.cl.yaml');
  fs.writeFileSync(cfgPath, [
    'version: 4',
    'structure:',
    '  input:',
    '    library:',
    `      main: ${path.join(tmpDir, 'main-lib')}`,
    '    snapshot: ./snapshot',
    `  output: ${path.join(tmpDir, 'output')}`,
    '',
  ].join('\n'), 'utf8');
  return cfgPath;
}

describe('snapshot-preferring resolution', () => {
  test('a populated snapshot redirects the active library map and `{%name}`', () => {
    const cfgPath = buildSyncedProject();
    const config = loadCompileConfig(cfgPath, { diagnostics: new Diagnostics() });

    const expectedActive = path.join(tmpDir, 'snapshot', 'main');
    const expectedSource = path.join(tmpDir, 'main-lib');

    expect(config._resolvedLibrary.get('main')).toBe(expectedActive);
    expect(config._resolvedLibrarySource.get('main')).toBe(expectedSource);
    expect(config._variables.main).toBe(expectedActive);
  });

  test('`options.live` resolves the active map back to the live source', () => {
    const cfgPath = buildSyncedProject();
    const config = loadCompileConfig(cfgPath, { diagnostics: new Diagnostics(), live: true });

    const expectedSource = path.join(tmpDir, 'main-lib');
    expect(config._resolvedLibrary.get('main')).toBe(expectedSource);
    expect(config._variables.main).toBe(expectedSource);
  });

  test('an unsynced project (no manifest) falls back to the live source, silently', () => {
    writeTree(tmpDir, { 'main-lib/note.cl.yaml': 'id: Note\nname: Note\n' });
    const cfgPath = path.join(tmpDir, 'compile.cl.yaml');
    fs.writeFileSync(cfgPath, [
      'version: 4',
      'structure:',
      '  input:',
      '    library:',
      `      main: ${path.join(tmpDir, 'main-lib')}`,
      '    snapshot: ./snapshot',
      `  output: ${path.join(tmpDir, 'output')}`,
      '',
    ].join('\n'), 'utf8');

    const diagnostics = new Diagnostics();
    const config = loadCompileConfig(cfgPath, { diagnostics });
    expect(config._resolvedLibrary.get('main')).toBe(path.join(tmpDir, 'main-lib'));
    // Silent: no manifest yet is the normal first-sync state, not a diagnostic.
    expect(diagnostics.all.length).toBe(0);
  });

  test('resolution is decided once — mutating the manifest or the live file afterward does not change an already-loaded config', () => {
    const cfgPath = buildSyncedProject();
    const config = loadCompileConfig(cfgPath, { diagnostics: new Diagnostics() });

    const expectedActive = path.join(tmpDir, 'snapshot', 'main');
    expect(config._resolvedLibrary.get('main')).toBe(expectedActive);
    expect(config._variables.main).toBe(expectedActive);

    // Remove the manifest entirely and edit the live library file — if redirection were
    // re-read by a consumer instead of baked in at load, either mutation would be visible
    // on the config object returned above.
    fs.rmSync(path.join(tmpDir, 'snapshot', 'manifest.json'));
    fs.writeFileSync(path.join(tmpDir, 'main-lib', 'note.cl.yaml'), 'id: Note\nname: Edited\n', 'utf8');

    expect(config._resolvedLibrary.get('main')).toBe(expectedActive);
    expect(config._variables.main).toBe(expectedActive);
  });
});
