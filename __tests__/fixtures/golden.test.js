'use strict';

/**
 * Golden fixture harness (v4 spec §14.3).
 *
 * Compiles each frozen fixture project from its `Loom/` source into a temp copy of the
 * whole `goldenFixtures/` tree, then asserts the result is byte-for-byte identical to the
 * committed `v3/` output.
 *
 * Phase 1 of the v4 rework is declared output-preserving with an EMPTY WHITELIST: any diff
 * this harness reports is a bug, not a re-baseline. Later phases change output deliberately
 * and re-baseline under review — see §14.3's expected-diff table before touching a fixture.
 *
 * The tree is copied because each project's `compile.yaml` writes to `../Velvet Lattice/`
 * and reaches up three levels for shared canon and templates (`{%loom}: ../../../_CodexLoom`),
 * so neither the output nor the inputs can be redirected without breaking the relative paths.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');

const GOLDEN_DIR = path.resolve(__dirname, '../../goldenFixtures');

const PROJECTS = [
  { name: 'Baseline', dir: path.join('Baseline', 'Baseline') },
  { name: 'Coinflip Company', dir: path.join('Eldemyr', 'Coinflip Company') },
  { name: 'The Institute', dir: path.join('Esudia', 'The Institute') },
];

/** Where a project's compile.yaml sends its output, relative to the project directory. */
const OUTPUT_SUBDIR = 'Velvet Lattice';
/** The committed baseline, relative to the project directory. */
const BASELINE_SUBDIR = 'v3';

/**
 * The migrated v4 sources, committed beside the frozen v3 output.
 *
 * The migrator runs at re-baseline time only, never here: if the test migrated on every
 * run, a migrator bug and a compiler bug would produce the same red and there would be no
 * way to tell them apart. `Loom/` keeps the original v3 sources for comparison.
 */
const SOURCE_SUBDIR = 'v4';

let tmpDir;

/** Collect every file under `dir` as a sorted list of paths relative to it. */
function listFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

/**
 * The canon manifest is the one output that cannot match byte-for-byte: it stamps a fresh
 * `generatedAt` and embeds absolute paths, which differ between the temp compile and the
 * committed baseline. Normalizing keeps it under comparison rather than whitelisted — the
 * canon file lists themselves are exactly the sort of thing a loader refactor could break.
 */
function normalizeManifest(raw, rootDir) {
  const parsed = JSON.parse(raw);
  delete parsed.generatedAt;
  const root = rootDir.replace(/\\/g, '/').toLowerCase();
  const scrub = (value) => {
    if (typeof value === 'string') {
      const unified = value.replace(/\\/g, '/')
        // The manifest records which compile.yaml produced the output. The v4 sources
        // live in v4/ and the v3 baseline was compiled from Loom/, so that segment
        // differs by fixture scaffolding rather than by anything about the scenario.
        .replace(/\/(v4|Loom)\/compile\.(cl\.)?ya?ml$/, '/<SOURCE>/compile.yaml');
      return unified.toLowerCase().startsWith(root)
        ? `<ROOT>${unified.slice(root.length)}`
        : unified;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    }
    return value;
  };
  return scrub(parsed);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-golden-'));

  // Copy the fixture tree, skipping the committed baselines — they are the comparison
  // target, not an input, and The Institute's alone is ~890 files.
  fs.cpSync(GOLDEN_DIR, tmpDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(GOLDEN_DIR, src);
      return !rel.split(path.sep).includes(BASELINE_SUBDIR);
    },
  });

  // compile() is chatty; a fixture run would otherwise bury the actual assertions.
  const quiet = ['log', 'warn', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
  try {
    for (const project of PROJECTS) {
      compile(path.join(tmpDir, project.dir, SOURCE_SUBDIR, 'compile.yaml'));
    }
  } finally {
    quiet.forEach((spy) => spy.mockRestore());
  }
}, 600000);

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.each(PROJECTS)('$name', (project) => {
  let actualDir;
  let expectedDir;

  beforeAll(() => {
    actualDir = path.join(tmpDir, project.dir, OUTPUT_SUBDIR);
    expectedDir = path.join(GOLDEN_DIR, project.dir, BASELINE_SUBDIR);
  });

  test('emits exactly the baseline file set', () => {
    expect(listFiles(actualDir)).toEqual(listFiles(expectedDir));
  });

  test('every emitted file is byte-identical to the baseline', () => {
    const differing = [];
    for (const rel of listFiles(expectedDir)) {
      const actualPath = path.join(actualDir, ...rel.split('/'));
      const expectedPath = path.join(expectedDir, ...rel.split('/'));
      if (!fs.existsSync(actualPath)) continue; // reported by the file-set test

      if (path.basename(rel) === 'canon-dependencies.json') {
        const actual = normalizeManifest(fs.readFileSync(actualPath, 'utf8'), path.join(tmpDir));
        const expected = normalizeManifest(fs.readFileSync(expectedPath, 'utf8'), GOLDEN_DIR);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) differing.push(rel);
        continue;
      }

      if (!fs.readFileSync(actualPath).equals(fs.readFileSync(expectedPath))) differing.push(rel);
    }
    expect(differing).toEqual([]);
  });
});
