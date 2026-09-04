'use strict';

/**
 * Roles end to end (§9.2, §9.3, Phase 8 Step 0 + Step 1).
 *
 * These have to be integration tests for the same reason placement-diagnostics does: a
 * role's declaration lives in `compile.cl.yaml`, its resolution runs inside `compile.js`'s
 * leaf loop, and diagnostic collection across the whole branch tree is a property of the
 * compile run, not of any one module.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');

const dirs = [];

/** Compile a one-off project and hand back what it said (see placement-diagnostics for why). */
function compileProject(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-roles-'));
  dirs.push(tmpDir);
  const slash = (p) => p.replace(/\\/g, '/');

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.replace(/%TMP%/g, slash(tmpDir)), 'utf8');
  }

  const diagnostics = new Diagnostics();
  let threw = null;
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics });
  } catch (err) {
    threw = err;
  }
  return { output: diagnostics.all.map((d) => d.format()).join('\n'), threw, tmpDir };
}

/**
 * Every diagnostic carrying `code`, each rejoined with its message line — `Diagnostic.format()`
 * puts the code and location on one line and the message on the next, so a bare line filter
 * would find the occurrence and lose the sentence naming what it's about.
 */
function occurrences(output, code) {
  const lines = output.split('\n');
  return lines
    .map((line, i) => (line.includes(code) ? `${line}\n${lines[i + 1] || ''}` : null))
    .filter(Boolean);
}

function cardFile(tmpDir, branch, type) {
  return branch
    ? path.join(tmpDir, 'output', 'Branches', branch, 'Story Cards', type, `${type}.md`)
    : path.join(tmpDir, 'output', 'Story Cards', type, `${type}.md`);
}

const BASE = {
  'templates/Full.template': '{$name.full} - {$body.Tagline}',
};

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('a branch-level roles: block reaches the token pass', () => {
  const files = {
    ...BASE,
    'Codex/items.yaml': [
      '- id: Malcolm',
      '  name: {display: Malcolm, full: Malcolm Vale}',
      '  pronouns: male',
      '  aid: {type: Character, triggers: [Malcolm]}',
      '  render: {template: Full}',
      '  body:',
      '    Tagline: "History with {$LI} is unresolved. {$LI.he} does not raise it."',
    ].join('\n'),
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'roles:',
      '  LI: Malcolm',
      'branches:',
      '  zephon: {}',
      '',
    ].join('\n'),
  };

  test('{$LI} resolves against the declared role, with no CL0540/CL0430 noise', () => {
    const { threw, output, tmpDir } = compileProject(files);
    expect(threw).toBeNull();
    expect(occurrences(output, 'CL0540')).toEqual([]);
    expect(occurrences(output, 'CL0430')).toEqual([]);
    const content = fs.readFileSync(cardFile(tmpDir, 'zephon', 'Character'), 'utf8');
    expect(content).toContain('History with Malcolm is unresolved. he does not raise it.');
  });
});

/**
 * §9.2's fourth token form, `{$Role.body.Field}`, end to end. `applyCrossItemRefs` runs
 * before the token pass and reads item ids only, so this only resolves because
 * `applyRolePass` rewrites the leading role name first. The plain-id form `{$Kaiden.body.…}`
 * is the control — it resolved before this pass existed and must still resolve now.
 * Asserted on the rendered card, not the call site: a leaked token here would surface as
 * CL0430, which the test also rules out.
 */
describe('{$Role.body.Field} resolves through the role, like the plain-id cross-item ref', () => {
  const files = {
    ...BASE,
    'Codex/items.yaml': [
      '- id: Kaiden',
      '  name: {display: Kaiden, full: Kaiden Ash}',
      '  pronouns: male',
      '  aid: {type: Character, triggers: [Kaiden]}',
      '  render: {template: Full}',
      '  body:',
      '    Tagline: the quiet one',
      '- id: Ree',
      '  name: {display: Ree, full: Ree Sol}',
      '  pronouns: female',
      '  aid: {type: Character, triggers: [Ree]}',
      '  render: {template: Full}',
      '  body:',
      '    Tagline: "via role: {$LI.body.Tagline}; via id: {$Kaiden.body.Tagline}"',
    ].join('\n'),
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'roles:',
      '  LI: Kaiden',
      'branches:',
      '  solo: {}',
      '',
    ].join('\n'),
  };

  test('both the role form and the id form resolve, with no CL0430 leak', () => {
    const { threw, output, tmpDir } = compileProject(files);
    expect(threw).toBeNull();
    expect(occurrences(output, 'CL0430')).toEqual([]);
    expect(occurrences(output, 'CL0540')).toEqual([]);
    const content = fs.readFileSync(cardFile(tmpDir, 'solo', 'Character'), 'utf8');
    expect(content).toContain('via role: the quiet one; via id: the quiet one');
    expect(content).not.toContain('{$LI.body.Tagline}');
  });
});

