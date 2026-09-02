'use strict';

/**
 * The unread-field audit (v4 spec §13.6, Phase 12 Step 4 — Decision 4).
 *
 * What is worth asserting here is behavior the golden corpus and the pathological snapshot
 * only touch obliquely: the resolved-leaf-path rule (a `from:` sub-key typo is still
 * caught), the guard-vs-content distinction, `{ allowExtra: true }`, passthrough scanning,
 * and the `(item id, field path)` dedupe firing once across repeated audits of one item.
 */

const { buildFieldAudit, readablePathsFor, bodyLeafPaths } = require('../../src/render/field-audit');

/** Minimal diagnostics sink — records `warn(code, message)` calls. */
function sink() {
  const calls = [];
  return {
    calls,
    warn(code, message) { calls.push({ code, message }); },
    codes() { return calls.map((c) => c.code); },
  };
}

const TABLE = {
  fields: {
    name: { label: 'Name' },
    vibe: { label: 'Vibe' },
    personalityExpanded: { from: 'personality.expanded', render: 'list' },
    homeland: { label: 'Homeland' },
    quirk: { label: 'Quirk' },
    loose: { label: 'Loose' },
    deadField: { label: 'Dead' },
  },
  groups: {
    personality: [
      { raw: '{if $body.personality}Personality:{/if} {join(", ", $body.personality.keywords)}' },
      'personalityExpanded',
    ],
    origin: ['homeland', 'quirk'],
  },
  templates: {
    Person: ['name', 'vibe', 'personality'],
    Place: ['name', 'origin'],
    Bare: ['name', 'loose'],
    Open: [{ allowExtra: true }, 'name'],
  },
  _sources: ['fields.cl.yaml'],
};

const PARTIALS = new Map([
  ['namewithtagline', { content: '{$name}{if $body.tagline} - {join("; ", $body.tagline)}{/if}' }],
]);

const mk = (id, type, body) => ({ id, _source: 'items.cl.yaml', aid: { type }, body });

describe('readablePathsFor', () => {
  test('a bare field contributes its name as a content path; a from: field its from-paths', () => {
    const { content } = readablePathsFor(TABLE.templates.Person, TABLE, PARTIALS);
    expect(content.has('name')).toBe(true);
    expect(content.has('vibe')).toBe(true);
    expect(content.has('personality.keywords')).toBe(true);
    expect(content.has('personality.expanded')).toBe(true);
  });

  test('an {if $body.X} guard only acknowledges X — it is not a content read', () => {
    const { content, ack } = readablePathsFor(TABLE.templates.Person, TABLE, PARTIALS);
    expect(ack.has('personality')).toBe(true);
    expect(content.has('personality')).toBe(false);
  });

  test('{ allowExtra: true } sets the flag', () => {
    expect(readablePathsFor(TABLE.templates.Open, TABLE, PARTIALS).allowExtra).toBe(true);
    expect(readablePathsFor(TABLE.templates.Person, TABLE, PARTIALS).allowExtra).toBe(false);
  });

  test('a passthrough {include} scans the partial body for $body refs', () => {
    const { content } = readablePathsFor(['name', { include: 'namewithtagline' }], TABLE, PARTIALS);
    expect(content.has('tagline')).toBe(true);
  });
});

describe('bodyLeafPaths', () => {
  test('descent stops at a content path — sub-keys of a rendered map are not leaves', () => {
    const content = new Set(['subAreas']);
    expect(bodyLeafPaths({ subAreas: { a: '1', b: '2' }, x: '3' }, content)).toEqual(['x']);
  });

  test('descends past a key that has content paths beneath it', () => {
    const content = new Set(['personality.keywords']);
    expect(bodyLeafPaths({ personality: { keywords: [], other: 'x' } }, content))
      .toEqual(['personality.other']);
  });
});

