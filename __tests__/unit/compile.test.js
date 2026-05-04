'use strict';

const { cardAppliesTo, getTemplate } = require('../../src/compile');

describe('cardAppliesTo', () => {
  test('no filter: always true', () => {
    expect(cardAppliesTo({}, ['any', 'path'])).toBe(true);
    expect(cardAppliesTo({}, ['subject'])).toBe(true);
  });

  test('only: exact match', () => {
    expect(cardAppliesTo({ only: 'subject' }, ['subject'])).toBe(true);
    expect(cardAppliesTo({ only: 'subject' }, ['researcher'])).toBe(false);
  });

  test('only: prefix match for deeper paths', () => {
    expect(cardAppliesTo({ only: 'subject' }, ['subject', 'A'])).toBe(true);
    expect(cardAppliesTo({ only: 'researcher' }, ['subject', 'A'])).toBe(false);
  });

  test('only: array of prefixes — any match passes', () => {
    expect(cardAppliesTo({ only: ['subject', 'felix'] }, ['felix'])).toBe(true);
    expect(cardAppliesTo({ only: ['subject', 'felix'] }, ['researcher'])).toBe(false);
  });

  test('except: excludes matching path', () => {
    expect(cardAppliesTo({ except: 'researcher' }, ['researcher'])).toBe(false);
    expect(cardAppliesTo({ except: 'researcher' }, ['subject'])).toBe(true);
  });

  test('except: prefix exclusion', () => {
    expect(cardAppliesTo({ except: 'A' }, ['A', 'X'])).toBe(false);
    expect(cardAppliesTo({ except: 'A' }, ['B', 'X'])).toBe(true);
  });

  test('case-insensitive prefix matching', () => {
    expect(cardAppliesTo({ only: 'Subject' }, ['subject'])).toBe(true);
    expect(cardAppliesTo({ except: 'RESEARCHER' }, ['researcher'])).toBe(false);
  });
});

describe('getTemplate', () => {
  const templates = new Map([
    ['character', { content: 'char template', _source: 'x' }],
    ['npc', { content: 'npc template', _source: 'y' }],
  ]);

  test('returns template by explicit template field', () => {
    expect(getTemplate({ template: 'npc', type: 'character' }, templates)).toBe('npc template');
  });

  test('falls back to type when template field absent', () => {
    expect(getTemplate({ type: 'Character' }, templates)).toBe('char template');
  });

  test('type lookup is case-insensitive', () => {
    expect(getTemplate({ type: 'CHARACTER' }, templates)).toBe('char template');
  });

  test('returns null when neither template nor type found', () => {
    expect(getTemplate({ type: 'Unknown' }, templates)).toBeNull();
  });

  test('returns null for card with no type or template', () => {
    expect(getTemplate({}, templates)).toBeNull();
  });
});
