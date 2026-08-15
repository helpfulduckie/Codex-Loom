'use strict';

/**
 * Golden fixture harness (v4 spec §14.3).
 *
 * Compiles each frozen fixture project from its `Loom/` source into a temp copy of the
 * whole `goldenFixtures/` tree, then asserts the result is byte-for-byte identical to the
 * committed `v3/` output.
 *
 * Phase 1 of the v4 rework is declared output-preserving with an EMPTY WHITELIST: any diff
 * this harness reports is a bug, not a re-baseline. Later phases change output deliberately
 * and re-baseline under review — see §14.3's expected-diff table before touching a fixture.
 *
 * "Under review" is enforced rather than trusted. Every differing file is classified by
 * `helpers/diffShape.js` into the line classes it touched, and the two assertions below
 * separate the questions §14.3 keeps distinct: *is this diff the shape we intended* (a
 * bug if not) and *has the baseline been regenerated yet* (a re-baseline if not). Setting
 * `EXPECTED_DIFF_CLASSES` for a phase is the deliberate act that declares the shape.
 *
 * The tree is copied because each project's `compile.yaml` writes to `../Velvet Lattice/`
 * and reaches up three levels for shared canon and templates (`{%loom}: ../../../_CodexLoom`),
 * so neither the output nor the inputs can be redirected without breaking the relative paths.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { classifyDiff, OPAQUE } = require('../helpers/diffShape');

const GOLDEN_DIR = path.resolve(__dirname, '../../goldenFixtures');

/**
 * The line classes the phase in progress is allowed to change (v4 spec §14.3).
 *
 * Empty means "byte-for-byte, any diff is a bug" — the obligation for Phases 1, 4, 5, 7
 * and 9. An output-changing phase widens it to exactly the classes its expected diff
 * covers, and never further:
 *
 *   Phase 2 (emitter)   ['fence']  the envelope moves into emit/vl.js
 *
 * Phase 2 is set to `fence` alone rather than `fence, title`, even though the heading is
 * half of what moved. The emitter's title ladder was checked against the corpus before it
 * was written: of 294 items carrying a title or a name, `aid.title` and `name.full` never
 * disagree, so no heading should change. Allowing `title` would buy nothing and would wave
 * through the one regression this move could plausibly cause — a card quietly renamed,
 * which in AID means a card the player sees under a different name.
 *
 * The classes name parts of an envelope, so they only discriminate on files that have
 * one. Component output — `Plot Essentials.md`, `AI Instructions.md` — carries no `##`
 * heading and no `~~~` fence, so every line in it is `body`. A phase whose expected diff
 * lands in a component file therefore cannot state its shape here, and needs a per-file
 * expectation instead. That is a limit of this constant rather than a prediction about
 * any particular phase: a phase that turns out output-preserving is already correctly
 * served by the empty setting.
 */
const EXPECTED_DIFF_CLASSES = ['fence'];

// The fixture set itself lives beside the fixtures, because `scripts/rebaseline.js`
// regenerates what this file checks and the two must not drift apart.
const {
  PROJECTS, OUTPUT_SUBDIR, BASELINE_SUBDIR, SOURCE_SUBDIR, REPORTS_SUBDIR, REPORT_MODES,
} = require('../../goldenFixtures/projects');

/**
 * Two things about that list are worth knowing here.
 *
 * The migrator runs at re-baseline time only, never in this harness: if the test migrated
 * on every run, a migrator bug and a compiler bug would produce the same red and there
 * would be no way to tell them apart. `SOURCE_SUBDIR` is the committed migrated source;
 * `Loom/` keeps the original v3 sources for comparison.
 *
 * Reports are frozen separately (§8.6) because `compile()` writes none — seed map, card
 * sizes and lint are post-hoc CLI modes that read the compiled tree back. So the whole
 * class of consumers that re-parses the VL format sat outside this harness, which is
 * exactly the code Phase 2 Step 2 retargeted onto `emit/vl.js:parseCards`. Retargeting a
 * parser with no output under test would be a refactor with nothing to refactor against:
 * the subtle behaviors — cards with no trigger list being skipped, quote characters
 * surviving into trigger values — are precisely what a rewrite normalizes away while
 * every unit test stays green.
 */

