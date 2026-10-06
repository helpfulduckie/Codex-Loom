'use strict';

const fs = require('fs');
const path = require('path');
const { Diagnostics, CODES } = require('../../src/diag');
const { loadCompileConfig } = require('../../src/config/load');
const { originAt } = require('../../src/origin');
const { withTmpDir } = require('../helpers/project');

let tmpDir;

beforeEach(() => { tmpDir = withTmpDir(); });

/**
 * Write a config and load it into a private bus, so nothing prints or throws.
 *
 * v4 requires `version:`, `structure:` and `structure.output`, which most cases here are
 * not about. They are **appended** rather than prepended so the line numbers of the
 * content under test are unaffected — several assertions below pin them.
 */
function load(yaml, { dirs = [], raw = false } = {}) {
  for (const dir of dirs) fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
  let text = yaml;
  // Only a mapping document gets scaffolding; the malformed-input cases below must reach
  // the loader exactly as written. `raw` opts out for the cases that are *about* the
  // scaffolding — a config missing a required key cannot have it supplied first.
  const isMapping = !raw && /^[A-Za-z_]\w*:/m.test(text);
  if (isMapping) {
    if (!/^version:/m.test(text)) text += '\nversion: 4\n';
    if (!/^structure:/m.test(text)) text += '\nstructure:\n  output: ./out\n';
    else if (!/^ {2}output:/m.test(text)) {
      // Into the existing block — a second `structure:` would be a duplicate key.
      text = text.replace(/^structure:$/m, 'structure:\n  output: ./out');
    }
  }
  const cfgPath = path.join(tmpDir, 'compile.cl.yaml');
  fs.writeFileSync(cfgPath, text, 'utf8');
  const diagnostics = new Diagnostics();
  const config = loadCompileConfig(cfgPath, { diagnostics });
  return { config, diagnostics, codes: diagnostics.all.map((d) => d.code), cfgPath };
}

describe('diagnostics carry source positions', () => {
  test('normalized config retains the root document origin index privately', () => {
    const { config, cfgPath } = load('structure:\n  output: ./out\n');
    expect(originAt(config, 'structure', 'output')).toMatchObject({
      file: cfgPath, path: ['structure', 'output'], line: 2,
    });
    expect(Object.keys(config)).not.toContain('_origins');
  });

  test('an unknown key names its line and column', () => {
    const { diagnostics } = load('title: x\nbogus: y\n');
    const diag = diagnostics.errors[0];
    expect(diag.line).toBe(2);
    expect(diag.col).toBe(1);
    expect(diag.file).toContain('compile.cl.yaml');
  });

  test('a nested unknown key points at the key itself, not its parent', () => {
    // `output:` written explicitly so the helper does not inject a line above `input:`.
    const { diagnostics } = load('structure:\n  output: ./out\n  input:\n    nope: []\n');
    expect(diagnostics.errors[0].line).toBe(4);
  });

  test('a path warning points at the offending sequence entry', () => {
    const { diagnostics } = load('structure:\n  input:\n    items:\n      - ./missing\n  output: ./o\n');
    const warn = diagnostics.warnings.find((d) => d.code === CODES.PATH_NOT_FOUND);
    expect(warn.line).toBe(4);
  });
});

