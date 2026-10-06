'use strict';

/**
 * The branch-merged placeholder table (§6.4, §12.2) — Phase 4 Step 1.
 *
 * These assert against Velvet Lattice's own merge semantics, which were read out of
 * `velvet_lattice/scenario.py` rather than assumed. VL computes
 * `{**parent_placeholders, **local_placeholders}` per node and reads only that node's own
 * `Placeholders.yaml`, so inheritance is **per key**, not per file: a child adds its keys
 * and overrides same-named ones, and every parent key it does not mention survives.
 *
 * Key order is asserted deliberately rather than incidentally. VL substitutes in one pass
 * with no re-substitution, so a nested `%key%` inside another key's question resolves only
 * if the inner key is iterated later — which makes the emitted order load-bearing until
 * Step 2's compile-time expansion removes the dependency. The order this produces has to
 * match what VL would compute from the same declarations, or the two disagree about a case
 * that fails silently.
 */

const { walkBranchChain } = require('../../src/model/branches');
const { CODES } = require('../../src/diag');

const config = {
  placeholders: {
    heroName: 'What is your name?',
    homeland: 'Which kingdom raised you?',
  },
  branches: {
    north: {
      placeholders: {
        homeland: 'Which northern hold raised you?',
        bladeName: 'What is your sword called?',
      },
      branches: {
        keep: {
          placeholders: { oath: 'What oath did you swear?' },
        },
      },
    },
    south: {
      placeholders: { patron: 'Which house sponsors you?' },
    },
    plain: {},
    unbound: {
      placeholders: { homeland: null },
    },
    ghost: {
      placeholders: { neverInherited: null },
    },
  },
};

const merge = (path, onWarn) =>
  walkBranchChain(config.branches, path, { rootPlaceholders: config.placeholders, onWarn }).placeholders;

describe('placeholder inheritance', () => {
  test('a branch inherits root keys and adds its own', () => {
    expect(merge(['north'])).toEqual({
      heroName: 'What is your name?',
      homeland: 'Which northern hold raised you?',
      bladeName: 'What is your sword called?',
    });
  });

  test('inheritance is per key, not per file — an unmentioned parent key survives', () => {
    // The distinction that matters: VL's *components* inherit file-wise, so a local
    // Plot Essentials replaces the parent's whole file. Placeholders use the same merge
    // expression with a finer key, and reasoning from one to the other gives the wrong
    // answer. `heroName` is declared only at root and must reach the deepest leaf.
    expect(merge(['north', 'keep']).heroName).toBe('What is your name?');
  });

  test('accumulates down a chain', () => {
    expect(Object.keys(merge(['north', 'keep'])).sort())
      .toEqual(['bladeName', 'heroName', 'homeland', 'oath']);
  });

  test('siblings are independent', () => {
    expect(merge(['south'])).toEqual({
      heroName: 'What is your name?',
      homeland: 'Which kingdom raised you?',
      patron: 'Which house sponsors you?',
    });
    expect(merge(['south']).bladeName).toBeUndefined();
  });

  test('a branch declaring nothing inherits everything unchanged', () => {
    expect(merge(['plain'])).toEqual(config.placeholders);
  });

  test('the root table is not mutated by a branch merge', () => {
    merge(['north', 'keep']);
    expect(config.placeholders).toEqual({
      heroName: 'What is your name?',
      homeland: 'Which kingdom raised you?',
    });
  });
});

describe('~ unbinds', () => {
  test('removes the key rather than setting it to null', () => {
    const merged = merge(['unbound']);
    expect('homeland' in merged).toBe(false);
    expect(merged.heroName).toBe('What is your name?');
  });

  test('unbinding something never inherited warns and removes nothing', () => {
    const warnings = [];
    const merged = merge(['ghost'], (code, message) => warnings.push({ code, message }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(CODES.PLACEHOLDER_UNBIND_UNKNOWN);
    // §6.4's footgun: a bare `key:` with nothing after it parses as null, so the most
    // natural way to declare a placeholder silently unbinds it. The message has to say so.
    expect(warnings[0].message).toMatch(/never inherited/);
    expect(merged.heroName).toBe('What is your name?');
  });

  test('unbinding an inherited key is silent', () => {
    const warnings = [];
    merge(['unbound'], (code, message) => warnings.push({ code, message }));
    expect(warnings).toHaveLength(0);
  });
});

describe('key order matches what Velvet Lattice would compute', () => {
  test('inherited keys come first, new local keys append', () => {
    expect(Object.keys(merge(['south']))).toEqual(['heroName', 'homeland', 'patron']);
  });

  test('an overriding key keeps the parent position rather than moving to the end', () => {
    // Python's dict update and JS's Object.assign agree here, and the agreement is what
    // lets Codex Loom predict VL's substitution order. `homeland` is overridden on
    // `north` and must stay in slot 1, ahead of the key declared after it.
    expect(Object.keys(merge(['north']))).toEqual(['heroName', 'homeland', 'bladeName']);
  });
});