let tmpDir;

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
 * The canon manifest is the one output that cannot match byte-for-byte: it stamps a fresh
 * `generatedAt` and embeds absolute paths, which differ between the temp compile and the
 * committed baseline. Normalizing keeps it under comparison rather than whitelisted — the
 * canon file lists themselves are exactly the sort of thing a loader refactor could break.
 */
function normalizeManifest(raw, rootDir) {
  const parsed = JSON.parse(raw);
  delete parsed.generatedAt;
  const root = rootDir.replace(/\\/g, '/').toLowerCase();
  const scrub = (value) => {
    if (typeof value === 'string') {
      const unified = value.replace(/\\/g, '/')
        // The manifest records which compile.yaml produced the output. The v4 sources
        // live in v4/ and the v3 baseline was compiled from Loom/, so that segment
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

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-golden-'));

  // Copy the fixture tree, skipping both committed baselines — they are the comparison
  // target, not an input, and The Institute's output baseline alone is ~890 files. The
  // report baseline must be excluded for a second reason: the harness writes fresh
  // reports to that same relative path inside the temp tree, and a copied baseline would
  // survive there as a stale file the file-set assertion could not tell from a real one.
  fs.cpSync(GOLDEN_DIR, tmpDir, {
    recursive: true,
    filter: (src) => {
      const segments = path.relative(GOLDEN_DIR, src).split(path.sep);
      return !segments.includes(BASELINE_SUBDIR) && !segments.includes(REPORTS_SUBDIR);
    },
  });

  // compile() is chatty; a fixture run would otherwise bury the actual assertions.
  const quiet = ['log', 'warn', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
  try {
    for (const project of PROJECTS) {
      compile(path.join(tmpDir, project.dir, SOURCE_SUBDIR, 'compile.yaml'));

      // Reports run post-hoc against the tree that compile just wrote, which is how the
      // CLI invokes them — so what is frozen is what a user would get.
      const scenarioRoot = path.join(tmpDir, project.dir, OUTPUT_SUBDIR);
      for (const mode of project.reports) {
        const dir = path.join(tmpDir, project.dir, REPORTS_SUBDIR, mode);
        fs.mkdirSync(dir, { recursive: true });
        REPORT_MODES[mode]()(scenarioRoot, dir, false);
      }
    }
  } finally {
    quiet.forEach((spy) => spy.mockRestore());
  }
}, 600000);

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.each(PROJECTS)('$name', (project) => {
  let actualDir;
  let expectedDir;

  beforeAll(() => {
    actualDir = path.join(tmpDir, project.dir, OUTPUT_SUBDIR);
    expectedDir = path.join(GOLDEN_DIR, project.dir, BASELINE_SUBDIR);
  });

  test('emits exactly the baseline file set', () => {
    expect(listFiles(actualDir)).toEqual(listFiles(expectedDir));
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

      if (path.basename(rel) === 'canon-dependencies.json') {
        const actual = normalizeManifest(fs.readFileSync(actualPath, 'utf8'), path.join(tmpDir));
        const expected = normalizeManifest(fs.readFileSync(expectedPath, 'utf8'), GOLDEN_DIR);
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
   * the phase is doing — during Phase 2 this is what stays green while the re-baseline
   * assertion below goes red.
   */
  test('no file differs outside the phase\'s expected diff shape', () => {
    const outside = collectDifferences()
      .filter((d) => d.classes.some((c) => !EXPECTED_DIFF_CLASSES.includes(c)))
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
   * whether or not the phase is output-changing. Phase 5 reworks `--card-sizes` (§8.5)
   * and re-baselines this deliberately; nothing before it should touch a byte.
   */
  describe.each(project.reports)(
    'report: %s',
    (mode) => {
      const actual = () => path.join(tmpDir, project.dir, REPORTS_SUBDIR, mode);
      const expected = () => path.join(GOLDEN_DIR, project.dir, REPORTS_SUBDIR, mode);

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
    },
  );
});
