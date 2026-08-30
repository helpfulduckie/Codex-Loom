'use strict';

/**
 * Convention packs — the engine (v4 spec §8.2.2, Phase 14 Steps 3-4).
 *
 * The loader, the branch-merge through `walkBranchChain`, the `notes:` re-parse, the
 * predicate vocabulary, the `src/schema.js` `min`/`max` extension, and `evaluatePack`.
 * The `wtg` pack itself and its end-to-end wiring are Session C.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { loadPack, evaluatePack, clampFinding, CODES } = require('../../src/lint/packs');
const { parseNotesBlock } = require('../../src/emit/vl');
const { walkBranchChain } = require('../../src/model/branches');
const { Diagnostics } = require('../../src/diag');

let TMP;
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-packs-')); });
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function writePack(name, body) {
  const p = path.join(TMP, `${name}.cl.yaml`);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

// ── loader ───────────────────────────────────────────────────────────────────

describe('loadPack', () => {
  test('a bundled name that resolves to no file is a CL0117 ERROR naming the pack', () => {
    const diag = new Diagnostics();
    const pack = loadPack('no-such-pack', {}, { baseDir: TMP, diagnostics: diag });
    expect(pack).toBeNull();
    expect(diag.errors).toHaveLength(1);
    expect(diag.errors[0].code).toBe(CODES.PACK_MALFORMED);
    expect(diag.errors[0].message).toContain('no-such-pack');
  });

  test('a source: path is resolved relative to baseDir and loaded', () => {
    writePack('local', 'name: local\nrules:\n  - id: 1\n    message: hi\n');
    const diag = new Diagnostics();
    const pack = loadPack('local', { source: './local.cl.yaml' }, { baseDir: TMP, diagnostics: diag });
    expect(diag.errors).toHaveLength(0);
    expect(pack.name).toBe('local');
    expect(pack.rules[0].code).toBe('CL-local/0001');
  });

  test('a {%token} in a source: path expands against variables', () => {
    const sub = path.join(TMP, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'p.cl.yaml'), 'name: p\nrules: []\n', 'utf8');
    const diag = new Diagnostics();
    const pack = loadPack('p', { source: '{%dir}/p.cl.yaml' },
      { baseDir: TMP, variables: { dir: sub }, diagnostics: diag });
    expect(diag.errors).toHaveLength(0);
    expect(pack.name).toBe('p');
  });

  test('malformed YAML is a CL0117, not a throw', () => {
    writePack('broken', 'name: broken\nrules: [\n');
    const diag = new Diagnostics();
    const pack = loadPack('broken', { source: './broken.cl.yaml' }, { baseDir: TMP, diagnostics: diag });
    expect(pack).toBeNull();
    expect(diag.errors[0].code).toBe(CODES.PACK_MALFORMED);
  });

  test('a name: that disagrees with the config key is a CL0119 ERROR', () => {
    writePack('keyname', 'name: realname\nrules: []\n');
    const diag = new Diagnostics();
    const pack = loadPack('keyname', { source: './keyname.cl.yaml' }, { baseDir: TMP, diagnostics: diag });
    expect(pack).toBeNull();
    expect(diag.errors[0].code).toBe(CODES.PACK_NAME_MISMATCH);
    expect(diag.errors[0].message).toContain('realname');
  });

  test('a pack with no rules: list is a CL0117', () => {
    writePack('norules', 'name: norules\n');
    const diag = new Diagnostics();
    expect(loadPack('norules', { source: './norules.cl.yaml' }, { baseDir: TMP, diagnostics: diag })).toBeNull();
    expect(diag.errors[0].code).toBe(CODES.PACK_MALFORMED);
  });

  test('rule id and severity default sanely', () => {
    writePack('defaults', 'name: defaults\nrules:\n  - message: a\n  - id: 7\n    severity: warn\n    message: b\n');
    const pack = loadPack('defaults', { source: './defaults.cl.yaml' }, { baseDir: TMP, diagnostics: new Diagnostics() });
    expect(pack.rules[0].code).toBe('CL-defaults/0001');
    expect(pack.rules[0].severity).toBe('error');
    expect(pack.rules[1].code).toBe('CL-defaults/0007');
    expect(pack.rules[1].severity).toBe('warn');
  });
});

// ── branch merge ─────────────────────────────────────────────────────────────

describe('walkBranchChain merges lint.packs like roles', () => {
  const branches = {
    a: {
      lint: { level: 'warn', packs: { b: { level: 'error' }, root: null } },
      branches: {
        x: { lint: { packs: { c: {} } } },
      },
    },
  };
  const rootLint = { level: 'off', packs: { root: {}, b: {} } };

  test('key-wise merge: child adds, keeps inherited, ~ deletes', () => {
    const chain = walkBranchChain(branches, ['a', 'x'], { rootLint });
    expect(Object.keys(chain.lint.packs).sort()).toEqual(['b', 'c']);
    expect(chain.lint.packs.b).toEqual({ level: 'error' }); // a's override won
  });

  test('a branch-declared level is the per-branch ceiling, last-wins; root level does not seed it', () => {
    const chain = walkBranchChain(branches, ['a', 'x'], { rootLint });
    expect(chain.lint.level).toBe('warn'); // from branch a; root's `off` is the bus's job
    const bare = walkBranchChain({ q: {} }, ['q'], { rootLint });
    expect(bare.lint.level).toBeNull();
  });

  test('root packs pass straight through when no branch touches them', () => {
    const chain = walkBranchChain({}, [], { rootLint });
    expect(Object.keys(chain.lint.packs).sort()).toEqual(['b', 'root']);
  });
});

// ── parseNotesBlock ──────────────────────────────────────────────────────────

describe('parseNotesBlock', () => {
  test('a key/value block round-trips to a mapping', () => {
    expect(parseNotesBlock('statTracker: on\nhp: 10')).toEqual({ statTracker: true, hp: 10 });
  });
  test('a scalar marker returns {}', () => {
    expect(parseNotesBlock('[e]')).toEqual({});
  });
  test('prose returns {}', () => {
    expect(parseNotesBlock('He guards the north gate and never sleeps.')).toEqual({});
  });
  test('empty / whitespace returns {}', () => {
    expect(parseNotesBlock('')).toEqual({});
    expect(parseNotesBlock('   \n  ')).toEqual({});
  });
  test('malformed YAML returns {} rather than throwing', () => {
    expect(parseNotesBlock('a: [1, 2\nb: {')).toEqual({});
  });
});

// ── the schema min/max extension ─────────────────────────────────────────────

describe('src/schema.js numeric min/max (CL0207)', () => {
  const { validate, CODES: SC } = require('../../src/schema');
  const desc = {
    type: 'map',
    keys: { n: { type: 'number', min: 0, max: 2 } },
  };
  const codesFor = (obj) => {
    const d = new Diagnostics();
    validate(obj, desc, { diagnostics: d });
    return d.all.map((x) => x.code);
  };
  test('in range is clean', () => expect(codesFor({ n: 1 })).toEqual([]));
  test('below min is CL0207', () => expect(codesFor({ n: -1 })).toContain(SC.VALUE_OUT_OF_RANGE));
  test('above max is CL0207', () => expect(codesFor({ n: 5 })).toContain(SC.VALUE_OUT_OF_RANGE));
  test('a non-number is a type error, not a range error', () => {
    expect(codesFor({ n: 'x' })).toContain(SC.WRONG_TYPE);
    expect(codesFor({ n: 'x' })).not.toContain(SC.VALUE_OUT_OF_RANGE);
  });
});

// ── predicates + evaluatePack ────────────────────────────────────────────────

/** Build a one-card compiled file for `evaluatePack` via `parseCards`. */
const { parseCards } = require('../../src/emit/vl');
function card({ title = 'C', triggers = 'k', notes = '', body = 'text' }) {
  const fence = ['~~~', `triggers: [${triggers}]`, 'encapsulate: false'];
  if (notes) fence.push(notes.includes('\n') ? `notes: |-\n${notes.split('\n').map((l) => `  ${l}`).join('\n')}` : `notes: '${notes}'`);
  fence.push('~~~');
  return parseCards(`## ${title}\n${fence.join('\n')}\n${body}\n`, { type: 'character' });
}

