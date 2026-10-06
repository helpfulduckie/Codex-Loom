'use strict';

/**
 * The declaration-driven emitter.
 *
 * The load-bearing test is byte-identity: the same item rendered through a hand-written
 * `.template` and through the field list that replaces it must produce the same string,
 * character for character — not "the declaration parsed". The fixture's `Character.template`
 * and its `Character` field-list entry are the twin.
 */

const path = require('path');

const { loadTemplates } = require('../../src/loader');
const { render } = require('../../src/template');
const { renderFieldList, stanzaSource } = require('../../src/render/field-list');
const { itemContext } = require('../../src/util');

const BASE = path.resolve(__dirname, '../fixtures/field-table/base');

const { templates, fieldTable } = loadTemplates([BASE]);
const twin = templates.get('character').content;

function bothWays(item) {
  const ctx = itemContext(item);
  const viaTemplate = render(twin, ctx, new Map(), null, {});
  const viaFieldList = renderFieldList(fieldTable.templates.Character, fieldTable, ctx, {});
  return { viaTemplate, viaFieldList };
}

const FULL = {
  id: 'Aness',
  name: 'Aness',
  aid: { type: 'Character' },
  body: {
    name: 'Aness Grayls',
    vibe: ['warm', 'unhurried'],
    appearance: ['tall', 'greying'],
    personality: ['patient', 'stubborn'],
    abilities: 'field medicine',
    magic: { affinity: 'restoration', effect: 'mends wounds over minutes' },
    pantheon: { Sun: 'dawn rites', Moon: 'dusk rites' },
    relationships: ['mentor to Veryn', 'wary of Voss'],
    secret: 'was the one who sealed the vault',
  },
};

