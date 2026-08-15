'use strict';

/**
 * Tests for the fixture diff classifier (§14.3).
 *
 * The classifier is what the Phase 2 re-baseline will be judged against, so it is worth
 * more test weight than a test helper usually earns: a false "fence only" verdict would
 * wave a body-text regression straight through review.
 */

const { classifyDiff, classifyLines, changedIndices, OPAQUE } = require('../helpers/diffShape');

/** A compiled story card, in the shape `emit/vl.js` will produce. */
function card({ title = 'Aness', triggers = '[Aness, Vale]', body = 'Aness - Journeyman Healer' } = {}) {
  return [
    `## ${title}`,
    '~~~',
    `triggers: ${triggers}`,
    'encapsulate: false',
    '~~~',
    body,
    '',
  ].join('\n');
}

describe('classifyLines', () => {
  test('splits a card into title, fence and body', () => {
    const classes = classifyLines(card().split('\n'));
    expect(classes).toEqual(['title', 'fence', 'fence', 'fence', 'fence', 'body', 'body']);
  });

  test('a heading below the fence is a title, not body', () => {
    const classes = classifyLines(['## One', '~~~', 'triggers: []', '~~~', '## Two']);
    expect(classes[4]).toBe('title');
  });

  test('a ## inside the fence belongs to the fence', () => {
    const classes = classifyLines(['## One', '~~~', '## not a heading', '~~~']);
    expect(classes[2]).toBe('fence');
  });

  test('a markdown code fence is body, not a VL fence', () => {
    const classes = classifyLines(['```', 'code', '```']);
    expect(classes).toEqual(['body', 'body', 'body']);
  });

  test('an unpaired fence poisons the whole file', () => {
    expect(classifyLines(['## One', '~~~', 'triggers: []'])).toBeNull();
  });
});

describe('changedIndices', () => {
  test('finds a single replaced line', () => {
    const a = ['one', 'two', 'three'];
    const b = ['one', 'TWO', 'three'];
    expect(changedIndices(a, b)).toEqual({ a: [1], b: [1] });
  });

  test('finds an insertion without shifting the lines after it', () => {
    const a = ['one', 'three'];
    const b = ['one', 'two', 'three'];
    expect(changedIndices(a, b)).toEqual({ a: [], b: [1] });
  });

  test('finds a deletion', () => {
    const a = ['one', 'two', 'three'];
    const b = ['one', 'three'];
    expect(changedIndices(a, b)).toEqual({ a: [1], b: [] });
  });

  test('reports nothing for identical input', () => {
    expect(changedIndices(['one'], ['one'])).toEqual({ a: [], b: [] });
  });
});

describe('classifyDiff', () => {
  test('identical files report no classes', () => {
    expect(classifyDiff(card(), card())).toEqual({
      identical: true, classes: [], changedLines: 0, samples: [],
    });
  });

  test('a re-quoted trigger list is a fence-only change — Phase 2 expected shape', () => {
    const result = classifyDiff(card(), card({ triggers: '["Aness", "Vale"]' }));
    expect(result.classes).toEqual(['fence']);
    expect(result.changedLines).toBe(2);
  });

  test('a dropped encapsulate line is a fence-only change', () => {
    const before = card();
    const after = before.replace('encapsulate: false\n', '');
    expect(classifyDiff(before, after).classes).toEqual(['fence']);
  });

  test('an edited card title is a title change', () => {
    expect(classifyDiff(card(), card({ title: 'Aness Vale' })).classes).toEqual(['title']);
  });

  test('an edited body line is a body change — the Phase 2 bug case', () => {
    expect(classifyDiff(card(), card({ body: 'Aness - Master Healer' })).classes).toEqual(['body']);
  });

  test('a fence change is not allowed to mask a body change in the same file', () => {
    const after = card({ triggers: '["Aness"]', body: 'Aness - Master Healer' });
    expect(classifyDiff(card(), after).classes).toEqual(['body', 'fence']);
  });

  test('a whole card appearing is a body change, not a title change', () => {
    // Phase 3 drops PE-only items from story-card output; that must never read as fence-only.
    expect(classifyDiff(card() + card({ title: 'Kaiden' }), card()).classes)
      .toEqual(expect.arrayContaining(['body']));
  });

  test('a line-ending change is reported rather than normalized away', () => {
    const result = classifyDiff(card(), card().replace(/\n/g, '\r\n'));
    expect(result.identical).toBe(false);
    expect(result.changedLines).toBeGreaterThan(0);
  });

  test('an unpaired fence is opaque, never a passable shape', () => {
    const truncated = '## Aness\n~~~\ntriggers: [Aness]\n';
    expect(classifyDiff(card(), truncated).classes).toEqual([OPAQUE]);
  });

  test('samples show both sides of the change', () => {
    const result = classifyDiff(card(), card({ triggers: '["Aness", "Vale"]' }));
    expect(result.samples.some((s) => s.startsWith('-'))).toBe(true);
    expect(result.samples.some((s) => s.startsWith('+'))).toBe(true);
  });

  test('samples are capped', () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 50 }, (_, i) => `LINE ${i}`).join('\n');
    expect(classifyDiff(before, after, { maxSamples: 4 }).samples.length).toBeLessThanOrEqual(4);
  });
});
