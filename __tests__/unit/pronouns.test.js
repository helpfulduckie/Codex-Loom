'use strict';

const {
  resolveProunounToken, applyTokenPass,
  getDisplayName, getFullName, applyRolePass, applyCrossItemRefs, applyPronounPasses,
} = require('../../src/model/pronouns');

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

function makeItem(id, pronouns) {
  const display = id.charAt(0).toUpperCase() + id.slice(1);
  return { id, name: display, pronouns };
}

describe('applyTokenPass — unscoped pronoun tokens', () => {
  test('{$she} with female item → she', () => {
    const item = makeItem('hero', 'female');
    expect(applyTokenPass('{$she} walked in', { item, registry: new Map(), branchProtagonist: null }))
      .toBe('she walked in');
  });

  test('{$she} with male item → he', () => {
    const item = makeItem('hero', 'male');
    expect(applyTokenPass('{$she} smiled', { item, registry: new Map(), branchProtagonist: null }))
      .toBe('he smiled');
  });

  test('{$her~} with female → her (possessive)', () => {
    const item = makeItem('hero', 'female');
    expect(applyTokenPass('look at {$her~} face', { item, registry: new Map(), branchProtagonist: null }))
      .toBe('look at her face');
  });

  test('{$She} with male → He (case preserved)', () => {
    const item = makeItem('hero', 'male');
    expect(applyTokenPass('{$She} walked in', { item, registry: new Map(), branchProtagonist: null }))
      .toBe('He walked in');
  });

  test('{$her~} with you set → your', () => {
    const item = makeItem('hero', 'you');
    expect(applyTokenPass('{$her~} choice', { item, registry: new Map(), branchProtagonist: null }))
      .toBe('your choice');
  });

  test('multiple unscoped tokens in one string', () => {
    const item = makeItem('hero', 'female');
    expect(applyTokenPass('{$she} raised {$her~} hand', { item, registry: new Map(), branchProtagonist: null }))
      .toBe('she raised her hand');
  });

  test('unscoped tokens do not affect verb scope', () => {
    // {$she} (unscoped) followed by [s] — scope falls back to item.pronouns
    const item = makeItem('hero', 'female');
    expect(applyTokenPass('{$she} run[s]', { item, registry: new Map(), branchProtagonist: null }))
      .toBe('she runs');
  });
});

describe('applyTokenPass — character references {$Id}', () => {
  test('{$Id} → "you" when item is protagonist', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness} walked in', { item, registry, branchProtagonist: 'aness' }))
      .toBe('you walked in');
  });

  test('{$Id} → display name when not protagonist', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness} smiled', { item, registry, branchProtagonist: 'veyrn' }))
      .toBe('Aness smiled');
  });

  test('{$Id} sets conjugation scope — female', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness} love[s] it', { item, registry, branchProtagonist: null }))
      .toBe('Aness loves it');
  });

  test('{$Id} sets conjugation scope — protagonist (you, plural → drop [s])', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness} love[s] it', { item, registry, branchProtagonist: 'aness' }))
      .toBe('you love it');
  });

  test('[is] uses scope from last {$Id}', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness} [is] ready', { item, registry, branchProtagonist: null }))
      .toBe('Aness is ready');
  });

  test('[was] uses scope from last {$Id} — protagonist', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness} [was] there', { item, registry, branchProtagonist: 'aness' }))
      .toBe('you were there');
  });
});

describe("applyTokenPass — possessive character reference {$Id's}", () => {
  test("{$Aness's} → \"Aness's\" when not protagonist", () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass("It was {$Aness's} choice", { item, registry, branchProtagonist: null }))
      .toBe("It was Aness's choice");
  });

  test("{$aness's} → \"your\" when protagonist (lowercase token → lowercase your)", () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass("It was {$aness's} choice", { item, registry, branchProtagonist: 'aness' }))
      .toBe("It was your choice");
  });

  test("{$aness's} (lowercase token) → \"Aness's\" — name always uses YAML casing", () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass("{$aness's} voice", { item, registry, branchProtagonist: null }))
      .toBe("Aness's voice");
  });

  test("{$Aness's} uppercase token → \"Your\" when protagonist", () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass("{$Aness's} choice", { item, registry, branchProtagonist: 'aness' }))
      .toBe("Your choice");
  });

  test("{$aness's} lowercase token → \"your\" when protagonist", () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass("{$aness's} choice", { item, registry, branchProtagonist: 'aness' }))
      .toBe("your choice");
  });

  test("{$Marcus's} — name ending in s gets 's appended", () => {
    const item = { id: 'marcus', name: 'Marcus', pronouns: 'male' };
    const registry = new Map([['marcus', item]]);
    expect(applyTokenPass("{$Marcus's} sword", { item, registry, branchProtagonist: null }))
      .toBe("Marcus's sword");
  });

  test("{$nobody's} — unknown id left as-is", () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass("{$nobody's} hat", { item, registry, branchProtagonist: null }))
      .toBe("{$nobody's} hat");
  });
});