describe('renderFieldList', () => {
  test('a field list renders byte-identically to its .template twin (full item)', () => {
    const { viaTemplate, viaFieldList } = bothWays(FULL);
    expect(viaFieldList).toBe(viaTemplate);
    // And it is not vacuously empty.
    expect(viaFieldList).toMatch(/Magic: restoration; mends wounds over minutes/);
  });

  test('byte-identical on a sparse item (most conditionals fall away)', () => {
    const sparse = {
      id: 'X', name: 'X', aid: { type: 'Character' },
      body: { name: 'Solia', personality: ['quiet'] },
    };
    const { viaTemplate, viaFieldList } = bothWays(sparse);
    expect(viaFieldList).toBe(viaTemplate);
    expect(viaFieldList).toBe('Name: Solia\nPersonality: quiet');
  });

  test('labelWhen: a present originalAppearance flips the label to "Current Appearance"', () => {
    const withOriginal = {
      id: 'Y', name: 'Y', aid: { type: 'Character' },
      body: { appearance: ['scarred'], originalAppearance: ['unmarked'] },
    };
    const { viaTemplate, viaFieldList } = bothWays(withOriginal);
    expect(viaFieldList).toBe(viaTemplate);
    expect(viaFieldList).toMatch(/^Current Appearance: scarred$/m);
  });

  test('labelWhen: originalAppearance absent leaves the plain label', () => {
    const plain = {
      id: 'Z', name: 'Z', aid: { type: 'Character' },
      body: { appearance: ['scarred'] },
    };
    const { viaFieldList } = bothWays(plain);
    expect(viaFieldList).toMatch(/^Appearance: scarred$/m);
    expect(viaFieldList).not.toMatch(/Current Appearance/);
  });

  test.each([false, 0])('labelWhen selects the alternate label for present value %s', (originalAppearance) => {
    const item = {
      id: 'Y', name: 'Y', aid: { type: 'Character' },
      body: { appearance: 'scarred', originalAppearance },
    };
    expect(bothWays(item).viaFieldList).toBe('Current Appearance: scarred');
  });

  test('block: true puts the value on its own line beneath the label', () => {
    const withPantheon = {
      id: 'P', name: 'P', aid: { type: 'Character' },
      body: { pantheon: { Sun: 'dawn', Moon: 'dusk' } },
    };
    const { viaTemplate, viaFieldList } = bothWays(withPantheon);
    expect(viaFieldList).toBe(viaTemplate);
    expect(viaFieldList).toBe('Pantheon:\n- Sun: dawn\n- Moon: dusk');
  });

  test('an { include } / { raw } entry is passed through as literal template source', () => {
    const { renderFieldList } = require('../../src/render/field-list');
    const table = { fields: { note: { label: 'Note' } }, groups: {}, templates: {} };
    const ctx = itemContext({ id: 'A', name: 'Cass', aid: { type: 'X' }, body: { note: 'hi' } });
    const out = renderFieldList(
      [{ raw: '{$name}' }, { field: 'note' }, { include: 'ghost' }], table, ctx,
      { partials: new Map([['ghost', { content: 'FOOTER', _source: 'g' }]]) },
    );
    expect(out).toBe('Cass\nNote: hi\nFOOTER');
  });

  // Pin the source generated for each label and wrapping shape.
  describe('label/wrap/block sugar lowers to parts', () => {
    const src = (decl) => stanzaSource({ name: 'x', decl }, 'body');

    test('label, no wrap → [label, ": ", value]', () => {
      expect(src({ label: 'Abilities' })).toBe(
        '{if present($body.x)}\nAbilities: {$body.x}\n{/if}',
      );
    });

    test('label + block → [label, ":\\n", value]', () => {
      expect(src({ label: 'Pantheon', block: true })).toBe(
        '{if present($body.x)}\nPantheon:\n{$body.x}\n{/if}',
      );
    });

    test('wrap + wrapLabel (bracket outside the whole label:value body)', () => {
      expect(src({ label: 'Hidden Info', wrap: '[]', wrapLabel: true })).toBe(
        '{if present($body.x)}\n[Hidden Info: {$body.x}]\n{/if}',
      );
    });

    test('wrap, no wrapLabel → [label, ": ", open, value, close]', () => {
      expect(src({ label: 'Vibe', wrap: '[]' })).toBe(
        '{if present($body.x)}\nVibe: [{$body.x}]\n{/if}',
      );
    });

    test('wrap + block, no wrapLabel → [label, ":\\n", open, value, close]', () => {
      expect(src({ label: 'Pantheon', wrap: '[]', block: true })).toBe(
        '{if present($body.x)}\nPantheon:\n[{$body.x}]\n{/if}',
      );
    });

    test('wrap with no label → [open, value, close]', () => {
      expect(src({ wrap: '[]' })).toBe('{if present($body.x)}\n[{$body.x}]\n{/if}');
    });

    test('labelWhen lowers to a single literal part carrying the labelExpr presence conditional', () => {
      expect(src({ label: 'Appearance', labelWhen: { originalAppearance: 'Current Appearance' } })).toBe(
        '{if present($body.x)}\n{if present($body.originalAppearance)}Current Appearance{else}Appearance{/if}: {$body.x}\n{/if}',
      );
    });

    test('an `always: true` field with a label concatenates unconditionally — no stray guard '
      + 'on the separator even when the value renders empty', () => {
      const table = {
        fields: { triple: { label: 'Triple', from: ['a', 'b'], join: '; ', always: true } },
        groups: {}, templates: {},
      };
      const ctx = itemContext({ id: 'A', name: 'A', aid: { type: 'X' }, body: {} });
      expect(renderFieldList([{ field: 'triple' }], table, ctx, {})).toBe('Triple:');
      expect(src(table.fields.triple)).toBe('Triple: {join("; ", $body.a, $body.b)}');
    });
  });

  test('a group name in a template list expands in place, in declared order', () => {
    const expanded = require('../../src/render/field-list').expandList(
      fieldTable.templates.Character, fieldTable,
    );
    expect(expanded.map((e) => e.name)).toEqual(
      ['name', 'vibe', 'appearance', 'personality', 'abilities', 'magic', 'pantheon', 'relationships', 'secret'],
    );
  });

  // Each source in `from:` can satisfy the stanza's presence guard.
  describe('multi-path `from:` guard', () => {
    test('a later path resolves and renders even when the first path is absent', () => {
      const effectOnly = {
        id: 'M', name: 'M', aid: { type: 'Character' },
        body: { magic: { effect: 'mends wounds over minutes' } },
      };
      const { viaFieldList } = bothWays(effectOnly);
      expect(viaFieldList).toMatch(/^Magic: mends wounds over minutes$/m);
    });

    test('the stanza still drops when every path is absent', () => {
      const noMagic = {
        id: 'N', name: 'N', aid: { type: 'Character' },
        body: {},
      };
      const { viaFieldList } = bothWays(noMagic);
      expect(viaFieldList).not.toMatch(/Magic/);
    });

    test('a single-path `from:` uses a presence guard', () => {
      const { stanzaSource } = require('../../src/render/field-list');
      const single = stanzaSource(
        { name: 'abilities', decl: fieldTable.fields.abilities }, 'body',
      );
      expect(single).toBe('{if present($body.abilities)}\nAbilities: {$body.abilities}\n{/if}');
    });

    test('three or more refs chain through nested {if}/{else} and produce one guard hit', () => {
      const table = {
        fields: { triple: { label: 'Triple', from: ['a', 'b', 'c'], join: '; ' } },
        groups: {}, templates: {},
      };
      const ctxFor = (body) => itemContext({ id: 'T', name: 'T', aid: { type: 'X' }, body });

      const onlyC = renderFieldList([{ field: 'triple' }], table, ctxFor({ c: 'only c' }), {});
      expect(onlyC).toBe('Triple: only c');

      const onlyA = renderFieldList([{ field: 'triple' }], table, ctxFor({ a: 'only a' }), {});
      expect(onlyA).toBe('Triple: only a');

      const none = renderFieldList([{ field: 'triple' }], table, ctxFor({}), {});
      expect(none).toBe('');
    });

    test('`always: true` keeps rendering with no guard at all, multi-path or not', () => {
      const table = {
        fields: { triple: { label: 'Triple', from: ['a', 'b'], join: '; ', always: true } },
        groups: {}, templates: {},
      };
      const ctx = itemContext({ id: 'A', name: 'A', aid: { type: 'X' }, body: {} });
      const out = renderFieldList([{ field: 'triple' }], table, ctx, {});
      expect(out).toBe('Triple:');
    });
  });

  // `always` makes literal scaffolding deliberate; the default policy applies adjacency guards.
  describe('parts: composition', () => {
    const render1 = (parts, body, opts = {}) => {
      const table = { fields: { x: { parts, always: opts.always } }, groups: {}, templates: {} };
      const ctx = itemContext({ id: 'T', name: { full: 'Tam' }, aid: { type: 'X' }, body });
      return renderFieldList([{ field: 'x' }], table, ctx, opts || {});
    };

    test('a $ ref renders its resolved value inline, with no label', () => {
      expect(render1(['$name.full'], {})).toBe('Tam');
    });

    describe('literal drop at list boundaries', () => {
      test('head literal, its one neighbor present → renders', () => {
        expect(render1(['PRE-', '$body.a'], { a: 'A' })).toBe('PRE-A');
      });
      test('head literal, its one neighbor absent → drops', () => {
        expect(render1(['PRE-', '$body.a'], {})).toBe('');
      });
      test('tail literal, its one neighbor present → renders', () => {
        expect(render1(['$body.a', '-POST'], { a: 'A' })).toBe('A-POST');
      });
      test('tail literal, its one neighbor absent → drops', () => {
        expect(render1(['$body.a', '-POST'], {})).toBe('');
      });
      test('middle literal, both neighbors present → renders', () => {
        expect(render1(['$body.a', '-MID-', '$body.b'], { a: 'A', b: 'B' })).toBe('A-MID-B');
      });
      test('middle literal, one neighbor absent → drops (needs both)', () => {
        expect(render1(['$body.a', '-MID-', '$body.b'], { b: 'B' })).toBe('B');
        expect(render1(['$body.a', '-MID-', '$body.b'], { a: 'A' })).toBe('A');
      });
    });

    // Each literal drops when one of its adjacent refs is absent.
    test('[A, "-", B, "-", C] with B absent yields "AC", not "A-C" or "A--C"', () => {
      const out = render1(['$body.a', '-', '$body.b', '-', '$body.c'], { a: 'A', c: 'C' });
      expect(out).toBe('AC');
    });

    describe('a part may itself be a declaration', () => {
      test('a nested declaration whose refs are all absent drops and takes its adjacent literal with it', () => {
        const parts = ['$body.a', ' - ', { from: ['tag1', 'tag2'], join: '; ' }];
        expect(render1(parts, { a: 'A' })).toBe('A');
      });

      test('a nested declaration that renders is followed by its separator', () => {
        const parts = ['$body.a', ' - ', { from: ['tag1', 'tag2'], join: '; ' }];
        expect(render1(parts, { a: 'A', tag1: 'T1' })).toBe('A - T1');
      });

      test('an outer stanza whose only present ref lives inside a nested part still renders', () => {
        const table = {
          fields: { x: { parts: ['$body.a', ' - ', { from: ['tag1', 'tag2'], join: '; ' }] } },
          groups: {}, templates: {},
        };
        const ctx = itemContext({ id: 'T', name: 'T', aid: { type: 'X' }, body: { tag1: 'T1' } });
        // The only present ref is nested two levels down inside the part.
        const out = renderFieldList([{ field: 'x' }], table, ctx, {});
        expect(out).toBe('T1');
      });
    });

    describe('always policy applies equally to sugar and parts', () => {
      test.each([
        ['sugar', { label: 'Status' }, 'Status:'],
        ['parts', { parts: ['Status: ', '$body.status'] }, 'Status:'],
      ])('%s keeps blank-form literals when always is true', (_shape, decl, expected) => {
        const table = { fields: { x: { ...decl, always: true } }, groups: {}, templates: {} };
        const ctx = itemContext({ id: 'T', name: 'T', aid: { type: 'X' }, body: {} });
        expect(renderFieldList([{ field: 'x' }], table, ctx, {})).toBe(expected);
      });

      test.each([
        ['sugar', { label: 'Status' }],
        ['parts', { parts: ['Status: ', '$body.status'] }],
      ])('%s drops blank-form literals by default', (_shape, decl) => {
        const table = { fields: { x: decl }, groups: {}, templates: {} };
        const ctx = itemContext({ id: 'T', name: 'T', aid: { type: 'X' }, body: {} });
        expect(renderFieldList([{ field: 'x' }], table, ctx, {})).toBe('');
      });

      test('a nested always declaration counts as present to its parent literals', () => {
        const table = {
          fields: { x: { parts: ['[', { parts: ['Status: ', '$body.status'], always: true }, ']'], always: true } },
          groups: {}, templates: {},
        };
        const ctx = itemContext({ id: 'T', name: 'T', aid: { type: 'X' }, body: {} });
        expect(renderFieldList([{ field: 'x' }], table, ctx, {})).toBe('[Status: ]');
      });
    });

    test('refRoot inherits into a nested from:, but a $ ref ignores it', () => {
      const src = stanzaSource(
        { name: 'x', decl: { parts: ['$name.full', ' - ', { from: 'tagline', join: '; ' }] } },
        'notes',
      );
      expect(src).toContain('$name.full');
      expect(src).toContain('$notes.tagline');
      expect(src).not.toContain('$notes.name.full');
    });

    test('a literal containing template syntax renders as source, not escaped text', () => {
      expect(render1(['$body.a', ' is {$body.b}'], { a: 'X', b: 'Y' })).toBe('X is Y');
    });

    test('{{ }} escapes give a literal brace inside a parts literal; {preserve} composes with it', () => {
      const out = render1(['$body.a', ' {preserve}{{lit}}{/preserve}'], { a: 'X' });
      expect(out).toBe('X {lit}');
    });
  });

  // `try:` is an ordered list of sources; the first present source renders. Unlike `parts:`, every entry
  // is a source (a bare string follows `from:`'s root-relative rule, a `$`-prefixed string is
  // absolute, a mapping is a nested declaration) — `from: [a, b]` renders both joined, which
  // is why the mutual-exclusion tests live in `field-table.test.js`, not here.
  describe('try: composition', () => {
    const tryTable = (decl) => ({ fields: { x: decl }, groups: {}, templates: {} });
    const ctxFor = (body, name) => itemContext({
      id: 'T', name: name || 'T', aid: { type: 'X' }, body,
    });
    const render1 = (decl, body, name) => renderFieldList(
      [{ field: 'x' }], tryTable(decl), ctxFor(body, name), {},
    );

    test('the first source wins when it resolves', () => {
      const out = render1({ try: ['a', 'b'], always: true }, { a: 'A', b: 'B' });
      expect(out).toBe('A');
    });

    test('a later source wins when every earlier source is absent', () => {
      const out = render1({ try: ['a', 'b'], always: true }, { b: 'B' });
      expect(out).toBe('B');
    });

    test('every source absent drops the stanza (no always:)', () => {
      const out = render1({ label: 'X', try: ['a', 'b'] }, {});
      expect(out).toBe('');
    });

    test('the stanza guard is satisfied by a later source alone', () => {
      const out = render1({ label: 'X', try: ['a', 'b'] }, { b: 'B' });
      expect(out).toBe('X: B');
    });

    test('render:/join: apply to whichever source won', () => {
      const decl = { label: 'X', try: ['a', 'b'], join: '; ' };
      expect(render1(decl, { a: ['p', 'q'] })).toBe('X: p; q');
      expect(render1(decl, { b: ['r', 's'] })).toBe('X: r; s');
    });

    test('a try: entry may be a nested declaration, with its own render:', () => {
      const decl = { try: [{ from: 'a', render: 'list' }, '$name.full'] };
      const nested = render1(decl, { a: ['1', '2'] }, { full: 'Tam' });
      expect(nested).toBe('- 1\n- 2');
      const fallback = render1(decl, {}, { full: 'Tam' });
      expect(fallback).toBe('Tam');
    });

    describe('first-present fallback source selection', () => {
      const decl = { try: ['content', 'entries'], render: 'list' };

      test('the generated stanza source uses presence guards', () => {
        const src = stanzaSource({ name: 'directory', decl }, 'body');
        expect(src).toBe(
          '{if present($body.content)}\n'
          + '{if present($body.content)}{list($body.content)}{else}{list($body.entries)}{/if}\n'
          + '{else}{if present($body.entries)}\n'
          + '{if present($body.content)}{list($body.content)}{else}{list($body.entries)}{/if}\n'
          + '{/if}{/if}',
        );
      });

      test('content wins when both are present', () => {
        expect(render1(decl, { content: ['a', 'b'], entries: ['x', 'y'] })).toBe('- a\n- b');
      });

      test('entries wins when content is absent', () => {
        expect(render1(decl, { entries: ['x', 'y'] })).toBe('- x\n- y');
      });

      test('entries also wins when content resolves to an empty list', () => {
        expect(render1(decl, { content: [], entries: ['e'] })).toBe('e');
      });

      test('both absent renders nothing', () => {
        expect(render1(decl, {})).toBe('');
      });
    });
  });

  test('zero and false count as values for multi-source declarations', () => {
    const table = {
      fields: { x: { label: 'X', from: ['a', 'b'], join: '; ' } }, groups: {}, templates: {},
    };
    const ctx = (body) => itemContext({ id: 'T', name: 'T', aid: { type: 'X' }, body });
    expect(renderFieldList(['x'], table, ctx({ a: 0 }), {})).toBe('X: 0');
    expect(renderFieldList(['x'], table, ctx({ b: false }), {})).toBe('X: false');
  });

  test('zero and false retain neighboring parts separators', () => {
    const table = { fields: { x: { parts: ['$body.a', ' / ', '$body.b'] } }, groups: {}, templates: {} };
    const ctx = itemContext({ id: 'T', name: 'T', aid: { type: 'X' }, body: { a: 0, b: false } });
    expect(renderFieldList(['x'], table, ctx, {})).toBe('0 / false');
  });

  test('nested parts and each adjacent separator retain zero and false', () => {
    const table = {
      fields: { x: { parts: ['$body.a', ' / ', { parts: ['$body.b', ' / ', '$body.c'] }] } },
      groups: {}, templates: {},
    };
    const ctx = itemContext({ id: 'T', name: 'T', aid: { type: 'X' }, body: { a: 0, b: false, c: 0 } });
    expect(renderFieldList(['x'], table, ctx, {})).toBe('0 / false / 0');
  });

  test('zero satisfies the first-present try source', () => {
    const table = { fields: { x: { label: 'X', try: ['a', 'b'] } }, groups: {}, templates: {} };
    const ctx = itemContext({ id: 'T', name: 'T', aid: { type: 'X' }, body: { a: 0, b: 'fallback' } });
    expect(renderFieldList(['x'], table, ctx, {})).toBe('X: 0');
  });

  test('false satisfies the first-present try source instead of falling through', () => {
    const table = { fields: { x: { label: 'X', try: ['a', 'b'] } }, groups: {}, templates: {} };
    const ctx = itemContext({ id: 'T', name: 'T', aid: { type: 'X' }, body: { a: false, b: 'fallback' } });
    expect(renderFieldList(['x'], table, ctx, {})).toBe('X: false');
  });

});
