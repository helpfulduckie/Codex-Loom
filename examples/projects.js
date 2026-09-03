'use strict';

/**
 * The example projects as a baseline fixture set (v4 spec §14.3).
 *
 * Same contract as `goldenFixtures/projects.js`, consumed by the same two things —
 * `__tests__/fixtures/examples.test.js` via `helpers/baselineHarness.js`, and
 * `scripts/rebaseline.js`. The difference is what the set is *for*: the goldens are private
 * real scenarios watched through the v3 migration, while these are committed, shareable
 * projects that documentation/ points at. So this set always runs, and a green suite means
 * the baseline was actually checked rather than silently skipped.
 *
 * Three fields differ from the golden manifest, and the harness defaults each to the golden
 * behavior so that file needs no edit:
 *
 *   CONFIG_NAME       these projects use the `.cl.yaml` extension
 *   SOURCE_SUBDIR '.' the project source is the project directory; there is no migrated/
 *                     original split to keep apart
 *   REPORTS_IN_PLACE  see below
 *
 * `BASELINE_SUBDIR === OUTPUT_SUBDIR` is the shape that makes an example readable: the
 * committed `output/` *is* the baseline, so the tree a reader browses is the tree they would
 * get by running the compiler themselves. The goldens keep the two apart because their
 * baseline is a frozen v3 compile that the current compiler is being measured against; an
 * example has nothing older to compare to.
 */

const PROJECTS = [
  {
    name: 'showcase',
    dir: 'showcase',
    /**
     * Every report mode this project freezes. The two compile reports come from
     * `--with-inventory --schema-tables`; the five post-hoc modes each need their own CLI
     * flag, which is the trap this list closes — `Review/` held four stale directories for
     * some time because the README's two commands do not run `seed-map`, `overview`,
     * `leaf-review` or `card-sizes`, and `--clean` clears `output/` but not `Review/`. The
     * baseline is regenerated through `scripts/rebaseline.js`, which runs all of them.
     */
    reports: ['seed-map', 'card-sizes', 'lint', 'overview', 'leaf-review'],
    compileReports: ['inventory', 'schemaTables'],
  },
  {
    name: 'variants-and-fieldops',
    dir: 'variants-and-fieldops',
    /**
     * No frozen reports. `showcase` owns the report baseline for the set — freezing all
     * five post-hoc modes plus the two compile reports on every project would multiply
     * each re-baseline diff for a derivation that only needs pinning once. `Review/` here
     * holds just what `compile()` writes unconditionally: the two provenance files, which
     * `REPORTS_IN_PLACE` brings under comparison so §17.4's rename row stays pinned.
     */
    reports: [],
    compileReports: [],
  },
];

/** These projects use the `.cl.yaml` extension; the goldens' migrated sources do not. */
const CONFIG_NAME = 'compile.cl.yaml';
/** The project source is the project directory itself. */
const SOURCE_SUBDIR = '.';
/** Where a project's compile.cl.yaml sends its output, relative to the project directory. */
const OUTPUT_SUBDIR = 'output';
/** The committed baseline is that same directory — see the header. */
const BASELINE_SUBDIR = 'output';
/** Where `structure.reports` resolves, and the committed report baseline. */
const REPORTS_SUBDIR = 'Review';

/**
 * Freeze the reports where the compiler puts them, rather than collecting them per mode.
 *
 * The golden harness copies each report into `<REPORTS_SUBDIR>/<mode>/` because its baseline
 * is a separate committed tree, so a report written inside the live tree has to be moved
 * somewhere to be frozen at all. Here the committed `Review/` *is* the baseline, so there is
 * nowhere to move it to and nothing to disambiguate — the whole directory is compared
 * wholesale, exactly as `output/` is.
 *
 * Two things follow, both wanted. `COMPILE_REPORT_LAYOUT` becomes unnecessary: `inventory`
 * and `schemaTables` already land in the right place, so nothing collects them. And
 * `output.provenance.md`/`.csv`, which plain `compile()` writes into the reports directory
 * unconditionally and which no mode key names, comes under comparison at all — §17.4's rule
 * that a renamed import's provenance row reads `project` rather than `library:<set>` becomes
 * pinned behavior rather than documented behavior.
 *
 * **Provenance only became freezable when its paths stopped being absolute.** `_source` is
 * stamped absolute at load, so every row named the machine that compiled it and no committed
 * baseline could match a temp compile. `src/provenance.js:sourceFile` now reports each path
 * relative to the project directory — which also stops a shared report carrying its author's
 * home directory, the reason to do it rather than normalize it away in the harness.
 *
 * `output/library-dependencies.json` is the one file left that cannot match byte-for-byte:
 * it stamps `generatedAt` and embeds the compile root, and the harness normalizes it.
 */
const REPORTS_IN_PLACE = true;

module.exports = {
  PROJECTS,
  CONFIG_NAME,
  SOURCE_SUBDIR,
  OUTPUT_SUBDIR,
  BASELINE_SUBDIR,
  REPORTS_SUBDIR,
  REPORTS_IN_PLACE,
};
