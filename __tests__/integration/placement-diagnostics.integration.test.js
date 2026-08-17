'use strict';

/**
 * The §7.4 placement invariants, end to end (step 7).
 *
 * These have to be integration tests. Every one of them is a question about an item's
 * target *and* a component's slot set on a particular branch, and no single module holds
 * both — `model/item.js` resolves the target, `model/component.js` resolves the slots, and
 * `compile.js` is the only place they meet. A unit test of either half would be asserting
 * against a hand-built version of the other.
 *
 * They also have to be written by hand rather than harvested from the golden fixtures. All
 * three corpora are correct, which is the point of them: no fixture names a slot that does
 * not exist, and every declared slot has at least one occupant on every leaf, so the
 * empty-slot WARN in particular has no fixture that would ever fire it. A version of these
 * checks that never fires would pass the whole suite.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');

const dirs = [];

/**
 * Compile a one-off project and hand back what it said.
 *
 * `compile` throws when it raised an ERROR — the message is a count, not the diagnostics —
 * so the diagnostics themselves are read off the console, which is where an author reads
 * them. The throw is caught and reported as `threw` rather than swallowed: whether a code
 * is an ERROR or a WARN is half of what these tests assert.
 */
function compileProject(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-invariants-'));
  dirs.push(tmpDir);
  const slash = (p) => p.replace(/\\/g, '/');

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.replace(/%TMP%/g, slash(tmpDir)), 'utf8');
  }

  const lines = [];
  const capture = (...args) => { lines.push(args.join(' ')); };
  const spies = ['log', 'warn', 'error'].map((l) => jest.spyOn(console, l).mockImplementation(capture));
  let threw = null;
  try {
    compile(path.join(tmpDir, 'compile.yaml'));
  } catch (err) {
    threw = err;
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return { output: lines.join('\n'), threw, tmpDir };
}

/**
 * Every diagnostic carrying `code`, each as one string.
 *
 * `Diagnostic.format()` puts the code and the location on one line and the message on the
 * next, so a line filter finds the occurrences and loses the sentence that says which
 * branch. Rejoining the pair is what lets these tests assert *both* — that a branch-scoped
 * error fired once, and that it fired on the branch it should have.
 */
function diagnostics(output, code) {
  const lines = output.split('\n');
  return lines
    .map((line, i) => (line.includes(code) ? `${line}\n${lines.slice(i + 1, i + 3).join('\n')}` : null))
    .filter(Boolean);
}

/** The standard scaffold: one component, two branches, one template. */
const BASE = {
  'templates/Full.template': '{$name.full}',
  'compile.yaml': [
    'version: 4',
    'structure:',
    '  input:',
    '    items: [%TMP%/Codex]',
    '    templates: [%TMP%/templates]',
    '  output: %TMP%/output',
    'components:',
    '  plotEssential: ./components/pe.yaml',
    'branches:',
    '  shown: {}',
    '  hidden: {}',
  ].join('\n'),
};

const component = (extra = []) => [
  'sections:',
  '  intro:',
  '    text: "Genre: Test"',
  '    render: {position: 1}',
  '  cast:',
  '    slot: true',
  '    render: {position: 2}',
  ...extra,
].join('\n');

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── CL0611 undeclared slot ────────────────────────────────────────────────────

describe('CL0611 — a target names a slot no component declares', () => {
  const result = () => compileProject({
    ...BASE,
    'components/pe.yaml': component(),
    'Codex/items.yaml': [
      '- id: Hero',
      '  name: {display: Hero, full: Hero Vale}',
      '  aid: {type: Character, triggers: [Hero]}',
      '  render: {template: Full, plotEssential: {slot: casts}}',
    ].join('\n'),
  });

  test('is an ERROR naming the item and the slot it asked for', () => {
    const { output, threw } = result();
    expect(output).toContain('CL0611');
    expect(output).toContain('"casts"');
    expect(output).toContain('Hero');
    expect(threw).not.toBeNull();
  });

  test('names the slots that do exist, so the typo is visible', () => {
    expect(result().output).toContain('cast');
  });
});

// ── CL0612 not a slot ─────────────────────────────────────────────────────────

describe('CL0612 — a target names a section that exists but is not a slot', () => {
  test('is its own ERROR rather than the undeclared-slot one', () => {
    const { output, threw } = compileProject({
      ...BASE,
      'components/pe.yaml': component(),
      'Codex/items.yaml': [
        '- id: Hero',
        '  name: {display: Hero, full: Hero Vale}',
        '  aid: {type: Character, triggers: [Hero]}',
        '  render: {template: Full, plotEssential: {slot: intro}}',
      ].join('\n'),
    });
    expect(output).toContain('CL0612');
    expect(output).not.toContain('CL0611');
    expect(output).toContain('slot: true');
    expect(threw).not.toBeNull();
  });
});

// ── CL0613 a target that names no slot ────────────────────────────────────────

