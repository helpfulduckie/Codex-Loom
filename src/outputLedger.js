'use strict';

/**
 * The files the running compile has written into the output tree, so the sweep that
 * follows can remove exactly the compiler output it did not write.
 *
 * Writers are many and deep in the call tree, so they report here rather than threading a
 * collection through every signature. A compile is synchronous; `startOutputLedger` and
 * `takeOutputLedger` bracket it, and outside that bracket recording does nothing.
 */

const path = require('path');

let ledger = null;

function startOutputLedger() { ledger = new Set(); }
function takeOutputLedger() { const out = ledger; ledger = null; return out; }

/** Record a file the compiler wrote into the output tree. */
function recordWrite(filePath) {
  if (ledger) ledger.add(path.resolve(filePath));
}

module.exports = { startOutputLedger, takeOutputLedger, recordWrite };
