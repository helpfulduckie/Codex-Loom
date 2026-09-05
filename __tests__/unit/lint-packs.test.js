'use strict';

/**
 * Convention packs — the engine (v4 spec §8.2.2, Phase 14 Steps 3-4).
 *
 * The loader, the branch-merge through `walkBranchChain`, the `notes:` re-parse, the
 * predicate vocabulary, the `src/schema.js` `min`/`max` extension, and `evaluatePack`.
 * The `wtg` pack itself and its end-to-end wiring are Session C.
 */

const path = require('path');
const fs = require('fs');

const {
  loadPack, evaluatePack, evaluatePackExistence, evaluatePackItemRules, clampFinding,
} = require('../../src/lint/packs');
const { parseNotesBlock, parseSettingsBlock } = require('../../src/emit/vl');
const { walkBranchChain } = require('../../src/model/branches');
const { Diagnostics, CODES } = require('../../src/diag');
const { withTmpDir, writeTree } = require('../helpers/project');

let TMP;
beforeAll(() => { TMP = withTmpDir(); });

function writePack(name, body) {
  writeTree(TMP, { [`${name}.cl.yaml`]: body });
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

  test('~ on a pack never inherited raises CL0118 through onWarn', () => {
    const warns = [];
    walkBranchChain(
      { a: { lint: { packs: { ghost: null } } } },
      ['a'],
      { rootLint: { packs: {} }, onWarn: (code, msg) => warns.push({ code, msg }) },
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].code).toBe('CL0118');
    expect(warns[0].msg).toContain('ghost');
  });

  test('no onWarn: the merge still deletes, it just says nothing', () => {
    const chain = walkBranchChain(
      { a: { lint: { packs: { b: null } } } }, ['a'], { rootLint: { packs: { b: {} } } },
    );
    expect(chain.lint.packs).not.toHaveProperty('b');
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
  test('a uniform "> " blockquote prefix is stripped (WTG\'s Configure WTG card)', () => {
    expect(parseNotesBlock('> Clock Format: 24h\n> Debug Mode: 0'))
      .toEqual({ 'Clock Format': '24h', 'Debug Mode': 0 });
    // blank lines between entries do not defeat the strip
    expect(parseNotesBlock('> a: 1\n\n> b: 2')).toEqual({ a: 1, b: 2 });
  });
  test('a non-uniform "> " is left alone — a partial match is real YAML', () => {
    expect(parseNotesBlock('a: 1\n> quoted aside')).toEqual({});
  });
});

// ── parseSettingsBlock ───────────────────────────────────────────────────────

describe('parseSettingsBlock', () => {
  test('a plain Key: Value block, values kept as strings (no YAML coercion)', () => {
    expect(parseSettingsBlock('Starting Era: AD\nInitialized: true'))
      .toEqual({ 'Starting Era': 'AD', Initialized: 'true' });
  });
  test('a leading "> " is stripped per line', () => {
    expect(parseSettingsBlock('> Starting Date: 1/1/2024')).toEqual({ 'Starting Date': '1/1/2024' });
  });
  test('only the first colon splits — the rest is the value', () => {
    expect(parseSettingsBlock('Foo: a: b')).toEqual({ Foo: 'a: b' });
  });
  test('a blank line and a line with no colon are skipped', () => {
    expect(parseSettingsBlock('A: 1\n\njust prose\nB: 2')).toEqual({ A: '1', B: '2' });
  });
  test('a repeated key keeps the first occurrence', () => {
    expect(parseSettingsBlock('A: first\nA: second')).toEqual({ A: 'first' });
  });
  test('empty / all-blank input is {}', () => {
    expect(parseSettingsBlock('')).toEqual({});
    expect(parseSettingsBlock('  \n\n ')).toEqual({});
  });
});

// ── the schema min/max extension ─────────────────────────────────────────────

