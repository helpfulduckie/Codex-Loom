'use strict';

/**
 * The example project set (v4 spec §14.3).
 *
 * The projects under `examples/` compiled from their committed source and asserted
 * byte-for-byte against their committed `output/` and `Review/`. The harness is
 * `__tests__/helpers/baselineHarness.js`, shared with `golden.test.js`; this file supplies
 * the set and nothing else.
 *
 * **This set is committed, so it always runs.** That is the whole reason it exists as a
 * fixture set rather than only as documentation: the goldens are private and skip silently
 * when their clone is absent, so a green run has never by itself meant a baseline was
 * checked. It does now.
 *
 * **The projects are read by people, which constrains the baseline.** The committed `output/`
 * is both the comparison target and the worked example a reader browses, so it has to be the
 * tree the compiler actually produces from the sources beside it — no separate baseline
 * directory, and reports frozen where the compiler writes them rather than collected into a
 * harness-shaped layout. `examples/projects.js` carries the reasoning.
 *
 * **`expectedDiffClasses` is empty here and stays empty.** The goldens widen theirs for a
 * phase that changes output deliberately; this set has no such history to carry, and an
 * output change here is re-baselined through `scripts/rebaseline.js` with the shape stated on
 * the command line rather than declared in the file.
 */

const path = require('path');

const { describeBaselineSet } = require('../helpers/baselineHarness');

const EXAMPLES_DIR = path.resolve(__dirname, '../../examples');

describeBaselineSet({
  root: EXAMPLES_DIR,
  // eslint-disable-next-line global-require
  manifest: require('../../examples/projects'),
  present: true,
  expectedDiffClasses: [],
  expectedDiffFiles: null,
});
