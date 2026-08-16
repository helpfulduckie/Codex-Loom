'use strict';

/**
 * The kitchen-sink schema fixtures.
 *
 * The golden fixtures pin compiled *output*; these pin the *key surface*. The Phase 1
 * audit found two bugs that survived 1,092 tests and three byte-identical fixtures, and
 * both lived in shapes no fixture project happened to write — a token in
 * `structure.output`, and a config error reached before any filesystem work. Output
 * fixtures cannot close that class, because the hole is a config nobody wrote.
 *
 * Each half asserts four things about a maximal *valid* document:
 *
 *   1. it covers every key its schema declares (the meta-test — this is what stops the
 *      fixture decaying into merely a large file);
 *   2. it produces no ERRORs, since a valid document that errors is the headline failure;
 *   3. its WARNs are exactly the not-yet-implemented keys, so a phase that implements a
 *      key and forgets to drop its `note` fails here;
 *   4. nothing resolvable is left unresolved.
 *
 * The invalid half lives in `config-load.test.js`, beside the other diagnostic tests.
 */

const path = require('path');

const { Diagnostics, CODES: DIAG_CODES } = require('../../src/diag');
const { validate, CODES: SCHEMA_CODES } = require('../../src/schema');
const { loadYamlDocument } = require('../../src/loader/yaml');
const { loadCompileConfig } = require('../../src/config/load');
const { CONFIG_SCHEMA } = require('../../src/config/schema');
const { ITEM_SCHEMA } = require('../../src/loader/schema');
const { missingPaths, notedPaths } = require('../helpers/schema-paths');

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/kitchen-sink');
const CONFIG_PATH = path.join(FIXTURE_DIR, 'compile.cl.yaml');
const ITEMS_PATH = path.join(FIXTURE_DIR, 'Codex', 'items.cl.yaml');

/** The leaf key a not-yet-implemented WARN names, for comparison against `notedPaths`. */
function warnedKey(diag) {
  const match = /^"([^"]+)"/.exec(diag.message);
  return match ? match[1] : diag.message;
}

/** The distinct leaf names of every `note`-carrying descriptor in a schema. */
function notedKeys(schema) {
  return new Set([...notedPaths(schema)].map((p) => p.split('.').pop()));
}

