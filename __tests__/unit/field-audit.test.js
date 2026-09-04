'use strict';

/**
 * The unread-field audit (v4 spec §13.6, Phase 12 Step 4 — Decision 4; rescoped
 * 2026-09-03, "Field Audit Rescoping").
 *
 * What is worth asserting here is behavior the golden corpus and the pathological snapshot
 * only touch obliquely: the resolved-leaf-path rule (a `from:` sub-key typo is still
 * caught), the guard-vs-content distinction, `{ allowExtra: true }`, passthrough scanning,
 * the `(item id, field path)` dedupe, and the three rescoping fixes —
 *   1. only project-authored body keys are audited on an imported item,
 *   2. a key is tested against the union of every list the item renders through,
 *   3. CL0428's dead-declaration sweep sees fields referenced only inside a partial.
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
    secret: { label: 'Hidden' },
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
    Roster: [{ include: 'rosterline' }],
    Card: ['name', 'vibe', 'secret'],
  },
  _sources: ['fields.cl.yaml'],
};

const PARTIALS = new Map([
  ['namewithtagline', { content: '{$name}{if $body.tagline} - {join("; ", $body.tagline)}{/if}' }],
  ['rosterline', { content: '{$aid.title} - {$body.homeland}; {$body.quirk}' }],
]);

const mk = (id, type, body) => ({ id, _source: 'items.cl.yaml', aid: { type }, body });
/** An imported item: `_projectAuthoredBody` lists the leaves the consumer touched. */
const mkImported = (id, type, body, projectAuthored) => {
  const item = mk(id, type, body);
  Object.defineProperty(item, '_projectAuthoredBody', { value: projectAuthored, enumerable: false });
  return item;
};

