'use strict';

/**
 * The baseline fixture harness, shared by two fixture sets (v4 spec §14.3).
 *
 * Compiles each project in a set from its source into a temp copy of the whole set tree,
 * then asserts the result is byte-for-byte identical to the committed baseline. It was
 * `__tests__/fixtures/golden.test.js` in full until the example projects needed the same
 * treatment; that file is now one caller and `examples.test.js` is the other.
 *
 * The tree is copied rather than redirected because a project's compile config writes to a
 * relative output path and may reach up out of its own directory for a shared library, so
 * neither the output nor the inputs can be pointed elsewhere without breaking those paths.
 *
 * ── What a set manifest supplies ──────────────────────────────────────────────
 *
 * `PROJECTS`, `OUTPUT_SUBDIR`, `BASELINE_SUBDIR` and `REPORTS_SUBDIR` are required. The rest
 * default to what the golden fixtures do, so that manifest — which lives in a separate
 * private repo — needed no edit when this was extracted:
 *
 *   CONFIG_NAME        'compile.yaml'
 *   SOURCE_SUBDIR      '' (the project directory itself)
 *   REPORT_MODES       DEFAULT_REPORT_MODES, below
 *   REPORTS_IN_PLACE   false — collect each report into `<REPORTS_SUBDIR>/<mode>/`
 *   COMPILE_REPORT_LAYOUT  {} (only consulted when collecting)
 *
 * `REPORTS_IN_PLACE` is the one difference that changes what is asserted rather than where a
 * file is read from. False collects each report mode into its own directory and compares the
 * set per mode, which a baseline stored apart from the live tree requires. True leaves every
 * report where the compiler wrote it and compares the reports directory wholesale — the shape
 * for a set whose committed tree *is* what a user would produce. See
 * `examples/projects.js` for why that matters there.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { compile } = require('../../src/compile');
const { loadCompileConfig, loadManifest } = require('../../src/config/load');
const { collectEntries, entryLabel, hashTree } = require('../../src/snapshot');
const { Diagnostics } = require('../../src/diag');
const { classifyDiff, OPAQUE } = require('./diffShape');

/**
 * The report modes reachable as `(scenarioRoot, outputDir, options)` against an
 * already-written tree — the harness calls each one directly and it writes into `outputDir`.
 * `seed-map`, `card-sizes` and `lint` parse compiled cards back into the model, which is how
 * `emit/vl.js:parseCards` gets tested against real output; `overview` and `leaf-review` read
 * files wholesale and match the same signature.
 */
const DEFAULT_REPORT_MODES = {
  'seed-map': () => require('../../src/seedmap').runSeedMapMode,
  'card-sizes': () => require('../../src/bodysize').runBodySizeMode,
  lint: () => require('../../src/lint').runLintMode,
  overview: () => require('../../src/overview').runOverviewMode,
  'leaf-review': () => require('../../src/overview').runLeafReviewMode,
};

/** Collect every file under `dir` as a sorted list of paths relative to it. */
function listFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

/**
 * The library manifest is the one output that cannot match byte-for-byte: it stamps a fresh
 * `generatedAt` and embeds absolute paths, which differ between the temp compile and the
 * committed baseline. Normalizing keeps it under comparison rather than whitelisted — the
 * library file lists themselves are exactly the sort of thing a loader refactor could break.
 */
function normalizeManifest(raw, rootDir) {
  const parsed = JSON.parse(raw);
  delete parsed.generatedAt;
  const root = rootDir.replace(/\\/g, '/').toLowerCase();
  const scrub = (value) => {
    if (typeof value === 'string') {
      const unified = value.replace(/\\/g, '/')
        // The manifest records which compile config produced the output. The goldens' v4
        // sources live in v4/ and their v3 baseline was compiled from Loom/, so that segment
        // differs by fixture scaffolding rather than by anything about the scenario.
        .replace(/\/(v4|Loom)\/compile\.(cl\.)?ya?ml$/, '/<SOURCE>/compile.yaml');
      return unified.toLowerCase().startsWith(root)
        ? `<ROOT>${unified.slice(root.length)}`
        : unified;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    }
    return value;
  };
  return scrub(parsed);
}

/**
 * `describe.each` rejects an empty array, so an absent set supplies one placeholder rather
 * than an empty project list. `reports` and `compileReports` are non-empty for the same
 * reason — a nested `describe.each` is still evaluated to collect test names even when the
 * enclosing describe is skipped. None of the values is ever read: no hook body runs.
 */
