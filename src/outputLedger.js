'use strict';

/**
 * Every write, delete and directory creation the compile makes in the output tree, and the
 * ledger of files it wrote so the sweep that follows can remove exactly the compiler output
 * it did not write.
 *
 * Writers are many and deep in the call tree, so they report here rather than threading a
 * collection through every signature. A compile is synchronous; `startOutputLedger` and
 * `takeOutputLedger` bracket it, and outside that bracket recording does nothing.
 *
 * Because all output goes through `writeOutputFile`, `removeOutputFile` and
 * `ensureOutputDir`, a bracket started with `{ capture: true }` can hold the output in
 * memory and touch no disk. Outside a bracket the three functions always use the disk.
 */

const fs = require('fs');
const path = require('path');

let ledger = null;
let captured = null;

function startOutputLedger(options = {}) {
  ledger = new Set();
  captured = options.capture ? new Map() : null;
}

// Ends capture too, so a compile that throws leaves no mode or content behind. A caller
// that wants the captured content takes it first.
function takeOutputLedger() {
  const out = ledger;
  ledger = null;
  captured = null;
  return out;
}

/** The captured path -> content map, or null when the bracket was not capturing. */
function takeCapturedOutput() {
  const out = captured;
  if (captured) captured = new Map();
  return out;
}

/** Record a file the compiler wrote into the output tree. */
function recordWrite(filePath) {
  if (ledger) ledger.add(path.resolve(filePath));
}

/** Write a string (as UTF-8) or Buffer, creating its directory, and record it. */
function writeOutputFile(filePath, content) {
  if (captured) {
    captured.set(path.resolve(filePath), content);
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (typeof content === 'string') fs.writeFileSync(filePath, content, 'utf8');
    else fs.writeFileSync(filePath, content);
  }
  recordWrite(filePath);
}

function removeOutputFile(filePath) {
  if (captured) return;
  if (fs.existsSync(filePath)) fs.rmSync(filePath);
}

function ensureOutputDir(dir) {
  if (captured) return;
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  startOutputLedger,
  takeOutputLedger,
  takeCapturedOutput,
  recordWrite,
  writeOutputFile,
  removeOutputFile,
  ensureOutputDir,
};