describe('applyTokenPass — scoped pronoun tokens {$Id.pronoun}', () => {
  test('{$Id.she} → "you" when protagonist', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness.she} smiled', { item, registry, branchProtagonist: 'aness' }))
      .toBe('you smiled');
  });

  test('{$Id.she} → "she" when not protagonist', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness.she} smiled', { item, registry, branchProtagonist: 'veyrn' }))
      .toBe('she smiled');
  });

  test('{$Id.her~} → "your" when protagonist (possessive)', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness.her~} choice', { item, registry, branchProtagonist: 'aness' }))
      .toBe('your choice');
  });

  test('{$Id.she} sets conjugation scope', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    // scoped pronoun sets scope, so [s] conjugates correctly
    expect(applyTokenPass('{$Aness.she} love[s] it', { item, registry, branchProtagonist: null }))
      .toBe('she loves it');
  });

  test('{$Id.she} → "you" and scope is plural → [s] drops', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness.she} love[s] it', { item, registry, branchProtagonist: 'aness' }))
      .toBe('you love it');
  });
});

describe('applyTokenPass — verb conjugation markers', () => {
  function scopedStr(str, pronouns) {
    // Use item's own pronouns as scope via unscoped tokens feeding into [marker]
    const item = makeItem('hero', pronouns);
    return applyTokenPass(str, { item, registry: new Map(), branchProtagonist: null });
  }

  test('[s] → s for female (singular)', () => {
    expect(scopedStr('she love[s] it', 'female')).toBe('she loves it');
  });

  test('[s] → s for male (singular)', () => {
    expect(scopedStr('he like[s] it', 'male')).toBe('he likes it');
  });

  test('[s] → empty for they (plural)', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    // scope set by {$Aness} as protagonist (you/plural)
    expect(applyTokenPass('{$Aness} love[s] it', { item, registry, branchProtagonist: 'aness' }))
      .toBe('you love it');
  });

  test('[es] → es for female (singular)', () => {
    expect(scopedStr('she flinch[es]', 'female')).toBe('she flinches');
  });

  test('[is] → are for protagonist scope', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness} [is] ready', { item, registry, branchProtagonist: 'aness' }))
      .toBe('you are ready');
  });

  test('[was] → were for protagonist scope', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness} [was] here', { item, registry, branchProtagonist: 'aness' }))
      .toBe('you were here');
  });

  test('[has] → have for protagonist scope', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness} [has] arrived', { item, registry, branchProtagonist: 'aness' }))
      .toBe('you have arrived');
  });

  test('multiple conjugation markers in one string', () => {
    const item = makeItem('aness', 'female');
    const registry = new Map([['aness', item]]);
    expect(applyTokenPass('{$Aness} run[s] and jump[s]', { item, registry, branchProtagonist: null }))
      .toBe('Aness runs and jumps');
  });
});

describe('applyTokenPass — scope tracking across tokens', () => {
  test('scope resets with each new {$Id} reference', () => {
    const aness = makeItem('aness', 'female');
    const kaiden = makeItem('kaiden', 'male');
    const registry = new Map([['aness', aness], ['kaiden', kaiden]]);
    // First {$Aness} → female scope → [s] adds 's'; then {$Kaiden} → male → [s] adds 's'
    expect(applyTokenPass('{$Aness} love[s] it. {$Kaiden} like[s] it.', { item: aness, registry, branchProtagonist: null }))
      .toBe('Aness loves it. Kaiden likes it.');
  });

  test('scope from {$Id} carries into subsequent [s] markers', () => {
    const aness = makeItem('aness', 'female');
    const registry = new Map([['aness', aness]]);
    expect(applyTokenPass('{$Aness} run[s] and jump[s]', { item: aness, registry, branchProtagonist: null }))
      .toBe('Aness runs and jumps');
  });
});