describe('buildFieldAudit — classification', () => {
  test('an undeclared body key is CL0426', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.auditBody(mk('Alba', 'Person', { name: 'A', vibe: 'v', strength: 'uncanny' }), TABLE.templates.Person, 'Person');
    a.finish(d);
    expect(d.codes()).toContain('CL0426');
    expect(d.calls.find((c) => c.code === 'CL0426').message).toMatch(/strength/);
  });

  test('a declared field the template routes elsewhere is CL0427, naming the group', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.auditBody(mk('Cairn', 'Person', { name: 'C', homeland: 'the flats' }), TABLE.templates.Person, 'Person');
    a.finish(d);
    const hit = d.calls.find((c) => c.code === 'CL0427');
    expect(hit).toBeTruthy();
    expect(hit.message).toMatch(/group `origin`/);
    expect(hit.message).toMatch(/homeland/);
  });

  test('a from: sub-key typo is CL0426 even though the parent field is read here', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    // Person reads personality.keywords / .expanded; .mood is neither.
    a.auditBody(
      mk('Mim', 'Person', { name: 'M', personality: { keywords: ['dry'], mood: 'sour' } }),
      TABLE.templates.Person, 'Person',
    );
    a.finish(d);
    const hit = d.calls.find((c) => c.message.includes('personality.mood'));
    expect(hit && hit.code).toBe('CL0426');
  });

  test('a declared field no template names is CL0428, once', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.finish(d);
    const dead = d.calls.filter((c) => c.code === 'CL0428');
    expect(dead).toHaveLength(1);
    expect(dead[0].message).toMatch(/deadField/);
  });

  test('{ allowExtra: true } suppresses every unknown-key finding for that template', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.auditBody(mk('Nook', 'Open', { name: 'N', colour: 'grey', texture: 'rough' }), TABLE.templates.Open, 'Open');
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426')).toEqual([]);
  });

  test('a bare field covering a map is fully read — its sub-keys are not flagged', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.auditBody(mk('Home', 'Bare', { name: 'H', loose: { one: '1', two: '2' } }), TABLE.templates.Bare, 'Bare');
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426' || c === 'CL0427')).toEqual([]);
  });
});

describe('buildFieldAudit — templateFor slot files (§13.4, Phase 14 Step 1)', () => {
  // A terse Person list — `name` only. Against the shared `Person` template it omits the
  // declared `vibe` and the `personality` group.
  const terseList = ['name'];
  const templateFor = { base: { Person: terseList } };
  const tierTemplates = [{ branch: 'lowContext', role: 'base', name: 'Person', list: terseList }];

  test('CL0428: a field named only by a tier list is not a dead declaration', () => {
    const d = sink();
    // `deadField` is in no shared template; naming it in a tier list clears the sweep.
    const tt = [{ branch: 'low', role: 'base', name: 'Terse', list: ['name', 'deadField'] }];
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS, tierTemplates: tt });
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0428')).toEqual([]);
  });

  test('CL0428: a field named by neither a shared template nor any tier list still fires', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS, tierTemplates });
    a.finish(d);
    const dead = d.calls.filter((c) => c.code === 'CL0428');
    expect(dead).toHaveLength(1);
    expect(dead[0].message).toMatch(/deadField/);
  });

  test('CL0427: a declared field a tier list omits is not a misroute when the branch templateFor is in hand', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS, tierTemplates });
    a.auditBody(
      mk('Aness', 'Person', { name: 'A', vibe: 'v' }), terseList, 'Person', { templateFor },
    );
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0427')).toEqual([]);
  });

  test('CL0427: the same omission on the same list still fires without the templateFor context', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS, tierTemplates });
    a.auditBody(mk('Aness', 'Person', { name: 'A', vibe: 'v' }), terseList, 'Person');
    a.finish(d);
    expect(d.codes()).toContain('CL0427');
  });

  test('CL0426: a genuinely unknown key is still flagged inside a tier render', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS, tierTemplates });
    a.auditBody(
      mk('Aness', 'Person', { name: 'A', strength: 'uncanny' }), terseList, 'Person', { templateFor },
    );
    a.finish(d);
    expect(d.codes()).toContain('CL0426');
  });
});