describe('CL0613 — a target that resolves to no slot at all', () => {
  test('a target mapping with no slot: key is an ERROR', () => {
    const { output, threw } = compileProject({
      ...BASE,
      'components/pe.yaml': component(),
      'Codex/items.yaml': [
        '- id: Hero',
        '  name: {display: Hero, full: Hero Vale}',
        '  aid: {type: Character, triggers: [Hero]}',
        '  render: {template: Full, plotEssential: {order: 1}}',
      ].join('\n'),
    });
    expect(output).toContain('CL0613');
    expect(threw).not.toBeNull();
  });

  test('the `plotEssential: true` shorthand is the same error, not a default slot', () => {
    // Step 1 deferred this shape deliberately. There is no default slot to fall back on —
    // a component may declare any number — so the shorthand has no meaning to give it.
    const { output } = compileProject({
      ...BASE,
      'components/pe.yaml': component(),
      'Codex/items.yaml': [
        '- id: Hero',
        '  name: {display: Hero, full: Hero Vale}',
        '  aid: {type: Character, triggers: [Hero]}',
        '  render: {template: Full, plotEssential: true}',
      ].join('\n'),
    });
    expect(output).toContain('CL0613');
  });
});

// ── CL0614 empty slot ─────────────────────────────────────────────────────────

describe('CL0614 — a declared slot with no occupants', () => {
  test('warns, and does not fail the compile', () => {
    const { output, threw } = compileProject({
      ...BASE,
      'components/pe.yaml': component(),
      'Codex/items.yaml': [
        '- id: Hero',
        '  name: {display: Hero, full: Hero Vale}',
        '  aid: {type: Character, triggers: [Hero]}',
        '  render: {template: Full}',
      ].join('\n'),
    });
    expect(output).toContain('CL0614');
    expect(output).toContain('cast');
    expect(threw).toBeNull();
  });

  test('a slot with an occupant on one branch and none on the other warns only there', () => {
    const { output } = compileProject({
      ...BASE,
      'components/pe.yaml': component(),
      'Codex/items.yaml': [
        '- id: Hero',
        '  name: {display: Hero, full: Hero Vale}',
        '  aid: {type: Character, triggers: [Hero]}',
        '  render: {template: Full, plotEssential: {slot: cast}}',
        '  branches: {hidden: ~}',
      ].join('\n'),
    });
    const warned = diagnostics(output, 'CL0614');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('hidden');
  });
});

// ── CL0610 the no-output invariant ────────────────────────────────────────────

describe('CL0610 — an item that resolves onto a branch and produces nothing there', () => {
  test('storyCard: false with no target at all is an ERROR', () => {
    const { output, threw } = compileProject({
      ...BASE,
      'components/pe.yaml': component(),
      'Codex/items.yaml': [
        '- id: Ghost',
        '  name: {display: Ghost, full: Ghost Vale}',
        '  render: {template: Full, storyCard: false}',
      ].join('\n'),
    });
    expect(output).toContain('CL0610');
    expect(output).toContain('Ghost');
    expect(threw).not.toBeNull();
  });

  test('storyCard: false into a slot gated off on that branch is an ERROR there only', () => {
    // §7.4's third row. The slot name is spelled correctly, so it is not a typo — the item
    // simply has nowhere left to go on `hidden`, which is the failure v3's suppression
    // comments were guarding against.
    const { output } = compileProject({
      ...BASE,
      'components/pe.yaml': component(['    branches: {hidden: ~}']),
      'Codex/items.yaml': [
        '- id: Ghost',
        '  name: {display: Ghost, full: Ghost Vale}',
        '  render: {template: Full, storyCard: false, plotEssential: {slot: cast}}',
      ].join('\n'),
    });
    const errors = diagnostics(output, 'CL0610');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('hidden');
  });

  test('storyCard: true into a gated-off slot is fine — the card still ships', () => {
    // §7.4's fifth row, and the reason the invariant counts outputs rather than targets.
    const { output, threw } = compileProject({
      ...BASE,
      'components/pe.yaml': component(['    branches: {hidden: ~}']),
      'Codex/items.yaml': [
        '- id: Hero',
        '  name: {display: Hero, full: Hero Vale}',
        '  aid: {type: Character, triggers: [Hero]}',
        '  render: {template: Full, plotEssential: {slot: cast}}',
      ].join('\n'),
    });
    expect(output).not.toContain('CL0610');
    expect(threw).toBeNull();
  });

  test('an item excluded from the branch outright is never asked', () => {
    const { output, threw } = compileProject({
      ...BASE,
      'components/pe.yaml': component(),
      'Codex/items.yaml': [
        '- id: Ghost',
        '  name: {display: Ghost, full: Ghost Vale}',
        '  render: {template: Full, storyCard: false, plotEssential: {slot: cast}}',
        '  branches: {hidden: ~}',
      ].join('\n'),
    });
    expect(output).not.toContain('CL0610');
    expect(threw).toBeNull();
  });
});

// ── CL0615 a component that renders to nothing ────────────────────────────────

describe('CL0615 — a component that renders to nothing on a branch', () => {
  test('every section gated off on one branch is an ERROR there', () => {
    const { output, threw } = compileProject({
      ...BASE,
      'components/pe.yaml': [
        'sections:',
        '  intro:',
        '    text: "Genre: Test"',
        '    branches: {hidden: ~}',
        '  cast:',
        '    slot: true',
        '    branches: {hidden: ~}',
      ].join('\n'),
      'Codex/items.yaml': [
        '- id: Hero',
        '  name: {display: Hero, full: Hero Vale}',
        '  aid: {type: Character, triggers: [Hero]}',
        '  render: {template: Full, plotEssential: {slot: cast}}',
      ].join('\n'),
    });
    const errors = diagnostics(output, 'CL0615');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('hidden');
    expect(threw).not.toBeNull();
  });
});