function runRule(rule, c) {
  const pack = { name: 't', rules: [{ id: '1', code: 'CL-t/0001', severity: 'error', message: 'm', ...rule }] };
  return evaluatePack(pack, c);
}

describe('predicate vocabulary', () => {
  test('hasKey over the parsed notes mapping', () => {
    expect(runRule({ forbid: { notes: { hasKey: 'statTracker' } } }, card({ notes: 'statTracker: on' }))).toHaveLength(1);
    expect(runRule({ forbid: { notes: { hasKey: 'statTracker' } } }, card({ notes: 'other: 1' }))).toHaveLength(0);
  });
  test('equals over a notes value', () => {
    expect(runRule({ forbid: { equals: { key: 'mode', value: 'debug' } } }, card({ notes: 'mode: debug' }))).toHaveLength(1);
  });
  test('match scans notes text and body together', () => {
    expect(runRule({ forbid: { match: '\\[e\\]' } }, card({ notes: '[e]' }))).toHaveLength(1);
    expect(runRule({ forbid: { match: 'SECRET' } }, card({ body: 'the SECRET room' }))).toHaveLength(1);
  });
  test('titleMatch gates a rule', () => {
    expect(runRule({ appliesTo: { titleMatch: '^Configure' }, forbid: {} }, card({ title: 'Configure WTG' }))).toHaveLength(1);
    expect(runRule({ appliesTo: { titleMatch: '^Configure' }, forbid: {} }, card({ title: 'Aria' }))).toHaveLength(0);
  });
  test('all / any / not compose', () => {
    const c = card({ notes: 'a: 1', body: 'has /] here' });
    expect(runRule({ forbid: { all: [{ notes: { hasKey: 'a' } }, { bodyMatch: '/\\]' }] } }, c)).toHaveLength(1);
    expect(runRule({ forbid: { any: [{ notes: { hasKey: 'zzz' } }, { bodyMatch: 'nope' }] } }, c)).toHaveLength(0);
    expect(runRule({ forbid: { not: { notes: { hasKey: 'zzz' } } } }, c)).toHaveLength(1);
  });
});

