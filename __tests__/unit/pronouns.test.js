'use strict';

const {
  resolveProunounToken, applyTokenPass,
  getDisplayName, getFullName, applyCrossCardRefs, applyPronounPasses,
} = require('../../src/pronouns');

// ── resolveProunounToken ────────────────────────────────────────────────────

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
    test("she's → he's", () => expect(resolveProunounToken("she's", 'male')).toBe("he's"));
  });

  describe('they set (alias for nonbinary)', () => {
    test('she → they', () => expect(resolveProunounToken('she', 'they')).toBe('they'));
    test('her → them', () => expect(resolveProunounToken('her', 'they')).toBe('them'));
    test('her~ → their', () => expect(resolveProunounToken('her~', 'they')).toBe('their'));
    test('herself → themselves', () => expect(resolveProunounToken('herself', 'they')).toBe('themselves'));
    test("she's → they're", () => expect(resolveProunounToken("she's", 'they')).toBe("they're"));
  });

  describe('nonbinary set', () => {
    test('she → they', () => expect(resolveProunounToken('she', 'nonbinary')).toBe('they'));
    test('her → them', () => expect(resolveProunounToken('her', 'nonbinary')).toBe('them'));
    test('her~ → their', () => expect(resolveProunounToken('her~', 'nonbinary')).toBe('their'));
    test('herself → themselves', () => expect(resolveProunounToken('herself', 'nonbinary')).toBe('themselves'));
  });

  describe('you set', () => {
    test('she → you', () => expect(resolveProunounToken('she', 'you')).toBe('you'));
    test('her~ → your', () => expect(resolveProunounToken('her~', 'you')).toBe('your'));
    test('herself → yourself', () => expect(resolveProunounToken('herself', 'you')).toBe('yourself'));
    test("she's → you're", () => expect(resolveProunounToken("she's", 'you')).toBe("you're"));
  });

  describe('case preservation', () => {
    test('She (capital) with male → He', () => expect(resolveProunounToken('She', 'male')).toBe('He'));
    test('Her~ (capital) with they → Their', () => expect(resolveProunounToken('Her~', 'they')).toBe('Their'));
    test('SHE is not all-caps preserving, just first-char', () => {
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

// ── applyTokenPass ───────────────────────────────────────────────────────────

function makeCard(id, pronouns) {
  const display = id.charAt(0).toUpperCase() + id.slice(1);
  return { id, name: display, pronouns };
}

describe('applyTokenPass — unscoped pronoun tokens', () => {
  test('{$she} with female card → she', () => {
    const card = makeCard('hero', 'female');
    expect(applyTokenPass('{$she} walked in', { card, registry: new Map(), branchProtagonist: null }))
      .toBe('she walked in');
  });

  test('{$she} with male card → he', () => {
    const card = makeCard('hero', 'male');
    expect(applyTokenPass('{$she} smiled', { card, registry: new Map(), branchProtagonist: null }))
      .toBe('he smiled');
  });

  test('{$her~} with female → her (possessive)', () => {
    const card = makeCard('hero', 'female');
    expect(applyTokenPass('look at {$her~} face', { card, registry: new Map(), branchProtagonist: null }))
      .toBe('look at her face');
  });

  test('{$She} with male → He (case preserved)', () => {
    const card = makeCard('hero', 'male');
    expect(applyTokenPass('{$She} walked in', { card, registry: new Map(), branchProtagonist: null }))
      .toBe('He walked in');
  });

  test('{$her~} with you set → your', () => {
    const card = makeCard('hero', 'you');
    expect(applyTokenPass('{$her~} choice', { card, registry: new Map(), branchProtagonist: null }))
      .toBe('your choice');
  });

  test('multiple unscoped tokens in one string', () => {
    const card = makeCard('hero', 'female');
    expect(applyTokenPass('{$she} raised {$her~} hand', { card, registry: new Map(), branchProtagonist: null }))
      .toBe('she raised her hand');
  });

  test('unscoped tokens do not affect verb scope', () => {
    // {$she} (unscoped) followed by [s] — scope falls back to card.pronouns
    const card = makeCard('hero', 'female');
    expect(applyTokenPass('{$she} run[s]', { card, registry: new Map(), branchProtagonist: null }))
      .toBe('she runs');
  });
});

describe('applyTokenPass — character references {$Id}', () => {
  test('{$Id} → "you" when card is protagonist', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness} walked in', { card, registry, branchProtagonist: 'aness' }))
      .toBe('you walked in');
  });

  test('{$Id} → display name when not protagonist', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness} smiled', { card, registry, branchProtagonist: 'veyrn' }))
      .toBe('Aness smiled');
  });

  test('{$Id} sets conjugation scope — female', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness} love[s] it', { card, registry, branchProtagonist: null }))
      .toBe('Aness loves it');
  });

  test('{$Id} sets conjugation scope — protagonist (you, plural → drop [s])', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness} love[s] it', { card, registry, branchProtagonist: 'aness' }))
      .toBe('you love it');
  });

  test('[is] uses scope from last {$Id}', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness} [is] ready', { card, registry, branchProtagonist: null }))
      .toBe('Aness is ready');
  });

  test('[was] uses scope from last {$Id} — protagonist', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness} [was] there', { card, registry, branchProtagonist: 'aness' }))
      .toBe('you were there');
  });
});