describe('readablePathsFor', () => {
  test('a bare field contributes its name as a content path; a from: field its from-paths', () => {
    const { content } = readablePathsFor(TABLE.templates.Person, TABLE, PARTIALS);
    expect(content.has('body.name')).toBe(true);
    expect(content.has('body.vibe')).toBe(true);
    expect(content.has('body.personality.keywords')).toBe(true);
    expect(content.has('body.personality.expanded')).toBe(true);
  });

  test('an {if $body.X} guard only acknowledges X — it is not a content read', () => {
    const { content, ack } = readablePathsFor(TABLE.templates.Person, TABLE, PARTIALS);
    expect(ack.has('body.personality')).toBe(true);
    expect(content.has('body.personality')).toBe(false);
  });

  test('{ allowExtra: true } sets the flag', () => {
    expect(readablePathsFor(TABLE.templates.Open, TABLE, PARTIALS).allowExtra).toBe(true);
    expect(readablePathsFor(TABLE.templates.Person, TABLE, PARTIALS).allowExtra).toBe(false);
  });

  test('a passthrough {include} scans the partial body for $body refs', () => {
    const { content } = readablePathsFor(['name', { include: 'namewithtagline' }], TABLE, PARTIALS);
    expect(content.has('body.tagline')).toBe(true);
  });

  // Composition primitive, step 3a (2026-09-03 handoff, Decision 8's `parts:` half): every
  // ref at every depth of a `parts:` list must reach `content`, root-qualified, or a field
  // an item genuinely reads through `parts:` looks unread to the audit.
  describe('parts: refs at every depth', () => {
    const partsTable = {
      fields: {
        line: {
          parts: [
            '$name.full',
            ' - ',
            { parts: [{ from: 'tagline' }, '; ', { from: 'notes.extra' }] },
          ],
        },
      },
      groups: {}, templates: { Line: ['line'] },
      _sources: ['fields.cl.yaml'],
    };

    test('a top-level $ ref qualifies to its own root, not body', () => {
      const { content } = readablePathsFor(partsTable.templates.Line, partsTable, new Map());
      expect(content.has('name.full')).toBe(true);
      expect(content.has('body.name.full')).toBe(false);
    });

    test('a nested from: ref reaches content, body-qualified, at any depth', () => {
      const { content } = readablePathsFor(partsTable.templates.Line, partsTable, new Map());
      expect(content.has('body.tagline')).toBe(true);
      expect(content.has('body.notes.extra')).toBe(true);
    });

    test('a literal part contributes no ref', () => {
      const { content } = readablePathsFor(partsTable.templates.Line, partsTable, new Map());
      expect([...content].some((c) => c.includes('-'))).toBe(false);
    });

    test('a body key read only through a nested parts: ref is not flagged CL0426', () => {
      const d = sink();
      const a = buildFieldAudit({ fieldTable: partsTable, partials: new Map() });
      a.collectForItem(
        mk('L', 'Line', { tagline: 'hi', notes: { extra: 'more' } }),
        partsTable.templates.Line,
      );
      a.finish(d);
      expect(d.codes()).not.toContain('CL0426');
    });
  });

  // `try:` (Decision 7's field-audit half, 2026-09-03 handoff): every source is read,
  // whichever one resolves at render time — unlike `parts:`, `try:` has no literal entries
  // to skip, so every source must reach `content` or a genuinely-read one looks unread.
  describe('try: sources all reach content, not just the winner', () => {
    const tryTable = {
      fields: {
        directory: { try: ['content', 'entries'], render: 'list' },
        nested: { try: [{ from: 'a' }, { parts: ['$body.b', '; ', { from: 'notes.c' }] }] },
      },
      groups: {}, templates: { Directory: ['directory'], Nested: ['nested'] },
      _sources: ['fields.cl.yaml'],
    };

    test('a bare try: source qualifies with refRoot, like a from: path', () => {
      const { content } = readablePathsFor(tryTable.templates.Directory, tryTable, new Map());
      expect(content.has('body.content')).toBe(true);
      expect(content.has('body.entries')).toBe(true);
    });

    test('the second source is read even though the first would win at render time', () => {
      const d = sink();
      const a = buildFieldAudit({ fieldTable: tryTable, partials: new Map() });
      a.collectForItem(
        mk('D', 'Directory', { content: 'c1', entries: 'c2' }),
        tryTable.templates.Directory,
      );
      a.finish(d);
      expect(d.codes()).not.toContain('CL0426');
    });

    test('a nested from:/parts: source inside try: reaches content at every depth', () => {
      const { content } = readablePathsFor(tryTable.templates.Nested, tryTable, new Map());
      expect(content.has('body.a')).toBe(true);
      expect(content.has('body.b')).toBe(true);
      expect(content.has('body.notes.c')).toBe(true);
    });
  });
});

describe('bodyLeafPaths', () => {
  test('descent stops at a content path — sub-keys of a rendered map are not leaves', () => {
    const content = new Set(['body.subAreas']);
    expect(bodyLeafPaths({ subAreas: { a: '1', b: '2' }, x: '3' }, content)).toEqual(['body.x']);
  });

  test('descends past a key that has content paths beneath it', () => {
    const content = new Set(['body.personality.keywords']);
    expect(bodyLeafPaths({ personality: { keywords: [], other: 'x' } }, content))
      .toEqual(['body.personality.other']);
  });
});

describe('buildFieldAudit — classification', () => {
  test('an undeclared body key is CL0426', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.collectForItem(mk('Alba', 'Person', { name: 'A', vibe: 'v', strength: 'uncanny' }), TABLE.templates.Person);
    a.finish(d);
    expect(d.codes()).toContain('CL0426');
    expect(d.calls.find((c) => c.code === 'CL0426').message).toMatch(/strength/);
  });

  test('a declared field the template routes elsewhere is CL0427, naming the group', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.collectForItem(mk('Cairn', 'Person', { name: 'C', homeland: 'the flats' }), TABLE.templates.Person);
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
    a.collectForItem(
      mk('Mim', 'Person', { name: 'M', personality: { keywords: ['dry'], mood: 'sour' } }),
      TABLE.templates.Person,
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
    a.collectForItem(mk('Nook', 'Open', { name: 'N', colour: 'grey', texture: 'rough' }), TABLE.templates.Open);
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426')).toEqual([]);
  });

  test('a bare field covering a map is fully read — its sub-keys are not flagged', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.collectForItem(mk('Home', 'Bare', { name: 'H', loose: { one: '1', two: '2' } }), TABLE.templates.Bare);
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426' || c === 'CL0427')).toEqual([]);
  });
});

