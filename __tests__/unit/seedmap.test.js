'use strict';

/**
 * Tests for the seed map's matching model.
 *
 * The seed map exists to answer "will this card ever be pulled into context", which is
 * a question about AID's trigger matching. So the matching semantics are the thing worth
 * pinning: substring, whitespace-sensitive, and — the defect these tests were written
 * for — stateless across candidates.
 */

const {
  buildSeedRelations, buildOpeningFlags, parseCardsFromMd,
} = require('../../src/seedmap');

const card = (title, triggers, body = '') => ({ title, triggers, body, type: 'Character' });

describe('trigger matching semantics', () => {
  test('a trigger matches inside a longer word', () => {
    const cards = [card('Cat', ['cat']), card('Disaster', [], 'a catastrophe struck')];
    expect(buildSeedRelations(cards).map((r) => r.seeder)).toEqual(['Disaster']);
  });

  test('a padded trigger does not match inside a longer word', () => {
    const cards = [card('Cat', ['cat ']), card('Disaster', [], 'a catastrophe struck')];
    expect(buildSeedRelations(cards)).toEqual([]);
  });

  test('a padded trigger matches where the padding is present', () => {
    const cards = [card('Cat', ['cat ']), card('Scene', [], 'the cat sat down')];
    expect(buildSeedRelations(cards).map((r) => r.seeder)).toEqual(['Scene']);
  });

  test('matching is case-insensitive', () => {
    const cards = [card('Cat', ['cat']), card('Scene', [], 'The CAT sat')];
    expect(buildSeedRelations(cards)).toHaveLength(1);
  });

  test('a card does not seed itself', () => {
    expect(buildSeedRelations([card('Cat', ['cat'], 'a cat here')])).toEqual([]);
  });

  test('regex metacharacters in a trigger are literal', () => {
    const cards = [card('Cmd', ['++']), card('Doc', [], 'type ++ to continue')];
    expect(buildSeedRelations(cards)).toHaveLength(1);
    expect(buildSeedRelations([card('Cmd', ['a.c']), card('Doc', [], 'abc')])).toEqual([]);
  });
});

describe('matching is stateless across candidates', () => {
  /**
   * The regression this file was added for: one regex is built per trigger and tested
   * against every other card in turn. With a `g` flag, `test` advances `lastIndex` on a
   * match, so the second body was searched from that offset and the third from wherever
   * that landed — real edges vanished depending on where the word fell in each string.
   */
  test('every body containing the trigger is reported, not every other one', () => {
    const cards = [
      card('Cat', ['cat']),
      card('A', [], 'a cat here'),
      card('B', [], 'a cat here'),
      card('C', [], 'a cat here'),
    ];
    expect(buildSeedRelations(cards).map((r) => r.seeder)).toEqual(['A', 'B', 'C']);
  });

  test('a match early in one body does not mask a later match in the next', () => {
    const cards = [
      card('Cat', ['cat']),
      card('Early', [], 'cat at the very start'),
      card('Late', [], 'a long stretch of unrelated text before the cat appears'),
    ];
    expect(buildSeedRelations(cards).map((r) => r.seeder)).toEqual(['Early', 'Late']);
  });

  test('Plot Essentials is still checked after a card match consumed the regex', () => {
    const cards = [card('Cat', ['cat']), card('A', [], 'a cat here')];
    const relations = buildSeedRelations(cards, 'the cat is mentioned in Plot Essentials');
    expect(relations.map((r) => r.source)).toEqual(['card', 'pe']);
  });

  test('opening flags are unaffected by an earlier trigger match', () => {
    const cards = [card('Cat', ['dog', 'cat']), card('Other', ['cat'])];
    expect([...buildOpeningFlags(cards, 'a cat in the opening')].sort()).toEqual(['Cat', 'Other']);
  });
});

describe('parseCardsFromMd', () => {
  const file = [
    '## Seedable', '~~~', 'triggers: [Aness]', '~~~', 'body one', '',
    '## NoTriggers', '~~~', 'triggers: []', '~~~', 'body two', '',
  ].join('\n');

  test('excludes cards with no triggers — they cannot be seeded', () => {
    expect(parseCardsFromMd(file).map((c) => c.title)).toEqual(['Seedable']);
  });

  test('carries the card type through', () => {
    expect(parseCardsFromMd(file, 'Character')[0].type).toBe('Character');
  });

  test('trigger values arrive YAML-parsed, without their quote characters', () => {
    const padded = '## A\n~~~\ntriggers: [" tea ", \'  meal \']\n~~~\nbody';
    expect(parseCardsFromMd(padded)[0].triggers).toEqual([' tea ', '  meal ']);
  });
});
