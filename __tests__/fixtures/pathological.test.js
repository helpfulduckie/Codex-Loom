'use strict';

/**
 * The pathological fixture harness (v4 Phase 4 plan, Step 0).
 *
 * Two projects that are wrong on purpose, and a committed snapshot of every diagnostic
 * they raise. This is the third source of confidence the plan names: the three golden
 * corpora are all correct projects, so they can go red on a *byte* and never on a *check*.
 * Every §7.4 invariant and every §12 placeholder check is invisible to them.
 *
 * Written from the spec before Phase 4's code exists, which is what makes the snapshot
 * mean something. It opens pinning Phase 3's diagnostics; each Phase 4 step then *adds
 * rows to a baseline that already exists*, so every change here is a second-run change
 * read against a known state rather than a first run that cannot fail.
 *
 * The six sub-projects (placement, schema, snapshot-mismatch, snapshot-corrupt,
 * card-collision, unread-fields) are separate because the layers abort differently (§4.3):
 * a schema ERROR stops the compile before anything is written, so a config mistake in the
 * placement project would suppress everything that project exists to demonstrate. See each
 * project's own header.
 *
 * Compiled into a temp copy so the repo never acquires an `out/` tree, and so the snapshot
 * carries no absolute paths.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');

const FIXTURE_DIR = path.resolve(__dirname, 'pathological');

const tmpDirs = [];

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Compile one sub-project and return its diagnostics as stable text.
 *
 * `compile` signals failure by throwing a *count* and prints nothing itself.
 * `options.diagnostics` hands back the bus on every exit path including the throw, which
 * is what this reads instead of scraping console output.
 *
 * Order is preserved rather than sorted. The sequence is itself an assertion: diagnostics
 * arrive per branch, in leaf order, so a check that starts firing once for the project
 * instead of once per branch shows up as a reordering rather than hiding in a set.
 */
function diagnoseProject(name) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codex-loom-pathological-${name}-`));
  tmpDirs.push(tmpDir);
  fs.cpSync(path.join(FIXTURE_DIR, name), tmpDir, { recursive: true });

  const diagnostics = new Diagnostics();
  try {
    compile(path.join(tmpDir, 'compile.cl.yaml'), { diagnostics });
  } catch (err) {
    // Expected: each project raises ERRORs by construction. What the ERROR *is* lives in
    // the diagnostics, so the throw itself carries nothing worth asserting.
  }

  const relative = (file) => {
    if (!file) return null;
    const rel = path.relative(tmpDir, file);
    return rel.startsWith('..') ? path.basename(file) : rel.split(path.sep).join('/');
  };

  // Mirrors Diagnostic#location: file alone, file:line, or file:line:col, whichever the
  // origin actually resolved. Retaining line/col (dropped by the pre-provenance normalizer)
  // is what lets this snapshot stand as proof that an origin survived to the report.
  const locationOf = (file, line, col) => {
    const rel = relative(file);
    if (!rel) return null;
    if (line === null || line === undefined) return rel;
    return col === null || col === undefined ? `${rel}:${line}` : `${rel}:${line}:${col}`;
  };

  // The branch is rendered so the snapshot pins which leaf a per-branch row came from —
  // the sequence assertion above says rows arrive per leaf, and this says which one.
  return diagnostics.all.map((d) => {
    const loc = locationOf(d.file, d.line, d.col);
    const head = [d.severity.toUpperCase(), d.code, loc, d.branch ? `(branch ${d.branch})` : '']
      .filter(Boolean).join(' ');
    const body = d.message.replace(/\r?\n\s*/g, ' ').trim();
    const parts = [head, `  ${body}`];
    if (d.hint) parts.push(`  hint: ${d.hint}`);
    for (const related of d.related || []) {
      const rloc = locationOf(related.file, related.line, related.col);
      parts.push(`  related${related.label ? ` (${related.label})` : ''}${rloc ? `: ${rloc}` : ''}`);
    }
    return parts.join('\n');
  }).join('\n');
}

describe('pathological fixture', () => {
  /**
   * The placement project: load-clean on purpose, so the compile phase runs in full and
   * §7.4's invariants have something to report.
   *
   * Every row here is now a row the fixture means to raise. CL0322 used to fire on `Ghost`
   * and `Silent` — items with `storyCard: false`, which §7.4 says are owed neither
   * `aid.type` nor `render.template` — and was pinned as known-incorrect until the check
   * was scoped to story-card targets. `Ghost` and `Silent` keep their CL0610, which is the
   * diagnostic that describes them.
   */
  test('placement invariants and latent placeholder content', () => {
    expect(diagnoseProject('placement')).toMatchSnapshot();
  });

  /**
   * The schema project: three unknown-key shapes, checked for their *hints* as much as
   * their codes. A near neighbor should be suggested, a valid-elsewhere key should be
   * relocated rather than rejected, and neither should degrade into a bare "unknown key".
   */
  test('config schema violations abort the load', () => {
    expect(diagnoseProject('schema')).toMatchSnapshot();
  });

  /**
   * The snapshot-mismatch project (Phase 7 Step 4): load-clean, like placement/, so both
   * WARNs fire in the same compile. `alpha` has no section in the committed manifest at
   * all (CL0113); `beta`'s recorded file matches what's frozen, but the frozen copy also
   * carries a file the manifest never recorded (CL0114). A "stale manifest" project was
   * tried first and dropped — drift is a progress-log line and never reaches the diagnostics
   * bus, so it would have contributed nothing here. See ../README.md.
   */
  test('a committed manifest that disagrees with the config and the disk', () => {
    expect(diagnoseProject('snapshot-mismatch')).toMatchSnapshot();
  });

  /**
   * The snapshot-corrupt project: a frozen file hand-edited since the manifest was
   * written. CL0115 is the one snapshot code that is an ERROR, and checkDrift runs before
   * abortOnLoadErrors throws — so, like schema/, this project aborts before anything
   * downstream runs.
   */
  test('a hand-edited snapshot file aborts the load', () => {
    expect(diagnoseProject('snapshot-corrupt')).toMatchSnapshot();
  });

  /**
   * The card-collision project (Phase 10 Step 3): two items share a displayed card name
   * across different aid.type values. VL merges cards by name alone, so only one reaches
   * AID and which one is position-dependent once cards are inherited rather than copied
   * to every leaf. CL0622 is the ERROR that names the collision (Phase 11 Step 5 — it was
   * a WARN through Phase 10).
   */
  test('two cards share a name across types', () => {
    expect(diagnoseProject('card-collision')).toMatchSnapshot();
  });

  /**
   * The unread-fields project (Phase 12 Step 4, §13.6): load-clean, so the audit runs.
   * `Alba` carries an undeclared body key (`strength` — CL0426); `Cairn` carries a real
   * field the template omits (`homeland`, in the `origin` group — CL0427); `deadField` is
   * declared and named by no template (CL0428). Two branches, so every item resolves
   * twice — the `(item id, field path)` dedupe is what keeps each finding to one row.
   * `Nook`'s template carries `{ allowExtra: true }` and raises nothing.
   */
  test('a body key no field reads, deduped across leaves', () => {
    expect(diagnoseProject('unread-fields')).toMatchSnapshot();
  });

});
