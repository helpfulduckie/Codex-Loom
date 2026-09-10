'use strict';

/**
 * The `duckieConv` bundled convention pack, end to end (v4 spec §8.2.2, Phase 16).
 *
 * `packs/duckieConv.cl.yaml` is the second bundled pack and the first that encodes
 * authoring judgment. It exercises the Phase 16 vocabulary: the `meta:` fence channel, the
 * `over: meta` schema route, and the three rule primitives — `budget` (per card, rides the
 * offline arm), `count` and `mutexHint` (per resolved item, inline only, Decision 5).
 *
 * Integration because every claim is about a finding reaching (or not reaching) the compile
 * bus — the `count` / `mutexHint` rules run only inside `compile.js:runPackChecks`, over
 * `resolvedItems`, and are not observable below `compile()`.
 */

const { compileProject } = require('../helpers/project');

const find = (d, code) => d.all.filter((x) => x.code === code);
const BUDGET = 'CL-duckieConv/0001';
const COUNT = 'CL-duckieConv/0002';
const MUTEX = 'CL-duckieConv/0003';
const ROLE = 'CL-duckieConv/0004';

const TEMPLATE = { 'templates/Card.template': '{$body.Text}' };

const config = (lintBlock) => [
  'version: 4',
  'structure:',
  '  input:',
  '    items: [%TMP%/Codex]',
  '    templates: [%TMP%/templates]',
  '  output: %TMP%/output',
  ...lintBlock,
  'branches:',
  '  main: {}',
].join('\n');

/**
 * One item. `fields` is merged into `body:` as raw YAML so a caller can write real lists
 * and maps; `text` fills `body.Text`, the only field the template renders (so `budget`
 * measures a length the caller controls).
 */
const item = ({ id, title = id, text = 'body', meta = null, fields = '' }) => [
  `- id: ${id}`,
  `  name: ${JSON.stringify(title)}`,
  `  aid: {type: Character, title: ${JSON.stringify(title)}, triggers: [${id}]}`,
  '  render: {template: Card}',
  ...(meta ? ['  meta:', ...meta.split('\n').map((l) => `    ${l}`)] : []),
  '  body:',
  `    Text: ${JSON.stringify(text)}`,
  ...(fields ? fields.split('\n').map((l) => `    ${l}`) : []),
].join('\n');

const ENABLED = ['lint: {packs: {duckieConv: {}}}'];

// ── CL-duckieConv/0001 — the per-role budget ────────────────────────────────

describe('CL-duckieConv/0001 — per-role character budget', () => {
  test('a role-less 500-char card is measured at standard (400) → WARN', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', text: 'x'.repeat(500) }),
    });
    const hits = find(d, BUDGET);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe('warn');
    expect(hits[0].message).toMatch(/role "standard"/);
    expect(hits[0].message).toContain('500');
  });

  test('the same body at role: anchor (800) is silent', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', text: 'x'.repeat(500), meta: 'duckieConv:\n  role: anchor' }),
    });
    expect(find(d, BUDGET)).toHaveLength(0);
  });

  test('an anchor card over 800 still WARNs', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'boss', text: 'x'.repeat(900), meta: 'duckieConv:\n  role: anchor' }),
    });
    const hits = find(d, BUDGET);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toMatch(/role "anchor"/);
  });

  test('a 450-char body at role: major (500) is silent', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', text: 'x'.repeat(450), meta: 'duckieConv:\n  role: major' }),
    });
    expect(find(d, BUDGET)).toHaveLength(0);
  });

  test('a 550-char body at role: major still WARNs', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', text: 'x'.repeat(550), meta: 'duckieConv:\n  role: major' }),
    });
    const hits = find(d, BUDGET);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toMatch(/role "major"/);
  });
});

// ── CL-duckieConv/0004 — the role annotation is a known value ────────────────

describe('CL-duckieConv/0004 — meta.duckieConv.role must be a known value', () => {
  test('a typo\'d role value → one WARN, and the card is still measured at standard', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', text: 'x'.repeat(500), meta: 'duckieConv:\n  role: minr' }),
    });
    expect(find(d, ROLE)).toHaveLength(1);
    expect(find(d, ROLE)[0].severity).toBe('warn');
    // fell back to standard, so the 500-char body also trips the budget rule
    expect(find(d, BUDGET)).toHaveLength(1);
    expect(find(d, BUDGET)[0].message).toMatch(/role "standard"/);
  });

  test('a valid role is silent on the role rule', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', text: 'short', meta: 'duckieConv:\n  role: minor' }),
    });
    expect(find(d, ROLE)).toHaveLength(0);
  });

  test('role: major is silent on the role rule', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', text: 'short', meta: 'duckieConv:\n  role: major' }),
    });
    expect(find(d, ROLE)).toHaveLength(0);
  });
});

