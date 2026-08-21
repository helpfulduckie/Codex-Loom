'use strict';

/**
 * Component `imports:` end to end (v4 spec §7.6, Phase 6 Step 1).
 *
 * Integration rather than unit because the feature is a chain: a path expands against the
 * root variable table, resolves against the importing file's directory, loads a document
 * that may import further, and only then does the merge `model/component.js` owns run. A
 * unit test of the merge asserts the layering rule and says nothing about whether the right
 * record reaches it — which is where every bug in a resolution chain lives.
 *
 * The compiled bytes are asserted, not the normalized shape. §7.6 exists to retire The
 * Institute's hardcoded absolute path to a shared `AI Instructions.md`, and the measure of
 * whether it can is whether a converted component still writes the same file.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');

const dirs = [];

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function compileProject(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-imports-'));
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
    // Several of these projects raise ERRORs by construction.
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return { diagnostics, tmpDir };
}

const codes = (diagnostics, code) => diagnostics.all.filter((d) => d.code === code);

const pe = (tmpDir) => fs.readFileSync(
  path.join(tmpDir, 'output', 'Branches', 'plain', 'Components', 'Plot Essentials.md'),
  'utf8',
);

const BASE = {
  'templates/Character.template': '{$body.Tagline}',
  'compile.yaml': [
    'version: 4',
    'variables:',
    '  here: .',
    "  shared: '{%here}/shared'",
    'structure:',
    '  input:',
    '    items: [%TMP%/Codex]',
    '    templates: [%TMP%/templates]',
    '  output: %TMP%/output',
    'components:',
    '  plotEssential: ./components/pe.cl.yaml',
    'branches:',
    '  plain: {}',
  ].join('\n'),
  'Codex/items.yaml': [
    '- id: Hero',
    '  name: Hero',
    '  aid: {type: Character, triggers: [Hero]}',
    '  body: {Tagline: Hero Vale}',
    '  render: {template: Character, plotEssential: {slot: cast}}',
  ].join('\n'),
};

/** The canonical document a project pulls in — the §7.6.1 shape, at fixture scale. */
const SHARED = [
  'sections:',
  '  genre:',
  '    text: "Genre: Thriller"',
  '    render: {position: 1}',
  '    variants:',
  '      dark: {text: "Genre: Noir"}',
  '  house:',
  '    text: "The house keeps its own counsel."',
  '    render: {position: 2}',
  '  cast:',
  '    slot: true',
  '    render: {position: 3}',
  '  legalese:',
  '    text: "Provided as is."',
  '    render: {position: 9}',
].join('\n');

// ── The merge ────────────────────────────────────────────────────────────────

