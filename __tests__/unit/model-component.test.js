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
  normalizeComponent, applySectionVariant, sectionsForBranch, slotsForBranch, WRAP, DEFAULT_POSITION,
  layerSectionDef, mergeSectionRecords, applySectionSelector,
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

describe('section variants (§7.2)', () => {
  const doc = (extra = {}) => normalizeComponent({
    sections: {
      genre: {
        text: 'Genre: Thriller',
        render: { position: 1 },
        branches: { terse: 'brief', missing: 'nope' },
        variants: {
          brief: { text: 'Genre: Noir', heading: 'Setting', render: { position: 9, bullet: true } },
        },
        ...extra,
      },
      cast: { slot: true, render: { position: 5 } },
    },
  });

  test('a dispatched variant replaces the section it names', () => {
    const genre = sectionsForBranch(doc(), ['terse']).find((s) => s.section.name === 'genre');
    expect(genre.section.text).toBe('Genre: Noir');
    expect(genre.section.heading).toBe('Setting');
    expect(genre.section.bullet).toBe(true);
  });

  test('a variant that moves a section re-sorts the output', () => {
    // `render.position: 9` on the variant has to move `genre` past `cast`, or the variant
    // is only half-applied — the flattened position would change and the order would not.
    expect(sectionsForBranch(doc(), ['terse']).map((s) => s.section.name)).toEqual(['cast', 'genre']);
    expect(sectionsForBranch(doc(), ['other']).map((s) => s.section.name)).toEqual(['genre', 'cast']);
  });

  test('applying a variant on one branch does not leak onto the next', () => {
    // The normalized document is shared by every leaf, so this is the property that makes
    // normalize-once-per-file safe rather than a cross-branch bleed waiting to happen.
    const shared = doc();
    sectionsForBranch(shared, ['terse']);
    const plain = sectionsForBranch(shared, ['other']).find((s) => s.section.name === 'genre');
    expect(plain.section.text).toBe('Genre: Thriller');
    expect(plain.section.heading).toBeNull();
  });

  test('a dispatch naming a variant the section does not define warns and changes nothing', () => {
    const seen = [];
    const genre = sectionsForBranch(doc(), ['missing'], (code, message) => seen.push({ code, message }))
      .find((s) => s.section.name === 'genre');
    expect(seen.map((w) => w.code)).toEqual([CODES.SECTION_VARIANT_NOT_FOUND]);
    expect(seen[0].message).toContain('nope');
    expect(genre.section.text).toBe('Genre: Thriller');
  });

  test('variant names match case-insensitively, as they do on items', () => {
    const withCaps = normalizeComponent({
      sections: {
        genre: { text: 'plain', branches: { x: 'Brief' }, variants: { brief: { text: 'variant' } } },
      },
    });
    expect(sectionsForBranch(withCaps, ['x'])[0].section.text).toBe('variant');
  });
});

