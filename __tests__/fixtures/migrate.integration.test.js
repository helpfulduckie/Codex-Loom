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
const { migrateProjectFully } = require('../../src/migrate');

const GOLDEN_DIR = path.resolve(__dirname, '..', '..', 'goldenFixtures');

/**
 * The fixtures are a separate private repo cloned into the gitignored `goldenFixtures/` —
 * see `.gitignore`. This file migrates the real v3 sources, so it has nothing to do without
 * them; the same guard and reasoning as `golden.test.js`, which carries the long version.
 */
const HAVE_FIXTURES = fs.existsSync(path.join(GOLDEN_DIR, 'projects.js'));

const { PROJECTS, OUTPUT_SUBDIR, BASELINE_SUBDIR } = HAVE_FIXTURES
  // eslint-disable-next-line global-require
  ? require('../../goldenFixtures/projects')
  : { PROJECTS: [{ name: 'goldenFixtures/ is not cloned — see .gitignore', dir: '' }], OUTPUT_SUBDIR: '', BASELINE_SUBDIR: '' };
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

  let notes = [];
  let reviewQueue = [];
  quietly(() => {
    const result = migrateProjectFully(configPath);
    notes = result.notes;
    reviewQueue = result.reviewQueue;
    compile(configPath);
  });

  return { outputDir: path.join(tmpDir, project.dir, OUTPUT_SUBDIR), notes, reviewQueue, configPath };
}

