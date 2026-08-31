'use strict';

const fs = require('fs');
const path = require('path');

// Isolated in its own file (rather than folded into compile.test.js) because the pass-count
// proof below needs `applyFieldRenderFunctions` spied on *before* `crossItem.js` is required —
// crossItem.js destructures the function into a local binding at its own module load time
// (`const { applyFieldRenderFunctions } = require('./template')`), so a spy installed after
// crossItem.js is already cached elsewhere would never be seen. A dedicated file gets a fresh,
// ordered require chain for free; Jest gives each test file its own module registry, so
// nothing else in the suite has required `crossItem.js` (or `template.js`) yet.
const templateModule = require('../../src/template');
const applyFieldRenderFunctionsSpy = jest.spyOn(templateModule, 'applyFieldRenderFunctions');
const { resolveCrossItemRenderFunctions } = require('../../src/crossItem');
const { Diagnostics, CODES: DIAG_CODES } = require('../../src/diag');

function byId(...items) {
  const map = new Map();
  for (const item of items) map.set(item.id.toLowerCase(), item);
  return map;
}

beforeEach(() => {
  applyFieldRenderFunctionsSpy.mockClear();
});

describe('resolveCrossItemRenderFunctions — dependency-ordered evaluation (Phase 9 Step 2)', () => {
  test('a three-item chain resolves in one evaluation pass, proven by call count', () => {
    // C is a leaf (no cross-item refs); B reads C; A reads B. Order in the array is
    // deliberately not dependency order, so a correct result also proves the graph — not
    // array position — drives evaluation order.
    const a = { id: 'A', body: { summary: '{join(" ", $B.body.tagline)}' } };
    const b = { id: 'B', body: { tagline: '{join(" ", $C.body.name)}' } };
    const c = { id: 'C', body: { name: 'Grayls' } };
    const resolvedById = byId(a, b, c);

    resolveCrossItemRenderFunctions([a, b, c], resolvedById, new Diagnostics());

    // One call per item, not one call per item per pass — the fixpoint loop this replaces
    // called applyFieldRenderFunctions len(items) times per pass and needed multiple passes
    // for a chain this deep; the count itself is the proof, not just the final value.
    expect(applyFieldRenderFunctionsSpy).toHaveBeenCalledTimes(3);
    expect(c.body.name).toBe('Grayls');
    expect(b.body.tagline).toBe('Grayls');
    expect(a.body.summary).toBe('Grayls');
  });

  test('a render function migrating between items is evaluated in the authoring item\'s context', () => {
    // B's own tagline reads $body.trait — unqualified, so it means B's body under either
    // scheme. What differs is which context is live when that render function itself runs.
    // A pulls B's tagline via a cross-item ref. Under the old fixpoint loop, B's raw
    // (unevaluated) text could land inside A's field first and get evaluated against A's
    // context on a later pass — A has no `trait`, so it would resolve to empty. Under
    // topological order, B is fully evaluated (against its own context) before A ever
    // reads it, so A sees B's finished value.
    const a = { id: 'A', body: { summary: '{join(" ", $B.body.tagline)}' } };
    const b = { id: 'B', body: { trait: 'brave', tagline: '{join(" ", $body.trait)}' } };
    const resolvedById = byId(a, b);

    resolveCrossItemRenderFunctions([a, b], resolvedById, new Diagnostics());

    expect(b.body.tagline).toBe('brave');
    expect(a.body.summary).toBe('brave');
  });

  test('a self-reference is tolerated, not reported as a cycle', () => {
    const a = { id: 'A', body: { primary: 'stoic', echo: '{join(" ", $A.body.primary)}' } };
    const resolvedById = byId(a);
    const diagnostics = new Diagnostics();

    resolveCrossItemRenderFunctions([a], resolvedById, diagnostics);

    expect(diagnostics.errors).toEqual([]);
    expect(a.body.echo).toBe('stoic');
  });

  test('a genuine two-item cycle raises CL0418 naming both items and both fields, and leaves both unexpanded', () => {
    const x = { id: 'X', body: { a: '{join(" ", $Y.body.b)}' } };
    const y = { id: 'Y', body: { b: '{join(" ", $X.body.a)}' } };
    const resolvedById = byId(x, y);
    const diagnostics = new Diagnostics();

    resolveCrossItemRenderFunctions([x, y], resolvedById, diagnostics);

    const cycleErrors = diagnostics.errors.filter((d) => d.code === DIAG_CODES.CROSS_ITEM_CYCLE);
    expect(cycleErrors).toHaveLength(1);
    expect(cycleErrors[0].message).toEqual(expect.stringContaining('"X".a'));
    expect(cycleErrors[0].message).toEqual(expect.stringContaining('"Y".b'));

    // Left as authored — CL0432 LEAKED_RENDER_FUNCTION catches this downstream in the
    // rendered output sweep, which is the second of the "two reports, both correct" the
    // plan's Unknowns section calls for.
    expect(x.body.a).toBe('{join(" ", $Y.body.b)}');
    expect(y.body.b).toBe('{join(" ", $X.body.a)}');

    // Cyclic items are never handed to the render pass at all.
    expect(applyFieldRenderFunctionsSpy).not.toHaveBeenCalled();
  });

  test('an item outside a cycle still evaluates, reading whatever raw state the cycle left behind', () => {
    const x = { id: 'X', body: { a: '{join(" ", $Y.body.b)}' } };
    const y = { id: 'Y', body: { b: '{join(" ", $X.body.a)}' } };
    const z = { id: 'Z', body: { summary: '{join(" ", $X.body.a)}' } };
    const resolvedById = byId(x, y, z);
    const diagnostics = new Diagnostics();

    resolveCrossItemRenderFunctions([x, y, z], resolvedById, diagnostics);

    expect(applyFieldRenderFunctionsSpy).toHaveBeenCalledTimes(1);
    expect(z.body.summary).toBe('{join(" ", $Y.body.b)}');
  });

  test('no fixpoint bound remains in the source', () => {
    // `maxPasses` and the `JSON.stringify`-before-and-after convergence check were the
    // fixpoint loop's own mechanism; their absence is direct evidence the loop is gone,
    // not just that its replacement happens to produce the same answer.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'compile.js'), 'utf8');
    expect(source).not.toMatch(/maxPasses/);
    expect(source).not.toMatch(/circular dependencies/);
  });
});
