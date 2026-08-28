'use strict';

/**
 * Phase 12 Step 6 — the `Scripts/` lift.
 *
 * `copyScripts` used to run unconditionally inside the per-leaf loop, so every leaf held
 * its own byte-identical copy of a project's shipped `.js`. It now rides the Phase 11 Step 4
 * inheritance pass: Velvet Lattice inherits a node's `Scripts/` dir down its subtree
 * (`scenario.py`: `self.scripts = {**parent, **local}`), so a `scripts:` spec that resolves
 * identically at every leaf and is redeclared by no branch is written once at the output
 * root, and per leaf otherwise.
 *
 * Integration because the behavior is only observable at the file level — which directory
 * the `.js` land in. Three cases:
 *   - a spec identical at every leaf, no branch redeclaring   → one `Scripts/` at the root
 *   - a branch redeclaring `scripts:` with a different dir     → per leaf
 *   - a branch redeclaring `scripts:` with the *same* dir      → still per leaf, because the
 *     guard is `branchTreeDeclares`, not just "are the specs equal"
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

/** Write `files` into a fresh temp dir, compile `compile.yaml`, return the temp path. */
function compileProject(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-scripts-lift-'));
  dirs.push(tmpDir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  const diagnostics = new Diagnostics();
  const spies = ['log', 'warn', 'error'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics });
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return { tmpDir, diagnostics };
}

const exists = (...parts) => fs.existsSync(path.join(...parts));
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const BASE = {
  'templates/Character.template': '{$name}\n',
  'Codex/items.yaml': [
    '- id: Hero',
    '  name: Hero',
    '  aid: {type: Character, triggers: [Hero]}',
    '  render: {template: Character, wrapper: none}',
    '',
  ].join('\n'),
  'scripts/library.js': 'exports.shared = 1;\n',
  'scripts/input.js': '// input hook\n',
};

const config = (extra) => [
  'version: 4',
  'title: Scripts Lift Probe',
  'structure:',
  '  input:',
  "    items: ['./Codex']",
  "    templates: ['./templates']",
  "  output: './out'",
  'scripts: ./scripts',
  'branches:',
  ...extra,
  '',
].join('\n');

describe('a scripts: dir identical at every leaf and redeclared by no branch', () => {
  const built = () => compileProject({ ...BASE, 'compile.yaml': config(['  a: {}', '  b: {}']) });

  test('is written once at the output root', () => {
    const { tmpDir } = built();
    expect(exists(tmpDir, 'out', 'Scripts', 'library.js')).toBe(true);
    expect(exists(tmpDir, 'out', 'Scripts', 'input.js')).toBe(true);
    expect(read(tmpDir, 'out', 'Scripts', 'library.js')).toBe('exports.shared = 1;\n');
  });

  test('is not copied to any leaf', () => {
    const { tmpDir } = built();
    expect(exists(tmpDir, 'out', 'Branches', 'a', 'Scripts')).toBe(false);
    expect(exists(tmpDir, 'out', 'Branches', 'b', 'Scripts')).toBe(false);
  });
});

describe('a branch that redeclares scripts: with a different dir', () => {
  const built = () => compileProject({
    ...BASE,
    'scripts-b/library.js': 'exports.shared = 2;\n',
    'compile.yaml': config(['  a: {}', '  b:', '    scripts: ./scripts-b']),
  });

  test('forces every leaf to hold its own copy — nothing at the root', () => {
    const { tmpDir } = built();
    expect(exists(tmpDir, 'out', 'Scripts')).toBe(false);
    expect(read(tmpDir, 'out', 'Branches', 'a', 'Scripts', 'library.js')).toBe('exports.shared = 1;\n');
    expect(read(tmpDir, 'out', 'Branches', 'b', 'Scripts', 'library.js')).toBe('exports.shared = 2;\n');
  });
});

describe('a branch that redeclares scripts: with the same dir', () => {
  const built = () => compileProject({
    ...BASE,
    'compile.yaml': config(['  a: {}', '  b:', '    scripts: ./scripts']),
  });

  test('still writes per leaf — the guard is branchTreeDeclares, not spec equality', () => {
    const { tmpDir } = built();
    expect(exists(tmpDir, 'out', 'Scripts')).toBe(false);
    expect(exists(tmpDir, 'out', 'Branches', 'a', 'Scripts', 'library.js')).toBe(true);
    expect(exists(tmpDir, 'out', 'Branches', 'b', 'Scripts', 'library.js')).toBe(true);
  });
});