describe('applyTokenPass — bare {$Id} name conjugates singular regardless of pronouns', () => {
  // A rendered proper name takes a third-person-singular verb. The verb marker fires on
  // the name as readily as on a pronoun, so a they/them NPC referenced as {$Zephon} must
  // still read "Zephon answers", not "Zephon answer".
  const zephon = makeItem('zephon', 'they');
  const registry = new Map([['zephon', zephon]]);

  test('{$Id} + [s] → singular for a they/them NPC', () => {
    expect(applyTokenPass('{$Zephon} answer[s]', { item: zephon, registry, branchProtagonist: null }))
      .toBe('Zephon answers');
  });

  test('{$Id} + [es] → singular for a they/them NPC', () => {
    expect(applyTokenPass('{$Zephon} rush[es] in', { item: zephon, registry, branchProtagonist: null }))
      .toBe('Zephon rushes in');
  });

  test('{$Id} + [is]/[was]/[has] → singular for a they/them NPC', () => {
    expect(applyTokenPass('{$Zephon} [is] here, {$Zephon} [was] late, {$Zephon} [has] left', { item: zephon, registry, branchProtagonist: null }))
      .toBe('Zephon is here, Zephon was late, Zephon has left');
  });

  test('name sets singular scope, then {$Id.they} flips it to plural in the same string', () => {
    expect(applyTokenPass('{$Zephon} answer[s] the question {$Zephon.they} wish[es] had been asked', { item: zephon, registry, branchProtagonist: null }))
      .toBe('Zephon answers the question they wish had been asked');
  });

  test('protagonist they/them still conjugates plural via the "you" swap', () => {
    expect(applyTokenPass('{$Zephon} answer[s]', { item: zephon, registry, branchProtagonist: 'zephon' }))
      .toBe('you answer');
  });
});

// ── getDisplayName ────────────────────────────────────────────────────────────

