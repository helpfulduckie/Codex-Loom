'use strict';

/**
 * The generated schema reference (v4 spec §13.8, Phase 12 Step 5).
 *
 * The golden harness freezes the whole document per project; this file pins the pieces
 * that matter in isolation — the render/label derivation, group membership with its
 * "named by" reverse lookup, and the ordered type-to-field expansion including the
 * escape-hatch entries.
 */

const { generateSchemaTables } = require('../../src/schematables');

const TABLE = {
  fields: {
    vibe: { label: 'Vibe', join: '; ', wrap: '[]' },
    appearance: { label: 'Appearance', join: '; ', labelWhen: { originalAppearance: 'Current Appearance' } },
    magic: { label: 'Magic', from: ['magic.affinity', 'magic.effect'], join: '; ' },
    effect: {},
    subAreas: { label: 'Sub Areas', block: true },
    cohortMaster: { label: 'Cohort Master', always: true },
    unused: { label: 'Unused' },
  },
  groups: {
    skills: ['magic'],
    geography: ['subAreas'],
  },
  templates: {
    Character: [{ include: 'cardHeader' }, 'vibe', 'appearance', 'skills', { include: 'cardFooter' }],
    Location: [{ allowExtra: true }, 'vibe', 'geography'],
    Directory: [{ raw: '{if $body.x}{$body.x}{/if}' }, 'effect'],
  },
};

const md = generateSchemaTables(TABLE, { title: 'T' });

describe('Fields table', () => {
  test('a join field shows its separator; a bare {} field renders bare', () => {
    expect(md).toMatch(/\| `vibe` \| Vibe \| join "; " \| `vibe` _\(wrap \[\]\)_ \|/);
    expect(md).toMatch(/\| `effect` \| — \| bare \| `effect` \|/);
  });

  test('labelWhen is shown as a conditional', () => {
    expect(md).toMatch(/`appearance` \| Current Appearance \/ Appearance _\(conditional\)_ \|/);
  });

  test('from: paths appear in the Reads column, not the field name', () => {
    expect(md).toMatch(/\| `magic` \| Magic \| join "; " \| `magic\.affinity`, `magic\.effect` \|/);
  });

  test('structural flags are surfaced', () => {
    expect(md).toMatch(/`subAreas`.*_\(block\)_/);
    expect(md).toMatch(/`cohortMaster`.*_\(always\)_/);
  });
});

describe('Groups table', () => {
  test('names each group member and the templates that name the group', () => {
    expect(md).toMatch(/\| `skills` \| `magic` \| `Character` \|/);
    expect(md).toMatch(/\| `geography` \| `subAreas` \| `Location` \|/);
  });
});

describe('Type to fields', () => {
  test('lists fields in order, expanding a group to its members', () => {
    const section = md.slice(md.indexOf('### `Character`'));
    expect(section).toMatch(/- _\(include: cardHeader\)_\n- `vibe`\n- `appearance`\n- \*\*skills\*\* _\(group\)_: `magic`/);
  });

  test('surfaces an { allowExtra: true } marker and a raw entry', () => {
    expect(md.slice(md.indexOf('### `Location`'))).toMatch(/- _\(allowExtra\)_/);
    expect(md.slice(md.indexOf('### `Directory`'))).toMatch(/- _\(raw\)_\n- `effect`/);
  });
});

describe('provenance line', () => {
  test('states it supersedes SCHEMA.md and that disagreement means drift', () => {
    expect(md).toMatch(/supersede the hand-maintained copies/);
    expect(md).toMatch(/where they disagree, `SCHEMA\.md` has drifted/);
  });
});

describe('Role and tier templates', () => {
  test('the section is absent when no templateFor is declared', () => {
    expect(md).not.toMatch(/## Role and tier templates/);
    expect(generateSchemaTables(TABLE, { title: 'T', tierTemplates: [] }))
      .not.toMatch(/## Role and tier templates/);
  });

  test('a terse base list and a Pattern 2 name are listed under their branch and role', () => {
    const withTiers = generateSchemaTables(TABLE, {
      title: 'T',
      tierTemplates: [
        { branch: 'lowContext', role: 'base', name: 'Character', list: ['vibe', { field: 'appearance', label: 'Look' }] },
        { branch: 'lowContext', role: 'base', name: 'CharacterFull', list: ['vibe', 'appearance', 'skills'] },
      ],
    });
    expect(withTiers).toMatch(/## Role and tier templates/);
    expect(withTiers).toMatch(/### Branch `lowContext` — role `base`/);
    const section = withTiers.slice(withTiers.indexOf('#### `Character`'));
    expect(section).toMatch(/#### `Character`\n\n- `vibe`\n- `appearance` _\(override\)_/);
    expect(section).toMatch(/#### `CharacterFull`\n\n- `vibe`\n- `appearance`\n- \*\*skills\*\* _\(group\)_: `magic`/);
  });
});
