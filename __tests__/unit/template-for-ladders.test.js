'use strict';

/**
 * The three resolution ladders with `templateFor` inserted (v4 spec §13.4, Phase 12 Step 2).
 *
 * Each ladder is exercised rung by rung, and the load-bearing assertion is that rung 1 —
 * the per-item override — still wins over a branch's `templateFor` slot.
 */

const {
  resolveBodyRender, resolveNotesRender, renderPlacementBody,
} = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');

const textTemplates = new Map([
  ['character', { content: '{$body.name}', _source: 'Character.template' }],
  ['character.notes', { content: 'NOTES {$notes.k}', _source: 'Character.notes.template' }],
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
  test('rung 1: item render.template names a field-list template', () => {
    const hit = resolveBodyRender(
      { render: { template: 'Fancy' }, aid: { type: 'Character' } }, textTemplates, fieldTable, {},
    );
    expect(hit).toMatchObject({ kind: 'fieldList', name: 'Fancy' });
  });

  test('rung 1 still wins over a templateFor.base entry for the same type', () => {
    const tf = { base: { Character: [{ field: 'name', label: 'Branch' }] } };
    const hit = resolveBodyRender(
      { render: { template: 'Character' }, aid: { type: 'Character' } }, textTemplates, fieldTable, tf,
    );
    // render.template: Character resolves the *named* template (here the text one), not the
    // branch's type→list map.
    expect(hit).toEqual({ kind: 'text', entry: textTemplates.get('character'), name: 'Character' });
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

describe('resolveNotesRender — notes ladder', () => {
  test('rung 1: item render.notesTemplate, named', () => {
    expect(resolveNotesRender(
      { render: { notesTemplate: 'Fancy' }, aid: { type: 'Character' } }, 'Character',
      textTemplates, fieldTable, null, {},
    )).toMatchObject({ kind: 'fieldList', name: 'Fancy' });
  });

  test('rung 2: <bodyName>.notes suffix still resolves (kept, not replaced)', () => {
    expect(resolveNotesRender({ aid: { type: 'Character' } }, 'Character', textTemplates, fieldTable, null, {}))
      .toEqual({ kind: 'text', entry: textTemplates.get('character.notes'), name: 'Character.notes' });
  });

  test('rung 3: templateFor.notes keyed on aid.type, with the notes ref root', () => {
    const tf = { notes: { Character: [{ field: 'k', label: 'K' }] } };
    const hit = resolveNotesRender({ aid: { type: 'Character' } }, 'Other', new Map(), { templates: {} }, null, tf);
    expect(hit).toMatchObject({ kind: 'fieldList', refRoot: 'notes' });
    expect(hit.list).toBe(tf.notes.Character);
  });

  test('rung 4: the branch/project notesTemplate name', () => {
    expect(resolveNotesRender({ aid: { type: 'X' } }, 'X', textTemplates, fieldTable, 'Fancy', {}))
      .toMatchObject({ kind: 'fieldList', name: 'Fancy' });
  });

  test('rung 1 with an unknown name is a missing marker, not a silent fall-through', () => {
    expect(resolveNotesRender({ render: { notesTemplate: 'Ghost' }, aid: { type: 'X' } }, 'X',
      new Map(), { templates: {} }, 'Fancy', {})).toEqual({ kind: 'missing', name: 'Ghost' });
  });

  test('nothing set → null (§4.5 default)', () => {
    expect(resolveNotesRender({ aid: { type: 'X' } }, 'X', new Map(), { templates: {} }, null, {})).toBeNull();
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
