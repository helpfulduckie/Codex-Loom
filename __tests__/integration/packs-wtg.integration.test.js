'use strict';

/**
 * The `wtg` bundled convention pack, end to end (v4 spec §8.2.2, Phase 14 Step 5).
 *
 * `packs/wtg.cl.yaml` is the first bundled pack and the phase's forcing function: it runs
 * on Session B's engine unchanged (`src/lint/packs.js`), and it proves the two things the
 * engine has to be able to express — a predicate scan across a card's notes text and body
 * (the `[e]` / `/]` marker conflict) and a `src/schema.js` check over a re-parsed `notes:`
 * mapping (the "Configure WTG" settings card).
 *
 * The settings card is authored the way a real scenario authors it — `> Setting Name:
 * value`, one per line — so this also exercises `parseNotesBlock`'s blockquote strip,
 * without which the whole `schema:` check silently no-ops.
 *
 * Integration because every claim is about a finding reaching (or not reaching) the
 * compile bus: no-auto-activation, the per-pack `level:` dial, and a branch `wtg: ~`
 * unbind, none of which is observable below `compile()`.
 */

const { compileProject } = require('../helpers/project');

const find = (d, code) => d.all.filter((x) => x.code === code);
const MARKER = 'CL-wtg/0001';
const SETTINGS = 'CL-wtg/0002';   // WARN — existence + completeness + unknown key
const MALFORMED = 'CL-wtg/0003';  // ERROR — a core field is not well-formed

const TEMPLATE = { 'templates/Card.template': '{$body.Text}' };

/** A `compile.yaml` with one unbranched output and `lint.packs` as given. */
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

const item = ({ id, title, notes, text = 'body text' }) => [
  `- id: ${id}`,
  `  name: ${title}`,
  `  aid: {type: Character, title: ${JSON.stringify(title)}, triggers: [${id}]}`,
  '  render: {template: Card}',
  ...(notes ? ['  notes: |', ...notes.split('\n').map((l) => `    ${l}`)] : []),
  `  body: {Text: ${JSON.stringify(text)}}`,
].join('\n');

// ── Rule 1 — the marker conflict ────────────────────────────────────────────

describe('CL-wtg/0001 — [e] / [wtg-no-timestamp] used together with /]', () => {
  test('a card carrying both markers is an ERROR', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': item({ id: 'gate', title: 'North Gate', notes: '[e]', text: 'the gate /] stands' }),
    });
    const hits = find(d, MARKER);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].severity).toBe('error');
  });

  test('the markers are caught in the notes text alone, not only the body', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': item({ id: 'gate', title: 'North Gate', notes: '[wtg-no-timestamp] /]' }),
    });
    expect(find(d, MARKER).length).toBeGreaterThan(0);
  });

  test('either marker alone is fine — the rule is the contradiction, not the markers', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': [
        item({ id: 'excluded', title: 'Debug Log', notes: '[e]' }),
        item({ id: 'placed', title: 'Ledger', notes: '/]' }),
      ].join('\n'),
    });
    expect(find(d, MARKER)).toHaveLength(0);
  });
});

// ── Rules 2 & 3 — the "WTG Time Config" card, read from the body ─────────────
//
// The card is authored as plain `Key: Value` in the card ENTRY, which is the Codex Loom
// `body` — so these items carry the settings block as `text`, not `notes`.

const VALID_TC = [
  'Starting Date: 6/28/1326',
  'Starting Era: AD',
  'Starting Time: 9:00 AM',
  'Initialized: true',
].join('\n');

const tcItem = (text) => item({ id: 'tc', title: 'WTG Time Config', text });

