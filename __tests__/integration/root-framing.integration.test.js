'use strict';

/**
 * Phase 11 Step 1 — root `branchFraming` renders through the same sectioned path an
 * interior node uses, rather than the literal/`{%variable}`-only `resolveOpeningContent`
 * the old hand-rolled root rung called.
 *
 * `__tests__/fixtures/kitchen-sink/` cannot carry this proof: its own header says it is
 * "validated, not compiled" — `kitchen-sink.test.js` only walks the schema for key
 * coverage, and the project's declared canon/templates/scripts don't exist on disk, so a
 * real `compile()` against it fails long before reaching root framing. None of the golden
 * corpus can carry it either (per the Phase 11 plan's Fixture obligations): proving a
 * `{$role}` token at root framing needs a **non-protagonist** role bound at a project
 * root, and no golden declares one. This test builds the smallest project that can.
 *
 * Three things this proves, per the plan's Session A stop conditions:
 *   - a root-level `branchFraming` pointing at a `sections:` document renders its sections
 *   - a `{$role}` token for a non-protagonist role resolves to that role's item
 *   - a `{%libraryName}` token in root framing expands (it did not before Step 1, because
 *     the old root rung resolved against `config.variables` rather than `config._variables`,
 *     which is where library names are folded in)
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics, CODES } = require('../../src/diag');

let tmpDir;
let diagnostics;

const outPath = (...parts) => path.join(tmpDir, 'out', ...parts);
const read = (...parts) => fs.readFileSync(outPath(...parts), 'utf8');

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-root-framing-'));
  const write = (rel, content) => {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };

  write('templates/Character.template', '{$name}\n');

  write('Codex/items.yaml', [
    '- id: Aness',
    '  name: Aness',
    '  pronouns: female',
    '  aid: {type: Character, triggers: [Aness]}',
    '  render: {template: Character, wrapper: none}',
    '',
    '- id: Kaiden',
    '  name: Kaiden',
    '  pronouns: male',
    '  aid: {type: Character, triggers: [Kaiden]}',
    '  render: {template: Character, wrapper: none}',
    '',
  ].join('\n'));

  // The sections document root framing now renders through. A bare {$LI} substitutes the
  // role's item display name; {%main} is a library name exposed as a variable (§6.1),
  // present only in the effective `_variables` set the root visit seeds with, not in the
  // author's declared `variables:` — which is what the old root rung expanded against.
  write('components/root-framing.yaml', [
    'sections:',
    '  choice:',
    '    text: |',
    '      Your bond, {$LI}, is waiting near {%main}. Which road do you take?',
    '',
  ].join('\n'));

  write('compile.yaml', [
    'version: 4',
    'title: Root Framing Probe',
    'structure:',
    '  input:',
    "    items: ['./Codex']",
    "    templates: ['./templates']",
    '    library:',
    "      main: './canon'",
    "  output: './out'",
    'roles:',
    '  protagonist: Aness',
    // A non-protagonist role bound at the project root. A {$protagonist} token would
    // render identically to plain second-person text even with role resolution broken
    // (the Watch note in the Phase 11 Session A handoff) — the proof needs a role other
    // than it.
    '  LI: Kaiden',
    'components:',
    '  branchFraming: ./components/root-framing.yaml',
    'branches:',
    '  subject: {}',
    '',
  ].join('\n'));

  fs.mkdirSync(path.join(tmpDir, 'canon'), { recursive: true });

  diagnostics = new Diagnostics();
  const spies = ['log', 'warn', 'error'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics });
  } catch (err) { /* ERRORs are the subject; the throw carries only a count */ } finally {
    spies.forEach((s) => s.mockRestore());
  }
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('no error-level diagnostic — the project compiles cleanly', () => {
  const errors = diagnostics.all.filter((d) => d.severity === 'error');
  expect(errors).toEqual([]);
});

test('root branchFraming renders the sections document, not a literal sentence', () => {
  expect(read('Components', 'Opening.md')).toBe(
    'Your bond, Kaiden, is waiting near '
    + path.join(tmpDir, 'canon')
    + '. Which road do you take?\n',
  );
});

test('the undeclared-placeholder check runs at root framing, where the old rung skipped it', () => {
  const found = diagnostics.all.filter((d) => d.code === CODES.PLACEHOLDER_UNDECLARED);
  expect(found).toEqual([]);
});

/**
 * The literal / inline arm of root framing resolves roles too.
 *
 * Phase 11 gave root framing the sectioned path (the tests above). What it left behind
 * was `renderFraming`'s fallback — a `branchFraming:` written as a bare sentence or a
 * prose `.md` still went through `resolveOpeningContent`, which only expands `{%…}`. A
 * `{$role}` there was never attempted, so the token leaked into `Opening.md` and tripped
 * the CL0430 output sweep. It now runs the same token pass the sectioned arm does, with
 * the project's own `roles:` table and (null) protagonist.
 */
describe('root branchFraming — inline sentence arm', () => {
  let dir;
  let diag;
  const readOut = (...p) => fs.readFileSync(path.join(dir, 'out', ...p), 'utf8');

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-root-framing-inline-'));
    const write = (rel, content) => {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    };
    write('templates/Character.template', '{$name}\n');
    write('Codex/items.yaml', [
      '- id: Aness',
      '  name: Aness',
      '  pronouns: female',
      '  aid: {type: Character, triggers: [Aness]}',
      '  render: {template: Character, wrapper: none}',
      '',
      '- id: Kaiden',
      '  name: Kaiden',
      '  pronouns: male',
      '  aid: {type: Character, triggers: [Kaiden]}',
      '  render: {template: Character, wrapper: none}',
      '',
    ].join('\n'));
    write('compile.yaml', [
      'version: 4',
      'title: Inline Root Framing Probe',
      'structure:',
      '  input:',
      "    items: ['./Codex']",
      "    templates: ['./templates']",
      "  output: './out'",
      'roles:',
      '  protagonist: Aness',
      '  LI: Kaiden',
      'components:',
      '  branchFraming: "Your bond, {$LI}, is already at the gate. Which road?"',
      'branches:',
      '  subject: {}',
      '',
    ].join('\n'));

    diag = new Diagnostics();
    const spies = ['log', 'warn', 'error'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
    try {
      compile(path.join(dir, 'compile.yaml'), { diagnostics: diag });
    } catch (err) { /* none expected */ } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('compiles with no error-level diagnostic', () => {
    expect(diag.all.filter((d) => d.severity === 'error')).toEqual([]);
  });

  test('the {$LI} role resolves to its item, with no leaked-token sweep hit', () => {
    expect(readOut('Components', 'Opening.md')).toBe(
      'Your bond, Kaiden, is already at the gate. Which road?\n',
    );
    expect(diag.all.filter((d) => d.code === CODES.LEAKED_FIELD_TOKEN)).toEqual([]);
  });
});
