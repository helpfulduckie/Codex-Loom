'use strict';

/**
 * The three resolution ladders with `templateFor` inserted (v4 spec §13.4, Phase 12 Step 2).
 *
 * Each ladder is exercised rung by rung, and the load-bearing assertion is that rung 1 —
 * the per-item override — still wins over a branch's `templateFor` slot.
 */

const { resolveBodyRender, resolveNotesRender } = require('../../src/templateResolve');
const { renderPlacementBody } = require('../../src/branchCompile');
const { Diagnostics } = require('../../src/diag');

const textTemplates = new Map([
  ['character', { content: '{$body.name}', _source: 'Character.template' }],
]);

const fieldTable = {
  fields: { name: { label: 'Name' }, k: { label: 'K' } },
  groups: {},
  templates: {
    Character: [{ field: 'name', label: 'FL-Name' }],
    Fancy: [{ field: 'name', label: 'Fancy' }],
  },
};

describe('resolveBodyRender — body ladder', () => {
  test('rung 1: an item render.template that differs from aid.type names a field-list template', () => {
    const hit = resolveBodyRender(
      { render: { template: 'Fancy' }, aid: { type: 'Character' } }, textTemplates, fieldTable, {},
    );
    expect(hit).toMatchObject({ kind: 'fieldList', name: 'Fancy' });
  });

  test('a render.template equal to aid.type is the normaliser default, not a choice — it falls to templateFor.base', () => {
    // `model/item.js` fills `render.template` with `aid.type` for every card, so honouring
    // it at rung 1 would shadow every branch's `templateFor.base`. Phase 13 finding.
    const tf = { base: { Character: [{ field: 'name', label: 'Branch' }] } };
    const hit = resolveBodyRender(
      { render: { template: 'Character' }, aid: { type: 'Character' } }, textTemplates, fieldTable, tf,
    );
    expect(hit).toEqual({ kind: 'fieldList', list: tf.base.Character, name: 'Character' });
  });

  test('a differing render.template still wins over templateFor.base for the same type', () => {
    const tf = { base: { Character: [{ field: 'name', label: 'Branch' }] } };
    const hit = resolveBodyRender(
      { render: { template: 'Fancy' }, aid: { type: 'Character' } }, textTemplates, fieldTable, tf,
    );
    expect(hit).toMatchObject({ kind: 'fieldList', name: 'Fancy' });
    expect(hit.list).toBe(fieldTable.templates.Fancy);
  });

  test('Pattern 2: render.template names a list the branch\'s slot file defines, not the shared table', () => {
    // `CharacterFull` exists only in `templateFor.base`, so an item opts back into it on the
    // tiered branch — the important card in a terse cast (§13.4).
    const tf = { base: { Character: [{ field: 'name', label: 'Terse' }], CharacterFull: [{ field: 'name', label: 'Full' }] } };
    const hit = resolveBodyRender(
      { render: { template: 'CharacterFull' }, aid: { type: 'Character' } }, new Map(), { templates: {} }, tf,
    );
    expect(hit).toEqual({ kind: 'fieldList', list: tf.base.CharacterFull, name: 'CharacterFull' });
  });

  test('rung 2: templateFor.base keyed on aid.type', () => {
    const tf = { base: { Character: [{ field: 'name', label: 'Branch' }] } };
    const hit = resolveBodyRender({ aid: { type: 'Character' } }, new Map(), { templates: {} }, tf);
    expect(hit).toEqual({ kind: 'fieldList', list: tf.base.Character, name: 'Character' });
  });

  test('rung 3: aid.type as a template name (text, then field list)', () => {
    expect(resolveBodyRender({ aid: { type: 'Character' } }, textTemplates, fieldTable, {}))
      .toEqual({ kind: 'text', entry: textTemplates.get('character'), name: 'Character' });
    expect(resolveBodyRender({ aid: { type: 'Fancy' } }, new Map(), fieldTable, {}))
      .toEqual({ kind: 'fieldList', list: fieldTable.templates.Fancy, name: 'Fancy' });
  });

  test('no match → null (verbatim rung)', () => {
    expect(resolveBodyRender({ aid: { type: 'Nope' } }, new Map(), { templates: {} }, {})).toBeNull();
  });
});