describe('buildFieldAudit — Fix 2: union of every list the item renders through', () => {
  test('a key one list omits but another reads is not flagged', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    const item = mk('Ash', 'Card', { name: 'A', vibe: 'v', secret: 'buried', homeland: 'the flats' });
    // The card reads secret; the roster (via its partial) reads homeland. Neither alone
    // covers both, but together they do.
    a.collectForItem(item, TABLE.templates.Card);
    a.collectForItem(item, TABLE.templates.Roster);
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426' || c === 'CL0427')).toEqual([]);
  });

  test('a key no list in the union reads is still flagged, once', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    const item = mk('Ble', 'Card', { name: 'B', vibe: 'v', strength: 'uncanny' });
    a.collectForItem(item, TABLE.templates.Card);
    a.collectForItem(item, TABLE.templates.Roster);
    a.finish(d);
    const hits = d.calls.filter((c) => c.code === 'CL0426');
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toMatch(/strength/);
  });

  test('the CL0427 message is item-scoped, not template-scoped', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.collectForItem(mk('Cwm', 'Card', { name: 'C', vibe: 'v', quirk: 'humming' }), TABLE.templates.Card);
    a.finish(d);
    const hit = d.calls.find((c) => c.code === 'CL0427');
    expect(hit.message).toMatch(/no template this item renders through/);
    expect(hit.message).toMatch(/group `origin`/);
  });
});

describe('buildFieldAudit — Fix 1: only project-authored keys on an imported item', () => {
  test('a library key the consumer never touched is silent even when no list reads it', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    // `strength` is undeclared and unread, but it came from the library — not in the stamp.
    a.collectForItem(
      mkImported('Dov', 'Person', { name: 'D', vibe: 'v', strength: 'inherited' }, ['vibe']),
      TABLE.templates.Person,
    );
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426' || c === 'CL0427')).toEqual([]);
  });

  test('a key the consumer introduced is audited — CL0426', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.collectForItem(
      mkImported('Eos', 'Person', { name: 'E', vibe: 'v', strength: 'added here' }, ['strength']),
      TABLE.templates.Person,
    );
    a.finish(d);
    expect(d.codes()).toContain('CL0426');
    expect(d.calls.find((c) => c.code === 'CL0426').message).toMatch(/strength/);
  });

  test('a declared key the consumer changed the value of is audited — CL0427', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.collectForItem(
      mkImported('Fen', 'Person', { name: 'F', vibe: 'v', homeland: 'overridden' }, ['homeland']),
      TABLE.templates.Person,
    );
    a.finish(d);
    expect(d.codes()).toContain('CL0427');
  });

  test('an empty stamp silences everything — a lean consumer rendering a subset is not an error', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.collectForItem(
      mkImported('Gul', 'Person', { name: 'G', vibe: 'v', homeland: 'x', strength: 'y' }, []),
      TABLE.templates.Person,
    );
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426' || c === 'CL0427')).toEqual([]);
  });

  test('a pure local item (no stamp) audits every key — unchanged behavior', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.collectForItem(mk('Hod', 'Person', { name: 'H', vibe: 'v', strength: 'uncanny' }), TABLE.templates.Person);
    a.finish(d);
    expect(d.codes()).toContain('CL0426');
  });
});