describe('applySectionVariant text forms', () => {
  const base = () => normalizeComponent({
    sections: { rules: { text: { a: 'first', b: 'second' } } },
  }).sections[0];

  test('a string replaces the whole text', () => {
    expect(applySectionVariant(base(), { text: 'replaced' }).text).toBe('replaced');
  });

  test('null drops the text', () => {
    expect(applySectionVariant(base(), { text: null }).text).toBeNull();
  });

  test('a mapping edits one key and leaves the rest, so a variant need not restate them', () => {
    const out = applySectionVariant(base(), { text: { b: 'changed', c: 'added' } });
    expect(out.text).toEqual({ a: 'first', b: 'changed', c: 'added' });
  });

  test('a mapping key set to null deletes that line only', () => {
    expect(applySectionVariant(base(), { text: { a: null } }).text).toEqual({ b: 'second' });
  });

  test('a delta that is not a mapping is ignored rather than throwing', () => {
    const section = base();
    expect(applySectionVariant(section, 'nonsense')).toBe(section);
    expect(applySectionVariant(section, null)).toBe(section);
  });

  test('a string text is a field op, so §7.6.2\'s appending variant appends', () => {
    // `dark: {text: '+{ … }'}` is the spec's own worked example and used to install the
    // literal characters `+{ … }` as the section's whole text. One vocabulary across both
    // positions a section variant is reached from: branch dispatch here, import selector
    // through `applySectionSelector`.
    const section = { ...base(), text: 'Write with weight.' };
    expect(applySectionVariant(section, { text: '+{Do not soften outcomes.}' }).text)
      .toEqual(['Write with weight.', 'Do not soften outcomes.']);
  });

  test('a plain string still replaces, because that is what a non-op string does', () => {
    const section = { ...base(), text: 'Thriller' };
    expect(applySectionVariant(section, { text: 'Noir' }).text).toBe('Noir');
  });

  /**
   * Where literal text stops and an operation starts.
   *
   * Routing a string `text:` through `applyFieldOp` is the one place Phase 6 Step 1 changed
   * behavior that already shipped, and the input it changes is a variant whose text is
   * *entirely* `+{…}`, `-{…}` or `/{…}/{…}`. An author who meant those characters literally
   * now gets an append. Nothing can distinguish the two intents, so what is pinned here is
   * the boundary rather than the intent: the pattern is anchored at both ends, so anything
   * with content outside the braces is text and stays text.
   *
   * The unpinnable case is a whole-string `+{…}` meant literally. It has no test because it
   * has no distinguishing feature — it is recorded in the Phase 6 notes as the thing to look
   * for if a converted component's bytes move during Step 5.
   */
  describe('the operation boundary on a string text', () => {
    const withText = (text) => ({ ...base(), text });

    test('a leading +{ that does not close at the end is literal text', () => {
      expect(applySectionVariant(withText('A'), { text: '+{B} and more' }).text)
        .toBe('+{B} and more');
    });

    test('braces that do not open the string are literal text', () => {
      expect(applySectionVariant(withText('A'), { text: 'Rule: +{B}' }).text)
        .toBe('Rule: +{B}');
    });

    test('a bare brace pair with no operator is literal text', () => {
      expect(applySectionVariant(withText('A'), { text: '{B}' }).text).toBe('{B}');
    });

    test('a whole-string +{...} is an append, and this is the case with no escape', () => {
      // Anchored at both ends, so this is the exact shape an author cannot write literally.
      expect(applySectionVariant(withText('A'), { text: '+{B}' }).text).toEqual(['A', 'B']);
    });
  });
});

/**
 * The `imports:` merge (§7.6.3), tested on raw section definitions.
 *
 * Raw, because that is the level the merge runs at and the reason it does is the design:
 * one layering vocabulary applied per import, then `normalizeSection` once on the finished
 * section. The integration suite proves the chain reaches this code with the right record;
 * these prove the record comes out right.
 */
describe('layerSectionDef', () => {
  test('a plain string replaces the base text', () => {
    expect(layerSectionDef({ text: 'old' }, { text: 'new' }).text).toBe('new');
  });

  test('a field op edits the base text instead of replacing it', () => {
    // The whole reason the merge is raw: `+{}` has to mean here what it means in a variant
    // delta, and after normalization the op string is indistinguishable from literal text.
    // An append yields the two parts, which the emitter joins with a newline — the same
    // shape `applyFieldOp` produces on an item field, rather than a component-only rule.
    expect(layerSectionDef({ text: 'A' }, { text: '+{B}' }).text).toEqual(['A', 'B']);
    expect(layerSectionDef({ text: 'A B' }, { text: '/{B}/{C}' }).text).toBe('A C');
  });

  test('a mapping text edits one named line and leaves the rest', () => {
    const merged = layerSectionDef(
      { text: { pov: 'second person', tone: 'clinical' } },
      { text: { pov: '+{ always' + ' }', extra: 'new line' } },
    );
    expect(merged.text.tone).toBe('clinical');
    expect(merged.text.pov).toContain('second person');
    expect(merged.text.extra).toBe('new line');
  });

  test('a null text drops it', () => {
    expect(layerSectionDef({ text: 'A' }, { text: null }).text).toBeNull();
  });

  test('render: merges key by key, so a move keeps the wrapper', () => {
    const merged = layerSectionDef(
      { render: { position: 1, wrapper: 'square' } },
      { render: { position: 4 } },
    );
    expect(merged.render).toEqual({ position: 4, wrapper: 'square' });
  });

  test('variants: merge case-insensitively, base spelling winning', () => {
    // `variants:` is an open namespace, so `Dark` and `dark` both pass validation. Merging
    // by exact key leaves two entries, and `sectionsForBranch` resolves a dispatch with a
    // case-insensitive `find` that takes the first — the imported one. The project's
    // override would be discarded silently, which is the failure this pins.
    const merged = layerSectionDef(
      { variants: { Dark: { text: 'noir' } } },
      { variants: { dark: { text: 'darker' } } },
    );
    expect(Object.keys(merged.variants)).toEqual(['Dark']);
    expect(merged.variants.Dark).toEqual({ text: 'darker' });
  });

  test('variants: merge by name, so a local branches: can reach an imported variant', () => {
    // §7.6.2's worked example: the project supplies only a dispatch, and the variant it
    // names lives in the imported section. A replacing `variants:` would delete it.
    const merged = layerSectionDef(
      { variants: { dark: { text: 'noir' } } },
      { branches: { flashback: 'dark' }, variants: { warm: { text: 'gentle' } } },
    );
    expect(Object.keys(merged.variants).sort()).toEqual(['dark', 'warm']);
    expect(merged.branches).toEqual({ flashback: 'dark' });
  });

  test('a dispatch alone keeps the imported variants untouched', () => {
    const merged = layerSectionDef(
      { text: 'weighty', variants: { light: { text: 'airy' } } },
      { branches: { flashback: 'light' } },
    );
    expect(merged.variants.light).toEqual({ text: 'airy' });
    expect(merged.text).toBe('weighty');
  });

  test('branches: replaces rather than merging', () => {
    const merged = layerSectionDef({ branches: { a: 'x' } }, { branches: { b: 'y' } });
    expect(merged.branches).toEqual({ b: 'y' });
  });

  test('neither input is mutated, because an imported document is shared', () => {
    const base = { text: 'A', render: { position: 1 } };
    layerSectionDef(base, { text: '+{B}', render: { position: 9 } });
    expect(base).toEqual({ text: 'A', render: { position: 1 } });
  });
});