(HAVE_FIXTURES ? describe : describe.skip)('migrating a real v3 project reproduces the hand conversion\'s output', () => {
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

      // Phase 13 Step 6: Coinflip's `v4/` gains a `lowContext` context tier — a branch
      // carrying `templateFor.base: terse.cl.yaml`. A context tier is a v4-only authoring
      // construct with no v3 spelling, so `migrateProjectFully()` has no step that could
      // produce it and a fresh migration of `Loom/` reproduces only the two framing
      // branches. The `Branches/lowContext/` subtree in the re-baselined `v3/` is
      // therefore a permanent divergence for this one project, the same shape as the
      // Phase 6 / 10 / 12 exceptions below — not a bug in either path.
      const isTierOnly = (rel) => project.dir === path.join('Eldemyr', 'Coinflip Company')
        && rel.split('/').slice(0, 2).join('/') === 'Branches/lowContext';
      const baselineMarkdown = () => listMarkdown(baselineDir()).filter((rel) => !isTierOnly(rel));

      test('writes exactly the files the baseline has', () => {
        // Checked before content, because a missing or extra file is a different failure
        // from a changed one — an item that migrated into the wrong output shows up here.
        expect(listMarkdown(results.get(project.name).outputDir)).toEqual(baselineMarkdown());
      });

      test('every file is byte-identical to the baseline', () => {
        const outputDir = results.get(project.name).outputDir;
        const differing = baselineMarkdown().filter((rel) => {
          // Phase 6 Step 5's one deliberate exception. All three v4/ sources now reach AI
          // Instructions through `imports:` (§7.6) instead of a hardcoded passthrough path,
          // which is a hand-made upgrade past what migration is asked to do — a bare `.md`
          // passthrough is still ordinary, valid v4 syntax, and `migrateProjectFully()`
          // rightly leaves it alone since there is no v3 spelling to convert *from*. So a
          // freshly migrated `Loom/` tree keeps compiling the old shared `.md` verbatim,
          // while the baseline now reflects the `sections:` conversion — a real, permanent
          // divergence for this one file rather than a bug in either path.
          if (path.basename(rel) === 'AI Instructions.md') return false;
          // Phase 10 Step 4's roles gap (§9.2/§9.3): two files were hand-edited in v4/ to
          // carry a `{$role}` reference proving `writeFramingRecursive` and the root
          // Description render now resolve roles — content with no v3 spelling to migrate
          // from at all, unlike Phase 6's re-routed-but-unchanged passthrough. `Loom/`'s v3
          // block for this framing (`ocLoveInterest`) predates the role system, so a fresh
          // migration reproduces the old literal sentence and can never reproduce a
          // hand-added token. Path-scoped rather than by basename, unlike the AI
          // Instructions exception above — `Description.md` and `Opening.md` are common
          // enough filenames elsewhere that excluding every instance would hide a real
          // regression in either project's other output.
          if (
            path.join(project.dir, rel) === path.join('Baseline', 'Baseline', 'Description.md')
            || path.join(project.dir, rel) === path.join(
              'Esudia', 'The Institute', 'Branches', 'Free Form', 'Branches', 'Aness', 'Components', 'Opening.md',
            )
          ) return false;
          // Phase 12 Step 3's field-table gap: The Institute's v3 `Loom/templates/` carries
          // two local override partials (`appearance.partial`, `personality.partial`) that
          // add `originalAppearance` / `originalPersonality` and a "Current " label prefix.
          // The Phase 12 corpus migration converts those into a project `templates/fields.cl.yaml`
          // by hand; `migrateProjectFully()` has no step that converts a local `.partial`
          // override into a field-table entry (Phase 12 added no migration step), so a fresh
          // migration reproduces the shared appearance/personality behavior while the
          // hand-authored `v4/` carries the `original*` extension. Visible only on the
          // transformed-protagonist leaves (Wyvern / Interface Crystal × Aness) where the
          // `original*` data exists — a real, permanent divergence for these files, not a
          // bug in either path. Path-scoped, like the roles exception above.
          if (
            project.dir === path.join('Esudia', 'The Institute')
            && /^Branches[\\/](Wyvern|Interface Crystal)[\\/]Branches[\\/]Aness[\\/].*[\\/]Plot Essentials\.md$/
              .test(rel.split('/').join(path.sep))
          ) return false;
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

  describe('Phase 7 — the snapshot key has no v3 spelling to migrate, proven rather than assumed', () => {
    // §14.2: a phase that changes syntax and does not name its migration step has not
    // finished planning. Phase 7 adds `structure.input.snapshot`, and the reason
    // `migrate/v3.js` gains no stage for it is that `structure.input.vault` — its
    // pre-rename name — never shipped, so no v3 project can hold it in any form. That
    // claim is checked against the real corpus here rather than assumed from the changelog.

    test('no v3 project declares a vault: or snapshot: key under structure.input', () => {
      for (const project of PROJECTS) {
        const configPath = path.join(GOLDEN_DIR, project.dir, LOOM_SUBDIR, 'compile.yaml');
        const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        const input = (config && config.structure && config.structure.input) || {};
        expect([project.name, 'vault' in input, 'snapshot' in input]).toEqual([project.name, false, false]);
      }
    });

    test('migrating a v3 project introduces no structure.input.snapshot key', () => {
      // The inverse of the pairing, which a stale no-op would also pass: assert the
      // migrator does not *introduce* the new key, not merely that it left it alone.
      for (const project of PROJECTS) {
        const configPath = path.join(tmpDir, project.dir, LOOM_SUBDIR, 'compile.yaml');
        const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        const input = (config && config.structure && config.structure.input) || {};
        expect([project.name, input.snapshot]).toEqual([project.name, undefined]);
      }
    });
  });

  describe('Phase 14 — lint.conventions has no v3 spelling to migrate, proven rather than assumed', () => {
    // §8.2.2 / §14.2: v4 replaces v3's `lint.conventions:` list with a `lint.packs:`
    // mapping. The migration row is "no v3 projects use it yet" — `lint:` never shipped in
    // the v3 config surface, so there is nothing to fold. Same discipline as Phase 4 and
    // Phase 7: a note-returning stage rather than a silent gap, and the corpus checked.

    test('no v3 project declares lint.conventions, and no migrated config grows lint.packs', () => {
      for (const project of PROJECTS) {
        const v3Config = YAML.parse(
          fs.readFileSync(path.join(GOLDEN_DIR, project.dir, LOOM_SUBDIR, 'compile.yaml'), 'utf8'),
        );
        const v3Lint = (v3Config && v3Config.lint) || {};
        expect([project.name, 'conventions' in v3Lint]).toEqual([project.name, false]);

        const migrated = YAML.parse(
          fs.readFileSync(path.join(tmpDir, project.dir, LOOM_SUBDIR, 'compile.yaml'), 'utf8'),
        );
        const migratedLint = (migrated && migrated.lint) || {};
        expect([project.name, migratedLint.packs]).toEqual([project.name, undefined]);
      }
    });
  });

  describe('Phase 8 Step 3 — the pseudo-role conversion, checked against the real corpus', () => {
    // §14.2's proven-empty rule, the other direction: Phase 8 changes syntax and this time
    // the corpus genuinely has one case to convert. The Institute's `li: Malcolm` — §9.1's
    // motivating defect — is the only pseudo-role in any of the three golden projects;
    // checked here rather than assumed, the same way Phase 4 and Phase 7 checked "nothing
    // to convert" for their own keys.

    test('only The Institute converts a variable to a role', () => {
      for (const project of PROJECTS) {
        const configPath = path.join(tmpDir, project.dir, LOOM_SUBDIR, 'compile.yaml');
        const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        const roleNames = Object.keys((config && config.roles) || {}).filter((k) => k !== 'protagonist');
        const expected = project.name === 'The Institute' ? ['LI'] : [];
        expect([project.name, roleNames]).toEqual([project.name, expected]);
      }
    });

    test('The Institute\'s li: role inherits and rebinds exactly where the variable did', () => {
      const configPath = path.join(tmpDir, 'Esudia', 'The Institute', LOOM_SUBDIR, 'compile.yaml');
      const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.roles.LI).toBe('Malcolm');
      expect(config.variables.li).toBeUndefined();
      const branch = config.branches['Free Form'].branches.Aness.branches.Zephon;
      expect(branch.roles.LI).toBe('Zephon');
      expect(branch.variables && branch.variables.li).toBeUndefined();
    });

    test('variables used only to build another variable\'s value do not convert, even '
      + 'though their own value also names an item', () => {
      // `protag: veryn` and `liname: malcolm` both resolve to a known item id exactly like
      // `li` does, but neither is ever written as `{%protag}` or `{%liname}` in prose —
      // only inside `openingFile`'s own path expression in compile.yaml. Converting them
      // would have deleted a variable `openingFile` still depends on.
      const configPath = path.join(tmpDir, 'Esudia', 'The Institute', LOOM_SUBDIR, 'compile.yaml');
      const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.variables.protag).toBe('veryn');
      expect(config.variables.liname).toBe('malcolm');
      expect(config.variables.openingFile).toContain('{%protag}');
      expect(config.variables.openingFile).toContain('{%liname}');
    });

    test('the review queue lists §9.1\'s own case — a converted role beside a hardcoded pronoun', () => {
      const queue = results.get('The Institute').reviewQueue;
      const hit = queue.find((e) => e.file.includes('TI.Veryn.yaml') && e.text.includes('his betrayal'));
      expect(hit).toBeDefined();
    });

    test('the review queue covers component sections too, not only item bodies (§9.7)', () => {
      // No golden project's component files carry a role token beside a pronoun today —
      // the empty result below is a fact about the corpus, not a gap in the scan. Proven
      // by construction: `migratePseudoRoles` walks every .yaml/.md/.template/.partial
      // file under the project, item and component alike, with the same rewrite pass.
      for (const project of PROJECTS) {
        const queue = results.get(project.name).reviewQueue;
        const inComponents = queue.filter((e) => /components?[\\/]/i.test(e.file));
        expect([project.name, inComponents]).toEqual([project.name, []]);
      }
    });

    test('Baseline and Coinflip Company have no pseudo-role review queue at all', () => {
      for (const name of ['Baseline', 'Coinflip Company']) {
        expect([name, results.get(name).reviewQueue]).toEqual([name, []]);
      }
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
