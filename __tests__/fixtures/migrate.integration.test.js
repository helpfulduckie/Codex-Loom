'use strict';

/**
 * The v3 migrator against real v3 projects (§14.2, §14.3).
 *
 * `goldenFixtures/*​/Loom/` is the untouched v3-era source for all three projects, and
 * `v3/` is the committed output of compiling the hand-converted `v4/` sources. That makes a
 * transitive check available that no unit test can give: migrate `Loom/`, compile the
 * result, and it must equal the same frozen baseline the hand conversion produces.
 *
 * ── Why this compares output and not YAML ───────────────────────────────────
 *
 * The migrator is not asked to reproduce `v4/` character for character, and demanding that
 * would fail it for being differently-shaped rather than wrong. The Institute is the case
 * that proves the point: its five v3 blocks share a wrapper and no heading, so the migrator
 * emits one slot where a human wrote three semantic ones. Different file, identical bytes
 * out — and identical bytes out is the only property that actually matters.
 *
 * ── Why the copy is deep ────────────────────────────────────────────────────
 *
 * Migration rewrites in place, and the fixtures are the project's evidence. Every run works
 * on a temp copy of the whole `goldenFixtures/` tree, because each project's compile.yaml
 * reaches up three levels for shared canon and templates — so neither the inputs nor the
 * output can be redirected without moving all of it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');

const { compile } = require('../../src/compile');
const { migrateProjectFully, migratePlaceholders } = require('../../src/migrate');
const { PROJECTS, OUTPUT_SUBDIR, BASELINE_SUBDIR } = require('../../goldenFixtures/projects');

const GOLDEN_DIR = path.resolve(__dirname, '..', '..', 'goldenFixtures');
const LOOM_SUBDIR = 'Loom';

/** Every markdown file under `dir`, as forward-slashed relative paths. */
function listMarkdown(dir) {
  const out = [];
  const walk = (current, prefix) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else if (entry.name.endsWith('.md')) out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

function quietly(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return fn(); } finally { Object.assign(console, saved); }
}

/** Migrate one project's `Loom/` tree in place and compile it. Returns the output dir. */
function migrateAndCompile(tmpDir, project) {
  const configPath = path.join(tmpDir, project.dir, LOOM_SUBDIR, 'compile.yaml');

  const notes = [];
  quietly(() => {
    notes.push(...migrateProjectFully(configPath).notes);
    compile(configPath);
  });

  return { outputDir: path.join(tmpDir, project.dir, OUTPUT_SUBDIR), notes };
}

describe('migrating a real v3 project reproduces the hand conversion\'s output', () => {
  let tmpDir;
  const results = new Map();

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-migrate-'));
    fs.cpSync(GOLDEN_DIR, tmpDir, { recursive: true });
    for (const project of PROJECTS) results.set(project.name, migrateAndCompile(tmpDir, project));
  }, 120000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const project of PROJECTS) {
    describe(project.name, () => {
      const baselineDir = () => path.join(GOLDEN_DIR, project.dir, BASELINE_SUBDIR);

      test('writes exactly the files the baseline has', () => {
        // Checked before content, because a missing or extra file is a different failure
        // from a changed one — an item that migrated into the wrong output shows up here.
        expect(listMarkdown(results.get(project.name).outputDir)).toEqual(listMarkdown(baselineDir()));
      });

      test('every file is byte-identical to the baseline', () => {
        const outputDir = results.get(project.name).outputDir;
        const differing = listMarkdown(baselineDir()).filter((rel) => {
          const a = path.join(outputDir, ...rel.split('/'));
          const b = path.join(baselineDir(), ...rel.split('/'));
          return !fs.existsSync(a) || !fs.readFileSync(a).equals(fs.readFileSync(b));
        });
        expect(differing).toEqual([]);
      });
    });
  }

  describe('Phase 4 — a migration step that converts nothing, proven rather than assumed', () => {
    // §15: a phase that changes syntax and does not name its migration step has not
    // finished planning. Phase 4 changes syntax and genuinely has nothing to convert —
    // there is no v3 spelling of `placeholders:` and no v3 project holds the data in
    // another form — so the obligation is discharged by asserting the silence.
    //
    // Phase 3 is why this is not left implicit. That phase recorded "migrate/v3.js
    // untouched, per plan", nothing carried the obligation forward, and the migrator
    // silently lacked the one phase that changed structure for months. A no-op that is
    // merely true is indistinguishable from one that was forgotten.

    test('the stage exists and reports no change', () => {
      expect(migratePlaceholders()).toEqual({ changed: false, notes: [] });
    });

    test('no migrated config acquires a placeholders: key', () => {
      // Read as `compile.yaml`, not `compile.cl.yaml`: `migrateAndCompile` passes no
      // options, and §4.6 makes the rename opt-in — plain `.yaml` is not deprecated and
      // `--migrate` renames only when asked. This line is that default's proof, since a
      // rename slipping into the default path would fail here rather than anywhere the
      // rename is the subject.
      for (const project of PROJECTS) {
        const configPath = path.join(tmpDir, project.dir, LOOM_SUBDIR, 'compile.yaml');
        const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        expect([project.name, config.placeholders]).toEqual([project.name, undefined]);
      }
    });

    test('no migrated source grows a %key% anywhere', () => {
      // The inverse of the pairing, which a stale no-op would also pass: assert the
      // migrator does not *introduce* the new syntax, not merely that it left the config
      // alone. These three projects use no placeholders at all, so any %key% in a migrated
      // tree came from the migrator.
      const offenders = [];
      for (const project of PROJECTS) {
        const loomDir = path.join(tmpDir, project.dir, LOOM_SUBDIR);
        const walk = (dir) => {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!/\.(ya?ml|md)$/i.test(entry.name)) continue;
            if (/%\w+%/.test(fs.readFileSync(full, 'utf8'))) {
              offenders.push(path.relative(tmpDir, full));
            }
          }
        };
        walk(loomDir);
      }
      expect(offenders).toEqual([]);
    });
  });

  test('the migration reports what it guessed, so nothing lands unreviewed', () => {
    // Slot names have no source in v3 — blocks are anonymous — so every one is a guess, and
    // a migration that made them silently would be one nobody knows to check.
    for (const project of PROJECTS) {
      const notes = results.get(project.name).notes;
      expect(notes.some((n) => n.includes('was named by the migrator'))).toBe(true);
    }
  });
});
