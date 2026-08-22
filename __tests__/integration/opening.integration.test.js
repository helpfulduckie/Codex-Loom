'use strict';

/**
 * Opening and branch framing on the sections grammar (v4 spec §7.1, §7.3, Phase 6 Step 6).
 *
 * §7.1 counts four syntaxes for "an ordered collection of content with per-branch dispatch",
 * and the Opening was the last one left. `src/opening.js` is deleted; an `opening:` is an
 * ordinary inherited component written by the leaf loop, and `branchFraming:` is a
 * non-routable component written at the interior nodes the leaf loop never visits.
 *
 * Integration because the whole subject is which file lands where. That an opening inherits,
 * that framing does not, that both write `Opening.md` at their own level, and that a spec may
 * be a document, a file or a sentence — none of it is visible below the file system.
 *
 * The migration of a v3 block list lives in `compile.integration.test.js`, where the original
 * block-rendering assertions were kept and re-pointed through the migrator.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics, CODES } = require('../../src/diag');

const dirs = [];
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function compileProject(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-open-'));
  dirs.push(tmpDir);
  const slash = (p) => p.replace(/\\/g, '/');

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.replace(/%TMP%/g, slash(tmpDir)), 'utf8');
  }

  const diagnostics = new Diagnostics();
  const spies = ['log', 'warn', 'error'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  let threw = null;
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics });
  } catch (err) {
    threw = err;
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return { diagnostics, tmpDir, threw };
}

const codes = (diagnostics, code) => diagnostics.all.filter((d) => d.code === code);
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8').trim();

const openingAt = (tmpDir, ...segments) => {
  let p = path.join(tmpDir, 'output');
  for (const s of segments) p = path.join(p, 'Branches', s);
  return path.join(p, 'Components', 'Opening.md');
};

const BASE = {
  'templates/Character.template': '{$body.Tagline}',
  'Codex/items.yaml': [
    '- id: Hero',
    '  name: Hero',
    '  aid: {type: Character, triggers: [Hero]}',
    '  body: {Tagline: Hero Vale}',
    '  render: {template: Character}',
  ].join('\n'),
};

const config = (lines) => [
  'version: 4',
  'structure:',
  '  input:',
  '    items: [%TMP%/Codex]',
  '    templates: [%TMP%/templates]',
  '  output: %TMP%/output',
  ...lines,
].join('\n');

// ── The three spec shapes ────────────────────────────────────────────────────

describe('an opening spec is a document, a prose file, or a sentence', () => {
  test('a sections document renders through the ordinary component path', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'components: {opening: ./components/opening.cl.yaml}',
        'branches: {calm: {}}',
      ]),
      'components/opening.cl.yaml': [
        'sections:',
        '  scene:',
        '    text: The harbor is still.',
        '    render: {position: 1}',
        '  hook:',
        '    text: Someone is waiting for you.',
        '    render: {position: 2}',
      ].join('\n'),
    });

    // Sections join as blocks, which is the same '\n\n' the v3 block list used — the reason
    // a converted project's openings come back byte-identical.
    expect(read(openingAt(tmpDir, 'calm')))
      .toBe('The harbor is still.\n\nSomeone is waiting for you.');
  });

  test('a .md file is copied verbatim, which is what every golden opening is', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'components: {opening: ./openings/calm.md}',
        'branches: {calm: {}}',
      ]),
      'openings/calm.md': 'The harbor is still.',
    });

    expect(read(openingAt(tmpDir, 'calm'))).toBe('The harbor is still.');
  });

  test('a spec resolving to no file is the literal sentence', () => {
    // `opening: "Who are you?"` — the one component whose spec is routinely prose. For any
    // other component a spec naming no file is a broken path, and writing it out as content
    // would put the path into the output instead of reporting it.
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'components:',
        "  opening: 'Who are you, really?'",
        'branches: {calm: {}}',
      ]),
    });

    expect(read(openingAt(tmpDir, 'calm'))).toBe('Who are you, really?');
  });

  test('an inline opening expands branch variables', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'components:',
        "  opening: 'You wake in {%place}.'",
        'branches:',
        '  calm: {variables: {place: the harbor}}',
        '  storm: {variables: {place: the wreck}}',
      ]),
    });

    expect(read(openingAt(tmpDir, 'calm'))).toBe('You wake in the harbor.');
    expect(read(openingAt(tmpDir, 'storm'))).toBe('You wake in the wreck.');
  });
});

// ── Inheritance ──────────────────────────────────────────────────────────────

describe('an opening inherits down the tree like any other component', () => {
  test('a leaf with no opening of its own takes the one above it', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'components: {opening: ./openings/root.md}',
        'branches:',
        '  calm: {}',
        '  storm: {components: {opening: ./openings/storm.md}}',
      ]),
      'openings/root.md': 'The default harbor.',
      'openings/storm.md': 'The wrecked harbor.',
    });

    expect(read(openingAt(tmpDir, 'calm'))).toBe('The default harbor.');
    expect(read(openingAt(tmpDir, 'storm'))).toBe('The wrecked harbor.');
  });

  test('the chain merge is buildCompileContext\'s, so it reaches a grandchild', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'branches:',
        '  storm:',
        '    components: {opening: ./openings/storm.md}',
        '    branches: {deep: {}}',
      ]),
      'openings/storm.md': 'The wrecked harbor.',
    });

    expect(read(openingAt(tmpDir, 'storm', 'deep'))).toBe('The wrecked harbor.');
    // Interior nodes get no Opening.md from an `opening:` — only a leaf does.
    expect(exists(path.join(tmpDir, 'output', 'Branches', 'storm', 'Components', 'Opening.md')))
      .toBe(false);
  });
});

// ── Branch framing ───────────────────────────────────────────────────────────

describe('branch framing is written at interior nodes and does not inherit', () => {
  test('a framing sentence lands at the node whose children it frames', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'branches:',
        '  storm:',
        '    components: {branchFraming: Which way did the water take you?}',
        '    branches:',
        '      deep: {components: {opening: ./openings/deep.md}}',
        '      shallow: {components: {opening: ./openings/shallow.md}}',
      ]),
      'openings/deep.md': 'Down.',
      'openings/shallow.md': 'Across.',
    });

    expect(read(path.join(tmpDir, 'output', 'Branches', 'storm', 'Components', 'Opening.md')))
      .toBe('Which way did the water take you?');
    // Not inherited: the children have their own openings and framing reaches neither.
    expect(read(openingAt(tmpDir, 'storm', 'deep'))).toBe('Down.');
  });

  test('framing may be a sections document, rendered with no items to place', () => {
    // The same `renderSectionedComponent` call the scenario blurb makes, at an interior
    // node's path. Items are resolved per leaf, so there is no cast here to route in.
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'branches:',
        '  storm:',
        '    components: {branchFraming: ./components/framing.cl.yaml}',
        '    branches: {deep: {components: {opening: ./openings/deep.md}}}',
      ]),
      'openings/deep.md': 'Down.',
      'components/framing.cl.yaml': [
        'sections:',
        '  ask:',
        '    text: Which way did the water take you?',
        '    render: {position: 1}',
        '  aside:',
        '    text: Both answers are survivable.',
        '    render: {position: 2}',
      ].join('\n'),
    });

    expect(read(path.join(tmpDir, 'output', 'Branches', 'storm', 'Components', 'Opening.md')))
      .toBe('Which way did the water take you?\n\nBoth answers are survivable.');
  });

  test('framing on a leaf is ignored, because a leaf has no children to frame', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'branches:',
        '  calm: {components: {branchFraming: Which way?, opening: ./openings/calm.md}}',
      ]),
      'openings/calm.md': 'The harbor is still.',
    });

    expect(read(openingAt(tmpDir, 'calm'))).toBe('The harbor is still.');
  });
});

// ── Routing ──────────────────────────────────────────────────────────────────

describe('items route into an opening, and never into framing', () => {
  test('a render.opening target fills a slot', () => {
    const { tmpDir, diagnostics } = compileProject({
      ...BASE,
      'Codex/items.yaml': [
        '- id: Hero',
        '  name: Hero',
        '  aid: {type: Character, triggers: [Hero]}',
        '  body: {Tagline: Beside you stands Hero Vale.}',
        '  render: {template: Character, opening: {slot: company}}',
      ].join('\n'),
      'compile.yaml': config([
        'components: {opening: ./components/opening.cl.yaml}',
        'branches: {calm: {}}',
      ]),
      'components/opening.cl.yaml': [
        'sections:',
        '  scene:',
        '    text: The harbor is still.',
        '    render: {position: 1}',
        '  company:',
        '    slot: true',
        '    render: {position: 2}',
      ].join('\n'),
    });

    expect(codes(diagnostics, CODES.TARGET_UNDECLARED_SLOT)).toHaveLength(0);
    expect(read(openingAt(tmpDir, 'calm')))
      .toBe('The harbor is still.\n\nBeside you stands Hero Vale.');
  });

  test('render.branchFraming is declared but reports that nothing reads it', () => {
    // Not a scheduling note: framing sits at an interior node, where no items resolve. It
    // stays declared so writing one is a clear answer rather than a bare unknown key.
    const { diagnostics } = compileProject({
      ...BASE,
      'Codex/items.yaml': [
        '- id: Hero',
        '  name: Hero',
        '  aid: {type: Character, triggers: [Hero]}',
        '  body: {Tagline: Hero Vale}',
        '  render: {template: Character, branchFraming: {slot: cast}}',
      ].join('\n'),
      'compile.yaml': config(['branches: {calm: {components: {opening: Who are you?}}}']),
    });

    const noted = diagnostics.all.filter((d) => d.message && d.message.includes('branchFraming'));
    expect(noted.length).toBeGreaterThan(0);
    expect(noted[0].message).toContain('interior node');
  });
});

// ── The cap, and the retired format ──────────────────────────────────────────

describe('§8.5 and the deleted block list', () => {
  test('an opening over 4,000 characters is still CL0710 after the move', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'components: {opening: ./openings/long.md}',
        'branches: {calm: {}}',
      ]),
      'openings/long.md': 'x'.repeat(4100),
    });

    expect(codes(diagnostics, CODES.OPENING_OVER_LIMIT)).toHaveLength(1);
  });

  test('an opening in the warn band is CL0711', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'components: {opening: ./openings/nearly.md}',
        'branches: {calm: {}}',
      ]),
      'openings/nearly.md': 'x'.repeat(3800),
    });

    expect(codes(diagnostics, CODES.OPENING_NEAR_LIMIT)).toHaveLength(1);
  });

  test('a v3 block list fails with a message naming what it becomes', () => {
    const { threw } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'components: {opening: ./components/opening.yaml}',
        'branches: {calm: {}}',
      ]),
      'components/opening.yaml': '- text: A world awaits.\n- text: You are late.\n',
    });

    expect(threw).toBeTruthy();
    expect(threw.message).toContain('Opening block becomes a named text section');
    expect(threw.message).toContain('migrateProjectFully');
  });
});