describe('variable graph checking', () => {
  test('an undeclared reference is an ERROR naming the referring variable', () => {
    const { diagnostics, codes } = load('variables:\n  a: "{%nope} x"\n');
    expect(codes).toContain(CODES.VARIABLE_UNDECLARED);
    expect(diagnostics.errors[0].message).toContain('referenced by variable "a"');
  });

  test('a cycle names every key in the loop', () => {
    const { diagnostics, codes } = load('variables:\n  a: "{%b}"\n  b: "{%c}"\n  c: "{%a}"\n');
    expect(codes).toContain(CODES.VARIABLE_CYCLE);
    const message = diagnostics.errors[0].message;
    for (const key of ['a', 'b', 'c']) expect(message).toContain(`"${key}"`);
  });

  test('a self-referential variable is reported once', () => {
    const { diagnostics } = load('variables:\n  a: "{%a}"\n');
    expect(diagnostics.errors.filter((d) => d.code === CODES.VARIABLE_CYCLE)).toHaveLength(1);
  });

  test('a cycle is reported once, not once per participant', () => {
    const { diagnostics } = load('variables:\n  a: "{%b}"\n  b: "{%a}"\n');
    expect(diagnostics.errors.filter((d) => d.code === CODES.VARIABLE_CYCLE)).toHaveLength(1);
  });

  test('chained references are fine in any declaration order', () => {
    const { diagnostics } = load('variables:\n  house: "{%setting} North"\n  setting: Academy\n');
    expect(diagnostics.hasErrors()).toBe(false);
  });

  test('references are matched case-insensitively', () => {
    const { diagnostics } = load('variables:\n  Setting: Academy\n  house: "{%setting}"\n');
    expect(diagnostics.hasErrors()).toBe(false);
  });

  test('a root variable may reference a name only branches declare', () => {
    // The Institute does exactly this: openingFile is built at root from `scenario`,
    // which every branch overrides. Reporting it as undeclared would be a false positive.
    const { diagnostics } = load([
      'variables:',
      '  openingFile: "./openings/{%scenario}.md"',
      'branches:',
      '  free:',
      '    variables:',
      '      scenario: free',
      '',
    ].join('\n'));
    expect(diagnostics.hasErrors()).toBe(false);
  });

  test('branch variables are collected from nested branches too', () => {
    const { diagnostics } = load([
      'variables:',
      '  f: "{%deep}"',
      'branches:',
      '  a:',
      '    branches:',
      '      b:',
      '        variables:',
      '          deep: x',
      '',
    ].join('\n'));
    expect(diagnostics.hasErrors()).toBe(false);
  });

  test('variables are not substituted at load — branch overrides must still apply', () => {
    const { config } = load('variables:\n  a: A\n  b: "{%a}/x"\n');
    expect(config.variables.b).toBe('{%a}/x');
  });
});

describe('pre-branch scoping (CL0520)', () => {
  const CONFIG = [
    'structure:',
    '  input:',
    '    items: ["./{%role}"]',   // structure resolves before branches are enumerated
    'branches:',
    '  subject:',
    '    variables:',
    '      role: research-subject',
    '',
  ].join('\n');

  test('a branch-scoped variable in a structure path gets its own code', () => {
    const { codes } = load(CONFIG);
    expect(codes).toContain(CODES.VARIABLE_PRE_BRANCH);
    expect(codes).not.toContain(CODES.VARIABLE_UNDECLARED);
  });

  test('the message says the declaration exists but is out of scope', () => {
    const { diagnostics } = load(CONFIG);
    const diag = diagnostics.errors.find((d) => d.code === CODES.VARIABLE_PRE_BRANCH);
    expect(diag.message).toContain('declared only under a branch');
    expect(diag.hint).toContain('Only root-level variables');
  });

  test('a name declared nowhere is still an ordinary undeclared ERROR', () => {
    const { codes } = load('structure:\n  input:\n    items: ["./{%typo}"]\n');
    expect(codes).toContain(CODES.VARIABLE_UNDECLARED);
    expect(codes).not.toContain(CODES.VARIABLE_PRE_BRANCH);
  });

  test('a name declared at root as well as on a branch resolves normally', () => {
    const { diagnostics } = load([
      'variables:',
      '  role: default',
      'structure:',
      '  input:',
      '    items: ["./{%role}"]',
      'branches:',
      '  subject:',
      '    variables:',
      '      role: research-subject',
      '',
    ].join('\n'));
    expect(diagnostics.hasErrors()).toBe(false);
  });
});

describe('storyCardType variable resolution', () => {
  test('expands values from root variables while retaining literal component keys', () => {
    const { config } = load([
      'variables:',
      '  category: Reference',
      'storyCardType:',
      '  aiInstructions: "{%category} Cards"',
      '  "{%category}": literal-key',
      '',
    ].join('\n'));
    expect(config.storyCardType).toEqual({ aiInstructions: 'Reference Cards', '{%category}': 'literal-key' });
  });

  test('a branch-only variable reports CL0520 once at its storyCardType value', () => {
    const { diagnostics } = load([
      'storyCardType:',
      '  aiInstructions: "{%leafType}"',
      'branches:',
      '  calm:',
      '    variables: {leafType: Reference}',
      '',
    ].join('\n'));
    const raised = diagnostics.all.filter((d) => d.code === CODES.VARIABLE_PRE_BRANCH);
    expect(raised).toHaveLength(1);
    expect(raised[0].line).toBe(2);
  });
});

