'use strict';

const { validateCardType, normalizeCardType, buildCardTypeAudit } = require('../../src/cardType');
const { Diagnostics, CODES: DIAG_CODES } = require('../../src/diag');

// ── validateCardType (aid.type must be a legal folder/file name) ──────────────

describe('validateCardType', () => {
  const item = (type) => ({ id: 'X', _source: 'items.yaml', aid: { type } });

  test('accepts a normal type', () => {
    const diagnostics = new Diagnostics();
    validateCardType(item('Character'), { diagnostics });
    expect(diagnostics.errors).toHaveLength(0);
  });

  test('accepts a type containing spaces', () => {
    const diagnostics = new Diagnostics();
    validateCardType(item('Story Card'), { diagnostics });
    expect(diagnostics.errors).toHaveLength(0);
  });

  test('no-op when aid.type is absent', () => {
    const diagnostics = new Diagnostics();
    validateCardType({ id: 'X', aid: {} }, { diagnostics });
    validateCardType({ id: 'X' }, { diagnostics });
    expect(diagnostics.errors).toHaveLength(0);
  });

  test.each(['a/b', 'a\\b', 'con:', 'a*b', 'a?b', 'a|b', '<x>', '"q"'])(
    'raises CL0632 on illegal path character: %s', (bad) => {
      const diagnostics = new Diagnostics();
      validateCardType(item(bad), { diagnostics });
      expect(diagnostics.errors).toHaveLength(1);
      expect(diagnostics.errors[0].message).toMatch(/Invalid aid\.type/);
    }
  );

  test('raises CL0632 on "." and ".."', () => {
    const diagnostics = new Diagnostics();
    validateCardType(item('.'), { diagnostics });
    validateCardType(item('..'), { diagnostics });
    expect(diagnostics.errors).toHaveLength(2);
    expect(diagnostics.errors.every((d) => /Invalid aid\.type/.test(d.message))).toBe(true);
  });

  test('raises CL0632 on trailing space or period (Windows-hostile)', () => {
    const diagnostics = new Diagnostics();
    validateCardType(item('Character '), { diagnostics });
    validateCardType(item('Character.'), { diagnostics });
    expect(diagnostics.errors).toHaveLength(2);
    expect(diagnostics.errors.every((d) => /Invalid aid\.type/.test(d.message))).toBe(true);
  });

  test('with diagnostics, raises CL0632 and does not throw', () => {
    const diagnostics = new Diagnostics();
    expect(() => validateCardType(item('a/b'), { diagnostics })).not.toThrow();
    expect(diagnostics.errors).toHaveLength(1);
    expect(diagnostics.errors[0].code).toBe(DIAG_CODES.CARD_TYPE_INVALID);
    expect(diagnostics.errors[0].message).toMatch(/"a\/b".*"X"/);
  });
});

// ── normalizeCardType / buildCardTypeAudit (CL0626–CL0628) ────────────────────
//
// `aid.type` becomes `Story Cards/{type}/{type}.md`. Two facts follow: AID's built-in
// categories are lowercase and it matches the string exactly, and a case-insensitive
// filesystem turns two case-variant types into one file. `validateCardType` above covers
// what cannot be a path at all; these cover what is a legal path and still wrong.

describe('normalizeCardType', () => {
  test.each(['character', 'class', 'race', 'location', 'faction'])(
    'folds the built-in %s to lowercase', (builtin) => {
      const capitalized = builtin[0].toUpperCase() + builtin.slice(1);
      expect(normalizeCardType(capitalized)).toEqual({
        type: builtin, trimmed: false,
      });
    }
  );

  test('leaves an already-lowercase built-in untouched', () => {
    expect(normalizeCardType('character')).toEqual({
      type: 'character', trimmed: false,
    });
  });

  test('leaves custom types alone, including ones that contain a built-in name', () => {
    for (const custom of ['Character - Dalor', 'Spell - Ice', 'Character (Preset)', 'You']) {
      expect(normalizeCardType(custom)).toEqual({ type: custom, trimmed: false });
    }
  });

  test('trims leading whitespace and folds in one pass', () => {
    expect(normalizeCardType(' Character')).toEqual({
      type: 'character', trimmed: true,
    });
  });

  test('is idempotent — it runs once per item per branch', () => {
    const once = normalizeCardType('Character').type;
    expect(normalizeCardType(once).type).toBe(once);
  });

  test('passes non-strings and empties through untouched', () => {
    expect(normalizeCardType('')).toEqual({ type: '', trimmed: false });
    expect(normalizeCardType(undefined).type).toBeUndefined();
  });
});

describe('buildCardTypeAudit', () => {
  const report = (types) => {
    const audit = buildCardTypeAudit();
    for (const t of types) audit.resolve(t, { file: 'items.yaml' });
    const diagnostics = new Diagnostics();
    audit.finish(diagnostics);
    return diagnostics;
  };

  test('resolve() returns the written type, leaving the authored value to the caller', () => {
    // `item.aid.type` is deliberately *not* mutated: it is also the selector the template
    // ladder and `templateFor` key on, and those maps carry the author's casing.
    expect(buildCardTypeAudit().resolve('Character', { file: 'items.yaml' })).toBe('character');
  });

  test('CL0628 still reports leading whitespace on a built-in', () => {
    const diagnostics = report([' Character']);
    expect(diagnostics.warnings.find((d) => d.code === 'CL0628')).toBeTruthy();
    expect(diagnostics.warnings).toHaveLength(1);
  });

  test('CL0626 errors on two custom types differing only by case', () => {
    const err = report(['Widget', 'widget']).errors.find((d) => d.code === 'CL0626');
    expect(err).toBeTruthy();
    expect(err.message).toContain('"Widget"');
    expect(err.message).toContain('"widget"');
  });

  test('a built-in pair folds to one type and is NOT a collision', () => {
    // Normalization runs before the collision check on purpose: `Character` and
    // `character` become one directory deliberately, so reporting them would flag a merge
    // the compiler performed itself.
    const diagnostics = report(['Character', 'character']);
    expect(diagnostics.errors.filter((d) => d.code === 'CL0626')).toHaveLength(0);
  });

  test('silent on a corpus with no built-ins and no case variants', () => {
    const diagnostics = report(['Character - Dalor', 'Spell - Ice', 'You', 'zz_Settings']);
    expect(diagnostics.warnings.filter((d) => d.code.startsWith('CL062'))).toHaveLength(0);
    expect(diagnostics.errors.filter((d) => d.code.startsWith('CL062'))).toHaveLength(0);
  });
});