describe('resolveNotesRender — notes ladder (three rungs)', () => {
  test('rung 1: item render.notesTemplate, named', () => {
    expect(resolveNotesRender(
      { render: { notesTemplate: 'Fancy' }, aid: { type: 'Character' } },
      textTemplates, fieldTable, null, {},
    )).toMatchObject({ kind: 'fieldList', name: 'Fancy' });
  });

  test('rung 2: templateFor.notes keyed on aid.type, with the notes ref root', () => {
    const tf = { notes: { Character: [{ field: 'k', label: 'K' }] } };
    const hit = resolveNotesRender({ aid: { type: 'Character' } }, new Map(), { templates: {} }, null, tf);
    expect(hit).toMatchObject({ kind: 'fieldList', refRoot: 'notes' });
    expect(hit.list).toBe(tf.notes.Character);
  });

  test('rung 2 (scalar spelling): the branch/project notesTemplate name', () => {
    expect(resolveNotesRender({ aid: { type: 'X' } }, textTemplates, fieldTable, 'Fancy', {}))
      .toMatchObject({ kind: 'fieldList', name: 'Fancy' });
  });

  test('a type-keyed templateFor.notes entry wins over the scalar notesTemplate', () => {
    const tf = { notes: { Character: [{ field: 'k', label: 'K' }] } };
    const hit = resolveNotesRender({ aid: { type: 'Character' } }, textTemplates, fieldTable, 'Fancy', tf);
    expect(hit.list).toBe(tf.notes.Character);
  });

  test('rung 1 with an unknown name is a missing marker, not a silent fall-through', () => {
    expect(resolveNotesRender({ render: { notesTemplate: 'Ghost' }, aid: { type: 'X' } },
      new Map(), { templates: {} }, 'Fancy', {})).toEqual({ kind: 'missing', name: 'Ghost' });
  });

  test('nothing set → null (default)', () => {
    expect(resolveNotesRender({ aid: { type: 'X' } }, new Map(), { templates: {} }, null, {})).toBeNull();
  });

  test('rung 2 matches aid.type against templateFor.notes case-insensitively', () => {
    const tf = { notes: { Character: [{ field: 'name', label: 'N' }] } };
    const hit = resolveNotesRender(
      { aid: { type: 'character' } }, new Map(), fieldTable, null, tf,
    );
    expect(hit).toMatchObject({ kind: 'fieldList', refRoot: 'notes' });
  });
});

describe('templateFor rung 2 is case-insensitive on aid.type', () => {
  // `cardType.js` folds a built-in `aid.type` to lowercase, and a slot file's `templates:`
  // keys are conventionally capitalized. A raw index at rung 2 meant a project that wrote
  // `character` silently missed its tier: no diagnostic, cards just rendered full length.
  const tierList = [{ field: 'name', label: 'Terse' }];

  test('body ladder: lowercase aid.type finds a capitalized templateFor.base key', () => {
    const hit = resolveBodyRender(
      { aid: { type: 'character' } }, textTemplates, fieldTable, { base: { Character: tierList } },
    );
    expect(hit).toMatchObject({ kind: 'fieldList', list: tierList });
  });

  test('body ladder: capitalized aid.type finds a lowercase templateFor.base key', () => {
    const hit = resolveBodyRender(
      { aid: { type: 'Character' } }, textTemplates, fieldTable, { base: { character: tierList } },
    );
    expect(hit).toMatchObject({ kind: 'fieldList', list: tierList });
  });

  test('component-target ladder: lowercase aid.type finds a capitalized slot key', () => {
    const out = renderPlacementBody(
      { id: 'A', aid: { type: 'character' }, body: { name: 'Aness' } },
      { component: 'plotEssential' }, new Map(), new Map(), {}, new Diagnostics(),
      { fieldTable, templateFor: { plotEssential: { Character: [{ field: 'name', label: 'PE' }] } } },
    );
    expect(out).toBe('PE: Aness');
  });
});