describe('kitchen-sink config (compile.cl.yaml)', () => {
  let config;
  let diagnostics;

  beforeAll(() => {
    diagnostics = new Diagnostics();
    config = loadCompileConfig(CONFIG_PATH, { diagnostics });
  });

  test('covers every key CONFIG_SCHEMA declares', () => {
    // A failure here is a to-do list, not a bug: add the named keys to the fixture.
    const { value } = loadYamlDocument(CONFIG_PATH);
    expect(missingPaths(value, CONFIG_SCHEMA)).toEqual([]);
  });

  test('loads without a single ERROR', () => {
    expect(diagnostics.errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  test('warns only about keys that are not yet implemented', () => {
    const other = diagnostics.warnings.filter((d) => d.code !== SCHEMA_CODES.NOT_YET_IMPLEMENTED);
    expect(other.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  /**
   * The pairing is what has teeth, not either half alone. Coverage above proves every
   * declared key is written; this proves every `note` on those keys actually reaches the
   * author. The hole it closes: `validate` checks `note` only in a map's key loop, so a
   * note declared on a *record's value* descriptor — `lint.packs.*` — is dead and warns
   * nobody. Verified by adding one and watching this fail.
   */
  test('and warns about all of them — a note the validator can never emit fails here', () => {
    const warned = new Set(diagnostics.warnings
      .filter((d) => d.code === SCHEMA_CODES.NOT_YET_IMPLEMENTED)
      .map(warnedKey));
    expect([...warned].sort()).toEqual([...notedKeys(CONFIG_SCHEMA)].sort());
  });

  describe('resolution', () => {
    /**
     * The regression guard for the audit's first bug. `structure.output` and
     * `structure.reports` went straight to `path.resolve` with no expansion, and no
     * fixture project put a token in either, so nothing failed. Asserting the property
     * over every resolved path — rather than key by key — is what makes the next such
     * omission fail without anyone thinking to test for it.
     */
    test('every resolved path is absolute and holds no unexpanded token', () => {
      const resolved = [
        config._resolvedOutput,
        config._resolvedReports,
        ...config._resolvedItems,
        ...config._resolvedTemplates,
        ...config._resolvedCanon.values(),
      ];
      for (const p of resolved) {
        expect(path.isAbsolute(p)).toBe(true);
        expect(p).not.toMatch(/\{%/);
      }
    });

    test('a canon name reaches structure.reports, since canon auto-exposes as a variable', () => {
      expect(config._resolvedReports).toBe(path.join(FIXTURE_DIR, 'Review'));
    });

    test('output expands its token', () => {
      expect(config._resolvedOutput).toBe(path.join(FIXTURE_DIR, 'out'));
    });

    /**
     * The other side of §5.1: component specs resolve per branch, against the merged
     * variable set, so they must still carry their tokens when config loading is done.
     * Expanding them here would silently collapse every branch into the root's values.
     */
    test('component specs are left unexpanded for branch-time resolution', () => {
      expect(config.components.plotEssential).toMatch(/\{%componentDir\}/);
    });

    test('the author\'s variables are reported without the derived canon names', () => {
      expect(Object.keys(config.variables)).not.toContain('main');
      expect(config._variables.main).toBeDefined();
    });
  });
});

describe('kitchen-sink items (Codex/items.cl.yaml)', () => {
  let items;
  let diagnostics;
  let sourceMap;

  beforeAll(() => {
    ({ value: items, sourceMap } = loadYamlDocument(ITEMS_PATH));
    diagnostics = new Diagnostics();
    items.forEach((item, i) => {
      validate(item, ITEM_SCHEMA, {
        diagnostics, sourceMap, path: [String(i)], displayOffset: 1, context: `item "${item.id}"`,
      });
    });
  });

  test('covers every key ITEM_SCHEMA declares', () => {
    const missing = items
      .map((item) => missingPaths(item, ITEM_SCHEMA))
      .reduce((remaining, covered) => remaining.filter((p) => covered.includes(p)));
    expect(missing).toEqual([]);
  });

  test('validates without a single ERROR', () => {
    expect(diagnostics.errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  test('warns only about keys that are not yet implemented', () => {
    const other = diagnostics.warnings.filter((d) => d.code !== SCHEMA_CODES.NOT_YET_IMPLEMENTED);
    expect(other.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  test('and warns about all of them', () => {
    const warned = new Set(diagnostics.warnings
      .filter((d) => d.code === SCHEMA_CODES.NOT_YET_IMPLEMENTED)
      .map(warnedKey));
    expect([...warned].sort()).toEqual([...notedKeys(ITEM_SCHEMA)].sort());
  });

  /**
   * §4.1 in its dangerous position. `Tagline: {$name.display} is a healer` is only
   * loadable because the preparser quotes it; without that it parses as a flow mapping
   * and `findSwallowedTokens` throws. The corpus carries the shape so the parser change
   * has a fixture rather than only unit tests.
   */
  test('an unquoted leading token survives the preparse as text', () => {
    const aness = items.find((item) => item.id === 'Aness');
    expect(aness.body.Tagline).toBe('{$name.display} is a healer');
  });

  /**
   * The §4.3 case the whole relocation check exists for, and a real defect from shared
   * canon: `triggers:` is spelled correctly and placed one level too high, so nothing
   * reads it and the item ships with no triggers.
   */
  test('triggers: at item top level is a relocation ERROR naming aid:', () => {
    const bus = new Diagnostics();
    validate({ id: 'Wyvern', aid: { type: 'Race' }, triggers: 'Wyvern' }, ITEM_SCHEMA, { diagnostics: bus });
    const diag = bus.errors[0];
    expect(diag.code).toBe(SCHEMA_CODES.MISPLACED_KEY);
    expect(diag.hint).toContain('"aid:"');
  });

  /**
   * §7.4's slot-owns-wrapping rule, enforced at the schema rather than left to a reader of
   * the spec. A per-target `wrapper:` would be read by nothing — the slot's wrapper wins —
   * so the key is absent from the target descriptor on purpose, and the relocation hint
   * sends the author to `render.wrapper`, which does still govern story-card output. The
   * test exists because "the key is missing deliberately" is invisible in the schema and
   * exactly the kind of omission a later phase helpfully undoes.
   */
  test('wrapper: on a render target is a relocation ERROR naming render:', () => {
    const bus = new Diagnostics();
    validate({ id: 'Aness', render: { plotEssential: { slot: 'cast', wrapper: 'curly' } } },
      ITEM_SCHEMA, { diagnostics: bus });
    const diag = bus.errors[0];
    expect(diag.code).toBe(SCHEMA_CODES.MISPLACED_KEY);
    expect(diag.hint).toContain('"render:"');
  });

  /** §6.4 — `~` unbinds a target rather than failing its type check. */
  test('a target set to ~ is an unbind, not a type error', () => {
    const bus = new Diagnostics();
    validate({ id: 'Aness', render: { plotEssential: null } }, ITEM_SCHEMA, { diagnostics: bus });
    expect(bus.errors).toEqual([]);
  });
});
