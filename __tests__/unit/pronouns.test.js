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

  describe('verb_is role', () => {
    test('is → is for female', () => expect(resolveProunounToken('is', 'female')).toBe('is'));
    test('is → is for male', () => expect(resolveProunounToken('is', 'male')).toBe('is'));
    test('is → are for they', () => expect(resolveProunounToken('is', 'they')).toBe('are'));
    test('is → are for you', () => expect(resolveProunounToken('is', 'you')).toBe('are'));
    test('are → are for they', () => expect(resolveProunounToken('are', 'they')).toBe('are'));
    test('are → is for female', () => expect(resolveProunounToken('are', 'female')).toBe('is'));
    test('Is (capital) → Is for female', () => expect(resolveProunounToken('Is', 'female')).toBe('Is'));
    test('Is (capital) → Are for you', () => expect(resolveProunounToken('Is', 'you')).toBe('Are'));
  });

  describe('verb_was role', () => {
    test('was → was for female', () => expect(resolveProunounToken('was', 'female')).toBe('was'));
    test('was → was for male', () => expect(resolveProunounToken('was', 'male')).toBe('was'));
    test('was → were for they', () => expect(resolveProunounToken('was', 'they')).toBe('were'));
    test('was → were for you', () => expect(resolveProunounToken('was', 'you')).toBe('were'));
    test('were → were for they', () => expect(resolveProunounToken('were', 'they')).toBe('were'));
    test('were → was for female', () => expect(resolveProunounToken('were', 'female')).toBe('was'));
    test('Was (capital) → Was for female', () => expect(resolveProunounToken('Was', 'female')).toBe('Was'));
    test('Was (capital) → Were for you', () => expect(resolveProunounToken('Was', 'you')).toBe('Were'));
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

  test('[es] → es for female (singular)', () => {
    expect(processVerbConjugation('she flinch[es]', 'female')).toBe('she flinches');
  });

  test('[es] → empty for they (plural)', () => {
    expect(processVerbConjugation('they flinch[es]', 'they')).toBe('they flinch');
  });

  test('[es] → empty for you (plural)', () => {
    expect(processVerbConjugation('you flinch[es]', 'you')).toBe('you flinch');
  });

  test('mixed [es] and [s] in one string', () => {
    expect(processVerbConjugation('she flinch[es] and love[s] it', 'female')).toBe('she flinches and loves it');
  });

  test('mixed [es] and [s] stripped for plural', () => {
    expect(processVerbConjugation('you flinch[es] and love[s] it', 'you')).toBe('you flinch and love it');
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

  test('$is → "are" for active protagonist (you set)', () => {
    const card = { name: 'Aness', protagonist: 'aness', fields: {} };
    const ctx = { card, registry, branchProtagonist: 'aness' };
    expect(processBareMarkers('$is ready', ctx)).toBe('are ready');
  });

  test('$is → "is" when protagonist uses female pronouns and is not active', () => {
    const card = { name: 'Aness', protagonist: 'aness', fields: {} };
    const ctx = { card, registry, branchProtagonist: 'veyrn' };
    expect(processBareMarkers('$is ready', ctx)).toBe('is ready');
  });

  test('$Is (capital) → "Are" for active protagonist', () => {
    const card = { name: 'Aness', protagonist: 'aness', fields: {} };
    const ctx = { card, registry, branchProtagonist: 'aness' };
    expect(processBareMarkers('$Is ready', ctx)).toBe('Are ready');
  });

  test('$was → "were" for active protagonist (you set)', () => {
    const card = { name: 'Aness', protagonist: 'aness', fields: {} };
    const ctx = { card, registry, branchProtagonist: 'aness' };
    expect(processBareMarkers('$was there', ctx)).toBe('were there');
  });

  test('$was → "was" when protagonist uses female pronouns and is not active', () => {
    const card = { name: 'Aness', protagonist: 'aness', fields: {} };
    const ctx = { card, registry, branchProtagonist: 'veyrn' };
    expect(processBareMarkers('$was there', ctx)).toBe('was there');
  });

  test('$Was (capital) → "Were" for active protagonist', () => {
    const card = { name: 'Aness', protagonist: 'aness', fields: {} };
    const ctx = { card, registry, branchProtagonist: 'aness' };
    expect(processBareMarkers('$Was there', ctx)).toBe('Were there');
  });
});
