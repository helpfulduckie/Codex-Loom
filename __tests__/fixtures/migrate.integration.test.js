'use strict';


const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');

const { compile } = require('../../src/compile');
const { migrateProjectFully } = require('../../src/migrate');
const { GOLDEN_DIR, HAVE_GOLDENS } = require('../helpers/baselineHarness');

const { PROJECTS, OUTPUT_SUBDIR, BASELINE_SUBDIR } = HAVE_GOLDENS
  ? require('../../goldenFixtures/projects')
  : { PROJECTS: [{ name: 'goldenFixtures/ is not cloned — see .gitignore', dir: '' }], OUTPUT_SUBDIR: '', BASELINE_SUBDIR: '' };
const LOOM_SUBDIR = 'Loom';

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

function migrateAndCompile(tmpDir, project) {
  const configPath = path.join(tmpDir, project.dir, LOOM_SUBDIR, 'compile.yaml');

  const result = migrateProjectFully(configPath);
  const notes = result.notes;
  const reviewQueue = result.reviewQueue;
  compile(configPath);

  return { outputDir: path.join(tmpDir, project.dir, OUTPUT_SUBDIR), notes, reviewQueue, configPath };
}

(HAVE_GOLDENS ? describe : describe.skip)('migrating a real v3 project reproduces the hand conversion\'s output', () => {
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

      const isTierOnly = (rel) => project.dir === path.join('Eldemyr', 'Coinflip Company')
        && rel.split('/').slice(0, 2).join('/') === 'Branches/lowContext';
      const baselineMarkdown = () => listMarkdown(baselineDir()).filter((rel) => !isTierOnly(rel));

      test('writes exactly the files the baseline has', () => {
        expect(listMarkdown(results.get(project.name).outputDir)).toEqual(baselineMarkdown());
      });

      test('every file is byte-identical to the baseline', () => {
        const outputDir = results.get(project.name).outputDir;
        const differing = baselineMarkdown().filter((rel) => {
          if (path.basename(rel) === 'AI Instructions.md') return false;
          if (
            path.join(project.dir, rel) === path.join('Baseline', 'Baseline', 'Description.md')
            || path.join(project.dir, rel) === path.join(
              'Esudia', 'The Institute', 'Branches', 'Free Form', 'Branches', 'Aness', 'Components', 'Opening.md',
            )
          ) return false;
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

  describe('a migration step that converts nothing, proven rather than assumed', () => {

    test('no migrated config acquires a placeholders: key', () => {
      for (const project of PROJECTS) {
        const configPath = path.join(tmpDir, project.dir, LOOM_SUBDIR, 'compile.yaml');
        const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        expect([project.name, config.placeholders]).toEqual([project.name, undefined]);
      }
    });

    test('no migrated source grows a %key% anywhere', () => {
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

  describe('the snapshot key has no v3 spelling to migrate, proven rather than assumed', () => {

    test('no v3 project declares a vault: or snapshot: key under structure.input', () => {
      for (const project of PROJECTS) {
        const configPath = path.join(GOLDEN_DIR, project.dir, LOOM_SUBDIR, 'compile.yaml');
        const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        const input = (config && config.structure && config.structure.input) || {};
        expect([project.name, 'vault' in input, 'snapshot' in input]).toEqual([project.name, false, false]);
      }
    });

    test('migrating a v3 project introduces no structure.input.snapshot key', () => {
      for (const project of PROJECTS) {
        const configPath = path.join(tmpDir, project.dir, LOOM_SUBDIR, 'compile.yaml');
        const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
        const input = (config && config.structure && config.structure.input) || {};
        expect([project.name, input.snapshot]).toEqual([project.name, undefined]);
      }
    });
  });

  describe('lint.conventions has no v3 spelling to migrate, proven rather than assumed', () => {

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

  describe('the pseudo-role conversion, checked against the real corpus', () => {

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
      const configPath = path.join(tmpDir, 'Esudia', 'The Institute', LOOM_SUBDIR, 'compile.yaml');
      const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.variables.protag).toBe('veryn');
      expect(config.variables.liname).toBe('malcolm');
      expect(config.variables.openingFile).toContain('{%protag}');
      expect(config.variables.openingFile).toContain('{%liname}');
    });

    test('the review queue lists a converted role beside a hardcoded pronoun', () => {
      const queue = results.get('The Institute').reviewQueue;
      const hit = queue.find((e) => e.file.includes('TI.Veryn.yaml') && e.text.includes('his betrayal'));
      expect(hit).toBeDefined();
    });

    test('the review queue covers component sections too, not only item bodies', () => {
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
    for (const project of PROJECTS) {
      const notes = results.get(project.name).notes;
      expect(notes.some((n) => n.includes('was named by the migrator'))).toBe(true);
    }
  });
});