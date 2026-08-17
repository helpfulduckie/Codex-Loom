'use strict';

/**
 * The `--inventory` report's two compressions (v4 spec §7.9).
 *
 * Row grouping and pattern collapsing are what make the report readable at The Institute's
 * 32 leaves, and both are lossy in a way that would be silent: a pattern that over-matches
 * asserts a placement that never happened, and it would look exactly like a correct one.
 * So the pattern is tested for what it refuses as much as for what it produces.
 */

const {
  occupancyKey,
  describeBranches,
  collectSlots,
} = require('../../src/inventory');

/** A leaf carrying only what the renderers read. */
function leaf(pathSegments) {
  return { label: pathSegments.join('/'), branchPath: pathSegments, components: [] };
}

/** The Institute's shape: four axes, two values each, fully populated. */
const INSTITUTE = [];
for (const a of ['Free Form', 'Wyvern']) {
  for (const you of ['Aness', 'Veryn']) {
    for (const cast of ['Zephon', 'Malcolm']) {
      for (const mood of ['hatesYou', 'lovesYou']) INSTITUTE.push(leaf([a, you, cast, mood]));
    }
  }
}

// ── occupancy states ─────────────────────────────────────────────────────────

describe('occupancyKey — the three ways a slot holds nothing', () => {
  test('occupants are named in the order given, not alphabetized', () => {
    // The caller sorted by `order:` then id (§7.4); re-sorting here would report a
    // sequence the output file does not use.
    const slot = { gated: false, occupants: [{ id: 'Kaiden' }, { id: 'Bryn' }, { id: 'Rhylen' }] };
    expect(occupancyKey(slot)).toBe('Kaiden, Bryn, Rhylen');
  });

  test('a declared, placeable slot nobody filled reads as empty', () => {
    expect(occupancyKey({ gated: false, occupants: [] })).toBe('(empty)');
  });

  test('a slot the component gated off this branch is distinct from empty', () => {
    // §7.4's third and fifth rows make gating legitimate, so collapsing it into "(empty)"
    // would report a deliberate exclusion as a possible mistake.
    expect(occupancyKey({ gated: true, occupants: [] })).toBe('(gated off this branch)');
  });

  test('a component that declares the slot nowhere on this branch is distinct again', () => {
    expect(occupancyKey(null)).toBe('(not declared)');
  });
});

// ── branch description ───────────────────────────────────────────────────────

describe('describeBranches', () => {
  test('a row covering every leaf says so without listing any', () => {
    expect(describeBranches(INSTITUTE, INSTITUTE)).toBe('all 16');
  });

  test('a set that is one axis collapses to a pattern naming that axis', () => {
    const aness = INSTITUTE.filter((l) => l.branchPath[1] === 'Aness');
    expect(describeBranches(aness, INSTITUTE)).toBe('8 — `*/Aness/*/*`');
  });

  test('two axes collapse together', () => {
    const both = INSTITUTE.filter((l) => l.branchPath[1] === 'Aness' && l.branchPath[3] === 'lovesYou');
    // Two axes pinned, two free: 4 of the 16.
    expect(describeBranches(both, INSTITUTE)).toBe('4 — `*/Aness/*/lovesYou`');
  });

  test('an arbitrary set falls back to listing rather than over-matching', () => {
    // Two leaves sharing no axis value. The per-segment union would be
    // `Free Form|Wyvern`/`Aness|Veryn`/… which matches four leaves, not these two — so
    // the pattern is rejected and the labels are printed instead.
    const arbitrary = [INSTITUTE[0], INSTITUTE[15]];
    const out = describeBranches(arbitrary, INSTITUTE);
    expect(out).not.toContain('`');
    expect(out).toBe(`2 — ${INSTITUTE[0].label}, ${INSTITUTE[15].label}`);
  });

  test('an unbranched project has no pattern to offer', () => {
    const single = [leaf([])];
    expect(describeBranches(single, single)).toBe('all 1');
  });
});

// ── slot collection ──────────────────────────────────────────────────────────

describe('collectSlots', () => {
  test('a slot gated off on the first branch is still collected from a later one', () => {
    // Built across all leaves rather than from leaves[0], which is the case that made the
    // traversal order matter: a report keyed off the first branch would omit the slot
    // entirely and answer a narrower question than the one asked.
    const withSlots = (slots) => [{ key: 'plotEssential', label: 'Plot Essentials', passthrough: false, slots }];
    const leaves = [
      { label: 'a', branchPath: ['a'], components: withSlots([]) },
      {
        label: 'b',
        branchPath: ['b'],
        components: withSlots([{ name: 'cast', heading: 'Cast', gated: false, occupants: [] }]),
      },
    ];
    const slots = collectSlots(leaves);
    expect([...slots.values()].map((s) => s.name)).toEqual(['cast']);
  });
});