describe('~ unbinds a role rather than resolving to a null binding', () => {
  const files = {
    ...BASE,
    'Codex/items.yaml': [
      '- id: Malcolm',
      '  name: {display: Malcolm, full: Malcolm Vale}',
      '  pronouns: male',
      '  aid: {type: Character, triggers: [Malcolm]}',
      '  render: {template: Full}',
      '  body:',
      '    Tagline: "{$LI} left"',
    ].join('\n'),
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'roles:',
      '  LI: Malcolm',
      'branches:',
      '  unbound:',
      '    roles:',
      '      LI: ~',
      '',
    ].join('\n'),
  };

  test('CL0540 fires under the unbound branch, and nothing renders a null binding', () => {
    const { output, tmpDir } = compileProject(files);
    expect(occurrences(output, 'CL0540').length).toBeGreaterThan(0);
    const content = fs.readFileSync(cardFile(tmpDir, 'unbound', 'Character'), 'utf8');
    expect(content).not.toContain('null');
  });
});

describe('an undeclared role collects across the branch rather than aborting on the first', () => {
  const items = ['A', 'B', 'C', 'D'].map((n) => [
    `- id: ${n}`,
    `  name: {display: ${n}, full: ${n} Vale}`,
    '  pronouns: male',
    `  aid: {type: Character, triggers: [${n}]}`,
    '  render: {template: Full}',
    '  body:',
    `    Tagline: "{$Rival} is watching ${n}"`,
  ].join('\n')).join('\n');

  const files = {
    ...BASE,
    'Codex/items.yaml': items,
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      // A different role declared, so the branch is role-aware (CL0540 is gated on that) —
      // "Rival" itself is left undeclared, which is the case under test.
      'roles:',
      '  LI: A',
      'branches:',
      '  main: {}',
      '',
    ].join('\n'),
  };

  test('four cards referencing an undeclared role produce four CL0540 diagnostics from one compile', () => {
    const { output } = compileProject(files);
    // §9.4.3's collection requirement: one run, one report per occurrence, not an abort on
    // the first — the compile bus never aborts mid-run (compile.js:1318's own claim).
    expect(occurrences(output, 'CL0540').length).toBe(4);
  });
});

describe('CL0545 — a role declared and never referenced', () => {
  const files = {
    ...BASE,
    'Codex/items.yaml': [
      '- id: Malcolm',
      '  name: {display: Malcolm, full: Malcolm Vale}',
      '  pronouns: male',
      '  aid: {type: Character, triggers: [Malcolm]}',
      '  render: {template: Full}',
      '  body:',
      '    Tagline: "Malcolm walked in"',
    ].join('\n'),
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'roles:',
      '  LI: Malcolm',
      'branches:',
      '  main: {}',
      '',
    ].join('\n'),
  };

  test('a role no text ever references warns CL0545, naming the role', () => {
    const { output } = compileProject(files);
    const hits = occurrences(output, 'CL0545');
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatch(/LI/);
  });
});

/**
 * The roles gap (Phase 10 Step 4, v4 spec §9.2/§9.3): `branchFraming` and the root
 * `Description` never received a roles table or a resolved protagonist, so a `{$role}`
 * token at either site read as an undeclared role (CL0540) rather than resolving. Proven
 * by the rendered file, not by the call site's arguments — per the step's own stop
 * condition, an empty diff here would mean the fixture doesn't exercise the gap, not that
 * it's closed.
 */
