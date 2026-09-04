'use strict';

const path = require('path');
const fs = require('fs');
const { NULL_LOG } = require('../../src/log');

describe('NULL_LOG', () => {
  test('has the two channels and both discard', () => {
    expect(typeof NULL_LOG.info).toBe('function');
    expect(typeof NULL_LOG.verbose).toBe('function');
    expect(NULL_LOG.info('x')).toBeUndefined();
    expect(NULL_LOG.verbose('x')).toBeUndefined();
  });

  test('is frozen, so no module can grow it a channel the CLI does not know about', () => {
    expect(Object.isFrozen(NULL_LOG)).toBe(true);
  });
});

describe('only cli.js prints', () => {
  // Everything under src/ reports through the diagnostics bus or narrates through a log
  // object; `console` belongs to the one module that decides what a run shows. Comments
  // are stripped first — a few modules mention `console.warn` in prose about what they
  // used to do.
  //
  // `STILL_PRINTING` is the set of modules that have not been converted yet, pinned
  // exactly: a module that stops printing must be removed from the list, and a new print
  // anywhere fails. The list empties over Package 2b and is then deleted.
  const srcDir = path.join(__dirname, '../../src');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  const STILL_PRINTING = [
    'bodysize.js',
    'lint.js',
    'overview.js',
    'seedmap.js',
  ];

  test('no src/ module outside cli.js calls console, beyond the pinned not-yet-converted set', () => {
    const printing = [];
    for (const file of walk(srcDir)) {
      const rel = path.relative(srcDir, file).split(path.sep).join('/');
      if (rel === 'cli.js') continue;
      if (/console\.(log|warn|error|info|debug)\b/.test(stripComments(fs.readFileSync(file, 'utf8')))) {
        printing.push(rel);
      }
    }
    expect(printing.sort()).toEqual([...STILL_PRINTING].sort());
  });
});
