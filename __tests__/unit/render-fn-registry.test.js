'use strict';

// Drift guard for the seven render-function names. `FUNCTION_NAMES` in render/parse.js is
// the one canonical list; every other shape that enumerates the render functions is now
// derived from it. This test fails if any of them stops covering exactly that set — the
// failure mode the old hand-typed copies had no protection against.

const { FUNCTION_NAMES } = require('../../src/render/parse');
const { FUNCTIONS } = require('../../src/render/eval');
const { TEMPLATE_FN_RE } = require('../../src/util');

const canonical = [...FUNCTION_NAMES].sort();

test('FUNCTIONS (render/eval.js) keys are exactly FUNCTION_NAMES', () => {
  expect(Object.keys(FUNCTIONS).sort()).toEqual(canonical);
});

test('TEMPLATE_FN_RE (util.js) matches exactly FUNCTION_NAMES', () => {
  for (const n of FUNCTION_NAMES) {
    expect(new RegExp(TEMPLATE_FN_RE.source).test(`{${n}($body.x)}`)).toBe(true);
  }
  expect(new RegExp(TEMPLATE_FN_RE.source).test('{bogus($body.x)}')).toBe(false);
});