describe('applyTokenPass — scoped pronoun tokens {$Id.pronoun}', () => {
  test('{$Id.she} → "you" when protagonist', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness.she} smiled', { card, registry, branchProtagonist: 'aness' }))
      .toBe('you smiled');
  });

  test('{$Id.she} → "she" when not protagonist', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness.she} smiled', { card, registry, branchProtagonist: 'veyrn' }))
      .toBe('she smiled');
  });

  test('{$Id.her~} → "your" when protagonist (possessive)', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness.her~} choice', { card, registry, branchProtagonist: 'aness' }))
      .toBe('your choice');
  });

  test('{$Id.she} sets conjugation scope', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    // scoped pronoun sets scope, so [s] conjugates correctly
    expect(applyTokenPass('{$Aness.she} love[s] it', { card, registry, branchProtagonist: null }))
      .toBe('she loves it');
  });

  test('{$Id.she} → "you" and scope is plural → [s] drops', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness.she} love[s] it', { card, registry, branchProtagonist: 'aness' }))
      .toBe('you love it');
  });
});

describe('applyTokenPass — verb conjugation markers', () => {
  function scopedStr(str, pronouns) {
    // Use card's own pronouns as scope via unscoped tokens feeding into [marker]
    const card = makeCard('hero', pronouns);
    return applyTokenPass(str, { card, registry: new Map(), branchProtagonist: null });
  }

  test('[s] → s for female (singular)', () => {
    expect(scopedStr('she love[s] it', 'female')).toBe('she loves it');
  });

  test('[s] → s for male (singular)', () => {
    expect(scopedStr('he like[s] it', 'male')).toBe('he likes it');
  });

  test('[s] → empty for they (plural)', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    // scope set by {$Aness} as protagonist (you/plural)
    expect(applyTokenPass('{$Aness} love[s] it', { card, registry, branchProtagonist: 'aness' }))
      .toBe('you love it');
  });

  test('[es] → es for female (singular)', () => {
    expect(scopedStr('she flinch[es]', 'female')).toBe('she flinches');
  });

  test('[is] → are for protagonist scope', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness} [is] ready', { card, registry, branchProtagonist: 'aness' }))
      .toBe('you are ready');
  });

  test('[was] → were for protagonist scope', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness} [was] here', { card, registry, branchProtagonist: 'aness' }))
      .toBe('you were here');
  });

  test('[has] → have for protagonist scope', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness} [has] arrived', { card, registry, branchProtagonist: 'aness' }))
      .toBe('you have arrived');
  });

  test('multiple conjugation markers in one string', () => {
    const card = makeCard('aness', 'female');
    const registry = new Map([['aness', card]]);
    expect(applyTokenPass('{$Aness} run[s] and jump[s]', { card, registry, branchProtagonist: null }))
      .toBe('Aness runs and jumps');
  });
});

describe('applyTokenPass — scope tracking across tokens', () => {
  test('scope resets with each new {$Id} reference', () => {
    const aness = makeCard('aness', 'female');
    const kaiden = makeCard('kaiden', 'male');
    const registry = new Map([['aness', aness], ['kaiden', kaiden]]);
    // First {$Aness} → female scope → [s] adds 's'; then {$Kaiden} → male → [s] adds 's'
    expect(applyTokenPass('{$Aness} love[s] it. {$Kaiden} like[s] it.', { card: aness, registry, branchProtagonist: null }))
      .toBe('Aness loves it. Kaiden likes it.');
  });

  test('scope from {$Id} carries into subsequent [s] markers', () => {
    const aness = makeCard('aness', 'female');
    const registry = new Map([['aness', aness]]);
    expect(applyTokenPass('{$Aness} run[s] and jump[s]', { card: aness, registry, branchProtagonist: null }))
      .toBe('Aness runs and jumps');
  });
});