describe('getDisplayName', () => {
  test('no name → falls back to item.id', () => {
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
  test('no name → falls back to item.id', () => {
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

// ── applyCrossItemRefs ────────────────────────────────────────────────────────

describe('applyCrossItemRefs', () => {
  test('resolves {$id.body.field} token in an item body string', () => {
    const items = [
      { id: 'aria',   body: { Tagline: '{$mentor.body.Tagline}' } },
      { id: 'mentor', body: { Tagline: 'Archivist' } },
    ];
    applyCrossItemRefs(items, new Map());
    expect(items[0].body.Tagline).toBe('Archivist');
  });

  test('case-insensitive item ID lookup', () => {
    const items = [
      { id: 'aria',   body: { Tagline: '{$Mentor.body.Tagline}' } },
      { id: 'mentor', body: { Tagline: 'Archivist' } },
    ];
    applyCrossItemRefs(items, new Map());
    expect(items[0].body.Tagline).toBe('Archivist');
  });

  test('case-insensitive field name lookup', () => {
    const items = [
      { id: 'aria',   body: { Tagline: '{$mentor.body.tagline}' } },
      { id: 'mentor', body: { Tagline: 'Archivist' } },
    ];
    applyCrossItemRefs(items, new Map());
    expect(items[0].body.Tagline).toBe('Archivist');
  });

  test('dotted nested field path', () => {
    const items = [
      { id: 'aria',   body: { Hair: '{$mentor.body.Traits.hair}' } },
      { id: 'mentor', body: { Traits: { hair: 'silver' } } },
    ];
    applyCrossItemRefs(items, new Map());
    expect(items[0].body.Hair).toBe('silver');
  });

  test('missing item → warns and leaves token as-is', () => {
    // model/ is pure (§3.3): it reports through the caller's onWarn rather than printing.
    const onWarn = jest.fn();
    const items = [{ id: 'aria', body: { Tagline: '{$nobody.body.Field}' } }];
    applyCrossItemRefs(items, new Map(), onWarn);
    expect(items[0].body.Tagline).toBe('{$nobody.body.Field}');
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('item not found'));
  });

  test('missing field → leaves token as-is', () => {
    const items = [
      { id: 'aria',   body: { Tagline: '{$mentor.body.Missing}' } },
      { id: 'mentor', body: { Tagline: 'Archivist' } },
    ];
    applyCrossItemRefs(items, new Map());
    expect(items[0].body.Tagline).toBe('{$mentor.body.Missing}');
  });

  test('resolves refs in nested body objects (recursive walk)', () => {
    const items = [
      { id: 'aria',   body: { Traits: { hair: '{$mentor.body.Hair}' } } },
      { id: 'mentor', body: { Hair: 'white' } },
    ];
    applyCrossItemRefs(items, new Map());
    expect(items[0].body.Traits.hair).toBe('white');
  });

  test('resolves refs in body array items', () => {
    const items = [
      { id: 'aria',   body: { Keywords: ['{$mentor.body.Title}', 'brave'] } },
      { id: 'mentor', body: { Title: 'Elder' } },
    ];
    applyCrossItemRefs(items, new Map());
    expect(items[0].body.Keywords[0]).toBe('Elder');
    expect(items[0].body.Keywords[1]).toBe('brave');
  });

  test('resolves {$Id.body.field} inside an aid field (coverage parity)', () => {
    const items = [
      { id: 'aria',   aid: { title: '{$mentor.body.Tagline}' }, body: {} },
      { id: 'mentor', body: { Tagline: 'Archivist' } },
    ];
    applyCrossItemRefs(items, new Map());
    expect(items[0].aid.title).toBe('Archivist');
  });

  test('falls back to registry when item not in resolved set', () => {
    const registryItem = { id: 'mentor', body: { Tagline: 'Sage' } };
    const registry = new Map([['mentor', registryItem]]);
    const items = [{ id: 'aria', body: { Tagline: '{$mentor.body.Tagline}' } }];
    applyCrossItemRefs(items, registry);
    expect(items[0].body.Tagline).toBe('Sage');
  });
});

// ── applyRolePass ────────────────────────────────────────────────────────────

describe('applyRolePass', () => {
  const registry = new Map([['kaiden', { id: 'kaiden' }]]);
  const opts = (extra) => ({ registry, roles: { LI: 'Kaiden' }, resolvedById: registry, ...extra });

  // The rewrite substitutes the binding target verbatim (`resolveRole` returns `roles[key]`
  // as authored); downstream lookups are case-insensitive, so casing here does not matter.
  test('rewrites the leading role name in every {$…} form, in place', () => {
    const items = [{
      id: 'ree',
      body: {
        A: '{$LI}', B: "{$LI's}", C: '{$LI.he}', D: '{$LI.body.Tagline}',
      },
    }];
    applyRolePass(items, opts());
    expect(items[0].body).toEqual({
      A: '{$Kaiden}', B: "{$Kaiden's}", C: '{$Kaiden.he}', D: '{$Kaiden.body.Tagline}',
    });
  });

  test('leaves an unknown name and a bare pronoun token untouched', () => {
    const items = [{ id: 'ree', body: { B: '{$Nobody}', C: '{$she}' } }];
    applyRolePass(items, opts());
    expect(items[0].body).toEqual({ B: '{$Nobody}', C: '{$she}' });
  });

  test('calls onRoleUsed for a role reached only through a {$Role.body.X} ref', () => {
    const onRoleUsed = jest.fn();
    const items = [{ id: 'ree', body: { Tagline: '{$LI.body.Tagline}' } }];
    applyRolePass(items, opts({ onRoleUsed }));
    expect(onRoleUsed).toHaveBeenCalledWith('LI');
  });

  test('no-op when no roles are in scope', () => {
    const items = [{ id: 'ree', body: { Tagline: '{$LI.body.Tagline}' } }];
    applyRolePass(items, { registry, roles: {}, resolvedById: registry });
    expect(items[0].body.Tagline).toBe('{$LI.body.Tagline}');
  });
});

// ── applyTokenPass — {$Id.display} and {$Id.full} ────────────────────────────

describe('applyTokenPass — {$Id.display} and {$Id.full} tokens', () => {
  test('{$Id.display} → resolves to display name and does not set conjugation scope', () => {
    // aness has 'they' pronouns (plural). hero item is 'female' (singular).
    // If {$Aness.display} incorrectly set scope to 'they', [s] would drop (plural → '').
    // Correct: display does not set scope → [s] falls back to item (female, singular) → 's'.
    const aness = { id: 'aness', name: 'Aness', pronouns: 'they' };
    const hero = makeItem('hero', 'female');
    const registry = new Map([['aness', aness]]);
    expect(applyTokenPass('{$Aness.display} love[s]', { item: hero, registry, branchProtagonist: null }))
      .toBe('Aness loves');
  });

  test('{$Id.full} → resolves to full name and does not set conjugation scope', () => {
    const aness = { id: 'aness', name: { display: 'Aness', full: 'Aness Rozen' }, pronouns: 'they' };
    const hero = makeItem('hero', 'female');
    const registry = new Map([['aness', aness]]);
    expect(applyTokenPass('{$Aness.full} lead[s]', { item: hero, registry, branchProtagonist: null }))
      .toBe('Aness Rozen leads');
  });

  test('{$Id.display} → returns display name even when Id is protagonist (no "you" swap)', () => {
    const aness = makeItem('aness', 'female');
    const registry = new Map([['aness', aness]]);
    expect(applyTokenPass('{$Aness.display}', { item: aness, registry, branchProtagonist: 'aness' }))
      .toBe('Aness');
  });
});

// ── applyPronounPasses ────────────────────────────────────────────────────────

describe('applyPronounPasses', () => {
  test('no item.body → returns without error', () => {
    expect(() => applyPronounPasses({ id: 'hero' }, new Map(), null)).not.toThrow();
  });

  test('resolves {$token} in string body fields', () => {
    const item = { id: 'hero', pronouns: 'female', body: { Tagline: '{$she} fights' } };
    applyPronounPasses(item, new Map(), null);
    expect(item.body.Tagline).toBe('she fights');
  });

  test('walks nested body objects', () => {
    const item = { id: 'hero', pronouns: 'male', body: { Traits: { desc: '{$she} stands tall' } } };
    applyPronounPasses(item, new Map(), null);
    expect(item.body.Traits.desc).toBe('he stands tall');
  });

  test('processes string items in body arrays', () => {
    const item = {
      id: 'hero', pronouns: 'female',
      body: { Keywords: ['{$she} fights', 'brave'] },
    };
    applyPronounPasses(item, new Map(), null);
    expect(item.body.Keywords[0]).toBe('she fights');
    expect(item.body.Keywords[1]).toBe('brave');
  });

  test('mutates item.body in place', () => {
    const body = { Tagline: '{$she} leads' };
    const item = { id: 'hero', pronouns: 'female', body };
    applyPronounPasses(item, new Map(), null);
    expect(item.body).toBe(body);
    expect(body.Tagline).toBe('she leads');
  });

  // Coverage parity: pronoun/character refs now resolve in aid and render too.
  test('resolves {$token} in aid.title and aid.triggers', () => {
    const item = {
      id: 'hero', pronouns: 'female',
      aid: { title: '{$she} the Bold', triggers: ['{$she}', 'Hero'] },
      body: {},
    };
    applyPronounPasses(item, new Map(), null);
    expect(item.aid.title).toBe('she the Bold');
    expect(item.aid.triggers).toEqual(['she', 'Hero']);
  });

  test('resolves {$Id} character ref in an aid field', () => {
    const registry = new Map([['mentor', { id: 'mentor', name: { display: 'Roshan' } }]]);
    const item = { id: 'hero', aid: { title: "{$Mentor}'s student" }, body: {} };
    applyPronounPasses(item, registry, null);
    expect(item.aid.title).toBe("Roshan's student");
  });
});

// ── roles (§9.2, §9.3) ──────────────────────────────────────────────────────

describe('applyTokenPass — role resolution (§9.3)', () => {
  const malcolm = makeItem('malcolm', 'male');
  const aness = makeItem('aness', 'female');
  const registry = new Map([['malcolm', malcolm], ['aness', aness]]);
  const roles = { LI: 'Malcolm', protagonist: 'Aness' };

  test('{$LI} rewrites to the bound item id and resolves like an ordinary reference', () => {
    expect(applyTokenPass('{$LI} walked in', { item: malcolm, registry, roles, branchProtagonist: null }))
      .toBe('Malcolm walked in');
  });

  test("{$LI's} rewrites and keeps the possessive suffix", () => {
    expect(applyTokenPass("It was {$LI's} choice", { item: malcolm, registry, roles, branchProtagonist: null }))
      .toBe("It was Malcolm's choice");
  });

  test('{$LI.he} rewrites and resolves the scoped pronoun', () => {
    expect(applyTokenPass('{$LI.he} left', { item: malcolm, registry, roles, branchProtagonist: null }))
      .toBe('he left');
  });

  // The token pass only rewrites the leading name and re-emits the cross-item ref;
  // `applyCrossItemRefs` resolves the `.body.` lookup. The end-to-end path — including a
  // role name in the leading slot — is covered by roles.integration.test.js.
  test('{$LI.body.field} rewrites the leading name and re-emits the cross-item ref', () => {
    expect(applyTokenPass('{$LI.body.Tagline}', { item: malcolm, registry, roles, branchProtagonist: null }))
      .toBe('{$Malcolm.body.Tagline}');
  });

  test('a role bound to the protagonist resolves to "you"', () => {
    expect(applyTokenPass('{$protagonist} arrived', {
      item: malcolm, registry, roles, branchProtagonist: 'aness',
    })).toBe('you arrived');
  });

  test('an ordinary item id is unaffected by an unrelated roles table', () => {
    expect(applyTokenPass('{$Malcolm} left', { item: malcolm, registry, roles, branchProtagonist: null }))
      .toBe('Malcolm left');
  });

  test('calls onRoleUsed with the role key on successful resolution', () => {
    const onRoleUsed = jest.fn();
    applyTokenPass('{$LI} and {$LI.he}', { item: malcolm, registry, roles, branchProtagonist: null, onRoleUsed });
    expect(onRoleUsed).toHaveBeenCalledWith('LI');
    expect(onRoleUsed).toHaveBeenCalledTimes(2);
  });

  test('no roles declared: behaves exactly as before roles existed, no CL0540 noise', () => {
    const onWarn = jest.fn();
    applyTokenPass('{$Nope}', { item: malcolm, registry, roles: null, branchProtagonist: null, onWarn });
    expect(onWarn).not.toHaveBeenCalled();
  });

  describe('CL0540 — undeclared role or unknown item id', () => {
    test('an unresolvable token on a role-declaring branch raises CL0540', () => {
      const onWarn = jest.fn();
      applyTokenPass('{$Nope}', { item: malcolm, registry, roles, branchProtagonist: null, onWarn });
      expect(onWarn).toHaveBeenCalledWith('CL0540', expect.stringContaining('Nope'));
      expect(onWarn).toHaveBeenCalledWith('CL0540', expect.stringContaining('LI'));
    });

    test('the dotted form also raises CL0540 when the prefix resolves to neither', () => {
      const onWarn = jest.fn();
      applyTokenPass('{$Nope.he}', { item: malcolm, registry, roles, branchProtagonist: null, onWarn });
      expect(onWarn).toHaveBeenCalledWith('CL0540', expect.any(String));
    });

    test('a cross-item ref to a real item does not raise CL0540', () => {
      const onWarn = jest.fn();
      applyTokenPass('{$Malcolm.body.Tagline}', { item: malcolm, registry, roles, branchProtagonist: null, onWarn });
      expect(onWarn).not.toHaveBeenCalled();
    });
  });

  test('CL0541 — a role name colliding with an item id is ambiguous', () => {
    const onWarn = jest.fn();
    const collidingRegistry = new Map([['li', { id: 'li', name: 'LI' }], ['malcolm', malcolm]]);
    applyTokenPass('{$LI}', {
      item: malcolm, registry: collidingRegistry, roles, branchProtagonist: null, onWarn,
    });
    expect(onWarn).toHaveBeenCalledWith('CL0541', expect.stringContaining('LI'));
  });

  test('CL0543 — a role bound to another role name is one level of indirection too many', () => {
    const onWarn = jest.fn();
    const indirect = { LI: 'RIVAL', RIVAL: 'Malcolm' };
    applyTokenPass('{$LI}', { item: malcolm, registry, roles: indirect, branchProtagonist: null, onWarn });
    expect(onWarn).toHaveBeenCalledWith('CL0543', expect.stringContaining('RIVAL'));
  });

  test('CL0542 — a role bound to an item this branch excludes', () => {
    const onWarn = jest.fn();
    const excluded = { LI: 'Ghost' };
    applyTokenPass('{$LI}', { item: malcolm, registry, roles: excluded, branchProtagonist: null, onWarn });
    expect(onWarn).toHaveBeenCalledWith('CL0542', expect.stringContaining('Ghost'));
  });

  test('resolvedById takes precedence over the raw registry for the role target, like an item ref', () => {
    const variant = { id: 'malcolm', name: { display: 'Malcolm (variant)' }, pronouns: 'male' };
    const resolvedById = new Map([['malcolm', variant]]);
    expect(applyTokenPass('{$LI}', {
      item: malcolm, registry, roles, resolvedById, branchProtagonist: null,
    })).toBe('Malcolm (variant)');
  });
});