// ── CL-duckieConv/0002 — list-length caps ───────────────────────────────────

describe('CL-duckieConv/0002 — count', () => {
  test('a 2-item vibe list is below the 3–5 range → WARN', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', fields: 'vibe: [tense, quiet]' }),
    });
    const hits = find(d, COUNT);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => /vibe/.test(h.message))).toBe(true);
  });

  test('a 6-item background list trips the * default (max 5) → WARN', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', fields: 'background: [a, b, c, d, e, f]\nvibe: [x, y, z, w]' }),
    });
    const hits = find(d, COUNT);
    expect(hits.some((h) => /background/.test(h.message))).toBe(true);
  });

  test('a bare comma-string vibe is NOT split — one value, no finding', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', fields: 'vibe: "tense, quiet, close, hot, loud, dim, still"' }),
    });
    expect(find(d, COUNT)).toHaveLength(0);
  });

  test('a 2-word tagline is fine — the tagline has a ceiling, not a floor', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', fields: 'tagline: The Sultan\nvibe: [a, b, c, d]' }),
    });
    const hits = find(d, COUNT);
    expect(hits.some((h) => /tagline/.test(h.message))).toBe(false);
  });

  test('a 6-word tagline is over the 5-word ceiling → WARN', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({ id: 'npc', fields: 'tagline: the last sultan of the sands\nvibe: [a, b, c, d]' }),
    });
    const hits = find(d, COUNT);
    expect(hits.some((h) => /tagline: 6 words, expected at most 5/.test(h.message))).toBe(true);
  });
});

// ── CL-duckieConv/0003 — faction field redundancy ───────────────────────────

describe('CL-duckieConv/0003 — mutexHint', () => {
  test('a card carrying all four of overview/purpose/structure/methods → WARN', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({
        id: 'guild',
        fields: 'overview: the smiths\npurpose: forge arms\nstructure: guildmaster + journeymen\nmethods: monopoly and patronage',
      }),
    });
    const hits = find(d, MUTEX);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe('warn');
  });

  test('only three of the four → silent', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': item({
        id: 'guild',
        fields: 'overview: the smiths\npurpose: forge arms\nstructure: guildmaster + journeymen',
      }),
    });
    expect(find(d, MUTEX)).toHaveLength(0);
  });
});

// ── meta: resolves per branch ──────────────────────────────────────────────

describe('a variant that sets meta.duckieConv.role resolves per leaf', () => {
  test('the same 500-char body is silent on the anchor branch and WARNs on the other', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'lint: {packs: {duckieConv: {}}}',
        'branches:',
        '  big: {}',
        '  small: {}',
      ].join('\n'),
      'Codex/items.yaml': [
        '- id: npc',
        '  name: "npc"',
        '  aid: {type: Character, title: "npc", triggers: [npc]}',
        '  render: {template: Card}',
        '  body:',
        `    Text: ${JSON.stringify('x'.repeat(500))}`,
        '  variants:',
        '    anchored:',
        '      meta: {duckieConv: {role: anchor}}',
        '  branches:',
        '    big: anchored',
      ].join('\n'),
    });
    const hits = find(d, BUDGET);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('branch "small"');
    expect(hits.some((h) => /branch "big"/.test(h.message))).toBe(false);
  });
});

// ── A conforming card, and the dial ────────────────────────────────────────

describe('a conforming card is silent, and level: off silences the pack', () => {
  const CONFORMING = item({
    id: 'npc',
    text: 'x'.repeat(300),
    fields: 'vibe: [tense, quiet, close, hot]\ntagline: A Quiet Smith',
  });

  test('a conforming card raises no duckieConv finding', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(ENABLED),
      'Codex/items.yaml': CONFORMING,
    });
    for (const code of [BUDGET, COUNT, MUTEX, ROLE]) {
      expect(find(d, code)).toHaveLength(0);
    }
  });

  test('a project that never declares the pack gets nothing (no auto-activation)', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config([]),
      'Codex/items.yaml': item({ id: 'npc', text: 'x'.repeat(500), fields: 'vibe: [a, b]' }),
    });
    expect(find(d, BUDGET)).toHaveLength(0);
    expect(find(d, COUNT)).toHaveLength(0);
  });

  test('level: off silences every rule, count and budget alike', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {duckieConv: {level: off}}}']),
      'Codex/items.yaml': item({
        id: 'npc', text: 'x'.repeat(500), meta: 'duckieConv:\n  role: minr',
        fields: 'vibe: [a, b]\noverview: o\npurpose: p\nstructure: s\nmethods: m',
      }),
    });
    for (const code of [BUDGET, COUNT, MUTEX, ROLE]) {
      expect(find(d, code)).toHaveLength(0);
    }
  });
});
