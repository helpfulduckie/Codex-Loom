'use strict';

/**
 * The field-declaration table loader (v4 spec §13.2–§13.5, Phase 12 Step 0).
 *
 * The load's dangerous property is that its merge rule is invisible in a single-directory
 * test: `loadNamedFiles`' per-file replacement and this loader's per-entry replacement
 * produce identical results until a second directory overrides one entry. So the headline
 * test here uses the two-directory fixture and asserts the sibling entries survive.
 */

const path = require('path');

const { Diagnostics } = require('../../src/diag');
const { loadFieldTable, CODES } = require('../../src/loader/field-table');
const { loadTemplates } = require('../../src/loader');

const FIXTURE = path.resolve(__dirname, '../fixtures/field-table');
const BASE = path.join(FIXTURE, 'base');
const OVERLAY = path.join(FIXTURE, 'overlay');

describe('loadFieldTable', () => {
  test('a single directory loads all three namespaces', () => {
    const table = loadFieldTable(BASE);
    expect(Object.keys(table.fields)).toEqual(expect.arrayContaining(
      ['name', 'vibe', 'appearance', 'personality', 'secret', 'landmarks'],
    ));
    expect(table.groups.core).toEqual(['name', 'vibe', 'appearance', 'personality']);
    expect(table.templates.Character).toEqual(
      ['core', 'abilities', 'magic', 'pantheon', 'relationships', 'secret'],
    );
  });

  test('a later directory overrides one entry key-wise, leaving siblings from the first', () => {
    const table = loadFieldTable([BASE, OVERLAY]);
    // The overridden entry is replaced wholesale — no `labelWhen` in the overlay, so the
    // base's conditional-label rule for `appearance` is gone, not merged.
    expect(table.fields.appearance).toEqual({ label: 'Face', join: '; ' });
    // Siblings the overlay never mentions still resolve from the base.
    expect(table.fields.vibe).toEqual({ label: 'Vibe', join: '; ', wrap: '[]' });
    expect(table.fields.personality).toEqual({ label: 'Personality', render: 'list' });
    expect(table.groups.core).toEqual(['name', 'vibe', 'appearance', 'personality']);
  });

  test('directory order decides the winner', () => {
    const table = loadFieldTable([OVERLAY, BASE]);
    // BASE now wins `appearance`, so its conditional label comes back.
    expect(table.fields.appearance.labelWhen).toEqual({ originalAppearance: 'Current Appearance' });
  });

  test('loadTemplates surfaces the field table beside templates and partials', () => {
    const diagnostics = new Diagnostics();
    const { templates, fieldTable } = loadTemplates([BASE], { diagnostics });
    expect(templates.has('character')).toBe(true);
    expect(fieldTable.templates.Character).toBeDefined();
    expect(diagnostics.errors).toEqual([]);
  });

  test('the good fixture raises nothing', () => {
    const diagnostics = new Diagnostics();
    loadFieldTable([BASE, OVERLAY], { diagnostics });
    expect(diagnostics.errors).toEqual([]);
    expect(diagnostics.warnings).toEqual([]);
  });

  describe('the malformed fixture', () => {
    let diagnostics;
    let table;
    beforeAll(() => {
      diagnostics = new Diagnostics();
      table = loadFieldTable([path.join(FIXTURE, 'malformed')], { diagnostics });
    });

    test('an unknown key on a field is CL0423, and the field still loads', () => {
      const codes = diagnostics.errors.map((d) => d.code);
      expect(codes).toContain(CODES.FIELD_TABLE_UNKNOWN_KEY);
      expect(table.fields.weird).toBeDefined();
      expect(table.fields.good).toEqual({ label: 'Good', join: '; ' });
    });

    test('an unknown render function is CL0423', () => {
      const msg = diagnostics.errors
        .filter((d) => d.code === CODES.FIELD_TABLE_UNKNOWN_KEY)
        .map((d) => d.message);
      expect(msg.some((m) => m.includes('sparkle'))).toBe(true);
    });

    test('a group member and a template entry that name nothing are CL0424 WARNs', () => {
      const badRefs = diagnostics.warnings.filter((d) => d.code === CODES.FIELD_TABLE_BAD_REF);
      expect(badRefs.map((d) => d.message).join('\n')).toMatch(/missingMember/);
      expect(badRefs.map((d) => d.message).join('\n')).toMatch(/alsoMissing/);
    });

    test('a misspelled fields.cl.yaml is a CL0425 WARN and is ignored', () => {
      const stray = diagnostics.warnings.filter((d) => d.code === CODES.FIELD_TABLE_STRAY_FILE);
      expect(stray).toHaveLength(1);
      expect(stray[0].message).toMatch(/fyelds\.cl\.yaml/);
      expect(table.templates.Ignored).toBeUndefined();
    });

    test('an unrelated .cl.yaml (a templateFor slot file) is NOT flagged', () => {
      const d = new Diagnostics();
      const dir = path.join(FIXTURE, '__slot__');
      require('fs').mkdirSync(dir, { recursive: true });
      require('fs').writeFileSync(path.join(dir, 'terse.cl.yaml'), 'templates:\n  Character: [name]\n');
      try {
        loadFieldTable([dir], { diagnostics: d });
        expect(d.warnings.filter((x) => x.code === CODES.FIELD_TABLE_STRAY_FILE)).toEqual([]);
      } finally {
        require('fs').rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test('CL0422–CL0425 form a contiguous band in the render decade', () => {
    expect([
      CODES.FIELD_TABLE_MALFORMED,
      CODES.FIELD_TABLE_UNKNOWN_KEY,
      CODES.FIELD_TABLE_BAD_REF,
      CODES.FIELD_TABLE_STRAY_FILE,
    ]).toEqual(['CL0422', 'CL0423', 'CL0424', 'CL0425']);
  });
});
