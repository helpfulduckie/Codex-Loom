'use strict';

const { LIMITS, expandPlaceholders, measure, checkLimit } = require('../../src/limits');
const { Diagnostics, CODES } = require('../../src/diag');

/**
 * The measurement §8.5 is about.
 *
 * The golden corpus cannot test this: it holds no `Placeholders.yaml` and no `%key%`
 * anywhere, so every card in it is the degenerate case where rendered length equals stored
 * length. Everything below is the case that actually bites.
 */
describe('expandPlaceholders — Velvet Lattice\'s substitution, not an estimate of it', () => {
  const table = { heroName: "What is your character's name?" };

  test('a declared key becomes ${question}', () => {
    expect(expandPlaceholders('Hello %heroName%.', table))
      .toBe("Hello ${What is your character's name?}.");
  });

  test('every occurrence is replaced, as a single pass over the whole string does', () => {
    expect(expandPlaceholders('%heroName% and %heroName%', table))
      .toBe("${What is your character's name?} and ${What is your character's name?}");
  });

  test('an undeclared key is left exactly as written', () => {
    // VL leaves it, AID receives it raw, and CL0532 is what reports it. Measuring it as
    // zero-growth is the honest reading of what would actually ship.
    expect(expandPlaceholders('Hello %nobody%.', table)).toBe('Hello %nobody%.');
  });

  test('a null question is skipped rather than substituted as "null"', () => {
    expect(expandPlaceholders('%unbound%', { unbound: null })).toBe('%unbound%');
  });

  test('no table at all leaves the text alone', () => {
    expect(expandPlaceholders('%heroName%', null)).toBe('%heroName%');
  });
});

describe('measure', () => {
  const table = { heroName: "What is your character's name?" };

  test('reports rendered and expanded lengths separately', () => {
    const result = measure('Hi %heroName%', table);
    expect(result.rendered).toBe('Hi %heroName%'.length);
    expect(result.expanded).toBe("Hi ${What is your character's name?}".length);
    expect(result.added).toBe(result.expanded - result.rendered);
  });

  test('placeholders expand upward — the whole reason the check is not text.length', () => {
    expect(measure('%heroName%', table).added).toBeGreaterThan(0);
  });

  test('the gain per reference is len(question) - len(key) + 1', () => {
    // `%key%` is len(key) + 2; `${question}` is len(question) + 3.
    const key = 'heroName';
    const question = table.heroName;
    expect(measure(`%${key}%`, table).added).toBe(question.length - key.length + 1);
  });

  test('counts declared references only, since undeclared ones do not grow', () => {
    expect(measure('%heroName% %nobody%', table).refs).toBe(1);
  });

  test('trims, because VL strips both a card body and a component file', () => {
    expect(measure('  padded  ', null).rendered).toBe('padded'.length);
  });

  test('empty and absent text measure zero rather than throwing', () => {
    expect(measure('', null).expanded).toBe(0);
    expect(measure(undefined, null).expanded).toBe(0);
    expect(measure(null, null).expanded).toBe(0);
  });
});

describe('checkLimit', () => {
  const body = (length) => 'x'.repeat(length);

  test('content under the band reports nothing', () => {
    const diagnostics = new Diagnostics();
    checkLimit(body(1799), null, LIMITS.cardBody, { diagnostics });
    expect(diagnostics.all).toEqual([]);
  });

  test('content at the band WARNs and names the remaining headroom', () => {
    const diagnostics = new Diagnostics();
    checkLimit(body(1800), null, LIMITS.cardBody, { diagnostics });
    expect(diagnostics.warnings.map((d) => d.code)).toEqual([CODES.CARD_BODY_NEAR_LIMIT]);
    expect(diagnostics.warnings[0].message).toContain('within 200 of the 2,000 limit');
  });

  test('content over the cap is an ERROR, and only the ERROR — not both', () => {
    const diagnostics = new Diagnostics();
    checkLimit(body(2001), null, LIMITS.cardBody, { diagnostics });
    expect(diagnostics.all.map((d) => d.code)).toEqual([CODES.CARD_BODY_OVER_LIMIT]);
  });

  test('exactly at the cap passes — the cap is inclusive, the band is what warns', () => {
    const diagnostics = new Diagnostics();
    checkLimit(body(2000), null, LIMITS.cardBody, { diagnostics });
    expect(diagnostics.errors).toEqual([]);
    expect(diagnostics.warnings.map((d) => d.code)).toEqual([CODES.CARD_BODY_NEAR_LIMIT]);
  });

  test('the Opening cap is its own, at 4,000', () => {
    const diagnostics = new Diagnostics();
    checkLimit(body(3999), null, LIMITS.opening, { diagnostics });
    expect(diagnostics.errors).toEqual([]);
    checkLimit(body(4001), null, LIMITS.opening, { diagnostics });
    expect(diagnostics.errors.map((d) => d.code)).toEqual([CODES.OPENING_OVER_LIMIT]);
  });

  /**
   * §8.5's worked example: content that passes a naive check and fails a real one.
   *
   * This is the failure the whole phase ordering exists to prevent — an Opening under
   * 4,000 rendered, over it once VL expands the placeholders.
   */
  test('an Opening under the cap rendered can be over it after substitution', () => {
    const question = 'What is your character called, and where did they grow up?';
    const table = { heroName: question };
    // 20 references, each gaining question.length - 'heroName'.length + 1 characters.
    const text = body(3700) + '%heroName%'.repeat(20);

    const naive = text.length;
    const diagnostics = new Diagnostics();
    const result = checkLimit(text, table, LIMITS.opening, { diagnostics });

    expect(naive).toBeLessThan(LIMITS.opening.cap);
    expect(result.expanded).toBeGreaterThan(LIMITS.opening.cap);
    expect(diagnostics.errors.map((d) => d.code)).toEqual([CODES.OPENING_OVER_LIMIT]);
  });

  test('the message shows both numbers when substitution changed the length', () => {
    const table = { heroName: 'A'.repeat(300) };
    const diagnostics = new Diagnostics();
    checkLimit(body(1900) + '%heroName%', table, LIMITS.cardBody, { diagnostics });
    const { message } = diagnostics.errors[0];
    expect(message).toContain('after placeholder substitution');
    expect(message).toContain('Rendered length is');
    expect(message).toContain('1 placeholder reference add');
  });

  test('the message shows one number when there was nothing to substitute', () => {
    const diagnostics = new Diagnostics();
    checkLimit(body(2001), null, LIMITS.cardBody, { diagnostics });
    expect(diagnostics.errors[0].message).not.toContain('after placeholder substitution');
    expect(diagnostics.errors[0].message).not.toContain('Rendered length is');
  });

  test('it returns the measurement even with no bus, so a report need not measure twice', () => {
    expect(checkLimit(body(10), null, LIMITS.cardBody, {}).expanded).toBe(10);
  });
});

describe('module purity', () => {
  test('limits.js requires neither fs nor console (§3.3)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../src/limits.js'), 'utf8');
    expect(source).not.toMatch(/require\(['"]fs['"]\)/);
    expect(source).not.toMatch(/console\./);
  });
});
