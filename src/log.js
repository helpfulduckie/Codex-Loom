'use strict';

/**
 * The progress log: the sink for everything a compile or report run narrates that is not
 * a diagnostic — "Loaded N templates", the verbose `OK:` lines, the leaf summary table,
 * the snapshot drift notice. Two channels. `info` reaches the author on every run;
 * `verbose` only under `--verbose`. Both take one string and return nothing.
 *
 * A module holding a log may call it and nothing else: never read it back, count it, or
 * test which implementation it was handed. That restriction is what makes `cli.js` the one
 * place that decides what a run shows. The console-backed log is built there, and a test
 * that wants to assert on a line passes one that collects (`__tests__/helpers/log.js`).
 * This module exports only the silent default, which is the correct behavior for a library
 * call and what every test gets without passing anything.
 *
 * Deliberately not the diagnostics bus. The bus is data: `hasErrors()` gates the exit code,
 * tests assert on codes, the pathological fixture snapshots every item. A progress line on
 * it would land in a diagnostic snapshot. `SEVERITY.INFO` exists in `diag.js` and stays
 * unused for this reason.
 */

const noop = () => {};

const NULL_LOG = Object.freeze({ info: noop, verbose: noop });

module.exports = { NULL_LOG };
