'use strict';

/**
 * The v3 Plot Essentials conversion (§7.2, §14.2) — the decisions, not the file surgery.
 *
 * Every case here is one the corpus exercises, because the acceptance test that compiles a
 * migrated `Loom/` tree can only report *that* output moved, never which rule got it wrong.
 * These name the rules so a failure points at one.
 */

const {
  readUnits,
  effectiveWrapper,
  baseTemplate,
  targetTemplate,
  buildItemLookup,
  groupIntoRuns,
  deriveSectionName,
  convertPlotEssentials,
} = require('../../src/migrate/plot-essentials');

/** A registry the lookup helpers accept: a Map of lowercased id to definition. */
const registryOf = (defs) => new Map(Object.entries(defs).map(([k, v]) => [k.toLowerCase(), v]));

const TEMPLATES = new Set(['character', 'character.hint', 'character.you', 'genresettingblock']);

// ── wrapper and template resolution ──────────────────────────────────────────

describe('what a block resolved to in v3', () => {
  test('a block with no wrapper inherits the item\'s own', () => {
    // Baseline's protagonist block declares no wrapper and ships curly, because canon
    // Aness declares curly. Reading the block alone would drop the braces.
    const registry = registryOf({ Aness: { render: { wrapper: 'curly' } } });
    const [unit] = readUnits([{ import: 'Aness' }]);
    expect(effectiveWrapper(unit.members[0], registry)).toBe('curly');
  });

  test('a declared wrapper wins over the item\'s', () => {
    const registry = registryOf({ Aness: { render: { wrapper: 'curly' } } });
    const [unit] = readUnits([{ import: 'Aness', render: { wrapper: 'square' } }]);
    expect(effectiveWrapper(unit.members[0], registry)).toBe('square');
  });

  test('the base template falls back through render.template then aid.type', () => {
    const registry = registryOf({
      Aness: { render: { template: 'Character' }, aid: { type: 'Ignored' } },
      Kaiden: { aid: { type: 'Character' } },
    });
    const [a, k] = readUnits([{ import: 'Aness' }, { import: 'Kaiden' }]);
    expect(baseTemplate(a.members[0], registry)).toBe('Character');
    expect(baseTemplate(k.members[0], registry)).toBe('Character');
  });
});

describe('style: and isPlayer: become a per-target template', () => {
  const registry = registryOf({ Kaiden: { render: { template: 'Character' } } });

  test('style: hint selects the .hint sibling', () => {
    const [unit] = readUnits([{ import: 'Kaiden', render: { style: 'hint' } }]);
    expect(targetTemplate(unit.members[0], registry, TEMPLATES, [])).toBe('Character.hint');
  });

  test('isPlayer selects the .you sibling', () => {
    const [unit] = readUnits([{ import: 'Kaiden', render: { isPlayer: true } }]);
    expect(targetTemplate(unit.members[0], registry, TEMPLATES, [])).toBe('Character.you');
  });

  test('a missing sibling is a no-op with a note, because that is what v3 did', () => {
    // v3 warned and fell back to the full template for a missing `.hint`, and `isPlayer`
    // was never a compiler key — it did something only where a template tested it. Turning
    // either into an error, or into a target naming a template that does not exist, would
    // change output rather than preserve it.
    const bare = registryOf({ Genre: { render: { template: 'genreSettingBlock' } } });
    const notes = [];
    const [unit] = readUnits([{ import: 'Genre', render: { isPlayer: true } }]);
    expect(targetTemplate(unit.members[0], bare, TEMPLATES, notes)).toBeNull();
    expect(notes[0]).toMatch(/no "genreSettingBlock.you.template" exists/);
  });
});

// ── the lookup ───────────────────────────────────────────────────────────────

describe('buildItemLookup', () => {
  test('a project import: layers its render over the canon item rather than colliding', () => {
    // `mergeRegistries` refuses an id in both canon and project, which is the shape every
    // `- import:` has — so the conversion cannot reuse it and needs the opposite rule.
    const canon = registryOf({ Kaiden: { render: { template: 'Character', wrapper: 'curly' } } });
    const lookup = buildItemLookup(canon, [{ import: 'Kaiden', render: { wrapper: 'square' } }]);
    expect(lookup.get('kaiden').render).toEqual({ template: 'Character', wrapper: 'square' });
  });

  test('include: entries are skipped — they name a file, not an item', () => {
    const lookup = buildItemLookup(new Map(), [{ include: '{%canon}/You.yaml' }]);
    expect(lookup.size).toBe(0);
  });
});

// ── run grouping ─────────────────────────────────────────────────────────────

describe('groupIntoRuns', () => {
  const wrapperOf = (unit) => unit.wrapper;

  test('adjacent blocks sharing a signature merge into one slot', () => {
    // Sound because sections join with the same blank line a wrap: each slot joins its
    // occupants with, so N single-occupant slots and one N-occupant slot are the same bytes.
    const units = readUnits([
      { import: 'A', render: { wrapper: 'square' } },
      { import: 'B', render: { wrapper: 'square' } },
      { import: 'C', render: { wrapper: 'square' } },
    ]);
    const runs = groupIntoRuns(units, wrapperOf);
    expect(runs).toHaveLength(1);
    expect(runs[0].units).toHaveLength(3);
  });

  test('a different wrapper starts a new slot', () => {
    const units = readUnits([
      { import: 'A', render: { wrapper: 'square' } },
      { import: 'B', render: { wrapper: 'curly' } },
    ]);
    expect(groupIntoRuns(units, wrapperOf)).toHaveLength(2);
  });

  test('position orders the runs, and document order breaks ties', () => {
    const units = readUnits([
      { import: 'late', render: { wrapper: 'square', position: 9 } },
      { import: 'early', render: { wrapper: 'curly', position: 1 } },
    ]);
    const runs = groupIntoRuns(units, wrapperOf);
    expect(runs.map((r) => r.units[0].members[0].id)).toEqual(['early', 'late']);
  });

  test('a blocks: group never merges with a neighbour, even an identical one', () => {
    // The group wraps its whole collection and a standalone block wraps itself, so merging
    // them would silently turn several bracketed blocks into one.
    const units = readUnits([
      { blocks: [{ import: 'A' }], render: { wrapper: 'curly' } },
      { import: 'B', render: { wrapper: 'curly' } },
    ]);
    expect(groupIntoRuns(units, wrapperOf)).toHaveLength(2);
  });
});