describe('buildFieldAudit — case-insensitive matching (renderer parity)', () => {
  // The renderer matches body fields case-insensitively, so the audit's own lookups must
  // too — a declaration/body pair that differs only in case is not a dropped-content bug.
  const CI_TABLE = {
    fields: {
      background: { label: 'Background' },
      Magic: { from: ['Magic.affinity', 'Magic.effect'] },
      magic2: { from: ['magic2.affinity', 'magic2.effect'] },
    },
    groups: {
      Lore: ['background'],
    },
    templates: {
      CaseTest: ['background', 'Magic', 'magic2', 'Lore'],
    },
    _sources: ['fields.cl.yaml'],
  };

  test('a lowercase declaration reading a capitalized body key raises no CL0426', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: CI_TABLE, partials: PARTIALS });
    a.auditBody(mk('Ren', 'CaseTest', { Background: 'a windswept coast' }), CI_TABLE.templates.CaseTest, 'CaseTest');
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426')).toEqual([]);
  });

  test('a from: declaration named Magic against body key Magic raises no CL0426', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: CI_TABLE, partials: PARTIALS });
    a.auditBody(
      mk('Sel', 'CaseTest', { Magic: { affinity: 'fire', effect: 'burn' } }),
      CI_TABLE.templates.CaseTest, 'CaseTest',
    );
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426')).toEqual([]);
  });

  test('the lowercase mirror — declaration magic2 against body key magic2 — also raises no CL0426', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: CI_TABLE, partials: PARTIALS });
    a.auditBody(
      mk('Tam', 'CaseTest', { magic2: { affinity: 'ice', effect: 'freeze' } }),
      CI_TABLE.templates.CaseTest, 'CaseTest',
    );
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426')).toEqual([]);
  });

  test('a group named in a template list resolves its members when the group name case differs', () => {
    const { content } = readablePathsFor(['lore'], CI_TABLE, PARTIALS);
    expect(content.has('background')).toBe(true);
  });

  test('a genuinely undeclared body key still raises CL0426 — no over-suppression', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: CI_TABLE, partials: PARTIALS });
    a.auditBody(mk('Wren', 'CaseTest', { Background: 'a coast', strength: 'uncanny' }), CI_TABLE.templates.CaseTest, 'CaseTest');
    a.finish(d);
    expect(d.codes()).toContain('CL0426');
    expect(d.calls.find((c) => c.code === 'CL0426').message).toMatch(/strength/);
  });

  test('a CL0426 message about body key Background keeps the author\'s casing', () => {
    const d = sink();
    const noBgTable = {
      fields: {},
      groups: {},
      templates: { Empty: ['name'] },
      _sources: ['fields.cl.yaml'],
    };
    const a = buildFieldAudit({ fieldTable: noBgTable, partials: PARTIALS });
    a.auditBody(mk('Iona', 'Empty', { Background: 'a coast' }), noBgTable.templates.Empty, 'Empty');
    a.finish(d);
    const hit = d.calls.find((c) => c.code === 'CL0426');
    expect(hit.message).toContain('"Background"');
    expect(hit.message).not.toContain('"background"');
  });
});

describe('buildFieldAudit — dedupe on (item id, field path)', () => {
  test('auditing the same item on many leaves reports each field once', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    const item = mk('Alba', 'Person', { name: 'A', vibe: 'v', strength: 'uncanny', bravado: 'loud' });
    for (let i = 0; i < 32; i += 1) a.auditBody(item, TABLE.templates.Person, 'Person');
    a.finish(d);
    const perItem = d.calls.filter((c) => c.code === 'CL0426');
    expect(perItem).toHaveLength(2); // strength, bravado — not 64
    expect(perItem.map((c) => c.message.match(/key "(\w+)"/)[1]).sort()).toEqual(['bravado', 'strength']);
  });
});