function absentProjects(reason) {
  return [{ name: reason, dir: '', reports: ['none'], compileReports: ['none'] }];
}

/**
 * Register the whole suite for one fixture set.
 *
 * Returns `{ present, getTmpDir }` so a caller can hang set-specific assertions off the same
 * compiled tree — `golden.test.js` uses it for the Coinflip tier check.
 */
function describeBaselineSet(options) {
  const {
    root,
    present,
    absentReason = 'fixture set is not present',
    /**
     * The line classes this phase is allowed to change, and the files it may change them in
     * (v4 spec §14.3). Empty and null mean "byte-for-byte, any diff is a bug" — the standing
     * obligation, widened only by a phase that changes output deliberately and never further
     * than the shape its reviewer looked at.
     */
    expectedDiffClasses = [],
    expectedDiffFiles = null,
  } = options;

  const manifest = present ? options.manifest : {};
  const {
    OUTPUT_SUBDIR = '',
    BASELINE_SUBDIR = '',
    REPORTS_SUBDIR = '',
    SOURCE_SUBDIR = '',
    CONFIG_NAME = 'compile.yaml',
    REPORT_MODES = DEFAULT_REPORT_MODES,
    REPORTS_IN_PLACE = false,
    COMPILE_REPORT_LAYOUT = {},
  } = manifest;
  const PROJECTS = present ? manifest.PROJECTS : absentProjects(absentReason);

  let tmpDir;

  /**
   * Where a project's frozen reports live, relative to the temp tree. When reports are
   * collected, that is a per-mode directory the harness owns; when they are frozen in place,
   * it is wherever `structure.reports` resolved during the compile.
   */
  function reportsDirFor(project, configPath, mode) {
    if (!REPORTS_IN_PLACE) return path.join(tmpDir, project.dir, REPORTS_SUBDIR, mode);
    const config = loadCompileConfig(configPath, { diagnostics: new Diagnostics() });
    const base = config._resolvedReports || path.join(config._resolvedOutput, 'Overview');
    return path.join(base, mode);
  }

  /**
   * Copy `diff`/`annotate`/`inventory`/`schemaTables` output into `<REPORTS_SUBDIR>/<mode>/`.
   * `compile()` writes those wherever `structure.reports` resolves and returns nothing that
   * names that path, so it is read back via `loadCompileConfig` — a second, side-effect-free
   * parse of the same config. Not called when reports are frozen in place: there the files
   * are already where the baseline expects them.
   */
  function collectCompileReports(project, configPath) {
    const config = loadCompileConfig(configPath, { diagnostics: new Diagnostics() });
    const reportBase = config._resolvedReports || path.join(config._resolvedOutput, 'Overview');
    for (const mode of project.compileReports || []) {
      const layout = COMPILE_REPORT_LAYOUT[mode];
      if (!layout) continue;
      const dir = path.join(tmpDir, project.dir, REPORTS_SUBDIR, mode);
      fs.mkdirSync(dir, { recursive: true });
      if (layout.files) {
        for (const f of layout.files) {
          const src = path.join(reportBase, f);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
        }
      } else if (layout.subdir) {
        const src = path.join(reportBase, layout.subdir);
        if (fs.existsSync(src)) fs.cpSync(src, dir, { recursive: true });
      }
    }
  }

  beforeAll(() => {
    // Jest runs a file's root hooks even when every describe in it is skipped, so this guard
    // is what actually stops an absent set from compiling a tree that is not there.
    if (!present) return;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-baseline-'));

    // Copy the set tree, skipping the committed baselines — they are the comparison target,
    // not an input. The reports baseline must be excluded for a second reason: the harness
    // writes fresh reports to that same relative path inside the temp tree, and a copied
    // baseline would survive there as a stale file the file-set assertion could not tell
    // from a real one. OUTPUT_SUBDIR is excluded for a third: on a checkout where the CLI
    // was run against a project directly it holds output this harness does not clean, so an
    // orphan the current compiler no longer writes would break the file-set assertion.
    fs.cpSync(root, tmpDir, {
      recursive: true,
      filter: (src) => {
        const segments = path.relative(root, src).split(path.sep);
        return !segments.includes(BASELINE_SUBDIR) && !segments.includes(REPORTS_SUBDIR)
          && !segments.includes(OUTPUT_SUBDIR);
      },
    });

    // compile() prints nothing; progress goes to an `options.log` the harness does not pass,
    // and the drift notice goes to that same log, so the snapshot check that follows is
    // still the only thing standing between a stale freeze and nothing.
    for (const project of PROJECTS) {
      const configPath = path.join(tmpDir, project.dir, SOURCE_SUBDIR, CONFIG_NAME);
      // `live: true` on every baseline compile, so a set's committed sources are the
      // sources it is checked against. A project that declares `structure.input.snapshot`
      // otherwise reads its frozen copy for every library entry and every out-of-base
      // template dir, and an edit to the shared tree those were taken from compiles
      // clean, changes nothing, and passes — the drift notice that would have said so is
      // a progress-log line the harness never passes a sink for, so it goes nowhere. The
      // snapshot redirection path keeps its own coverage in
      // `__tests__/integration/snapshot.integration.test.js`; what a baseline set owes is
      // corpus-scale evidence about the compiler, which is worthless read off a copy.
      // Inert for a set that declares no snapshot, which is why it is unconditional.
      const compileOptions = { live: true };
      for (const mode of project.compileReports || []) compileOptions[mode] = true;
      compile(configPath, compileOptions);

      // Reports run post-hoc against the tree compile just wrote, which is how the CLI
      // invokes them — so what is frozen is what a user would get.
      const scenarioRoot = path.join(tmpDir, project.dir, OUTPUT_SUBDIR);
      for (const mode of project.reports) {
        const dir = reportsDirFor(project, configPath, mode);
        fs.mkdirSync(dir, { recursive: true });
        REPORT_MODES[mode]()(scenarioRoot, dir);
      }

      if (!REPORTS_IN_PLACE) collectCompileReports(project, configPath);
    }
  }, 600000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  (present ? describe : describe.skip).each(PROJECTS)('$name', (project) => {
    let actualDir;
    let expectedDir;

    beforeAll(() => {
      actualDir = path.join(tmpDir, project.dir, OUTPUT_SUBDIR);
      expectedDir = path.join(root, project.dir, BASELINE_SUBDIR);
    });

    test('emits exactly the baseline file set', () => {
      expect(listFiles(actualDir)).toEqual(listFiles(expectedDir));
    });

    /**
     * The mirror of the bug `live: true` fixes.
     *
     * Compiling live makes a committed `snapshot/` a directory nothing reads, and therefore
     * one free to rot — at which point someone editing the frozen copy to fix something has
     * exactly the old failure back, pointed the other way. This asserts the two stay the
     * same tree, and it is the only place that does: `checkDrift`'s live-drift report is a
     * progress-log line, not a diagnostic, and CL0113 compares the frozen copy against its own
     * manifest rather than against the source it was taken from.
     *
     * Reads the committed tree, not the temp copy, because the fixture on disk is what a
     * `--snapshot` run would refresh. A set that declares no snapshot returns nothing.
     */
    test('every snapshot entry matches the live source it was frozen from', () => {
      const configPath = path.join(root, project.dir, SOURCE_SUBDIR, CONFIG_NAME);
      const config = loadCompileConfig(configPath, { diagnostics: new Diagnostics(), live: true });
      const snapshotDir = config._resolvedSnapshot;
      const manifestPath = snapshotDir && path.join(snapshotDir, 'manifest.json');

      const stale = [];
      if (manifestPath && fs.existsSync(manifestPath)) {
        const manifest = loadManifest(manifestPath, new Diagnostics()) || {};
        for (const entry of collectEntries(config)) {
          const section = entry.kind === 'library'
            ? (manifest.library || {})[entry.name]
            : (manifest.templates || {})[entry.name];
          if (!section) {
            stale.push(`${entryLabel(entry)} — no entry in manifest.json`);
            continue;
          }
          const live = hashTree(entry.sourcePath);
          const frozen = section.files || {};
          const changed = Object.keys(live).filter((rel) => rel in frozen && frozen[rel] !== live[rel]);
          const added = Object.keys(live).filter((rel) => !(rel in frozen));
          const removed = Object.keys(frozen).filter((rel) => !(rel in live));
          if (changed.length || added.length || removed.length) {
            stale.push(
              `${entryLabel(entry)} — ${[...changed, ...added, ...removed].sort().join(', ')}`
              + ' (re-run the CLI with --snapshot and commit the result)'
            );
          }
        }
      }
      expect(stale).toEqual([]);
    });

    /**
     * Every file that differs from the baseline, with the line classes its diff touched.
     *
     * Only `.md` output is classifiable — it is the format the emitter owns. Anything else
     * that differs is reported as `opaque`, which no phase's expected shape may contain, so
     * a changed script or manifest can never pass as an intended fence-only diff.
     */
    function collectDifferences() {
      const differences = [];
      for (const rel of listFiles(expectedDir)) {
        const actualPath = path.join(actualDir, ...rel.split('/'));
        const expectedPath = path.join(expectedDir, ...rel.split('/'));
        if (!fs.existsSync(actualPath)) continue; // reported by the file-set test

        if (path.basename(rel) === 'library-dependencies.json') {
          const actual = normalizeManifest(fs.readFileSync(actualPath, 'utf8'), tmpDir);
          const expected = normalizeManifest(fs.readFileSync(expectedPath, 'utf8'), root);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            differences.push({ rel, classes: [OPAQUE], summary: `${rel} — manifest contents differ` });
          }
          continue;
        }

        if (fs.readFileSync(actualPath).equals(fs.readFileSync(expectedPath))) continue;

        if (!rel.endsWith('.md')) {
          differences.push({ rel, classes: [OPAQUE], summary: `${rel} — non-markdown output differs` });
          continue;
        }

        const diff = classifyDiff(
          fs.readFileSync(expectedPath, 'utf8'),
          fs.readFileSync(actualPath, 'utf8'),
        );
        differences.push({
          rel,
          classes: diff.classes,
          summary: `${rel} — ${diff.classes.join('+')} (${diff.changedLines} lines) ${diff.samples.join(' | ')}`,
        });
      }
      return differences;
    }

    /**
     * The bug assertion. A diff outside the phase's declared shape is a regression whatever
     * the phase is doing — it stays green while the re-baseline assertion below goes red.
     */
    test('no file differs outside the phase\'s expected diff shape', () => {
      const outside = collectDifferences()
        .filter((d) => d.classes.some((c) => !expectedDiffClasses.includes(c))
          || (expectedDiffFiles && !expectedDiffFiles.test(d.rel)))
        .map((d) => d.summary);
      expect(outside).toEqual([]);
    });

    /**
     * The re-baseline assertion. Passes only against a regenerated baseline, so an intended
     * output change cannot be left uncommitted — §14.3's "reviewed, committed artifact".
     */
    test('every emitted file is byte-identical to the baseline', () => {
      const differing = collectDifferences().map((d) => d.summary);
      expect(differing).toEqual([]);
    });

    /**
     * Reports are byte-for-byte in every phase. They are derived views of output that is
     * already under test, so a report diff means the derivation changed — which is a bug
     * whether or not the phase is output-changing.
     */
    function reportAssertions(actual, expected) {
      test('emits exactly the baseline file set', () => {
        expect(listFiles(actual())).toEqual(listFiles(expected()));
      });

      test('every file is byte-identical to the baseline', () => {
        const differing = listFiles(expected()).filter((rel) => {
          const a = path.join(actual(), ...rel.split('/'));
          const b = path.join(expected(), ...rel.split('/'));
          return !fs.existsSync(a) || !fs.readFileSync(a).equals(fs.readFileSync(b));
        });
        expect(differing).toEqual([]);
      });
    }

    if (REPORTS_IN_PLACE) {
      // One comparison over the whole reports directory. Nothing was collected, so the
      // per-mode split has nothing to key on — and files no mode key names (provenance)
      // are inside the baseline precisely because this compares wholesale.
      describe('reports', () => {
        reportAssertions(
          () => path.join(tmpDir, project.dir, REPORTS_SUBDIR),
          () => path.join(root, project.dir, REPORTS_SUBDIR),
        );
      });
    } else {
      describe.each([...project.reports, ...(project.compileReports || [])])(
        'report: %s',
        (mode) => {
          reportAssertions(
            () => path.join(tmpDir, project.dir, REPORTS_SUBDIR, mode),
            () => path.join(root, project.dir, REPORTS_SUBDIR, mode),
          );
        },
      );
    }
  });

  return { present, getTmpDir: () => tmpDir };
}

module.exports = {
  describeBaselineSet, DEFAULT_REPORT_MODES,
};
