'use strict';

/**
 * Shared scaffold for the one-off compile that the integration suites run: write a
 * `{relPath: content}` map into a fresh temp dir, compile its `compile.yaml`, and read
 * diagnostics off the bus the CLI prints from.
 *
 * `%TMP%` in any file is rewritten to the forward-slashed temp path, so a fixture can name
 * an absolute `structure.input` path; a fixture with no token is unaffected. `compile`
 * throws when it raised an ERROR — the message is only a count — so the throw is captured
 * as `threw` rather than swallowed, because whether a code is an ERROR or a WARN is half of
 * what these suites assert.
 *
 * Cleanup is owned here. Jest gives each test file its own module registry, so this module
 * body — and the `afterAll` below — run once per test file that requires it, tearing down
 * only the dirs that file created.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');

const slash = (p) => p.replace(/\\/g, '/');

const created = [];

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  created.length = 0;
});

/** A fresh temp dir under the OS temp root, registered for the shared afterAll. */
function withTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-'));
  created.push(dir);
  return dir;
}

/** Write a `{relPath: content}` map into `dir`, mkdir -p per file, `%TMP%` → `dir`. */
function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.replace(/%TMP%/g, slash(dir)), 'utf8');
  }
  return dir;
}

/** Compile a throwaway project and hand back the bus, its dir, and any ERROR throw. */
function compileProject(files) {
  const tmpDir = withTmpDir();
  writeTree(tmpDir, files);
  const diagnostics = new Diagnostics();
  let threw = null;
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics });
  } catch (err) {
    threw = err;
  }
  return { diagnostics, tmpDir, threw };
}

/** The diagnostic stream as one string, code+location and message rejoined per entry. */
function formatAll(diagnostics) {
  return diagnostics.all.map((d) => d.format()).join('\n');
}

module.exports = { withTmpDir, writeTree, compileProject, formatAll };
