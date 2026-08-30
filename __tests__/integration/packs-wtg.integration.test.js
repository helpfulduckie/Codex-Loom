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

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');

const dirs = [];
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function compileProject(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-wtg-'));
  dirs.push(tmpDir);
  const slash = (p) => p.replace(/\\/g, '/');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.replace(/%TMP%/g, slash(tmpDir)), 'utf8');
  }
  const diagnostics = new Diagnostics();
  const spies = ['log', 'warn', 'error'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics });
  } catch (err) {
    // A pack ERROR fails the build by design (§12.5); the tree is still written.
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return diagnostics;
}

const find = (d, code) => d.all.filter((x) => x.code === code);
const MARKER = 'CL-wtg/0001';
const SETTINGS = 'CL-wtg/0002';

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
    const d = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': item({ id: 'gate', title: 'North Gate', notes: '[e]', text: 'the gate /] stands' }),
    });
    const hits = find(d, MARKER);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].severity).toBe('error');
  });

  test('the markers are caught in the notes text alone, not only the body', () => {
    const d = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': item({ id: 'gate', title: 'North Gate', notes: '[wtg-no-timestamp] /]' }),
    });
    expect(find(d, MARKER).length).toBeGreaterThan(0);
  });

  test('either marker alone is fine — the rule is the contradiction, not the markers', () => {
    const d = compileProject({
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

// ── Rule 2 — the Configure WTG settings card ────────────────────────────────

const GOOD_SETTINGS = [
  '> Enable WTG: true',
  '> Clock Format: 24h',
  '> Date Format: iso',
  '> Debug Mode: 0',
  '> Number of Turns per Hour: 30',
  '> Instruction Injection Mode: cached-invisible',
  '> Exclude Card Types: [zz_Settings, zz_Debug, _WTG]',
].join('\n');

const BAD_SETTINGS = [
  '> Clock Format: 25h',            // not in {12h, 24h}
  '> Debug Mode: 7',                // not in {0, 1, 2}
  '> Number of Turns per Hour: 0',  // below min 1
  '> Clok Format: 12h',            // misspelled key
].join('\n');

describe('CL-wtg/0002 — the "Configure WTG" settings card', () => {
  test('a bad value, an out-of-range number, and a misspelled key all fire', () => {
    const d = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': item({ id: 'cfg', title: 'Configure WTG', notes: BAD_SETTINGS }),
    });
    const hits = find(d, SETTINGS);
    expect(hits.length).toBe(4);
    const joined = hits.map((h) => h.message).join('\n');
    expect(joined).toContain('Clock Format');
    expect(joined).toContain('Debug Mode');
    expect(joined).toContain('at least 1');
    expect(joined).toContain('Did you mean "Clock Format"');
  });

  test('a fully valid settings card is silent — the blockquote form still parses', () => {
    const d = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': item({ id: 'cfg', title: 'Configure WTG', notes: GOOD_SETTINGS }),
    });
    expect(find(d, SETTINGS)).toHaveLength(0);
  });

  test('the rule is scoped by title — a bad value on any other card is ignored', () => {
    const d = compileProject({
      ...TEMPLATE,
      'compile.yaml': config(['lint: {packs: {wtg: {}}}']),
      'Codex/items.yaml': item({ id: 'aria', title: 'Aria', notes: '> Clock Format: 25h' }),
    });
    expect(find(d, SETTINGS)).toHaveLength(0);
  });
});

// ── The dial, the unbind, and no auto-activation ────────────────────────────

describe('level: and declaration control whether the pack runs', () => {
  const TRAP = {
    ...TEMPLATE,
    'Codex/items.yaml': item({ id: 'gate', title: 'North Gate', notes: '[e] /]' }),
  };

  test('a project that never declares the pack gets no findings (no auto-activation)', () => {
    const d = compileProject({ ...TRAP, 'compile.yaml': config([]) });
    expect(find(d, MARKER)).toHaveLength(0);
  });

  test('per-pack level: warn demotes the ERROR to WARN and the build survives', () => {
    const d = compileProject({
      ...TRAP,
      'compile.yaml': config(['lint: {packs: {wtg: {level: warn}}}']),
    });
    const hits = find(d, MARKER);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.severity === 'warn')).toBe(true);
  });

  test('per-pack level: off silences it entirely', () => {
    const d = compileProject({
      ...TRAP,
      'compile.yaml': config(['lint: {packs: {wtg: {level: off}}}']),
    });
    expect(find(d, MARKER)).toHaveLength(0);
  });

  test('wtg: ~ on a branch unbinds it there while a sibling branch still fires', () => {
    const d = compileProject({
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
