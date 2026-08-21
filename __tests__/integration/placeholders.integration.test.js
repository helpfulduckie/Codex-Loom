'use strict';

/**
 * §12.3 checks 1 and 3 across every destination — Phase 4 Steps 3 and 4.
 *
 * These are integration tests because the question is *which write points are covered*, and
 * no unit can answer it. `checkUndeclaredPlaceholders` is unit-tested on its own; what it
 * cannot tell you is whether the branch title, the Opening, the Description and a
 * placeholder's own question text each reach it. Every one of those is written by a
 * different function, and three of them run outside the leaf loop where the merged table
 * lives — which is exactly how a destination gets forgotten.
 *
 * The pathological fixture covers the item and component paths and pins them in a snapshot.
 * These cover the ones it does not, and assert on codes rather than on rendered text so
 * rewording a message does not fail them.
 *
 * Check 3 is here for a second reason: its rescope is mostly a statement about what is
 * *legal*, and a check that wrongly forbids something has no failing case of its own. The
 * silent tests are the load-bearing ones.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');
const { CODES } = require('../../src/diag');

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const ITEM = [
  '- id: Anchor',
  '  name: Anchor',
  '  aid: {type: Character, triggers: [Anchor]}',
  '  body: {Tagline: Nothing interesting.}',
  '',
].join('\n');

/** Compile a one-off project and return every diagnostic it raised. */
function run(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-ph-int-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'templates', 'Character.template'), '{$body.Tagline}\n', 'utf8');
  if (!files['Codex/items.cl.yaml']) {
    fs.mkdirSync(path.join(dir, 'Codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Codex', 'items.cl.yaml'), ITEM, 'utf8');
  }

  const diagnostics = new Diagnostics();
  const spies = ['log', 'warn', 'error'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  try {
    compile(path.join(dir, 'compile.cl.yaml'), { diagnostics });
  } catch (err) { /* ERRORs are the subject; the throw carries only a count */ } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return diagnostics.all;
}

const undeclared = (diags) => diags
  .filter((d) => d.code === CODES.PLACEHOLDER_UNDECLARED)
  .map((d) => d.message);

const byCode = (diags, code) => diags.filter((d) => d.code === code).map((d) => d.message);

const HEAD = [
  'version: 4',
  'title: Probe',
  'structure:',
  '  input:',
  "    items: ['./Codex']",
  "    templates: ['./templates']",
  "  output: './out'",
].join('\n');