describe('resolution behavior carried forward', () => {
  test('_base is the directory holding the config', () => {
    expect(load('title: x\n').config._base).toBe(tmpDir);
  });

  test('output resolves relative to the config directory', () => {
    expect(load('structure:\n  output: ./out\n').config._resolvedOutput).toBe(path.join(tmpDir, 'out'));
  });

  test('the v3 cards: key names items: as its replacement, since edit distance cannot', () => {
    const { diagnostics } = load('structure:\n  output: ./out\n  input:\n    cards: [./Codex]\n');
    const diag = diagnostics.errors.find((d) => d.message.includes('cards'));
    expect(diag.hint).toContain('renamed to "items" in v4');
  });

  /**
   * §14.2: the `--migrate` CLI landed in Phase 8, so the rename hint points authors at it.
   */
  test('the rename hint points at the --migrate command', () => {
    const { diagnostics } = load('structure:\n  output: ./out\n  input:\n    cards: [./Codex]\n');
    const diag = diagnostics.errors.find((d) => d.message.includes('cards'));
    expect(diag.hint).toContain('codex-loom --migrate <project>');
  });

  test('{%variables} expand inside structure paths', () => {
    const { config } = load(
      'variables:\n  root: ./Codex\nstructure:\n  input:\n    items: ["{%root}"]\n',
      { dirs: ['Codex'] }
    );
    expect(config._resolvedItems).toEqual([path.join(tmpDir, 'Codex')]);
  });

  test('library entries resolve to absolute paths', () => {
    const { config } = load('structure:\n  input:\n    library:\n      main: ./canon\n', { dirs: ['canon'] });
    expect(config._resolvedLibrary.get('main')).toBe(path.join(tmpDir, 'canon'));
  });

  // §5.1 / §6.1: every string value in compile.cl.yaml passes through the same expander.
  // v3 sent structure.output and structure.reports straight to path.resolve with no
  // expansion — an inconsistency the spec calls out by name, not a scoping rule.
  test('{%variables} expand inside structure.output', () => {
    const { config } = load('variables:\n  root: out\nstructure:\n  output: "./{%root}"\n');
    expect(config._resolvedOutput).toBe(path.join(tmpDir, 'out'));
  });

  test('{%variables} expand inside structure.reports', () => {
    const { config } = load('variables:\n  root: reviews\nstructure:\n  output: ./out\n  reports: "./{%root}"\n');
    expect(config._resolvedReports).toBe(path.join(tmpDir, 'reviews'));
  });

  test('library names are available to structure.output, since library auto-exposes as variables', () => {
    const { config } = load(
      'structure:\n  input:\n    library:\n      main: ./canon\n  output: "{%main}/out"\n',
      { dirs: ['canon'] }
    );
    expect(config._resolvedOutput).toBe(path.join(tmpDir, 'canon', 'out'));
  });

  test('an undeclared {%variable} in structure.output is an ERROR, like every other structure.* path', () => {
    const { codes } = load('structure:\n  output: "./{%typo}"\n');
    expect(codes).toContain(CODES.VARIABLE_UNDECLARED);
  });

  test('structure.input.snapshot resolves relative to the config directory, like output/reports', () => {
    const { config } = load('structure:\n  input:\n    snapshot: ./snapshot\n');
    expect(config._resolvedSnapshot).toBe(path.join(tmpDir, 'snapshot'));
  });

  test('_resolvedSnapshot is null when structure.input.snapshot is unset', () => {
    const { config } = load('structure:\n  output: ./out\n');
    expect(config._resolvedSnapshot).toBeNull();
  });

  test('structure.input.snapshot does not need to exist at load time (it is created by --snapshot)', () => {
    const { config, diagnostics } = load('structure:\n  input:\n    snapshot: ./not-there-yet\n');
    expect(config._resolvedSnapshot).toBe(path.join(tmpDir, 'not-there-yet'));
    expect(diagnostics.errors.length).toBe(0);
  });

  test('{%variables} expand inside structure.input.snapshot', () => {
    const { config } = load('variables:\n  root: frozen\nstructure:\n  input:\n    snapshot: "./{%root}"\n');
    expect(config._resolvedSnapshot).toBe(path.join(tmpDir, 'frozen'));
  });
});

