'use strict';

/**
 * The committed example library, exercised by a real compile (v4 spec §17).
 *
 * `examples/library/` holds two sets, `core/` and `grimwood/`, that both define `magic`.
 * No example *project* consumes it yet — `variants-and-fieldops` is a later session — so
 * this is what stands between the library and being dead YAML: it writes a small project
 * beside a copy of the real sets and compiles it.
 *
 * What that proves, and why each part needs a running compile rather than an assertion:
 *
 *   - **Every file in both sets parses and schema-validates.** `buildCanonRegistry` walks a
 *     set directory whole, so declaring the set is what reads every file in it. A typo in an
 *     item nobody imports still fails here.
 *   - **The relative climb out of the project directory works.** The library is declared as
 *     `../library/core`, the shape an example project uses and the shape
 *     `baselineHarness.js` supports by copying the whole set tree rather than one project.
 *   - **A qualified reference resolves and a renamed one registers locally.** Both magic
 *     systems land in one compiled tree under names the project chose (§17.4).
 *   - **The collision is still a collision.** A second project referencing `magic`
 *     unqualified fails with `CL0340`, which is the check that the plain registry key is
 *     genuinely empty rather than quietly resolved by declaration order (§17.3).
 *
 * The library carries no committed baseline of its own, deliberately: the project below is
 * a test fixture, not a worked example, and freezing its output would give a later session
 * a baseline to re-cut for no reader's benefit.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { compile } = require('../../src/compile');
const { loadCompileConfig } = require('../../src/config/load');
const { buildCanonRegistry } = require('../../src/loader/registry');
const { resolveItemRef } = require('../../src/model/refs');
const { Diagnostics } = require('../../src/diag');

const LIBRARY_SRC = path.resolve(__dirname, '../../examples/library');

let tmpDir;
let projectDir;
let diagnostics;

/** The config every case here shares, differing only in which items file it reads. */
function writeProject(dir, items) {
  fs.mkdirSync(path.join(dir, 'Codex'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Codex', 'items.cl.yaml'), items, 'utf8');
  fs.writeFileSync(path.join(dir, 'compile.cl.yaml'), [
    'version: 4',
    'title: Library Consumer',
    '',
    'structure:',
    '  input:',
    '    items: [./Codex]',
    '    library:',
    // The relative climb: the sets sit beside the project, not inside it.
    '      core: ../library/core',
    '      grimwood: ../library/grimwood',
    '    templates: [../library/templates]',
    '  output: ./output',
    '  reports: ./Review',
    '',
    'variables:',
    '  genre: Dark Fantasy',
    '  settingName: The Medieval Kingdom',
    '',
    // `Wayfarer` is written against these two and the library cannot declare them.
    'placeholders:',
    '  heroName: What should we call you?',
    '  heroTrait: What are you known for?',
    '',
    'templateFor:',
    '  base: fields.cl.yaml',
    '',
    'components:',
    "  plotEssential: '{%core}/components/plot-essentials.cl.yaml'",
    "  aiInstructions: '{%core}/components/ai-instructions.cl.yaml'",
    "  authorsNote: '{%core}/components/authors-note.cl.yaml'",
    "  summary: '{%core}/components/summary.cl.yaml'",
    '  opening: "You wake with the road behind you."',
    '',
    'branches:',
    '  main: {}',
    '',
  ].join('\n'), 'utf8');
  return path.join(dir, 'compile.cl.yaml');
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-examples-library-'));
  fs.cpSync(LIBRARY_SRC, path.join(tmpDir, 'library'), { recursive: true });

  projectDir = path.join(tmpDir, 'consumer');
  const configPath = writeProject(projectDir, [
    '# Both magic systems, side by side. The core one keeps the library id; the grimwood',
    '# one is renamed on import (§17.4), which is what lets them coexist.',
    '- import: core:magic',
    '- id: blood-magic',
    '  import: grimwood:magic',
    '',
    '',
    '# The library declares the Plot Essentials slots; the project decides who fills them.',
    '- import: Wayfarer',
    '- import: Aness',
    '  importVariants: [magical]',
    '  render:',
    '    template: Character',
    '    plotEssential: {slot: cast, order: 1, template: CharacterRoster}',
    '- import: Zephon',
    '  importVariants: [mundane]',
    '  render:',
    '    template: Character',
    '    plotEssential: {slot: cast, order: 2, template: CharacterRoster}',
    '- import: Kaiden',
    '- import: grimwood:Hollis',
    '- import: MedievalKingdom',
    '  importVariants: [magical]',
    '  render:',
    '    template: Location',
    '    plotEssential: {slot: world, order: 1}',
    '- import: Grimwood',
    '',
    '# A project-local item routed into the library Summary format\'s one slot.',
    '- id: DebtThread',
    '  name: The unpaid working',
    '  aid: {title: The unpaid working, type: thread}',
    '  render:',
    '    template: Thread',
    '    storyCard: false',
    '    summary: {slot: openThreads, order: 1}',
    '  body:',
    '    Tagline: A working was paid for and the payment has not been collected.',
    '',
  ].join('\n'));

  diagnostics = new Diagnostics();
  const quiet = ['log', 'warn', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
  try {
    compile(configPath, { diagnostics });
  } finally {
    quiet.forEach((spy) => spy.mockRestore());
  }
}, 120000);

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Every compiled file under the project's output, as one string. */
function outputText() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(path.join(projectDir, 'output'));
  return out.join('\n');
}

describe('examples/library — both sets load from outside the project directory', () => {
  test('a library declared as ../library/<set> resolves', () => {
    const config = loadCompileConfig(path.join(projectDir, 'compile.cl.yaml'), { diagnostics: new Diagnostics() });
    const resolved = config._resolvedLibrary;
    expect([...resolved.keys()].sort()).toEqual(['core', 'grimwood']);
    for (const dir of resolved.values()) {
      expect(fs.existsSync(dir)).toBe(true);
      // The climb actually left the project directory rather than resolving inside it.
      expect(path.relative(projectDir, dir).startsWith('..')).toBe(true);
    }
  });

  test('every item file in both sets loads, including ones no project imports', () => {
    const config = loadCompileConfig(path.join(projectDir, 'compile.cl.yaml'), { diagnostics: new Diagnostics() });
    const diagnostics = new Diagnostics();
    const registry = buildCanonRegistry(config._resolvedLibrary, { diagnostics });

    // Named individually rather than counted: a count passes while an item silently
    // stops loading and another is added.
    const ids = [...registry.keys(), ...registry.ambiguous.keys()].sort();
    expect(ids).toEqual([
      'aness', 'grimwood', 'hollis', 'kaiden', 'magic',
      'medievalkingdom', 'moderncity', 'scifiplanet', 'wayfarer', 'zephon',
    ]);
    expect(diagnostics.errors.map((d) => d.format())).toEqual([]);
  });

});

describe('the colliding magic pair (§17.2–§17.4)', () => {
  /**
   * The plan's constraint, asserted rather than assumed: a project holding both magic
   * systems compiles clean. If it could not, the example and the pathological fixture
   * could not split §17 between them — the collision would always be somebody's error.
   */
  test('a project holding both systems compiles with no diagnostic at all', () => {
    expect(diagnostics.all.map((d) => d.format())).toEqual([]);
  });

  test('`magic` is ambiguous, so the plain registry key is empty', () => {
    const config = loadCompileConfig(path.join(projectDir, 'compile.cl.yaml'), { diagnostics: new Diagnostics() });
    const registry = buildCanonRegistry(config._resolvedLibrary, { diagnostics: new Diagnostics() });

    expect(registry.get('magic')).toBeUndefined();
    expect(registry.ambiguous.get('magic')).toHaveLength(2);
    expect(registry.qualified.get('core:magic').name).toBe('Elemental Manipulation');
    expect(registry.qualified.get('grimwood:magic').name).toBe('Blood Magic');
  });

  test('an unqualified reference fails with CL0340 naming both sets', () => {
    const config = loadCompileConfig(path.join(projectDir, 'compile.cl.yaml'), { diagnostics: new Diagnostics() });
    const registry = buildCanonRegistry(config._resolvedLibrary, { diagnostics: new Diagnostics() });

    const result = resolveItemRef(registry, 'magic');
    expect(result.item).toBeNull();
    expect(result.code).toBe('CL0340');
    expect(result.hint).toContain('core:magic');
    expect(result.hint).toContain('grimwood:magic');
  });

  test('both systems reach one compiled card under the titles their sets gave them', () => {
    const card = fs.readFileSync(
      path.join(projectDir, 'output', 'Branches', 'main', 'Story Cards', 'system', 'system.md'),
      'utf8',
    );
    expect(card).toContain('## Elemental Magic');
    expect(card).toContain('## Blood Magic');
    // Distinguishable by content, not only by title — this is §17.1's sentence compiled.
    expect(card).toContain('An affinity is trained, not inherited.');
    expect(card).toContain('It runs in a line and cannot be taught to someone outside it.');
  });

  test('a renamed import is provenanced to the project, an unrenamed one to its set', () => {
    const rows = fs.readFileSync(
      path.join(projectDir, 'Review', 'output.provenance.csv'), 'utf8',
    ).trim().split(/\r?\n/).slice(1).map((line) => line.split(','));

    // §17.4: only the id moves, and the row reads `project` with the library ref in `Via`.
    const renamed = rows.find((r) => r[0] === 'blood-magic');
    expect(renamed[1]).toBe('project');
    expect(renamed[3]).toBe('grimwood:magic');

    // The un-renamed side keeps both copies, each attributed to its own set and marked
    // ambiguous — the report's view of the empty plain registry key.
    const magic = rows.filter((r) => r[0] === 'magic');
    expect(magic.map((r) => r[1]).sort()).toEqual(['library:core', 'library:grimwood']);
    expect(magic.map((r) => r[4])).toEqual(['ambiguous', 'ambiguous']);

    // Paths are project-relative, so a committed report names no machine (session 1).
    expect(renamed[2]).toBe('Codex/items.cl.yaml');
    expect(magic[0][2].startsWith('../library/')).toBe(true);
  });
});

describe('the library items compile against the shared field table', () => {
  test('a tone variant selected with importVariants reaches the output', () => {
    const text = outputText();
    // `Aness` imported with `magical`; `Zephon` with `mundane`. Both appear on the story
    // card name line — the roster line carries `role`, not the Tagline.
    expect(text).toContain('hedge-trained');
    expect(text).toContain('Courier; former archivist');
  });

  test('an appended Tagline collapses on the story-card name line', () => {
    // `cardName.partial` renders `{$aid.title} - {join("", $body.Tagline)}`, so the
    // two-element list `+{; hedge-trained}` produced folds back to one line.
    const text = outputText();
    expect(text).toContain('Aness Kolar - Fixer; knows who owes whom; hedge-trained');
  });

  test('the cast roster reads role, and swaps it per tone', () => {
    // `Zephon` was imported with `mundane`, whose delta sets `role: Courier`.
    const text = outputText();
    expect(text).toContain('Zephon Adrel - Courier; nonbinary; late 20s; long brown hair, tied back');
  });

  test('the placeholder-defined character is addressed as You', () => {
    const text = outputText();
    expect(text).toContain('You: %heroName%');
  });
});
