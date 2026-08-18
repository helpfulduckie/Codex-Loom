'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Diagnostics } = require('../../src/diag');
const { loadCompileConfig, CODES } = require('../../src/config/load');
const { CODES: SCHEMA_CODES } = require('../../src/schema');

let tmpDir;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cfg-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

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

describe('diagnostics carry source positions (§4.4)', () => {
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

  test('a cycle names every key in the loop (§6.2)', () => {
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

describe('pre-branch scoping (§5.1, CL0520)', () => {
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
    expect(diag.hint).toContain('--migrate');
  });

  test('{%variables} expand inside structure paths', () => {
    const { config } = load(
      'variables:\n  root: ./Codex\nstructure:\n  input:\n    items: ["{%root}"]\n',
      { dirs: ['Codex'] }
    );
    expect(config._resolvedItems).toEqual([path.join(tmpDir, 'Codex')]);
  });

  test('canon entries resolve to absolute paths', () => {
    const { config } = load('structure:\n  input:\n    canon:\n      main: ./canon\n', { dirs: ['canon'] });
    expect(config._resolvedCanon.get('main')).toBe(path.join(tmpDir, 'canon'));
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

  test('canon names are available to structure.output, since canon auto-exposes as variables', () => {
    const { config } = load(
      'structure:\n  input:\n    canon:\n      main: ./canon\n  output: "{%main}/out"\n',
      { dirs: ['canon'] }
    );
    expect(config._resolvedOutput).toBe(path.join(tmpDir, 'canon', 'out'));
  });

  test('an undeclared {%variable} in structure.output is an ERROR, like every other structure.* path', () => {
    const { codes } = load('structure:\n  output: "./{%typo}"\n');
    expect(codes).toContain(CODES.VARIABLE_UNDECLARED);
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

  test('without a supplied bus, errors are printed and thrown', () => {
    const cfgPath = path.join(tmpDir, 'compile.cl.yaml');
    fs.writeFileSync(cfgPath, 'version: 4\nstructure:\n  output: ./out\nbogus: 1\n', 'utf8');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadCompileConfig(cfgPath)).toThrow('Configuration has 1 error');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('warnings alone do not throw', () => {
    const cfgPath = path.join(tmpDir, 'compile.cl.yaml');
    fs.writeFileSync(
      cfgPath,
      'version: 4\nstructure:\n  output: ./out\n  input:\n    items: [./nope]\n',
      'utf8'
    );
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => loadCompileConfig(cfgPath)).not.toThrow();
    spy.mockRestore();
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
    ['unknown key', SCHEMA_CODES.UNKNOWN_KEY, 'bogus: 1\n', {}],
    ['a v3 key that was renamed', SCHEMA_CODES.UNKNOWN_KEY, 'overview: ./Review\n', {}],
    ['wrong type, non-empty', SCHEMA_CODES.WRONG_TYPE, 'variables:\n  - a\n  - b\n', {}],
    ['missing required key', SCHEMA_CODES.MISSING_REQUIRED, 'version: 4\nstructure:\n  input:\n    items: []\n', { raw: true }],
    ['not yet implemented', SCHEMA_CODES.NOT_YET_IMPLEMENTED, 'roles:\n  protagonist: Aness\n', {}],
    // The §4.3 case: a correctly spelled key one level too high.
    ['a valid key at the wrong level', SCHEMA_CODES.MISPLACED_KEY, 'items: [./Codex]\n', {}],
    ['a document that is not a mapping', CODES.CONFIG_NOT_A_MAPPING, '- a\n- list\n', {}],
    ['a path that does not exist', CODES.PATH_NOT_FOUND, 'structure:\n  input:\n    items: [./nope]\n', {}],
    ['an undeclared variable', CODES.VARIABLE_UNDECLARED, 'variables:\n  a: "{%nope}"\n', {}],
    ['a variable cycle', CODES.VARIABLE_CYCLE, 'variables:\n  a: "{%b}"\n  b: "{%a}"\n', {}],
    ['a branch-scoped variable used pre-branch', CODES.VARIABLE_PRE_BRANCH,
      'structure:\n  input:\n    items: ["./{%r}"]\nbranches:\n  s:\n    variables:\n      r: x\n', {}],
    ['a canon name colliding with a variable', CODES.CANON_NAME_COLLIDES,
      'variables:\n  main: x\nstructure:\n  input:\n    canon:\n      main: ./canon\n', {}],
  ];

  test.each(CASES)('%s → %s', (_name, code, yaml, options) => {
    expect(load(yaml, options).codes).toContain(code);
  });

  test('the table covers every code the config surface declares', () => {
    // Two omissions, both unreachable from this surface rather than untested.
    // CL0205 (SUPERSEDED_KEY): no key in CONFIG_SCHEMA declares an `alias` — the v3
    // spellings were removed outright at the config break rather than kept as warned
    // aliases (§14.1). CL0206 (VALUE_NOT_ALLOWED): no key in CONFIG_SCHEMA declares a
    // `values:` set. The item schema does, for `kind:` (§4.8), and `schema.test.js`
    // covers it there.
    const unreachable = new Set([SCHEMA_CODES.SUPERSEDED_KEY, SCHEMA_CODES.VALUE_NOT_ALLOWED]);
    const reachable = [...Object.values(CODES), ...Object.values(SCHEMA_CODES)]
      .filter((c) => !unreachable.has(c));
    const exercised = new Set(CASES.map(([, code]) => code));
    expect(reachable.filter((c) => !exercised.has(c))).toEqual([]);
  });
});

describe('later-phase keys are recognized, not rejected', () => {
  test.each([
    ['roles', 'roles:\n  protagonist: Aness\n'],
    ['lint', 'lint:\n  level: warn\n'],
  ])('%s WARNs as unimplemented rather than erroring', (_name, yaml) => {
    const { diagnostics } = load(yaml);
    expect(diagnostics.hasErrors()).toBe(false);
    expect(diagnostics.warnings.some((d) => d.message.includes('not yet implemented'))).toBe(true);
  });

  /**
   * The inverse, and the half a stale `note:` would otherwise pass. `placeholders:` moved
   * off the list above in Phase 4 Step 1; a note left on an implemented key tells authors
   * their declaration will be ignored while the compiler honors it, which is worse than no
   * note at all — the same failure `kitchen-sink.test.js` pins for slotted components.
   */
  test('placeholders is implemented and no longer warns', () => {
    const { diagnostics } = load("placeholders:" + String.fromCharCode(10) + "  heroName: Who?" + String.fromCharCode(10));
    expect(diagnostics.hasErrors()).toBe(false);
    expect(diagnostics.warnings.some((d) => d.message.includes('not yet implemented'))).toBe(false);
  });
});