describe('malformed configuration', () => {
  test('a non-mapping document is an ERROR rather than a crash', () => {
    const { config, codes } = load('- just\n- a list\n');
    expect(codes).toContain(CODES.CONFIG_NOT_A_MAPPING);
    expect(config).toBeNull();
  });

  test('an empty file is an ERROR rather than a crash', () => {
    const { codes } = load('');
    expect(codes).toContain(CODES.CONFIG_NOT_A_MAPPING);
  });
});

describe('bus ownership', () => {
  test('with a supplied bus, errors are collected rather than thrown', () => {
    expect(() => load('bogus: 1\n')).not.toThrow();
  });

  test('an unknown key is collected on the bus as an error, and the config still returns', () => {
    const { config, diagnostics } = load('version: 4\nstructure:\n  output: ./out\nbogus: 1\n', { raw: true });
    expect(diagnostics.hasErrors()).toBe(true);
    expect(diagnostics.errors).toHaveLength(1);
    expect(config).not.toBeNull();
  });

  test('warnings alone do not mark the bus as having errors', () => {
    const { diagnostics } = load(
      'version: 4\nstructure:\n  output: ./out\n  input:\n    items: [./nope]\n',
      { raw: true },
    );
    expect(diagnostics.hasErrors()).toBe(false);
    expect(diagnostics.warnings.length).toBeGreaterThan(0);
  });
});

/**
 * The invalid half of the kitchen sink (`__tests__/unit/kitchen-sink.test.js` holds the
 * valid half).
 *
 * The tests above pin the *message* of a handful of diagnostics; this table pins the
 * *code* of every one the config surface can emit, in one place. The point is inventory
 * rather than depth — a new code with no case here is a red test, which is the same
 * property the coverage meta-test gives the valid half.
 */