// ── getDisplayName ────────────────────────────────────────────────────────────

describe('getDisplayName', () => {
  test('no name → falls back to card.id', () => {
    expect(getDisplayName({ id: 'hero' })).toBe('hero');
  });

  test('no name and no id → returns empty string', () => {
    expect(getDisplayName({})).toBe('');
  });

  test('string name → returns first whitespace-delimited word', () => {
    expect(getDisplayName({ name: 'Aria Voss' })).toBe('Aria');
  });

  test('single-word string name → returned as-is', () => {
    expect(getDisplayName({ name: 'Aria' })).toBe('Aria');
  });

  test('object name with display → returns display', () => {
    expect(getDisplayName({ name: { display: 'Aria', full: 'Aria Voss' } })).toBe('Aria');
  });

  test('object name without display → returns first value', () => {
    expect(getDisplayName({ name: { full: 'Elder Roshan' } })).toBe('Elder Roshan');
  });
});

// ── getFullName ───────────────────────────────────────────────────────────────

describe('getFullName', () => {
  test('no name → falls back to card.id', () => {
    expect(getFullName({ id: 'hero' })).toBe('hero');
  });

  test('no name and no id → returns empty string', () => {
    expect(getFullName({})).toBe('');
  });

  test('string name → returns full string unchanged', () => {
    expect(getFullName({ name: 'Aria Voss' })).toBe('Aria Voss');
  });

  test('object name with full → returns full', () => {
    expect(getFullName({ name: { full: 'Aria Voss', display: 'Aria' } })).toBe('Aria Voss');
  });

  test('object name without full, with display → returns display', () => {
    expect(getFullName({ name: { display: 'Aria' } })).toBe('Aria');
  });

  test('object name with neither full nor display → returns first value', () => {
    expect(getFullName({ name: { common: 'Elder' } })).toBe('Elder');
  });
});

// ── applyCrossCardRefs ────────────────────────────────────────────────────────