describe('CL-wtg/0002 — the "WTG Time Config" card exists and is complete', () => {
  test('(a) no card at all → one WARN naming the leaf', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': item({ id: 'aria', title: 'Aria', text: 'just a character' }),
    });
    const hits = find(d, SETTINGS);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe('warn');
    expect(hits[0].message).toContain('branch "main"');
  });

  test('(b) a core field missing → one WARN naming that field', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': tcItem('Starting Date: 6/28/1326\nStarting Time: 9:00 AM\nInitialized: true'),
    });
    const hits = find(d, SETTINGS);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('Starting Era');
  });

  test('(c) a key WTG will not read → one WARN naming it, with a typo hint when close', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': tcItem(`${VALID_TC}\nNotes: remember to update this`),
    });
    const hits = find(d, SETTINGS);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('Notes');
  });

  test('(d) a recognized override key → silent', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': tcItem(`${VALID_TC}\nClock Format: 24h`),
    });
    expect(find(d, SETTINGS)).toHaveLength(0);
    expect(find(d, MALFORMED)).toHaveLength(0);
  });

  test('(f) a fully valid card → silent', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': tcItem(VALID_TC),
    });
    expect(find(d, SETTINGS)).toHaveLength(0);
    expect(find(d, MALFORMED)).toHaveLength(0);
  });

  test('(i) a recognized override with a bad value → one WARN naming the key', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': tcItem(`${VALID_TC}\nClock Format: purple`),
    });
    const hits = find(d, SETTINGS);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe('warn');
    expect(hits[0].message).toContain('Clock Format');
  });

  test('(j) every override key present with a valid value → silent', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': tcItem([
        VALID_TC,
        'Enable WTG: true',
        'Time Duration Multiplier: 1.0',
        'Text Characters per Turn: 600',
        'Number of Turns per Hour: 30',
        'Enable Dynamic Time: true',
        'Enable Localization: false',
        'Clock Format: 24h',
        'Date Format: iso',
        'Player Command Clean Mode: in-place',
        'Player Command Merge Mode: command-based',
        'AI Command Nudge: false',
        'Nudge Show Date: true',
        'Nudge Show Era: true',
        'Nudge Show Time: true',
        'Nudge Show Day of Week: true',
        'Nudge Show Phase: true',
        'Instruction Injection Mode: cached-invisible',
        'Show Date: true',
        'Show Era: true',
        'Show Time: true',
        'Show Day of Week: true',
        'Show Phase: true',
        'DateTime Card Show Phase: true',
        'Enable Generated Cards: false',
        'Generated Card Type: _Generated',
        'Enable Fuzzy Duplicate Matching: false',
        'Enable Card Timestamps: true',
        'Exclude Card Types: [zz_Settings,zz_Debug,_WTG]',
      ].join('\n')),
    });
    expect(find(d, SETTINGS)).toHaveLength(0);
    expect(find(d, MALFORMED)).toHaveLength(0);
  });

  test('(k) enum and boolean overrides are matched case-insensitively — 24H / AMERICAN / TRUE pass', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': tcItem(`${VALID_TC}\nClock Format: 24H\nDate Format: AMERICAN\nEnable WTG: TRUE`),
    });
    expect(find(d, SETTINGS)).toHaveLength(0);
    expect(find(d, MALFORMED)).toHaveLength(0);
  });
});

describe('CL-wtg/0003 — the "WTG Time Config" core fields are well-formed', () => {
  test('(e) an ISO date is an ERROR — WTG wants M/D/year', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': tcItem('Starting Date: 2024-01-01\nStarting Era: AD\nStarting Time: 9:00 AM\nInitialized: true'),
    });
    const hits = find(d, MALFORMED);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe('error');
    expect(hits[0].message).toContain('Starting Date');
    expect(find(d, SETTINGS)).toHaveLength(0);
  });

  test('the four fields are matched case-insensitively — bc / 9:00 am / TRUE pass', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': tcItem('Starting Date: 6/28/1326\nStarting Era: bc\nStarting Time: 9:00 am\nInitialized: TRUE'),
    });
    expect(find(d, MALFORMED)).toHaveLength(0);
    expect(find(d, SETTINGS)).toHaveLength(0);
  });

  test('an out-of-set era is an ERROR — {AD, CE, BC, BCE} only, dotted forms rejected', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': tcItem('Starting Date: 6/28/1326\nStarting Era: A.D.\nStarting Time: 9:00 AM\nInitialized: true'),
    });
    const hits = find(d, MALFORMED);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('Starting Era');
  });

  test('the rule is scoped by title — a malformed field on any other card is ignored', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': item({ id: 'aria', title: 'Aria', text: 'Starting Date: nonsense' }),
    });
    expect(find(d, MALFORMED)).toHaveLength(0);
    expect(find(d, SETTINGS)).toHaveLength(1); // still no WTG Time Config card
  });
});