describe('the roles gap — branchFraming and the root Description', () => {
  const files = {
    ...BASE,
    'Codex/items.yaml': [
      '- id: Malcolm',
      '  name: {display: Malcolm, full: Malcolm Vale}',
      '  pronouns: male',
      '  aid: {type: Character, triggers: [Malcolm]}',
      '  render: {template: Full}',
      '  body:',
      '    Tagline: Malcolm walked in',
    ].join('\n'),
    'components/framing.cl.yaml': [
      'sections:',
      '  ask:',
      '    text: "History with {$LI} is unresolved."',
      '    render: {position: 1}',
    ].join('\n'),
    'components/description.cl.yaml': [
      'sections:',
      '  blurb:',
      '    text: "Rumors mention {$LI}."',
      '    render: {position: 1}',
    ].join('\n'),
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'roles:',
      '  LI: Malcolm',
      'components:',
      '  description: ./components/description.cl.yaml',
      'branches:',
      '  act1:',
      '    components:',
      '      branchFraming: ./components/framing.cl.yaml',
      '    branches:',
      '      calm: {components: {opening: Which way?}}',
      '      storm: {components: {opening: Which way?}}',
      '',
    ].join('\n'),
  };

  test('a branchFraming component at an interior node resolves a role reference', () => {
    const { output, tmpDir } = compileProject(files);
    expect(occurrences(output, 'CL0540')).toEqual([]);
    const framing = fs.readFileSync(
      path.join(tmpDir, 'output', 'Branches', 'act1', 'Components', 'Opening.md'), 'utf8',
    ).trim();
    expect(framing).toBe('History with Malcolm is unresolved.');
  });

  test('the root Description resolves a role reference the same way', () => {
    const { output, tmpDir } = compileProject(files);
    expect(occurrences(output, 'CL0540')).toEqual([]);
    const description = fs.readFileSync(
      path.join(tmpDir, 'output', 'Description.md'), 'utf8',
    ).trim();
    expect(description).toBe('Rumors mention Malcolm.');
  });

  test('both sites calling onRoleUsed means CL0545 does not fire for a role only they reference', () => {
    const { output } = compileProject(files);
    expect(occurrences(output, 'CL0545')).toEqual([]);
  });
});

/**
 * A `{%var}` in `roles.protagonist` is expanded once per node where the answer can change
 * (`resolveProtagonists` in compile.js), not once per leaf. Before the hoist the leaf loop
 * and the framing walker each expanded it themselves with no bus, so an undeclared name was
 * an uncoded `console.warn` and the build passed with a protagonist that matched nothing.
 * Now it is the same `CL0510` every other undeclared-variable site raises, exactly once, and
 * the run fails.
 */
describe('an undeclared {%var} in roles.protagonist is one CL0510, not one per leaf', () => {
  const files = {
    ...BASE,
    'Codex/items.yaml': [
      '- id: Malcolm',
      '  name: {display: Malcolm, full: Malcolm Vale}',
      '  pronouns: male',
      '  aid: {type: Character, triggers: [Malcolm]}',
      '  render: {template: Full}',
      '  body:',
      '    Tagline: "Seen: {$Malcolm}."',
    ].join('\n'),
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'roles:',
      '  protagonist: "{%hero}"',
      'branches:',
      '  a: {}',
      '  b: {}',
      '  c: {}',
      '',
    ].join('\n'),
  };

  test('three leaves, one CL0510 naming the token, and the build fails', () => {
    const { threw, output } = compileProject(files);
    const found = occurrences(output, 'CL0510');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('{%hero}');
    expect(threw).not.toBeNull();
    expect(threw.message).toMatch(/while compiling/);
  });
});

describe('a branch that declares the missing variable resolves its own protagonist', () => {
  const files = {
    ...BASE,
    'Codex/items.yaml': [
      '- id: Malcolm',
      '  name: {display: Malcolm, full: Malcolm Vale}',
      '  pronouns: male',
      '  aid: {type: Character, triggers: [Malcolm]}',
      '  render: {template: Full}',
      '  body:',
      '    Tagline: "Seen: {$Malcolm}."',
    ].join('\n'),
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'roles:',
      '  protagonist: "{%hero}"',
      'branches:',
      '  bound:',
      '    variables: {hero: Malcolm}',
      // Two leaves under an unbound interior node: the interior node and both leaves inherit
      // the root's failed resolve without re-reporting it.
      '  unbound:',
      '    branches:',
      '      x: {}',
      '      y: {}',
      '',
    ].join('\n'),
  };

  test('the bound subtree renders "you", the unbound one renders the name, and CL0510 fires once', () => {
    const { output, tmpDir } = compileProject(files);
    expect(occurrences(output, 'CL0510')).toHaveLength(1);
    const bound = fs.readFileSync(cardFile(tmpDir, 'bound', 'Character'), 'utf8');
    expect(bound).toContain('Seen: you.');
    // `x` and `y` render the card identically, so Phase 11 placement writes it once at the
    // `unbound` node rather than at either leaf.
    const unbound = fs.readFileSync(cardFile(tmpDir, 'unbound', 'Character'), 'utf8');
    expect(unbound).toContain('Seen: Malcolm.');
  });
});
