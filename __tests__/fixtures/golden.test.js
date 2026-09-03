'use strict';

/**
 * The golden fixture set (v4 spec §14.3).
 *
 * Three real scenario projects, frozen on v3 before any v4 code was written, compiled from
 * their migrated v4 sources and asserted byte-for-byte against the committed v3 output. The
 * harness itself is `__tests__/helpers/baselineHarness.js`, shared with the example projects
 * (`examples.test.js`); this file supplies the set and the one assertion that is specific to
 * these fixtures.
 *
 * **The goldens are a separate private repo cloned into the gitignored `goldenFixtures/`**,
 * because the projects contain unpublished writing. Absent, this file has nothing to compile
 * and the manifest require would throw at load time, failing the run for a reason that says
 * nothing about the compiler — so the whole set registers as skipped instead, against a
 * placeholder project whose name says why.
 *
 * **A skipped golden suite is silent in a green run**, which is the failure mode to watch
 * for: `npm test` passing does not mean the goldens passed unless they ran. The example
 * projects are committed and always run, which is why they now carry the standing obligation
 * — see `examples/projects.js`.
 *
 * ── The re-baselining protocol ────────────────────────────────────────────────
 *
 * `expectedDiffClasses` and `expectedDiffFiles` below are §14.3's declaration of what the
 * phase in progress is allowed to change. Empty and null mean "byte-for-byte, any diff is a
 * bug" — the standing obligation. A phase that changes output deliberately widens them to
 * exactly the classes and files its expected diff covers, never further, and re-baselines
 * under review via `scripts/rebaseline.js`. A widened allowance is reset by the next phase
 * rather than inherited: carrying one forward is the accumulation these constants exist to
 * prevent. The history of which phase set what is in the session records, not here.
 *
 * The corpus has been byte-for-byte since Phase 10 Step 4.
 */

const path = require('path');
const fs = require('fs');

const { describeBaselineSet } = require('../helpers/baselineHarness');

const GOLDEN_DIR = path.resolve(__dirname, '../../goldenFixtures');
const HAVE_FIXTURES = fs.existsSync(path.join(GOLDEN_DIR, 'projects.js'));

/**
 * The set manifest lives beside the fixtures, because `scripts/rebaseline.js` regenerates
 * what this file checks and the two must not drift apart. It predates the harness split and
 * needs no edit for it: every field the harness added since — `CONFIG_NAME`, `SOURCE_SUBDIR`
 * as a project-relative path, `REPORTS_IN_PLACE` — defaults to what this set already does.
 */
// eslint-disable-next-line global-require, import/no-dynamic-require
const manifest = HAVE_FIXTURES ? require('../../goldenFixtures/projects') : null;

const { getTmpDir } = describeBaselineSet({
  root: GOLDEN_DIR,
  manifest,
  present: HAVE_FIXTURES,
  absentReason: 'goldenFixtures/ is not cloned — see .gitignore',
  expectedDiffClasses: [],
  expectedDiffFiles: null,
});

/**
 * The label-membership guard (Phase 13 Decision 2, §13.4) against a real scenario.
 *
 * Coinflip's `lowContext` branch carries `templateFor.base: terse.cl.yaml`, whose terse
 * `Character` list only *omits* — no substitution. So the guard here is the strict form:
 * every stanza the terse card keeps is byte-identical to the full card's, the kept labels
 * are an in-order subsequence, and the terse card is genuinely shorter (it drops
 * `Background`). Byte-identity against a frozen baseline cannot make this assertion — the
 * tier card is *supposed* to differ from the full one — which is why this guard exists.
 *
 * The full comparison branch is `foundFamily`: both it and `lowContext` render the party's
 * base variants (the `minions` alternates apply only on that branch), so the same three
 * cards appear under the same names on each.
 */
const { parseCards, isSubsequence } = require('../helpers/tier-wellformed');

(HAVE_FIXTURES ? describe : describe.skip)('Coinflip Company — lowContext tier is well-formed', () => {
  const CARD = ['Branches', '%b', 'Story Cards', 'Character', 'Character.md'];
  const read = (branch) => {
    const rel = CARD.map((s) => (s === '%b' ? branch : s));
    return fs.readFileSync(
      path.join(getTmpDir(), 'Eldemyr', 'Coinflip Company', manifest.OUTPUT_SUBDIR, ...rel), 'utf8',
    );
  };

  let terse;
  let full;
  beforeAll(() => {
    terse = parseCards(read('lowContext'));
    full = parseCards(read('foundFamily'));
  });

  test('the tier renders the same cast as the full branch', () => {
    expect([...terse.keys()].sort()).toEqual([...full.keys()].sort());
    expect(terse.size).toBeGreaterThan(0);
  });

  test('every terse card only omits — kept stanzas are byte-identical and in order, and it is shorter', () => {
    for (const [name, terseStanzas] of terse) {
      const fullStanzas = full.get(name);
      const fullLabels = fullStanzas.map((s) => s.label);
      const terseLabels = terseStanzas.map((s) => s.label);

      // (a) invents nothing.
      for (const l of terseLabels) {
        expect(fullLabels).toContain(l);
      }
      // (b) kept labels are an in-order subsequence of the full render's.
      expect(isSubsequence(terseLabels, fullLabels)).toBe(true);
      // (c) pure omission: every kept stanza's body is byte-identical to the full render's.
      const fullByLabel = new Map(fullStanzas.map((s) => [s.label, s.body]));
      for (const s of terseStanzas) {
        expect(s.body).toBe(fullByLabel.get(s.label));
      }
      // the tier actually does something — the terse card is strictly shorter.
      expect(terseLabels.length).toBeLessThan(fullLabels.length);
    }
  });

  test('the terse Character list drops Background', () => {
    for (const [, terseStanzas] of terse) {
      expect(terseStanzas.map((s) => s.label)).not.toContain('Background');
    }
    for (const [, fullStanzas] of full) {
      expect(fullStanzas.map((s) => s.label)).toContain('Background');
    }
  });
});
