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
