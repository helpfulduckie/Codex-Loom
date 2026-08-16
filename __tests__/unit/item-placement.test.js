'use strict';

/**
 * Placement resolution (v4 spec §7.2, §7.4) — step 3 of Phase 3.
 *
 * These are explicit-expectation tests rather than snapshots on purpose. A snapshot cannot
 * fail on its first run, so writing one is the moment its correctness is decided, and the
 * thing being decided here — which template a target picks, and what `storyCard` defaults
 * to — is exactly what a wrong first snapshot would freeze in place unchallenged.
 */

const { resolvePlacements, DEFAULT_ORDER, PLACEABLE_COMPONENTS } = require('../../src/model/item');

const pe = (item) => resolvePlacements(item).targets.find((t) => t.component === 'plotEssential');

describe('storyCard', () => {
  test('an item with no render block emits a story card and nothing else', () => {
    expect(resolvePlacements({ id: 'Aness' })).toEqual({ storyCard: true, targets: [] });
  });

  test('storyCard defaults to true when other render keys are present', () => {
    expect(resolvePlacements({ render: { template: 'Character' } }).storyCard).toBe(true);
  });

  test('storyCard: false is the only thing that suppresses a card', () => {
    expect(resolvePlacements({ render: { storyCard: false } }).storyCard).toBe(false);
  });

  test('a component target does not by itself suppress the card', () => {
    // The party hints in Coinflip Company depend on this: they render into Plot
    // Essentials *and* ship a full story card.
    const { storyCard, targets } = resolvePlacements({
      render: { plotEssential: { slot: 'party' } },
    });
    expect(storyCard).toBe(true);
    expect(targets).toHaveLength(1);
  });
});

describe('targets', () => {
  test('every §7.3 component that takes sections is placeable', () => {
    expect([...PLACEABLE_COMPONENTS]).toEqual([
      'plotEssential', 'summary', 'aiInstructions', 'authorsNote',
    ]);
  });

  test('an item may name several components at once', () => {
    const { targets } = resolvePlacements({
      render: { plotEssential: { slot: 'cast' }, summary: { slot: 'history' } },
    });
    expect(targets.map((t) => t.component)).toEqual(['plotEssential', 'summary']);
  });

  test('false and ~ are "not here" and produce no target', () => {
    expect(resolvePlacements({ render: { plotEssential: false } }).targets).toEqual([]);
    expect(resolvePlacements({ render: { plotEssential: null } }).targets).toEqual([]);
  });

  test('true names no slot and is carried through for step 7 to reject', () => {
    // The schema cannot express "boolean, but only false", so the unresolvable arm has to
    // survive as far as the place that reports on targets rather than being dropped here.
    expect(pe({ render: { plotEssential: true } })).toMatchObject({ slot: null });
  });

  test('a slot name that is not a non-empty string reads as no slot', () => {
    expect(pe({ render: { plotEssential: { slot: '' } } }).slot).toBeNull();
  });

  test('order defaults to 5 and is taken verbatim otherwise', () => {
    expect(pe({ render: { plotEssential: { slot: 'cast' } } }).order).toBe(DEFAULT_ORDER);
    expect(pe({ render: { plotEssential: { slot: 'cast', order: 0 } } }).order).toBe(0);
    expect(pe({ render: { plotEssential: { slot: 'cast', order: -1 } } }).order).toBe(-1);
  });
});

describe('the template ladder (§7.4)', () => {
  const item = (target) => ({
    aid: { type: 'Character' },
    render: { template: 'Mixed', plotEssential: { slot: 'you', ...target } },
  });

  test("the target's own template wins", () => {
    expect(pe(item({ template: 'Character.you' })).template).toBe('Character.you');
  });

  test('render.template is the second rung', () => {
    expect(pe(item({})).template).toBe('Mixed');
  });

  test('aid.type is the third rung', () => {
    expect(pe({ aid: { type: 'Character' }, render: { plotEssential: { slot: 'you' } } }).template)
      .toBe('Character');
  });

  test('a null template is the verbatim rung, not a missing answer', () => {
    // Nothing to render *through* is a legitimate state: a block written as prose passes
    // its own text along untouched.
    expect(pe({ render: { plotEssential: { slot: 'genre' } } }).template).toBeNull();
  });

  test('the ladder is per target, so two targets can differ', () => {
    const { targets } = resolvePlacements({
      render: {
        template: 'Character',
        plotEssential: { slot: 'cast', template: 'Character.hint' },
        summary: { slot: 'history' },
      },
    });
    expect(targets.map((t) => t.template)).toEqual(['Character.hint', 'Character']);
  });
});