describe('mergeSectionRecords', () => {
  const base = () => ({
    genre: { text: 'Thriller' },
    cast: { slot: true },
  });

  test('an unmatched local name is appended after everything inherited', () => {
    const merged = mergeSectionRecords(base(), { institute: { text: 'Clinical.' } });
    expect(Object.keys(merged)).toEqual(['genre', 'cast', 'institute']);
  });

  test('a matched local name layers onto the inherited definition', () => {
    const merged = mergeSectionRecords(base(), { genre: { text: '+{Noir}' } });
    expect(merged.genre.text).toEqual(['Thriller', 'Noir']);
    expect(Object.keys(merged)).toEqual(['genre', 'cast']);
  });

  test('the base spelling wins on a case-insensitive match', () => {
    const merged = mergeSectionRecords(base(), { Genre: { text: 'Noir' } });
    expect(Object.keys(merged)).toEqual(['genre', 'cast']);
    expect(merged.genre.text).toBe('Noir');
  });

  test('~ deletes an inherited section and says nothing', () => {
    const { seen, onWarn } = collector();
    const merged = mergeSectionRecords(base(), { cast: null }, onWarn);
    expect(Object.keys(merged)).toEqual(['genre']);
    expect(seen).toEqual([]);
  });

  test('~ on a name nothing provided is CL0608', () => {
    const { codes: seenCodes, onWarn } = collector();
    mergeSectionRecords(base(), { nosuch: null }, onWarn);
    expect(seenCodes()).toEqual([CODES.IMPORT_DELETE_UNKNOWN]);
  });

  test('the base record is not mutated', () => {
    const original = base();
    mergeSectionRecords(original, { genre: { text: 'Noir' }, cast: null });
    expect(Object.keys(original)).toEqual(['genre', 'cast']);
    expect(original.genre.text).toBe('Thriller');
  });
});

describe('applySectionSelector', () => {
  const sections = () => ({
    genre: { text: 'Thriller', variants: { dark: { text: 'Noir' } } },
    house: { text: 'Quiet.' },
    cast: { slot: true },
  });

  test('applies to every section defining the name and counts them', () => {
    const applied = applySectionSelector(sections(), 'dark');
    expect(applied.matched).toBe(1);
    expect(applied.sections.genre.text).toBe('Noir');
  });

  test('leaves the sections that do not define it exactly as they were', () => {
    const applied = applySectionSelector(sections(), 'dark');
    expect(applied.sections.house).toEqual({ text: 'Quiet.' });
    expect(applied.sections.cast).toEqual({ slot: true });
  });

  test('matched is zero when no section defines the name, which is what CL0326 reads', () => {
    // The count is the entire safety mechanism behind arity-N silence: without it a
    // misspelled selector applies to nothing and reports nothing.
    expect(applySectionSelector(sections(), 'drak').matched).toBe(0);
  });

  test('the lookup is case-insensitive, like every other name in the language', () => {
    expect(applySectionSelector(sections(), 'DARK').matched).toBe(1);
  });
});