describe('a component imports another and layers over it', () => {
  const project = (local) => compileProject({
    ...BASE,
    'shared/base.cl.yaml': SHARED,
    'components/pe.cl.yaml': local,
  });

  test('imported sections render when the local file adds nothing', () => {
    const { tmpDir, diagnostics } = project([
      'imports:',
      "  - from: '{%shared}/base.cl.yaml'",
    ].join('\n'));
    expect(diagnostics.errors).toHaveLength(0);
    const text = pe(tmpDir);
    expect(text).toContain('Genre: Thriller');
    expect(text).toContain('The house keeps its own counsel.');
    expect(text).toContain('Provided as is.');
  });

  test('a local section overrides an imported one by name', () => {
    const text = pe(project([
      'imports:',
      "  - from: '{%shared}/base.cl.yaml'",
      'sections:',
      '  house:',
      '    text: "The house says what it likes."',
    ].join('\n')).tmpDir);
    expect(text).toContain('The house says what it likes.');
    expect(text).not.toContain('keeps its own counsel');
  });

  test('a local override applies field ops against the imported text', () => {
    // The reason the merge happens on raw definitions: `+{}` has to mean the same thing
    // here as in a variant delta, and it can only do that before normalization.
    const text = pe(project([
      'imports:',
      "  - from: '{%shared}/base.cl.yaml'",
      'sections:',
      '  house:',
      '    text: "+{ It says so quietly. }"',
    ].join('\n')).tmpDir);
    expect(text).toContain('The house keeps its own counsel.\nIt says so quietly.');
  });

  test('a local section the import does not provide is appended', () => {
    const text = pe(project([
      'imports:',
      "  - from: '{%shared}/base.cl.yaml'",
      'sections:',
      '  institute:',
      '    text: "Conditioning scenes are clinical."',
      '    render: {position: 5}',
    ].join('\n')).tmpDir);
    expect(text).toContain('Conditioning scenes are clinical.');
    expect(text).toContain('Genre: Thriller');
  });

  test('~ deletes an inherited section', () => {
    const { tmpDir, diagnostics } = project([
      'imports:',
      "  - from: '{%shared}/base.cl.yaml'",
      'sections:',
      '  legalese: ~',
    ].join('\n'));
    expect(pe(tmpDir)).not.toContain('Provided as is.');
    expect(codes(diagnostics, 'CL0608')).toHaveLength(0);
  });

  test('~ on a name no import provided is CL0608', () => {
    const { diagnostics } = project([
      'imports:',
      "  - from: '{%shared}/base.cl.yaml'",
      'sections:',
      '  nosuchsection: ~',
    ].join('\n'));
    const found = codes(diagnostics, 'CL0608');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('nosuchsection');
    expect(found[0].severity).toBe('warn');
  });

  test('an imported slot accepts a local item, so slots merge by name', () => {
    // §7.6.3's second payoff for §7.2: membership lives on items, so an imported component
    // describes shape only and is genuinely project-independent. `cast` is declared in the
    // shared file and filled by an item that has never heard of it.
    const { tmpDir, diagnostics } = project([
      'imports:',
      "  - from: '{%shared}/base.cl.yaml'",
    ].join('\n'));
    expect(pe(tmpDir)).toContain('Hero Vale');
    expect(codes(diagnostics, 'CL0611')).toHaveLength(0);
  });

  test('importVariants: selects a variant from every imported section defining it', () => {
    const text = pe(project([
      'imports:',
      "  - from: '{%shared}/base.cl.yaml'",
      '    importVariants: [dark]',
    ].join('\n')).tmpDir);
    expect(text).toContain('Genre: Noir');
    expect(text).not.toContain('Thriller');
  });

  test('importVariants: is silent on the sections that do not define the name', () => {
    // Three of the four sections have no `dark`, which is the arity-N case (§7.6.2a).
    const { diagnostics } = project([
      'imports:',
      "  - from: '{%shared}/base.cl.yaml'",
      '    importVariants: [dark]',
    ].join('\n'));
    expect(codes(diagnostics, 'CL0604')).toHaveLength(0);
    expect(codes(diagnostics, 'CL0326')).toHaveLength(0);
  });

  test('an importVariants: name no section defines is CL0326', () => {
    const { diagnostics } = project([
      'imports:',
      "  - from: '{%shared}/base.cl.yaml'",
      '    importVariants: [drak]',
    ].join('\n'));
    const found = codes(diagnostics, 'CL0326');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"drak"');
  });
});

// ── Order, and depth ─────────────────────────────────────────────────────────