describe('undeclared placeholders are caught in every destination', () => {
  test('a branch title', () => {
    const found = undeclared(run({
      'compile.cl.yaml': [HEAD, 'branches:', '  north:', '    title: The %missing% Road', ''].join('\n'),
    }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('%missing%');
    expect(found[0]).toContain('north');
  });

  test('the project title', () => {
    const found = undeclared(run({
      'compile.cl.yaml': [
        'version: 4', 'title: The %missing% Chronicle', 'structure:', '  input:',
        "    items: ['./Codex']", "    templates: ['./templates']", "  output: './out'", '',
      ].join('\n'),
    }));
    expect(found.some((m) => m.includes('the project title'))).toBe(true);
  });

  test('an Opening', () => {
    const found = undeclared(run({
      'compile.cl.yaml': [
        HEAD, 'components:', '  opening: You wake in %missing%, alone.', '',
      ].join('\n'),
    }));
    expect(found.some((m) => m.includes('Opening'))).toBe(true);
  });

  test('branch framing on a non-leaf', () => {
    const found = undeclared(run({
      'compile.cl.yaml': [
        HEAD, 'branches:', '  north:', '    components:',
        '      branchFraming: Where in %missing% do you begin?',
        '    branches:', '      keep:', '        title: The Keep', '',
      ].join('\n'),
    }));
    expect(found.some((m) => m.includes('branch framing'))).toBe(true);
  });

  test('the Description', () => {
    const found = undeclared(run({
      'compile.cl.yaml': [HEAD, 'components:', "  description: './desc.md'", ''].join('\n'),
      'desc.md': 'A tale of %missing% and its people.\n',
    }));
    expect(found.some((m) => m.includes('Description'))).toBe(true);
  });

  test("a placeholder's own question text", () => {
    // After compile-time expansion every declared key has had its chance to substitute, so
    // a surviving `%x%` in a question is unambiguously undeclared.
    const found = undeclared(run({
      'compile.cl.yaml': [
        HEAD, 'placeholders:', '  liGender: What is %liName% gender?', '',
      ].join('\n'),
    }));
    expect(found.some((m) => m.includes('question text') && m.includes('%liName%'))).toBe(true);
  });
});

describe('declared placeholders are silent everywhere', () => {
  test('every destination at once, with the key declared', () => {
    const diags = run({
      'compile.cl.yaml': [
        'version: 4',
        'title: The %saga% Chronicle',
        'structure:', '  input:', "    items: ['./Codex']", "    templates: ['./templates']",
        "  output: './out'",
        'placeholders:', '  saga: Name your saga?',
        'components:', '  opening: You wake in the %saga% lands.', "  description: './desc.md'",
        'branches:', '  north:', '    title: The %saga% Road', '',
      ].join('\n'),
      'desc.md': 'A tale of the %saga%.\n',
    });
    expect(undeclared(diags)).toEqual([]);
  });

  test('a key declared on a branch covers that branch and not its sibling', () => {
    const found = undeclared(run({
      'compile.cl.yaml': [
        HEAD,
        'branches:',
        '  north:', '    title: The %hold% Road', '    placeholders:', '      hold: Which hold?',
        '  south:', '    title: The %hold% Coast', '',
      ].join('\n'),
    }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('south');
  });

  test('a key unbound with ~ becomes undeclared on that branch', () => {
    // This is what the unbind actually buys. It cannot be expressed in the emitted output —
    // Velvet Lattice has no way to remove an inherited key — so its whole effect is here.
    const found = undeclared(run({
      'compile.cl.yaml': [
        HEAD,
        'placeholders:', '  hold: Which hold?',
        'branches:',
        '  north:', '    title: The %hold% Road',
        '  south:', '    title: The %hold% Coast', '    placeholders:', '      hold: ~', '',
      ].join('\n'),
    }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('south');
  });
});

describe('§12.3 check 3 — where a placeholder may not go', () => {
  const DECLARED = ['placeholders:', '  hero: Your name?'];

  test('the Description errors even though the key is declared', () => {
    // The whole point of separating this from the undeclared check: the Description is
    // shown before an adventure exists to answer a prompt, so declaring it changes nothing.
    const diags = run({
      'compile.cl.yaml': [HEAD, ...DECLARED, 'components:', "  description: './desc.md'", ''].join('\n'),
      'desc.md': 'You play %hero%.\n',
    });
    expect(byCode(diags, CODES.PLACEHOLDER_INVALID_CONTEXT)).toHaveLength(1);
    expect(undeclared(diags)).toEqual([]);
  });

  test("a card's type errors, and is reported before the template it also breaks", () => {
    // `aid.type` picks the template when none is named, so a placeholder there fails to
    // match one too. If the context check ran after the template ladder, CL0420 would be
    // the only thing reported — the symptom, with the cause skipped past.
    const diags = run({
      'compile.cl.yaml': [HEAD, ...DECLARED, ''].join('\n'),
      'Codex/items.cl.yaml': [
        '- id: Bad', '  name: Bad', '  aid:', "    type: 'Character-%hero%'",
        '    triggers: [Bad]', '  body: {Tagline: x}', '',
      ].join('\n'),
    });
    const codes = diags.map((d) => d.code);
    expect(codes).toContain(CODES.PLACEHOLDER_INVALID_CONTEXT);
    expect(codes.indexOf(CODES.PLACEHOLDER_INVALID_CONTEXT))
      .toBeLessThan(codes.indexOf(CODES.TEMPLATE_NOT_FOUND));
  });

  test('a branch title warns rather than erroring', () => {
    const diags = run({
      'compile.cl.yaml': [
        HEAD, ...DECLARED, 'branches:', '  north:', '    title: The %hero% Road', '',
      ].join('\n'),
    });
    expect(byCode(diags, CODES.PLACEHOLDER_IN_TITLE)).toHaveLength(1);
    expect(byCode(diags, CODES.PLACEHOLDER_INVALID_CONTEXT)).toEqual([]);
  });

  test('the scenario title warns — it is never filled, only legal', () => {
    // Confirmed against AID: it does not substitute in the listing name, and no author
    // expects it to. A WARN rather than an ERROR because writing one is legal and can even
    // be the joke — `${Roleplaying A Cool AID Scenario}` works *because* it is never
    // replaced.
    const diags = run({
      'compile.cl.yaml': [
        'version: 4', 'title: The %hero% Chronicle', 'structure:', '  input:',
        "    items: ['./Codex']", "    templates: ['./templates']", "  output: './out'",
        ...DECLARED, '',
      ].join('\n'),
    });
    expect(byCode(diags, CODES.PLACEHOLDER_IN_TITLE)).toHaveLength(1);
    expect(byCode(diags, CODES.PLACEHOLDER_INVALID_CONTEXT)).toEqual([]);
  });

  test('components and card bodies are legal and stay silent', () => {
    // The half of the rescope that matters most: Velvet Lattice warns on AI Instructions
    // and Summary, AID added both in March 2026, and adopting VL's list would make Codex
    // Loom stricter than the tool it compiles for.
    const diags = run({
      'compile.cl.yaml': [
        HEAD, ...DECLARED, 'components:', '  opening: You wake, %hero%.', '',
      ].join('\n'),
      'Codex/items.cl.yaml': [
        '- id: Anchor', '  name: Anchor',
        '  aid: {type: Character, triggers: [Anchor]}',
        '  body: {Tagline: "They call you %hero%."}', '',
      ].join('\n'),
    });
    expect(byCode(diags, CODES.PLACEHOLDER_INVALID_CONTEXT)).toEqual([]);
    expect(byCode(diags, CODES.PLACEHOLDER_IN_TITLE)).toEqual([]);
  });
});

describe('§12.3 check 2 — declared but never used', () => {
  const unused = (diags) => diags
    .filter((d) => d.code === CODES.PLACEHOLDER_UNUSED)
    .map((d) => d.message);

  test('a root key used on one branch of three is silent', () => {
    const diags = run({
      'compile.cl.yaml': [
        HEAD,
        'placeholders:', '  saga: Name your saga?',
        'branches:',
        '  north:', '    title: The %saga% Road',
        '  south:', '    title: The Coast',
        '  east:', '    title: The Marches', '',
      ].join('\n'),
    });
    expect(unused(diags)).toEqual([]);
  });

  test('a root key used nowhere warns once', () => {
    const diags = run({
      'compile.cl.yaml': [HEAD, 'placeholders:', '  ghost: Never asked for?', ''].join('\n'),
    });
    expect(unused(diags)).toHaveLength(1);
    expect(unused(diags)[0]).toContain('%ghost%');
  });

  test('a branch key used only on a sibling warns', () => {
    const diags = run({
      'compile.cl.yaml': [
        HEAD,
        'branches:',
        '  north:', '    placeholders:', '      hold: Which hold?', '    title: The North',
        '  south:', '    title: The %hold% Coast', '',
      ].join('\n'),
    });
    expect(unused(diags)).toHaveLength(1);
    expect(unused(diags)[0]).toContain('north');
  });

  test('use inside another question counts — the nesting reaches the player', () => {
    // Step 2 expands nesting into the emitted file, so the inner question does reach the
    // player, through the outer prompt rather than on its own.
    const diags = run({
      'compile.cl.yaml': [
        HEAD,
        'placeholders:',
        '  liName: Their name?',
        '  liGender: What is %liName% gender?',
        'components:', '  opening: You travel with %liGender%.', '',
      ].join('\n'),
    });
    expect(unused(diags)).toEqual([]);
  });

  test('a card body counts as use', () => {
    const diags = run({
      'compile.cl.yaml': [HEAD, 'placeholders:', '  hero: Your name?', ''].join('\n'),
      'Codex/items.cl.yaml': [
        '- id: Anchor', '  name: Anchor',
        '  aid: {type: Character, triggers: [Anchor]}',
        '  body: {Tagline: "They call you %hero%."}', '',
      ].join('\n'),
    });
    expect(unused(diags)).toEqual([]);
  });
});

describe('duplicate question text, end to end', () => {
  const dupes = (diags) => diags
    .filter((d) => d.code === CODES.PLACEHOLDER_DUPLICATE_QUESTION)
    .map((d) => d.message);

  test('two root keys with one question warn once', () => {
    const diags = run({
      'compile.cl.yaml': [
        HEAD,
        'placeholders:',
        '  heroName: What is your name?',
        '  pcName: What is your name?',
        'components:', '  opening: %heroName% and %pcName% set out.', '',
      ].join('\n'),
    });
    expect(dupes(diags)).toHaveLength(1);
  });

  test('one key used many times is not a duplicate', () => {
    // The distinction the check's name invites getting wrong: reuse is the feature.
    const diags = run({
      'compile.cl.yaml': [
        HEAD,
        'placeholders:', '  hero: What is your name?',
        'components:', '  opening: %hero%, %hero%, and %hero% again.',
        'branches:', '  north:', '    title: The %hero% Road', '',
      ].join('\n'),
    });
    expect(dupes(diags)).toEqual([]);
  });

  test('keys that differ in source but agree after variables expand still collide', () => {
    // Compared on the expanded form, because that is what AID sees — and what decides
    // whether the two prompts collapse into one.
    const diags = run({
      'compile.cl.yaml': [
        HEAD,
        'variables:', '  noun: name',
        'placeholders:',
        '  a: What is your {%noun} ?',
        '  b: What is your name ?',
        'components:', '  opening: %a% %b%', '',
      ].join('\n'),
    });
    expect(dupes(diags)).toHaveLength(1);
  });

  test('a branch key colliding with an inherited one is caught', () => {
    const diags = run({
      'compile.cl.yaml': [
        HEAD,
        'placeholders:', '  hero: What is your name?',
        'components:', '  opening: You are %hero%.',
        'branches:',
        '  north:', '    placeholders:', '      alias: What is your name?',
        '    title: The %alias% Road', '',
      ].join('\n'),
    });
    expect(dupes(diags)).toHaveLength(1);
  });
});

/**
 * §12.5's ceiling, end to end through a real compile.
 *
 * `CL0535` — a placeholder declared and referenced nowhere beneath its declaring node — is
 * an opinion, and `CL0532` — a `%key%` reaching output undeclared — is a fact. One project
 * raising both is the shortest proof that `lint.level` reaches one and cannot reach the
 * other.
 */
describe('lint.level reaches the opinion layer and nothing else', () => {
  const project = (lint) => ({
    'compile.cl.yaml': [
      'version: 4',
      'title: Probe',
      'structure:',
      '  input:',
      "    items: ['./Codex']",
      "    templates: ['./templates']",
      "  output: './out'",
      ...lint,
      'placeholders:',
      '  neverUsed: Which house raised you?',
      'branches:',
      '  north:',
      '    title: The %missing% Road',
      '',
    ].join('\n'),
  });

  test('with no lint block, both the opinion and the fact are reported', () => {
    const codes = run(project([])).map((d) => d.code);
    expect(codes).toContain(CODES.PLACEHOLDER_UNUSED);
    expect(codes).toContain(CODES.PLACEHOLDER_UNDECLARED);
  });

  test('level: off drops the opinion and leaves the fact standing', () => {
    const codes = run(project(['lint:', '  level: off'])).map((d) => d.code);
    expect(codes).not.toContain(CODES.PLACEHOLDER_UNUSED);
    expect(codes).toContain(CODES.PLACEHOLDER_UNDECLARED);
  });

  test('level: error drops the opinion too, the prose heuristics all being WARNs', () => {
    const codes = run(project(['lint:', '  level: error'])).map((d) => d.code);
    expect(codes).not.toContain(CODES.PLACEHOLDER_UNUSED);
    expect(codes).toContain(CODES.PLACEHOLDER_UNDECLARED);
  });

  test('level: warn keeps the opinion at WARN', () => {
    const unused = run(project(['lint:', '  level: warn']))
      .filter((d) => d.code === CODES.PLACEHOLDER_UNUSED);
    expect(unused).toHaveLength(1);
    expect(unused[0].severity).toBe('warn');
  });
});