describe('buildFieldAudit — Fix 3: CL0428 sees fields referenced only inside a partial', () => {
  test('a field read only through {include: partial} is not a dead declaration', () => {
    const d = sink();
    // `homeland` and `quirk` are named by no `templates:` list directly — only by
    // `rosterline.partial`, reached through the `Roster` template's {include}.
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    a.finish(d);
    const dead = d.calls.filter((c) => c.code === 'CL0428').map((c) => c.message);
    expect(dead.join('\n')).not.toMatch(/"homeland"/);
    expect(dead.join('\n')).not.toMatch(/"quirk"/);
    // deadField is genuinely named nowhere.
    expect(dead.join('\n')).toMatch(/deadField/);
  });

  test('a partial reached only from a tier list also clears the sweep', () => {
    const d = sink();
    const tt = [{ branch: 'low', role: 'base', name: 'Terse', list: [{ include: 'rosterline' }] }];
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS, tierTemplates: tt });
    a.finish(d);
    const dead = d.calls.filter((c) => c.code === 'CL0428').map((c) => c.message).join('\n');
    expect(dead).not.toMatch(/"homeland"/);
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

  test('CL0427: a declared field a tier list omits is not a misroute when it is the only list', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS, tierTemplates });
    a.collectForItem(
      mk('Aness', 'Person', { name: 'A', vibe: 'v' }), terseList, { templateFor },
    );
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0427')).toEqual([]);
  });

  test('CL0427: the same omission still fires when a real template is also in the union', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS, tierTemplates });
    const item = mk('Aness', 'Person', { name: 'A', quirk: 'humming' });
    a.collectForItem(item, terseList, { templateFor });
    a.collectForItem(item, TABLE.templates.Person); // a real template — quirk still unread
    a.finish(d);
    expect(d.codes()).toContain('CL0427');
  });

  test('CL0426: a genuinely unknown key is still flagged inside a tier render', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS, tierTemplates });
    a.collectForItem(
      mk('Aness', 'Person', { name: 'A', strength: 'uncanny' }), terseList, { templateFor },
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
    a.collectForItem(mk('Ren', 'CaseTest', { Background: 'a windswept coast' }), CI_TABLE.templates.CaseTest);
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426')).toEqual([]);
  });

  test('a from: declaration named Magic against body key Magic raises no CL0426', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: CI_TABLE, partials: PARTIALS });
    a.collectForItem(
      mk('Sel', 'CaseTest', { Magic: { affinity: 'fire', effect: 'burn' } }),
      CI_TABLE.templates.CaseTest,
    );
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426')).toEqual([]);
  });

  test('the lowercase mirror — declaration magic2 against body key magic2 — also raises no CL0426', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: CI_TABLE, partials: PARTIALS });
    a.collectForItem(
      mk('Tam', 'CaseTest', { magic2: { affinity: 'ice', effect: 'freeze' } }),
      CI_TABLE.templates.CaseTest,
    );
    a.finish(d);
    expect(d.codes().filter((c) => c === 'CL0426')).toEqual([]);
  });

  test('a group named in a template list resolves its members when the group name case differs', () => {
    const { content } = readablePathsFor(['lore'], CI_TABLE, PARTIALS);
    expect(content.has('body.background')).toBe(true);
  });

  test('a genuinely undeclared body key still raises CL0426 — no over-suppression', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: CI_TABLE, partials: PARTIALS });
    a.collectForItem(mk('Wren', 'CaseTest', { Background: 'a coast', strength: 'uncanny' }), CI_TABLE.templates.CaseTest);
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
    a.collectForItem(mk('Iona', 'Empty', { Background: 'a coast' }), noBgTable.templates.Empty);
    a.finish(d);
    const hit = d.calls.find((c) => c.code === 'CL0426');
    expect(hit.message).toContain('"Background"');
    expect(hit.message).not.toContain('"background"');
  });
});

describe('buildFieldAudit — dedupe on (item id, field path)', () => {
  test('collecting the same item on many leaves reports each field once', () => {
    const d = sink();
    const a = buildFieldAudit({ fieldTable: TABLE, partials: PARTIALS });
    const item = mk('Alba', 'Person', { name: 'A', vibe: 'v', strength: 'uncanny', bravado: 'loud' });
    for (let i = 0; i < 32; i += 1) a.collectForItem(item, TABLE.templates.Person);
    a.finish(d);
    const perItem = d.calls.filter((c) => c.code === 'CL0426');
    expect(perItem).toHaveLength(2); // strength, bravado — not 64
    expect(perItem.map((c) => c.message.match(/key "(\w+)"/)[1]).sort()).toEqual(['bravado', 'strength']);
  });
});
