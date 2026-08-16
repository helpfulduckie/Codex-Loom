'use strict';

/**
 * The component model (§7.2, §7.3) — the grammar the flip commit routes items into.
 *
 * Nothing calls this module yet: steps 3–5 wire it in, and until then it is tested on its
 * own. That is deliberate rather than a gap. The grammar is the piece the whole phase
 * depends on, and settling its behavior before any output moves is what keeps the flip
 * commit reviewable — a defect found here is one line, the same defect found there is
 * hidden inside a re-baselined Plot Essentials diff.
 */

const {
  normalizeComponent, sectionsForBranch, slotsForBranch, WRAP, DEFAULT_POSITION,
} = require('../../src/model/component');
const { CODES } = require('../../src/diag');

/** Collect `onWarn(code, message)` calls the way `compile.js` collects them from model/. */
function collector() {
  const seen = [];
  const onWarn = (code, message) => seen.push({ code, message });
  return { seen, onWarn, codes: () => seen.map((d) => d.code) };
}

describe('normalizeComponent', () => {
  test('an absent or empty document yields no sections and no slots', () => {
    for (const doc of [null, undefined, {}, { sections: {} }]) {
      const component = normalizeComponent(doc);
      expect(component.sections).toEqual([]);
      expect(component.slots.size).toBe(0);
    }
  });

  test('sections carry their name and keep declaration order as the sort tiebreak', () => {
    const { sections } = normalizeComponent({
      sections: {
        genre: { text: 'Genre: Thriller' },
        cast: { slot: true },
        tone: { text: 'Tone: bleak' },
      },
    });
    expect(sections.map((s) => s.name)).toEqual(['genre', 'cast', 'tone']);
  });

  test('position sorts ahead of declaration order', () => {
    const { sections } = normalizeComponent({
      sections: {
        last: { text: 'z', render: { position: 9 } },
        first: { text: 'a', render: { position: 1 } },
        middle: { text: 'm' },
      },
    });
    expect(sections.map((s) => s.name)).toEqual(['first', 'middle', 'last']);
  });

  test('an unpositioned section defaults to 5, which is where both v3 formats put it', () => {
    const { sections } = normalizeComponent({ sections: { solo: { text: 'x' } } });
    expect(sections[0].position).toBe(DEFAULT_POSITION);
  });

  test('slot: true indexes the section by name; a text section is not a slot', () => {
    const component = normalizeComponent({
      sections: { cast: { slot: true }, genre: { text: 'Genre: Thriller' } },
    });
    expect([...component.slots.keys()]).toEqual(['cast']);
    expect(component.slots.get('cast').isSlot).toBe(true);
  });

  test('a section set to ~ is dropped rather than normalized into an empty one', () => {
    const component = normalizeComponent({
      sections: { cast: { slot: true }, retired: null },
    });
    expect(component.sections.map((s) => s.name)).toEqual(['cast']);
  });

  /**
   * The header's stated non-decision. Plot Essentials reads a bare heading as level 0 and
   * AI Instructions reads it as level 2; defaulting here would restyle every heading in
   * one of the two the moment they share a grammar.
   */
  test('headingLevel is carried through unwritten rather than defaulted', () => {
    const { sections } = normalizeComponent({
      sections: { a: { heading: 'Cast', slot: true }, b: { heading: 'Tone', headingLevel: 2, text: 'x' } },
    });
    expect(sections[0].headingLevel).toBeUndefined();
    expect(sections[1].headingLevel).toBe(2);
  });
});

describe('wrap (§7.4, per-occupant by default)', () => {
  test('a slot wraps each occupant unless it asks for the collection', () => {
    const { slots } = normalizeComponent({
      sections: {
        cast: { slot: true, render: { wrapper: 'square' } },
        party: { slot: true, render: { wrapper: 'curly', wrap: 'all' } },
      },
    });
    expect(slots.get('cast').wrap).toBe(WRAP.EACH);
    expect(slots.get('party').wrap).toBe(WRAP.ALL);
  });

  test('an unrecognized wrap warns and falls back to each', () => {
    const { onWarn, seen, codes } = collector();
    const { slots } = normalizeComponent({
      sections: { cast: { slot: true, render: { wrap: 'both' } } },
    }, { onWarn });
    expect(codes()).toEqual([CODES.SECTION_WRAP_UNKNOWN]);
    expect(seen[0].message).toContain('"both"');
    expect(slots.get('cast').wrap).toBe(WRAP.EACH);
  });
});

describe('section diagnostics', () => {
  test('text and slot: true together is an ERROR-severity code', () => {
    const { onWarn, seen, codes } = collector();
    normalizeComponent({ sections: { cast: { slot: true, text: 'The party:' } } }, { onWarn });
    expect(codes()).toEqual([CODES.SECTION_TEXT_AND_SLOT]);
    expect(seen[0].message).toContain('cast');
  });

  test('a section with nothing to render warns', () => {
    const { onWarn, codes } = collector();
    normalizeComponent({ sections: { hollow: { render: { position: 2 } } } }, { onWarn });
    expect(codes()).toEqual([CODES.SECTION_RENDERS_NOTHING]);
  });

  test('a heading alone renders, so it is not an empty section', () => {
    const { onWarn, codes } = collector();
    normalizeComponent({ sections: { divider: { heading: 'Cast' } } }, { onWarn });
    expect(codes()).toEqual([]);
  });

  test('normalizing without an onWarn does not throw', () => {
    expect(() => normalizeComponent({ sections: { hollow: {} } })).not.toThrow();
  });
});

describe('branch gating (§7.2 component-level visibility)', () => {
  const component = () => normalizeComponent({
    sections: {
      genre: { text: 'Genre: Thriller' },
      cast: { slot: true, branches: { flashback: null } },
      hints: { slot: true, branches: { '*': 'terse' } },
    },
  });

  test('a section excluded on a branch is dropped from that branch only', () => {
    expect(sectionsForBranch(component(), ['flashback']).map((s) => s.section.name))
      .toEqual(['genre', 'hints']);
    expect(sectionsForBranch(component(), ['present']).map((s) => s.section.name))
      .toEqual(['genre', 'cast', 'hints']);
  });

  test('the variant names the dispatch selected travel with the section', () => {
    const hints = sectionsForBranch(component(), ['present']).find((s) => s.section.name === 'hints');
    expect(hints.variants).toEqual(['terse']);
  });

  /**
   * §7.4's slot gating, which is the reason the no-output invariant is scoped by
   * consequence: dropping a whole slot on one branch is legitimate, and only becomes an
   * error when it would make some item vanish entirely.
   */
  test('slotsForBranch reports only the slots that survive the branch', () => {
    expect([...slotsForBranch(component(), ['flashback']).keys()]).toEqual(['hints']);
    expect([...slotsForBranch(component(), ['present']).keys()]).toEqual(['cast', 'hints']);
  });
});