// ── naming ───────────────────────────────────────────────────────────────────

describe('deriveSectionName', () => {
  const nameOf = (blocks, taken = new Set()) => {
    const runs = groupIntoRuns(readUnits(blocks), (u) => u.wrapper);
    return deriveSectionName(runs[0], 0, taken);
  };

  test('a heading supplies the name, trimmed to two words', () => {
    expect(nameOf([{ blocks: [{ import: 'A' }], heading: "Coinflip Company — an adventurer's party" }]))
      .toBe('coinflip-company');
  });

  test('a lone occupant supplies its id', () => {
    expect(nameOf([{ import: 'genreBlock' }])).toBe('genreblock');
  });

  test('several occupants and no heading fall back to position', () => {
    expect(nameOf([{ import: 'A' }, { import: 'B' }])).toBe('section-1');
  });

  test('a collision is suffixed rather than silently overwriting a slot', () => {
    const taken = new Set(['genreblock']);
    expect(nameOf([{ import: 'genreBlock' }], taken)).toBe('genreblock-2');
  });
});

// ── the whole conversion ─────────────────────────────────────────────────────

describe('convertPlotEssentials', () => {
  const registry = registryOf({
    Kaiden: { render: { template: 'Character', wrapper: 'curly' } },
    Melli: { render: { template: 'Character', wrapper: 'curly' } },
  });

  test('a full-style import suppresses the story card; a hint does not', () => {
    // This is `emittedFullImportIds`, the side channel Phase 3 deleted. Getting it backwards
    // either drops every party card or ships a duplicate protagonist card.
    const { placements } = convertPlotEssentials([
      { import: 'Kaiden', render: { style: 'hint', wrapper: 'curly' } },
      { import: 'Melli', render: { wrapper: 'square' } },
    ], registry, TEMPLATES);
    const byId = Object.fromEntries(placements.map((p) => [p.block.id, p]));
    expect(byId.Kaiden.suppressStoryCard).toBe(false);
    expect(byId.Melli.suppressStoryCard).toBe(true);
  });

  test('style: skip drops the block entirely and says so', () => {
    const { placements, notes } = convertPlotEssentials(
      [{ import: 'Kaiden', render: { style: 'skip' } }], registry, TEMPLATES,
    );
    expect(placements).toHaveLength(0);
    expect(notes.some((n) => n.includes('style: skip'))).toBe(true);
  });

  test('a group becomes one wrap: all slot carrying the heading and compact', () => {
    const { sections } = convertPlotEssentials([{
      blocks: [{ import: 'Kaiden', render: { style: 'hint' } }],
      heading: 'Party',
      headingLevel: 0,
      render: { wrapper: 'curly', compact: true },
    }], registry, TEMPLATES);
    expect(sections.party).toEqual({
      slot: true,
      heading: 'Party',
      headingLevel: 0,
      render: { position: 1, wrapper: 'curly', wrap: 'all', compact: true },
    });
  });

  test('occupants are numbered within their slot, in document order', () => {
    // Document order is the only tiebreak a slot ever needs, because `position` is part of
    // the run signature — two blocks with different positions are two slots by construction,
    // so within one slot every occupant shares a position and the file decides.
    const { sections, placements } = convertPlotEssentials([
      { import: 'Melli', render: { wrapper: 'curly' } },
      { import: 'Kaiden', render: { wrapper: 'curly' } },
    ], registry, TEMPLATES);
    expect(Object.keys(sections)).toHaveLength(1);
    expect(placements.map((p) => [p.block.id, p.target.order])).toEqual([['Melli', 1], ['Kaiden', 2]]);
  });

  test('differing positions produce separate slots, each numbered from one', () => {
    const { sections, placements } = convertPlotEssentials([
      { import: 'Melli', render: { wrapper: 'curly', position: 2 } },
      { import: 'Kaiden', render: { wrapper: 'curly', position: 1 } },
    ], registry, TEMPLATES);
    expect(Object.keys(sections)).toHaveLength(2);
    // Kaiden's slot sorts first, because position ordered the runs.
    expect(Object.values(sections).map((s) => s.render.position)).toEqual([1, 2]);
    expect(placements.map((p) => [p.block.id, p.target.order])).toEqual([['Kaiden', 1], ['Melli', 1]]);
  });

  test('every derived slot name is reported, including the plausible-looking ones', () => {
    const { notes } = convertPlotEssentials(
      [{ blocks: [{ import: 'Kaiden' }], heading: 'Party', render: { wrapper: 'curly' } }],
      registry, TEMPLATES,
    );
    expect(notes.some((n) => n.includes('slot "party" was named by the migrator'))).toBe(true);
  });
});