describe('evaluatePack', () => {
  test('require fires when the predicate does NOT match', () => {
    expect(runRule({ require: { notes: { hasKey: 'must' } } }, card({ notes: 'other: 1' }))).toHaveLength(1);
    expect(runRule({ require: { notes: { hasKey: 'must' } } }, card({ notes: 'must: 1' }))).toHaveLength(0);
  });
  test('a schema: block re-codes validate findings to the rule code', () => {
    const rule = {
      appliesTo: { titleMatch: 'Cfg' },
      schema: { type: 'map', keys: { Speed: { type: 'number', min: 1, max: 10 } } },
    };
    const found = runRule(rule, card({ title: 'Cfg', notes: 'Speed: 99' }));
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe('CL-t/0001');
    expect(found[0].message).toContain('Speed');
  });
  test('the finding message names the pack, the card, and the branch', () => {
    const pack = { name: 'wtg', rules: [{ id: '1', code: 'CL-wtg/0001', severity: 'error', message: 'boom', forbid: {} }] };
    const [f] = evaluatePack(pack, card({ title: 'Gate' }), { branchLabel: 'a/x' });
    expect(f.message).toContain('[wtg]');
    expect(f.message).toContain('"Gate"');
    expect(f.message).toContain('branch "a/x"');
  });
});

// ── clampFinding ─────────────────────────────────────────────────────────────

describe('clampFinding — per-pack then per-branch ceiling, tightest wins', () => {
  test('no ceilings: severity passes through', () => {
    expect(clampFinding('error', null, null)).toBe('error');
  });
  test('pack level: warn demotes an error', () => {
    expect(clampFinding('error', 'warn', null)).toBe('warn');
  });
  test('pack level: error drops a warn', () => {
    expect(clampFinding('warn', 'error', null)).toBeNull();
  });
  test('branch level composes on top of pack level', () => {
    expect(clampFinding('error', null, 'off')).toBeNull();
    expect(clampFinding('error', 'error', 'warn')).toBe('warn');
  });
});