describe('every diagnostic the config surface can emit', () => {
  const CASES = [
    ['unknown key', CODES.UNKNOWN_KEY, 'bogus: 1\n', {}],
    ['a v3 key that was renamed', CODES.UNKNOWN_KEY, 'overview: ./Review\n', {}],
    ['wrong type, non-empty', CODES.WRONG_TYPE, 'variables:\n  - a\n  - b\n', {}],
    ['missing required key', CODES.MISSING_REQUIRED, 'version: 4\nstructure:\n  input:\n    items: []\n', { raw: true }],
    ['a v3 project (no version: key)', CODES.UNSUPPORTED_VERSION, 'structure:\n  output: ./out\n', { raw: true }],
    // No CL0204 case: `lint.packs` went live in Phase 14 (§8.2.2) and it held the last
    // `note:` on the config surface, so NOT_YET_IMPLEMENTED is now unreachable here —
    // recorded in the `unreachable` set below.
    // The §4.3 case: a correctly spelled key one level too high.
    ['a valid key at the wrong level', CODES.MISPLACED_KEY, 'items: [./Codex]\n', {}],
    ['a document that is not a mapping', CODES.CONFIG_NOT_A_MAPPING, '- a\n- list\n', {}],
    ['a path that does not exist', CODES.PATH_NOT_FOUND, 'structure:\n  input:\n    items: [./nope]\n', {}],
    ['an undeclared variable', CODES.VARIABLE_UNDECLARED, 'variables:\n  a: "{%nope}"\n', {}],
    ['a variable cycle', CODES.VARIABLE_CYCLE, 'variables:\n  a: "{%b}"\n  b: "{%a}"\n', {}],
    ['a branch-scoped variable used pre-branch', CODES.VARIABLE_PRE_BRANCH,
      'structure:\n  input:\n    items: ["./{%r}"]\nbranches:\n  s:\n    variables:\n      r: x\n', {}],
    ['a library name colliding with a variable', CODES.LIBRARY_NAME_COLLIDES,
      'variables:\n  main: x\nstructure:\n  input:\n    library:\n      main: ./canon\n', {}],
  ];

  test.each(CASES)('%s → %s', (_name, code, yaml, options) => {
    expect(load(yaml, options).codes).toContain(code);
  });

  test('the table covers every code the config surface can emit', () => {
    // "The config surface" is what `loadCompileConfig` and its expanders actually raise:
    // every `CODES.NAME` referenced in `src/config/load.js`, plus the schema codes a
    // CONFIG_SCHEMA violation can produce. Codes in `diag.js`'s registry that this module
    // never names are out of scope and not listed here.
    const loadSource = fs.readFileSync(
      path.join(__dirname, '../../src/config/load.js'), 'utf8'
    );
    const configCodes = new Set(
      [...loadSource.matchAll(/\bCODES\.([A-Z_]+)\b/g)]
        .map((m) => CODES[m[1]])
        .filter(Boolean)
    );

    // Schema codes a CONFIG_SCHEMA violation cannot reach, so they have no case here:
    //  - SUPERSEDED_KEY / VALUE_NOT_ALLOWED: no CONFIG_SCHEMA key declares `alias` or `values:`.
    //  - NOT_YET_IMPLEMENTED: no CONFIG_SCHEMA key carries `note:` any more.
    //  - VALUE_OUT_OF_RANGE / PATTERN_MISMATCH: no CONFIG_SCHEMA key declares `min`/`max`
    //    or `pattern:` — only the convention-pack schema surface does (covered in
    //    schema.test.js and lint-packs.test.js).
    const schemaUnreachable = new Set([
      CODES.SUPERSEDED_KEY, CODES.VALUE_NOT_ALLOWED,
      CODES.NOT_YET_IMPLEMENTED, CODES.VALUE_OUT_OF_RANGE,
      CODES.PATTERN_MISMATCH,
    ]);
    for (const c of Object.values(CODES)) {
      if (/^CL02\d\d$/.test(c) && !schemaUnreachable.has(c)) configCodes.add(c);
    }

    // Codes this module names but that fire outside `loadCompileConfig`'s single pass, so
    // they are tested where they are raised rather than here:
    //  - SNAPSHOT_* / LIBRARY_ROLE_SCAN_REFUSED: raised by `snapshot.js`'s
    //    syncLibrary/checkDrift (snapshot.test.js, the --snapshot integration test).
    //  - VARIABLE_UNBIND_UNKNOWN: raised by `model/branches.js`'s walkBranchChain
    //    (model-branches.test.js).
    //  - LIBRARY_DEPENDENCY_UNCOVERED: needs a resolved component dependency, so it fires
    //    in `compile.js`'s leaf loop (component-imports.integration.test.js).
    for (const c of [
      CODES.SNAPSHOT_DIR_MISSING, CODES.SNAPSHOT_MANIFEST_UNPARSEABLE,
      CODES.SNAPSHOT_MISSING_ENTRY, CODES.SNAPSHOT_FILE_UNTRACKED, CODES.SNAPSHOT_HASH_MISMATCH,
      CODES.LIBRARY_ROLE_SCAN_REFUSED, CODES.VARIABLE_UNBIND_UNKNOWN,
      CODES.LIBRARY_DEPENDENCY_UNCOVERED,
    ]) {
      configCodes.delete(c);
    }

    const exercised = new Set(CASES.map(([, code]) => code));
    expect([...configCodes].filter((c) => !exercised.has(c)).sort()).toEqual([]);
  });
});

/**
 * §14.1 / §6: `version: 4` is required with no compatibility mode, so a missing or wrong
 * `version:` is CL0209 — the "run --migrate" detection ERROR — reported before `validate`
 * so a v3 config gets this one line instead of an unknown-key cascade.
 */