describe('renderPlacementBody — component-target ladder', () => {
  const item = { id: 'A', aid: { type: 'Character' }, body: { name: 'Aness' } };

  test('rung 1: the target\'s own template: wins over templateFor.plotEssential', () => {
    const tf = { plotEssential: { Character: [{ field: 'name', label: 'Branch PE' }] } };
    const out = renderPlacementBody(
      item, { component: 'plotEssential', template: 'Fancy' }, new Map(), new Map(), {}, new Diagnostics(),
      { fieldTable, templateFor: tf },
    );
    expect(out).toBe('Fancy: Aness');
  });

  test('rung 2: templateFor.<component> keyed on aid.type', () => {
    const tf = { plotEssential: { Character: [{ field: 'name', label: 'PE' }] } };
    const out = renderPlacementBody(
      item, { component: 'plotEssential' }, new Map(), new Map(), {}, new Diagnostics(),
      { fieldTable, templateFor: tf },
    );
    expect(out).toBe('PE: Aness');
  });

  test('a target.template equal to aid.type is the model/item.js:384 fill, not a choice — it falls to templateFor.<component>', () => {
    // Phase 14 Step 0: the parallel of the body ladder's fix A. `model/item.js:384` fills a
    // component target's `template:` from `aid.type` for every card that names none, so
    // honouring it at rung 1 shadowed `templateFor.plotEssential` corpus-wide.
    const tf = { plotEssential: { Character: [{ field: 'name', label: 'Branch PE' }] } };
    const out = renderPlacementBody(
      item, { component: 'plotEssential', template: 'Character' }, new Map(), new Map(), {},
      new Diagnostics(), { fieldTable, templateFor: tf },
    );
    expect(out).toBe('Branch PE: Aness');
  });

  test('a target.template equal to aid.type also falls through to templateFor.base', () => {
    const tf = { base: { Character: [{ field: 'name', label: 'Branch Base' }] } };
    const out = renderPlacementBody(
      item, { component: 'plotEssential', template: 'Character' }, new Map(), new Map(), {},
      new Diagnostics(), { fieldTable, templateFor: tf },
    );
    expect(out).toBe('Branch Base: Aness');
  });

  test('a target.template equal to aid.type with no templateFor still resolves the type template (output-preserving)', () => {
    // The corpus relies on this: pre-Step-0 the type-fill `target.template` was what
    // resolved the shared-table `Character` list at rung 1. It now resolves at the lower
    // aid.type rung, unchanged.
    const out = renderPlacementBody(
      item, { component: 'plotEssential', template: 'Character' }, textTemplates, new Map(), {},
      new Diagnostics(), { fieldTable, templateFor: {} },
    );
    // `lookupNamedTemplate('Character', …)` — the text template 'character' wins over the
    // shared field list of the same name, exactly as the body ladder's rung 3 does.
    expect(out).toBe('Aness');
  });

  test('Pattern 2: a differing target.template names a free-standing list in the component slot file', () => {
    const tf = {
      plotEssential: {
        Character: [{ field: 'name', label: 'Terse' }],
        CharacterFull: [{ field: 'name', label: 'Full PE' }],
      },
    };
    const out = renderPlacementBody(
      item, { component: 'plotEssential', template: 'CharacterFull' }, new Map(), new Map(), {},
      new Diagnostics(), { fieldTable, templateFor: tf },
    );
    expect(out).toBe('Full PE: Aness');
  });

  test('rung 3: falls back to templateFor.base', () => {
    const tf = { base: { Character: [{ field: 'name', label: 'Base' }] } };
    const out = renderPlacementBody(
      item, { component: 'aiInstructions' }, new Map(), new Map(), {}, new Diagnostics(),
      { fieldTable, templateFor: tf },
    );
    expect(out).toBe('Base: Aness');
  });

  test('no template and no body text → null and a diagnostic (unchanged)', () => {
    const d = new Diagnostics();
    const out = renderPlacementBody(
      { id: 'B', aid: { type: 'Nope' }, body: {} }, { component: 'plotEssential' },
      new Map(), new Map(), {}, d, {},
    );
    expect(out).toBeNull();
    expect(d.errors).toHaveLength(1);
  });
});