describe('src/schema.js numeric min/max (CL0207)', () => {
  const { validate } = require('../../src/schema');
  const { CODES: SC } = require('../../src/diag');
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

describe('over: body routes the schema at the card entry', () => {
  // A body authored as a settings block; `notes` carries nothing.
  const bodyCard = parseCards(
    ['## WTG Time Config', '~~~', 'triggers: [tc]', 'encapsulate: false', '~~~',
      'Starting Era: AD', 'Starting Time: 9:00 AM'].join('\n'),
    { type: 'zz_Settings' },
  );
  const rule = {
    appliesTo: { titleMatch: '^WTG Time Config$' },
    schema: { type: 'record', keys: { 'Starting Era': { type: 'string', pattern: '^(AD|CE|BC|BCE)$' } } },
  };

  test('with over: body the schema sees the entry keys', () => {
    expect(runRule({ ...rule, over: 'body' }, bodyCard)).toHaveLength(0);
    const bad = parseCards(
      ['## WTG Time Config', '~~~', 'triggers: [tc]', 'encapsulate: false', '~~~',
        'Starting Era: Anno Domini'].join('\n'),
      { type: 'zz_Settings' },
    );
    const found = runRule({ ...rule, over: 'body' }, bad);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('Starting Era');
  });

  test('without over: the same rule reads notes and finds nothing in the body', () => {
    expect(runRule(rule, bodyCard)).toHaveLength(0);
  });
});

// ── Phase 16: over: meta + the budget primitive ─────────────────────────────

/** A one-card compiled file carrying a `meta:` fence block. */
function metaCard({ title = 'C', body = 'text', meta = {} }) {
  const dumped = require('yaml').stringify(meta, { indent: 2 }).replace(/\n+$/, '').split('\n');
  const fence = ['~~~', 'triggers: [k]', 'encapsulate: false',
    'meta:', ...dumped.map((l) => `  ${l}`), '~~~'];
  return parseCards(`## ${title}\n${fence.join('\n')}\n${body}\n`, { type: 'character' });
}

describe('over: meta routes the schema at meta[pack.name]', () => {
  const rule = {
    over: 'meta',
    schema: { type: 'map', keys: { role: { type: 'string', values: ['anchor', 'standard', 'minor'] } } },
  };
  const packOf = (r) => ({ name: 'dc', rules: [{ id: '1', code: 'CL-dc/0001', severity: 'warn', message: 'm', ...r }] });

  test('a good role value is silent', () => {
    const found = evaluatePack(packOf(rule), metaCard({ meta: { dc: { role: 'anchor' } } }));
    expect(found).toHaveLength(0);
  });
  test('a bad role value is one finding, re-coded to the rule', () => {
    const found = evaluatePack(packOf(rule), metaCard({ meta: { dc: { role: 'minr' } } }));
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe('CL-dc/0001');
  });
  test('a stray sub-key in the pack namespace is a finding (closed map)', () => {
    const found = evaluatePack(packOf(rule), metaCard({ meta: { dc: { rolle: 'anchor' } } }));
    expect(found.length).toBeGreaterThan(0);
  });
  test('a card with no meta: at all is silent — empty input against a keyless map', () => {
    expect(evaluatePack(packOf(rule), card({ title: 'X' }))).toHaveLength(0);
  });
  test('another pack\'s meta namespace is invisible', () => {
    const found = evaluatePack(packOf(rule), metaCard({ meta: { other: { role: 'bogus' } } }));
    expect(found).toHaveLength(0);
  });
});

describe('the budget primitive', () => {
  const packOf = (budget) => ({
    name: 'dc',
    rules: [{ id: '1', code: 'CL-dc/0001', severity: 'warn', message: 'over budget', budget }],
  });
  const B = { anchor: 800, standard: 400, minor: 200 };

  test('an absent role is measured as standard', () => {
    const found = evaluatePack(packOf(B), metaCard({ body: 'x'.repeat(500), meta: { note: 1 } }));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('role "standard"');
    expect(found[0].message).toContain('500');
  });
  test('the same body is silent at role: anchor', () => {
    expect(evaluatePack(packOf(B), metaCard({ body: 'x'.repeat(500), meta: { dc: { role: 'anchor' } } })))
      .toHaveLength(0);
  });
  test('an unrecognized role falls back to standard — a typo does not suppress the check', () => {
    const found = evaluatePack(packOf(B), metaCard({ body: 'x'.repeat(500), meta: { dc: { role: 'minr' } } }));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('role "standard"');
  });
  test('an unrecognized role with standard absent from the map skips (no cap to measure)', () => {
    const found = evaluatePack(packOf({ anchor: 800 }), metaCard({ body: 'x'.repeat(5000), meta: { dc: { role: 'minr' } } }));
    expect(found).toHaveLength(0);
  });
  test('a body at exactly the cap does not fire', () => {
    expect(evaluatePack(packOf(B), metaCard({ body: 'x'.repeat(400), meta: { dc: { role: 'standard' } } })))
      .toHaveLength(0);
  });
});

// ── Phase 16: evaluatePackItemRules — count / mutexHint over resolved items ──

describe('evaluatePackItemRules — count', () => {
  const packOf = (count) => ({
    name: 'dc',
    rules: [{ id: '2', code: 'CL-dc/0002', severity: 'warn', message: 'count', count }],
  });
  const run = (count, body, opts) => evaluatePackItemRules(packOf(count), [{ id: 'I', body }], opts);

  test('a named list field below min fires', () => {
    const found = run({ fields: { vibe: { min: 3, max: 5 } } }, { vibe: ['a', 'b'] });
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe('CL-dc/0002');
    expect(found[0].message).toContain('vibe');
  });
  test('a named list field in range is silent', () => {
    expect(run({ fields: { vibe: { min: 3, max: 5 } } }, { vibe: ['a', 'b', 'c', 'd'] })).toHaveLength(0);
  });
  test('a dotted path resolves case-insensitively', () => {
    const found = run(
      { fields: { 'personality.keywords': { min: 2, max: 4 } } },
      { Personality: { Keywords: ['only-one'] } },
    );
    expect(found).toHaveLength(1);
  });
  test('a map field is counted by its key count', () => {
    const found = run({ fields: { pantheon: { max: 2 } } }, { pantheon: { A: 1, B: 2, C: 3 } });
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('3 items');
  });
  test('a bare comma string is NOT split — one value, skipped', () => {
    expect(run({ fields: { vibe: { min: 3, max: 5 } } }, { vibe: 'a, b, c, d, e, f, g' })).toHaveLength(0);
  });
  test('words: counts whitespace tokens on a string', () => {
    const found = run({ fields: { tagline: { words: { min: 3, max: 5 } } } }, { tagline: 'The Sultan' });
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('2 words');
  });
  test('default applies to every un-named list/map field, not to strings', () => {
    const found = run(
      { default: { max: 5 }, fields: {} },
      { background: ['1', '2', '3', '4', '5', '6'], summary: 'a, b, c, d, e, f, g' },
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('background');
  });
  test('the branch label rides the finding, with the (root) special-case', () => {
    const onBranch = run({ fields: { vibe: { min: 3 } } }, { vibe: ['a'] }, { branchLabel: 'a/x' });
    expect(onBranch[0].message).toContain('on branch "a/x"');
    expect(onBranch[0].leaf).toBe('a/x');
    const atRoot = run({ fields: { vibe: { min: 3 } } }, { vibe: ['a'] }, { branchLabel: '(root)' });
    expect(atRoot[0].message).not.toContain('branch');
    expect(atRoot[0].leaf).toBe('(root)');
  });
});

describe('evaluatePackItemRules — mutexHint', () => {
  const pack = {
    name: 'dc',
    rules: [{
      id: '3', code: 'CL-dc/0003', severity: 'warn', message: 'merge down',
      mutexHint: { fields: ['overview', 'purpose', 'structure', 'methods'], max: 3, message: 'audit for overlap' },
    }],
  };
  const run = (body) => evaluatePackItemRules(pack, [{ id: 'F', body }]);

  test('four of four present → one finding carrying the rule message', () => {
    const found = run({ overview: 'o', purpose: 'p', structure: 's', methods: 'm' });
    expect(found).toHaveLength(1);
    expect(found[0].detail).toBe('audit for overlap');
    expect(found[0].message).toContain('4 of 4 present');
  });
  test('three of four present → silent (max: 3)', () => {
    expect(run({ overview: 'o', purpose: 'p', structure: 's' })).toHaveLength(0);
  });
  test('an empty-string field does not count as present', () => {
    expect(run({ overview: 'o', purpose: 'p', structure: 's', methods: '   ' })).toHaveLength(0);
  });
});

describe('evaluatePackItemRules — a rule with neither count nor mutexHint is ignored', () => {
  test('a forbid-only rule contributes nothing here', () => {
    const plain = { name: 'p', rules: [{ id: '1', code: 'CL-p/0001', severity: 'error', message: 'm', forbid: {} }] };
    expect(evaluatePackItemRules(plain, [{ id: 'X', body: { vibe: ['a'] } }])).toHaveLength(0);
  });
  test('an empty / non-array items argument is safe', () => {
    const pack = { name: 'p', rules: [{ id: '2', code: 'CL-p/0002', severity: 'warn', message: 'm', count: { default: { max: 1 } } }] };
    expect(evaluatePackItemRules(pack, undefined)).toEqual([]);
    expect(evaluatePackItemRules(pack, [])).toEqual([]);
  });
});

describe('evaluatePackExistence', () => {
  const pack = {
    name: 'wtg',
    rules: [{
      id: '2', code: 'CL-wtg/0002', severity: 'warn', message: 'a card should exist',
      requireCard: { titleMatch: '^WTG Time Config$' },
    }],
  };

  test('one finding when no card matches the requireCard predicate', () => {
    const found = evaluatePackExistence(pack, card({ title: 'Aria' }), { branchLabel: 'main' });
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe('CL-wtg/0002');
    expect(found[0].severity).toBe('warn');
    expect(found[0].leaf).toBe('main');
    expect(found[0].message).toContain('branch "main"');
  });

  test('nothing when a card does match', () => {
    expect(evaluatePackExistence(pack, card({ title: 'WTG Time Config' }), { branchLabel: 'main' }))
      .toHaveLength(0);
  });

  test('a rule without requireCard is ignored here', () => {
    const plain = { name: 'p', rules: [{ id: '1', code: 'CL-p/0001', severity: 'error', message: 'm', forbid: {} }] };
    expect(evaluatePackExistence(plain, card({ title: 'X' }), {})).toHaveLength(0);
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