describe('imports: is an ordered list that composes', () => {
  test('a later import wins over an earlier one on the same section', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'shared/base.cl.yaml': SHARED,
      'shared/world.cl.yaml': [
        'sections:',
        '  house:',
        '    text: "The Northern Wing keeps its own counsel."',
      ].join('\n'),
      'components/pe.cl.yaml': [
        'imports:',
        "  - from: '{%shared}/base.cl.yaml'",
        "  - from: '{%shared}/world.cl.yaml'",
      ].join('\n'),
    });
    expect(pe(tmpDir)).toContain('The Northern Wing keeps its own counsel.');
  });

  test('a three-deep chain carries the first layer through the middle one', () => {
    // The failure this guards: a middle layer that re-exported only its own `sections:`
    // would drop the house style entirely, and the output would look merely incomplete.
    const { tmpDir } = compileProject({
      ...BASE,
      'shared/base.cl.yaml': SHARED,
      'shared/world.cl.yaml': [
        'imports:',
        "  - from: '{%shared}/base.cl.yaml'",
        'sections:',
        '  world:',
        '    text: "The war ended a year ago."',
        '    render: {position: 4}',
      ].join('\n'),
      'components/pe.cl.yaml': [
        'imports:',
        "  - from: '{%shared}/world.cl.yaml'",
        'sections:',
        '  local:',
        '    text: "And the Academy reopened."',
        '    render: {position: 5}',
      ].join('\n'),
    });
    const text = pe(tmpDir);
    expect(text).toContain('Genre: Thriller');
    expect(text).toContain('The war ended a year ago.');
    expect(text).toContain('And the Academy reopened.');
  });

  test('a relative from: resolves against the project base, like every other path', () => {
    // Not against the importing file's own directory. A `{%var}` is written relative to the
    // project, so making a bare path file-relative would give one key two bases depending on
    // whether the string happened to contain a token.
    const { tmpDir, diagnostics } = compileProject({
      ...BASE,
      'components/base.cl.yaml': SHARED,
      'components/pe.cl.yaml': [
        'imports:',
        '  - from: ./components/base.cl.yaml',
      ].join('\n'),
    });
    expect(diagnostics.errors).toHaveLength(0);
    expect(pe(tmpDir)).toContain('Genre: Thriller');
  });
});

// ── The two errors ───────────────────────────────────────────────────────────

describe('an import that cannot be resolved', () => {
  test('a from: naming no file is CL0606', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'components/pe.cl.yaml': [
        'imports:',
        "  - from: '{%shared}/nosuch.cl.yaml'",
        'sections:',
        '  cast: {slot: true}',
      ].join('\n'),
    });
    const found = codes(diagnostics, 'CL0606');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toContain('nosuch.cl.yaml');
  });

  test('a cycle is CL0607 rather than a stack overflow', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'shared/a.cl.yaml': [
        'imports:',
        "  - from: '{%shared}/b.cl.yaml'",
        'sections:',
        '  fromA: {text: "A"}',
      ].join('\n'),
      'shared/b.cl.yaml': [
        'imports:',
        "  - from: '{%shared}/a.cl.yaml'",
        'sections:',
        '  fromB: {text: "B"}',
      ].join('\n'),
      'components/pe.cl.yaml': [
        'imports:',
        "  - from: '{%shared}/a.cl.yaml'",
        'sections:',
        '  cast: {slot: true}',
      ].join('\n'),
    });
    const found = codes(diagnostics, 'CL0607');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
  });

  test('a file importing itself is the same cycle', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'components/pe.cl.yaml': [
        'imports:',
        '  - from: ./components/pe.cl.yaml',
        'sections:',
        '  cast: {slot: true}',
      ].join('\n'),
    });
    expect(codes(diagnostics, 'CL0607')).toHaveLength(1);
  });
});

// ── The cache ────────────────────────────────────────────────────────────────

describe('an import chain resolves once per file, not once per leaf', () => {
  test('a cycle across four branches is reported once', () => {
    // `loadSectioned` caches by resolved path, which is why import diagnostics belong
    // inside that load: The Institute has 32 leaves, and a per-leaf chain would turn one
    // cycle into 32 identical errors.
    const { diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': BASE['compile.yaml'].replace(
        '  plain: {}',
        ['  plain: {}', '  noir: {}', '  gated: {}', '  open: {}'].join('\n'),
      ),
      'shared/a.cl.yaml': [
        'imports:',
        "  - from: '{%shared}/a.cl.yaml'",
        'sections:',
        '  fromA: {text: "A"}',
      ].join('\n'),
      'components/pe.cl.yaml': [
        'imports:',
        "  - from: '{%shared}/a.cl.yaml'",
        'sections:',
        '  cast: {slot: true}',
      ].join('\n'),
    });
    expect(codes(diagnostics, 'CL0607')).toHaveLength(1);
  });
});