describe('applyCrossCardRefs', () => {
  test('resolves {$id.body.field} token in a card body string', () => {
    const cards = [
      { id: 'aria',   body: { Tagline: '{$mentor.body.Tagline}' } },
      { id: 'mentor', body: { Tagline: 'Archivist' } },
    ];
    applyCrossCardRefs(cards, new Map());
    expect(cards[0].body.Tagline).toBe('Archivist');
  });

  test('case-insensitive card ID lookup', () => {
    const cards = [
      { id: 'aria',   body: { Tagline: '{$Mentor.body.Tagline}' } },
      { id: 'mentor', body: { Tagline: 'Archivist' } },
    ];
    applyCrossCardRefs(cards, new Map());
    expect(cards[0].body.Tagline).toBe('Archivist');
  });

  test('case-insensitive field name lookup', () => {
    const cards = [
      { id: 'aria',   body: { Tagline: '{$mentor.body.tagline}' } },
      { id: 'mentor', body: { Tagline: 'Archivist' } },
    ];
    applyCrossCardRefs(cards, new Map());
    expect(cards[0].body.Tagline).toBe('Archivist');
  });

  test('dotted nested field path', () => {
    const cards = [
      { id: 'aria',   body: { Hair: '{$mentor.body.Traits.hair}' } },
      { id: 'mentor', body: { Traits: { hair: 'silver' } } },
    ];
    applyCrossCardRefs(cards, new Map());
    expect(cards[0].body.Hair).toBe('silver');
  });

  test('missing card → warns and leaves token as-is', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const cards = [{ id: 'aria', body: { Tagline: '{$nobody.body.Field}' } }];
    applyCrossCardRefs(cards, new Map());
    expect(cards[0].body.Tagline).toBe('{$nobody.body.Field}');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('missing field → leaves token as-is', () => {
    const cards = [
      { id: 'aria',   body: { Tagline: '{$mentor.body.Missing}' } },
      { id: 'mentor', body: { Tagline: 'Archivist' } },
    ];
    applyCrossCardRefs(cards, new Map());
    expect(cards[0].body.Tagline).toBe('{$mentor.body.Missing}');
  });

  test('resolves refs in nested body objects (recursive walk)', () => {
    const cards = [
      { id: 'aria',   body: { Traits: { hair: '{$mentor.body.Hair}' } } },
      { id: 'mentor', body: { Hair: 'white' } },
    ];
    applyCrossCardRefs(cards, new Map());
    expect(cards[0].body.Traits.hair).toBe('white');
  });

  test('resolves refs in body array items', () => {
    const cards = [
      { id: 'aria',   body: { Keywords: ['{$mentor.body.Title}', 'brave'] } },
      { id: 'mentor', body: { Title: 'Elder' } },
    ];
    applyCrossCardRefs(cards, new Map());
    expect(cards[0].body.Keywords[0]).toBe('Elder');
    expect(cards[0].body.Keywords[1]).toBe('brave');
  });

  test('falls back to registry when card not in resolved set', () => {
    const registryCard = { id: 'mentor', body: { Tagline: 'Sage' } };
    const registry = new Map([['mentor', registryCard]]);
    const cards = [{ id: 'aria', body: { Tagline: '{$mentor.body.Tagline}' } }];
    applyCrossCardRefs(cards, registry);
    expect(cards[0].body.Tagline).toBe('Sage');
  });
});

// ── applyTokenPass — {$Id.display} and {$Id.full} ────────────────────────────

describe('applyTokenPass — {$Id.display} and {$Id.full} tokens', () => {
  test('{$Id.display} → resolves to display name and does not set conjugation scope', () => {
    // aness has 'they' pronouns (plural). hero card is 'female' (singular).
    // If {$Aness.display} incorrectly set scope to 'they', [s] would drop (plural → '').
    // Correct: display does not set scope → [s] falls back to card (female, singular) → 's'.
    const aness = { id: 'aness', name: 'Aness', pronouns: 'they' };
    const hero = makeCard('hero', 'female');
    const registry = new Map([['aness', aness]]);
    expect(applyTokenPass('{$Aness.display} love[s]', { card: hero, registry, branchProtagonist: null }))
      .toBe('Aness loves');
  });

  test('{$Id.full} → resolves to full name and does not set conjugation scope', () => {
    const aness = { id: 'aness', name: { display: 'Aness', full: 'Aness Rozen' }, pronouns: 'they' };
    const hero = makeCard('hero', 'female');
    const registry = new Map([['aness', aness]]);
    expect(applyTokenPass('{$Aness.full} lead[s]', { card: hero, registry, branchProtagonist: null }))
      .toBe('Aness Rozen leads');
  });

  test('{$Id.display} → returns display name even when Id is protagonist (no "you" swap)', () => {
    const aness = makeCard('aness', 'female');
    const registry = new Map([['aness', aness]]);
    expect(applyTokenPass('{$Aness.display}', { card: aness, registry, branchProtagonist: 'aness' }))
      .toBe('Aness');
  });
});

// ── applyPronounPasses ────────────────────────────────────────────────────────

describe('applyPronounPasses', () => {
  test('no card.body → returns without error', () => {
    expect(() => applyPronounPasses({ id: 'hero' }, new Map(), null)).not.toThrow();
  });

  test('resolves {$token} in string body fields', () => {
    const card = { id: 'hero', pronouns: 'female', body: { Tagline: '{$she} fights' } };
    applyPronounPasses(card, new Map(), null);
    expect(card.body.Tagline).toBe('she fights');
  });

  test('walks nested body objects', () => {
    const card = { id: 'hero', pronouns: 'male', body: { Traits: { desc: '{$she} stands tall' } } };
    applyPronounPasses(card, new Map(), null);
    expect(card.body.Traits.desc).toBe('he stands tall');
  });

  test('processes string items in body arrays', () => {
    const card = {
      id: 'hero', pronouns: 'female',
      body: { Keywords: ['{$she} fights', 'brave'] },
    };
    applyPronounPasses(card, new Map(), null);
    expect(card.body.Keywords[0]).toBe('she fights');
    expect(card.body.Keywords[1]).toBe('brave');
  });

  test('mutates card.body in place', () => {
    const body = { Tagline: '{$she} leads' };
    const card = { id: 'hero', pronouns: 'female', body };
    applyPronounPasses(card, new Map(), null);
    expect(card.body).toBe(body);
    expect(body.Tagline).toBe('she leads');
  });
});