// ── The dial, the unbind, and no auto-activation ────────────────────────────

describe('level: and declaration control whether the pack runs', () => {
  const TRAP = {
    ...TEMPLATE,
    'Codex/items.yaml': item({ id: 'gate', title: 'North Gate', notes: '[e] /]' }),
  };

  test('a project that never declares the pack gets no findings (no auto-activation)', () => {
    const { diagnostics: d } = compileProject({ ...TRAP, 'compile.yaml': config([]) });
    expect(find(d, MARKER)).toHaveLength(0);
  });

  test('per-pack level: warn demotes the ERROR to WARN and the build survives', () => {
    const { diagnostics: d } = compileProject({
      ...TRAP,
      'compile.yaml': config(['lint: {packs: {wtg: {level: warn}}}']),
    });
    const hits = find(d, MARKER);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.severity === 'warn')).toBe(true);
  });

  test('per-pack level: off silences it entirely', () => {
    const { diagnostics: d } = compileProject({
      ...TRAP,
      'compile.yaml': config(['lint: {packs: {wtg: {level: off}}}']),
    });
    expect(find(d, MARKER)).toHaveLength(0);
  });

  test('(g) level: warn demotes the CL-wtg/0003 ERROR to WARN and the build survives', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {level: warn}}}']),
      'Codex/items.yaml': tcItem('Starting Date: 2024-01-01\nStarting Era: AD\nStarting Time: 9:00 AM\nInitialized: true'),
    });
    const hits = find(d, MALFORMED);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.severity === 'warn')).toBe(true);
  });

  test('(h) level: off silences both WTG Time Config rules', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {level: off}}}']),
      'Codex/items.yaml': tcItem('Starting Date: 2024-01-01'),
    });
    expect(find(d, SETTINGS)).toHaveLength(0);
    expect(find(d, MALFORMED)).toHaveLength(0);
  });

  test('requireCard fires per binding leaf with no card — once, and not on an unbound branch', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      // No WTG Time Config card anywhere; every item is global to both leaves.
      'Codex/items.yaml': item({ id: 'aria', title: 'Aria', text: 'a character' }),
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'lint: {packs: {wtg: {}}}',
        'branches:',
        '  bound: {}',
        '  freed:',
        '    lint: {packs: {wtg: ~}}',
      ].join('\n'),
    });
    const hits = find(d, SETTINGS);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('branch "bound"');
    expect(hits.some((h) => /branch "freed"/.test(h.message))).toBe(false);
  });

  test('wtg: ~ on a branch unbinds it there while a sibling branch still fires', () => {
    const { diagnostics: d } = compileProject({
      ...TEMPLATE,
      'Codex/items.yaml': item({ id: 'gate', title: 'North Gate', notes: '[e] /]' }),
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'lint: {packs: {wtg: {}}}',
        'branches:',
        '  bound: {}',
        '  freed:',
        '    lint: {packs: {wtg: ~}}',
      ].join('\n'),
    });
    const hits = find(d, MARKER);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => /branch "bound"/.test(h.message))).toBe(true);
    expect(hits.some((h) => /branch "freed"/.test(h.message))).toBe(false);
  });
});
