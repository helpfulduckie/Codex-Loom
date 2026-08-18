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
 * The two projects are separate because the layers abort differently (§4.3): a schema
 * ERROR stops the compile before anything is written, so a config mistake in the placement
 * project would suppress everything that project exists to demonstrate. See each
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
 * `compile` signals failure by throwing a *count* and reports the diagnostics themselves
 * to the console, interleaved with progress lines and temp paths — which is right for an
 * author at a terminal and useless as a baseline. `options.diagnostics` hands back the
 * bus instead, on every exit path including the throw.
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
  const spies = ['log', 'warn', 'error'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  try {
    compile(path.join(tmpDir, 'compile.cl.yaml'), { diagnostics });
  } catch (err) {
    // Expected: both projects raise ERRORs by construction. What the ERROR *is* lives in
    // the diagnostics, so the throw itself carries nothing worth asserting.
  } finally {
    spies.forEach((s) => s.mockRestore());
  }

  const relative = (file) => {
    if (!file) return null;
    const rel = path.relative(tmpDir, file);
    return rel.startsWith('..') ? path.basename(file) : rel.split(path.sep).join('/');
  };

  return diagnostics.all.map((d) => {
    const loc = relative(d.file);
    const head = [d.severity.toUpperCase(), d.code, loc].filter(Boolean).join(' ');
    const body = d.message.replace(/\r?\n\s*/g, ' ').trim();
    return d.hint ? `${head}\n  ${body}\n  hint: ${d.hint}` : `${head}\n  ${body}`;
  }).join('\n');
}

describe('pathological fixture', () => {
  /**
   * The placement project: load-clean on purpose, so the compile phase runs in full and
   * §7.4's invariants have something to report. Its placeholder content is inert today —
   * `placeholders:` draws a NOT_YET_IMPLEMENTED WARN and is ignored — and that WARN
   * disappearing is the first row Phase 4 Step 1 is expected to change.
   *
   * One row in this snapshot is known to be WRONG, and is pinned rather than blessed:
   * CL0322 fires on `Ghost`, an item with `storyCard: false` whose only template sits on
   * its component target. §7.4 says an item routed only into components needs neither
   * `aid.type` nor `render.template`, so the check is a Phase 3 leftover that the item/slot
   * flip never rescoped. It is tracked separately; when it is fixed, this snapshot loses
   * two rows and that is the intended diff.
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
});
