'use strict';

const {
  resolveProunounToken,
  processBracedPronounTokens,
  processVerbConjugation,
  processBareMarkers,
} = require('../../src/pronouns');

describe('resolveProunounToken', () => {
  describe('female set', () => {
    test('she → she', () => expect(resolveProunounToken('she', 'female')).toBe('she'));
    test('her → her', () => expect(resolveProunounToken('her', 'female')).toBe('her'));
    test('her~ → her', () => expect(resolveProunounToken('her~', 'female')).toBe('her'));
    test('herself → herself', () => expect(resolveProunounToken('herself', 'female')).toBe('herself'));
    test("she's → she's", () => expect(resolveProunounToken("she's", 'female')).toBe("she's"));
  });

  describe('male set', () => {
    test('she → he', () => expect(resolveProunounToken('she', 'male')).toBe('he'));
    test('her → him', () => expect(resolveProunounToken('her', 'male')).toBe('him'));
    test('her~ → his', () => expect(resolveProunounToken('her~', 'male')).toBe('his'));
    test('herself → himself', () => expect(resolveProunounToken('herself', 'male')).toBe('himself'));
  });

  describe('they set', () => {
    test('she → they', () => expect(resolveProunounToken('she', 'they')).toBe('they'));
    test('her → them', () => expect(resolveProunounToken('her', 'they')).toBe('them'));
    test('her~ → their', () => expect(resolveProunounToken('her~', 'they')).toBe('their'));
    test('herself → themselves', () => expect(resolveProunounToken('herself', 'they')).toBe('themselves'));
  });

  describe('you set', () => {
    test('she → you', () => expect(resolveProunounToken('she', 'you')).toBe('you'));
    test('her~ → your', () => expect(resolveProunounToken('her~', 'you')).toBe('your'));
    test('herself → yourself', () => expect(resolveProunounToken('herself', 'you')).toBe('yourself'));
  });

  describe('case preservation', () => {
    test('She (capital) with male → He', () => expect(resolveProunounToken('She', 'male')).toBe('He'));
    test('Her~ (capital) with they → Their', () => expect(resolveProunounToken('Her~', 'they')).toBe('Their'));
    test('SHE is not all-caps preserving, just first-char', () => {
      // Current impl only preserves leading capital, not all-caps
      const result = resolveProunounToken('SHE', 'male');
      expect(result[0]).toBe(result[0].toUpperCase());
    });
  });

  describe('unknown set fallback', () => {
    test('returns bare word for unknown set', () => {
      expect(resolveProunounToken('she', 'unknown')).toBe('she');
    });
    test('strips ~ for unknown set', () => {
      expect(resolveProunounToken('her~', null)).toBe('her');
    });
  });
});

describe('processBracedPronounTokens', () => {
  test('replaces {$her~} with possessive for female', () => {
    expect(processBracedPronounTokens('look at {$her~} face', 'female')).toBe('look at her face');
  });

  test('replaces {$She} with capitalized male subject', () => {
    expect(processBracedPronounTokens('{$She} walked in', 'male')).toBe('He walked in');
  });

  test('leaves non-pronoun braced tokens unchanged', () => {
    expect(processBracedPronounTokens('{$fields.something}', 'female')).toBe('{$fields.something}');
  });

  test('replaces multiple tokens in one string', () => {
    const result = processBracedPronounTokens('{$she} raised {$her~} hand', 'female');
    expect(result).toBe('she raised her hand');
  });

  test('you set: {$her~} → your', () => {
    expect(processBracedPronounTokens('{$her~} choice', 'you')).toBe('your choice');
  });
});

describe('processVerbConjugation', () => {
  test('[s] → s for female (singular)', () => {
    expect(processVerbConjugation('she love[s] it', 'female')).toBe('she loves it');
  });

  test('[s] → s for male (singular)', () => {
    expect(processVerbConjugation('he like[s] it', 'male')).toBe('he likes it');
  });

  test('[s] → empty for they (plural)', () => {
    expect(processVerbConjugation('they love[s] it', 'they')).toBe('they love it');
  });

  test('[s] → empty for you (plural)', () => {
    expect(processVerbConjugation('you love[s] this', 'you')).toBe('you love this');
  });

  test('multiple [s] markers in one string', () => {
    expect(processVerbConjugation('she run[s] and jump[s]', 'female')).toBe('she runs and jumps');
  });
});

describe('processBareMarkers', () => {
  const heroCard = { id: 'aness', name: 'Aness', pronouns: 'female', protagonist: 'aness', fields: {} };
  const registry = new Map([['aness', heroCard]]);

  test('$CharacterId → "you" when card is active protagonist', () => {
    const ctx = { card: heroCard, registry, branchProtagonist: 'aness' };
    expect(processBareMarkers('$Aness walked in', ctx)).toBe('you walked in');
  });

  test('$CharacterId → name when not active protagonist', () => {
    const ctx = { card: heroCard, registry, branchProtagonist: 'veyrn' };
    expect(processBareMarkers('$Aness smiled', ctx)).toBe('Aness smiled');
  });

  test('pronoun token $she → "you" for active protagonist', () => {
    const card = { name: 'Aness', protagonist: 'aness', fields: {} };
    const ctx = { card, registry, branchProtagonist: 'aness' };
    expect(processBareMarkers('$she knows', ctx)).toBe('you knows');
  });

  test('pronoun token $she → female pronoun when protagonist is different', () => {
    const card = { name: 'Aness', protagonist: 'aness', fields: {} };
    const ctx = { card, registry, branchProtagonist: 'veyrn' };
    expect(processBareMarkers('$she knows', ctx)).toBe('she knows');
  });

  test('$her~ → "your" for active protagonist', () => {
    const card = { name: 'Aness', protagonist: 'aness', fields: {} };
    const ctx = { card, registry, branchProtagonist: 'aness' };
    expect(processBareMarkers('$her~ choice', ctx)).toBe('your choice');
  });
});
