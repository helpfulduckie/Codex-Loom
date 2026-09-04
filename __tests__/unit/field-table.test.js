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

  // Composition primitive, step 3a (2026-09-03 handoff): `parts:` is a source *plus* a
  // composition, so carrying it alongside `from:` on one declaration is an author error
  // rather than two settings that combine. No CL04xx code already names "two mutually
  // exclusive keys given together"; CL0422 ("entry has the wrong shape") is reused rather
  // than a new code being minted, since diagnostic numbering is a human decision.
  describe('parts: and from: are mutually exclusive', () => {
    const dir = path.join(FIXTURE, '__parts-from-conflict__');
    beforeAll(() => {
      require('fs').mkdirSync(dir, { recursive: true });
      require('fs').writeFileSync(path.join(dir, 'fields.cl.yaml'), [
        'fields:',
        '  conflicted: { label: X, from: a, parts: [$body.a] }',
        '  nested: { label: Y, parts: [$body.a, { from: b, parts: [$body.c] }] }',
        '  clean: { label: Z, parts: [$body.a] }',
      ].join('\n'));
    });
    afterAll(() => require('fs').rmSync(dir, { recursive: true, force: true }));

    test('a top-level from: + parts: conflict is CL0422, and the field still loads', () => {
      const d = new Diagnostics();
      const table = loadFieldTable([dir], { diagnostics: d });
      const codes = d.errors.map((e) => e.code);
      expect(codes).toContain(CODES.FIELD_TABLE_MALFORMED);
      expect(d.errors.some((e) => e.message.includes('conflicted'))).toBe(true);
      expect(table.fields.conflicted).toBeDefined();
    });

    test('the conflict is caught inside a nested part too', () => {
      const d = new Diagnostics();
      loadFieldTable([dir], { diagnostics: d });
      const msgs = d.errors.filter((e) => e.code === CODES.FIELD_TABLE_MALFORMED).map((e) => e.message);
      expect(msgs.some((m) => m.includes('nested part') && m.includes('nested'))).toBe(true);
    });

    test('a clean parts: declaration with no from: raises nothing', () => {
      const d = new Diagnostics();
      loadFieldTable([dir], { diagnostics: d });
      const msgs = d.errors.filter((e) => e.code === CODES.FIELD_TABLE_MALFORMED).map((e) => e.message);
      expect(msgs.some((m) => m.includes('"clean"'))).toBe(false);
    });
  });

  // `try:` (Decision 7 — 2026-09-03 handoff) is a third source specification, mutually
  // exclusive with `from:` and `parts:` the same way those two are exclusive with each other —
  // `checkSourceConflict` covers all three pairings rather than a second, parallel check.
  describe('try: is mutually exclusive with from: and parts:', () => {
    const dir = path.join(FIXTURE, '__try-source-conflict__');
    beforeAll(() => {
      require('fs').mkdirSync(dir, { recursive: true });
      require('fs').writeFileSync(path.join(dir, 'fields.cl.yaml'), [
        'fields:',
        '  tryFrom: { label: X, from: a, try: [b, c] }',
        '  tryParts: { label: Y, parts: [$body.a], try: [b, c] }',
        '  nested: { label: Z, try: [b, { from: c, try: [d] }] }',
        '  clean: { label: W, try: [b, c] }',
      ].join('\n'));
    });
    afterAll(() => require('fs').rmSync(dir, { recursive: true, force: true }));

    test('try: + from: on one declaration is CL0422, and the field still loads', () => {
      const d = new Diagnostics();
      const table = loadFieldTable([dir], { diagnostics: d });
      const codes = d.errors.map((e) => e.code);
      expect(codes).toContain(CODES.FIELD_TABLE_MALFORMED);
      expect(d.errors.some((e) => e.message.includes('tryFrom'))).toBe(true);
      expect(table.fields.tryFrom).toBeDefined();
    });

    test('try: + parts: on one declaration is CL0422 too', () => {
      const d = new Diagnostics();
      loadFieldTable([dir], { diagnostics: d });
      expect(d.errors.some((e) => e.code === CODES.FIELD_TABLE_MALFORMED
        && e.message.includes('tryParts'))).toBe(true);
    });

    test('the conflict is caught inside a nested try: source too', () => {
      const d = new Diagnostics();
      loadFieldTable([dir], { diagnostics: d });
      const msgs = d.errors.filter((e) => e.code === CODES.FIELD_TABLE_MALFORMED).map((e) => e.message);
      expect(msgs.some((m) => m.includes('nested try source') && m.includes('nested'))).toBe(true);
    });

    test('a clean try: declaration with no from:/parts: raises nothing', () => {
      const d = new Diagnostics();
      loadFieldTable([dir], { diagnostics: d });
      const msgs = d.errors.filter((e) => e.code === CODES.FIELD_TABLE_MALFORMED).map((e) => e.message);
      expect(msgs.some((m) => m.includes('"clean"'))).toBe(false);
    });
  });

});

describe('FIELD_TABLE_SCHEMA stays in step with the procedural loader', () => {
  // The declarative descriptor (`field-table-schema.js`, used by the schema engine and by
  // the doc-example test) and the procedural fold in `field-table.js` are two views of one
  // surface. This binds them so a key added to one is added to the other.
  const { FIELD_KEYS } = require('../../src/loader/field-table');
  const { FIELD_DECL, RENDER_FUNCTIONS } = require('../../src/loader/field-table-schema');
  const { FUNCTION_NAMES } = require('../../src/render/parse');

  test('a fields: entry declares exactly the keys FIELD_KEYS allows', () => {
    expect(Object.keys(FIELD_DECL.keys).sort()).toEqual([...FIELD_KEYS].sort());
  });

  test('the render set is the seven functions plus bare, taken from render/parse', () => {
    expect(RENDER_FUNCTIONS).toEqual([...FUNCTION_NAMES, 'bare']);
  });
});
