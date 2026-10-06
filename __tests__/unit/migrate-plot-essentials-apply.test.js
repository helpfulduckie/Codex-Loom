'use strict';

/**
 * The file surgery half of the Plot Essentials migration (§7.2, §14.2).
 *
 * The acceptance test compiles a migrated `Loom/` tree and compares bytes, which proves the
 * whole chain and names nothing. These cover the two pieces carrying real judgement: which
 * branch paths a v3 block's dispatch actually included, and how a variant name is added to a
 * dispatch node that already exists in one of four shapes.
 */

const YAML = require('yaml');

const {
  entryId,
  includedPaths,
  addVariantAt,
  buildInlineItems,
} = require('../../src/migrate/plot-essentials-apply');

/** Parse a branches: mapping into a document node, the way the migrator meets one. */
function branchesDoc(yaml) {
  const doc = YAML.parseDocument(yaml);
  return { doc, node: doc.contents };
}

// ── reading an entry ─────────────────────────────────────────────────────────

describe('entryId', () => {
  test('reads id, import, or a scalar name — the three ways an entry is addressed', () => {
    const ids = YAML.parseDocument('- id: Bryn\n- import: Kaiden\n- name: Rhylen\n')
      .contents.items.map(entryId);
    expect(ids).toEqual(['bryn', 'kaiden', 'rhylen']);
  });

  test('a name: mapping is not an id, because display/full is not a handle', () => {
    const [node] = YAML.parseDocument('- name: {display: Bryn, full: Bryn Lysen}\n').contents.items;
    expect(entryId(node)).toBeNull();
  });
});

// ── which branches a block applied to ────────────────────────────────────────

describe('includedPaths', () => {
  test('a null leaf is an exclusion and contributes no path', () => {
    // `~` on a v3 block meant "no Plot Essentials on this branch", which in v4 is simply the
    // placement variant not being applied — so it needs nothing written anywhere.
    expect(includedPaths({ subject: [], flashback: null })).toEqual([['subject']]);
  });

  test('scalar and array leaves both include', () => {
    expect(includedPaths({ a: 'variantName', b: ['x', 'y'] })).toEqual([['a'], ['b']]);
  });

  test('nested branches: descend, and the wildcard is just another key', () => {
    // The Institute's protagonist block, which is the only case in the corpus that needs
    // grafting: include where the second axis is Veryn, exclude everywhere else.
    expect(includedPaths({ '*': { branches: { Veryn: [], _: null } } })).toEqual([['*', 'Veryn']]);
  });

  test('a mapping with apply: and no sub-branches includes at its own level', () => {
    expect(includedPaths({ a: { apply: ['x'] } })).toEqual([['a']]);
  });
});

// ── grafting the variant into an existing dispatch ───────────────────────────

describe('addVariantAt', () => {
  test('a mapping node takes the name under apply:, beside the branches it descends', () => {
    // The shape The Institute actually has. Writing the name anywhere else would either
    // replace the existing dispatch or be ignored.
    const { doc, node } = branchesDoc('"*":\n  branches:\n    Veryn:\n      branches:\n        x: [a]\n');
    addVariantAt(doc, node, ['*', 'Veryn'], 'pe-you');
    expect(doc.toJS()['*'].branches.Veryn.apply).toEqual(['pe-you']);
    expect(doc.toJS()['*'].branches.Veryn.branches).toEqual({ x: ['a'] });
  });

  test('a sequence node gains the name rather than being replaced', () => {
    const { doc, node } = branchesDoc('subject: [base]\n');
    addVariantAt(doc, node, ['subject'], 'pe-you');
    expect(doc.toJS().subject).toEqual(['base', 'pe-you']);
  });

  test('a bare scalar becomes a list, because one slot cannot hold two names', () => {
    const { doc, node } = branchesDoc('subject: base\n');
    addVariantAt(doc, node, ['subject'], 'pe-you');
    expect(doc.toJS().subject).toEqual(['base', 'pe-you']);
  });

  test('a missing path is created rather than dropped', () => {
    const { doc, node } = branchesDoc('other: [x]\n');
    addVariantAt(doc, node, ['a', 'b'], 'pe-you');
    expect(doc.toJS()).toEqual({ other: ['x'], a: { branches: { b: ['pe-you'] } } });
  });

  test('an existing apply: scalar is widened, not overwritten', () => {
    const { doc, node } = branchesDoc('subject:\n  apply: base\n');
    addVariantAt(doc, node, ['subject'], 'pe-you');
    expect(doc.toJS().subject.apply).toEqual(['base', 'pe-you']);
  });
});

// ── inline blocks becoming items ─────────────────────────────────────────────

describe('buildInlineItems', () => {
  const placementFor = (raw, target) => ({
    block: { kind: 'inline', id: raw.id, raw, template: (raw.render || {}).template || null },
    target,
    suppressStoryCard: false,
  });

  test('the aid: block goes, and its type survives as the template', () => {
    // §7.4 asks for triggers and a type only when a story-card target exists, and a block
    // that lived in Plot Essentials has none — but `aid.type` was also how v3 named the
    // template, so dropping it wholesale would leave the item unrenderable.
    const raw = { id: 'genreBlock', name: 'genreBlock', aid: { type: 'genreSettingBlock' }, body: { genre: ['x'] } };
    const [item] = buildInlineItems([placementFor(raw, { slot: 'genre', order: 1 })]);
    expect(item.aid).toBeUndefined();
    expect(item.render).toEqual({
      template: 'genreSettingBlock', storyCard: false, plotEssential: { slot: 'genre', order: 1 },
    });
  });

  test('variants and branches come across, since they are the item\'s now', () => {
    // v3 applied a PE block's variants as a flat field delta and discarded the dispatch, so
    // carrying both is a behavior change — and the intended one: the genre blocks whose
    // branch variants v3 silently dropped are exactly what the Phase 3 re-baseline surfaced.
    const raw = {
      id: 'genreBlock',
      body: { genre: ['x'] },
      variants: { family: { genre: ['y'] } },
      branches: { foundFamily: ['family'] },
    };
    const [item] = buildInlineItems([placementFor(raw, { slot: 'genre', order: 1 })]);
    expect(item.variants).toEqual({ family: { genre: ['y'] } });
    expect(item.branches).toEqual({ foundFamily: ['family'] });
  });

  test('layout keys stay behind on the section where they belong', () => {
    const raw = { id: 'x', heading: 'Cast', headingLevel: 0, body: {} };
    const [item] = buildInlineItems([placementFor(raw, { slot: 'cast', order: 1 })]);
    expect(item.heading).toBeUndefined();
    expect(item.headingLevel).toBeUndefined();
  });

  test('import blocks are not inline items and are left alone', () => {
    const placement = { block: { kind: 'import', id: 'Aness', raw: {} }, target: {} };
    expect(buildInlineItems([placement])).toEqual([]);
  });
});