describe('version: 4 detection (CL0209)', () => {
  test('no version: key is a v3 project — CL0209 naming --migrate, and load returns null', () => {
    const { config, diagnostics } = load('structure:\n  output: ./out\n', { raw: true });
    expect(config).toBeNull();
    const diag = diagnostics.errors.find((d) => d.code === CODES.UNSUPPORTED_VERSION);
    expect(diag).toBeDefined();
    expect(diag.message).toContain('--migrate');
  });

  test('an explicit version: 3 gets the same v3 detection ERROR', () => {
    const { diagnostics } = load('version: 3\nstructure:\n  output: ./out\n', { raw: true });
    const diag = diagnostics.errors.find((d) => d.code === CODES.UNSUPPORTED_VERSION);
    expect(diag).toBeDefined();
    expect(diag.message).toContain('--migrate');
  });

  test('a version this compiler does not know gets a plain unsupported-version ERROR', () => {
    const { diagnostics } = load('version: 99\nstructure:\n  output: ./out\n', { raw: true });
    const diag = diagnostics.errors.find((d) => d.code === CODES.UNSUPPORTED_VERSION);
    expect(diag).toBeDefined();
    expect(diag.message).toMatch(/unsupported.*99/i);
    expect(diag.message).not.toContain('--migrate');
  });

  test('the v3 ERROR is raised alone — no unknown-key cascade for keys v4 renamed', () => {
    const { codes } = load('protagonist: Tess\noverview: ./Review\nstructure:\n  output: ./out\n', { raw: true });
    expect(codes).toEqual([CODES.UNSUPPORTED_VERSION]);
  });

  test('version: 4 draws no CL0209', () => {
    const { codes } = load('title: x\n');
    expect(codes).not.toContain(CODES.UNSUPPORTED_VERSION);
  });
});

describe('lint: is a fully implemented key surface', () => {
  test('lint.packs at the root validates with no error and no not-yet-implemented WARN', () => {
    const { diagnostics } = load('lint:\n  packs:\n    wtg: {}\n');
    expect(diagnostics.hasErrors()).toBe(false);
  });

  test('a pack entry carrying source: and level: validates', () => {
    const { diagnostics } = load(
      'lint:\n  packs:\n    wtg:\n      source: ./lint/wtg.cl.yaml\n      level: warn\n');
    expect(diagnostics.hasErrors()).toBe(false);
  });

  test('an out-of-set pack level: is a CL0206', () => {
    const { codes } = load('lint:\n  packs:\n    wtg:\n      level: loud\n');
    expect(codes).toContain(CODES.VALUE_NOT_ALLOWED);
  });

  /**
   * `lint:` exists on a branch node because §8.2.2 branch-merges `lint.packs`. As of
   * Phase 14 a branch-declared `level:` is also live — a per-branch ceiling that names the
   * branch — so it no longer draws a not-yet-implemented WARN.
   */
  test('lint.level on a branch node is accepted silently', () => {
    const { diagnostics } = load(
      'branches:\n  hero:\n    lint:\n      level: off\n');
    expect(diagnostics.hasErrors()).toBe(false);
  });

  test('lint.packs on a branch node stays legal — the branch merge carries it', () => {
    const { diagnostics } = load(
      'branches:\n  hero:\n    lint:\n      packs:\n        wtg: {}\n');
    expect(diagnostics.hasErrors()).toBe(false);
  });

  /**
   * The bug this pins was invisible to every diagnostic-shaped test. `loadCompileConfig`
   * returns an explicit projection of the config, and a key validated by the schema but
   * absent from that projection is accepted, documented, and completely inert — which is
   * what `lint:` was between the schema landing and this line. A key that draws no warning
   * reads as working.
   */
  test('lint reaches the loaded config, not only the schema that validated it', () => {
    const { config } = load('lint:\n  level: off\n');
    expect(config.lint).toEqual({ level: 'off' });
  });

  test('an absent lint block projects as null rather than undefined', () => {
    expect(load('title: x\n').config.lint).toBeNull();
  });

  test('an unknown lint.level value is a CL0206 naming the three legal ones', () => {
    const { diagnostics } = load('lint:\n  level: loud\n');
    const bad = diagnostics.errors.find((d) => d.code === 'CL0206');
    expect(bad).toBeDefined();
    expect(bad.message).toContain('"off"');
    expect(bad.message).toContain('"error"');
    expect(bad.message).toContain('"warn"');
  });
});
