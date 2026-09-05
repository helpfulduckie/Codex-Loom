'use strict';

const path = require('path');
const fs = require('fs');
const {
  writeOutput, buildBranchOutputDir, cleanAndArchive,
} = require('../../src/outputPaths');
const { NULL_LOG } = require('../../src/log');
const { withTmpDir } = require('../helpers/project');

// ── buildBranchOutputDir ──────────────────────────────────────────────────────

describe('buildBranchOutputDir', () => {
  test('empty branchPath returns baseOutput unchanged', () => {
    expect(buildBranchOutputDir('/output', [])).toBe('/output');
  });

  test('single-level path inserts Branches/{name}', () => {
    expect(buildBranchOutputDir('/output', ['knight']))
      .toBe(path.join('/output', 'Branches', 'knight'));
  });

  test('two-level path interleaves Branches between each level', () => {
    expect(buildBranchOutputDir('/output', ['tier1', 'alpha']))
      .toBe(path.join('/output', 'Branches', 'tier1', 'Branches', 'alpha'));
  });
});

// ── writeOutput ───────────────────────────────────────────────────────────────

describe('writeOutput', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = withTmpDir();
  });

  test('writes items joined by \\n\\n with trailing newline', () => {
    writeOutput(tmpDir, 'Character', ['Item A', 'Item B']);
    const outPath = path.join(tmpDir, 'Story Cards', 'Character', 'Character.md');
    expect(fs.readFileSync(outPath, 'utf8')).toBe('Item A\n\nItem B\n');
  });

  test('creates Story Cards/{type}/ directory recursively', () => {
    writeOutput(tmpDir, 'Location', ['Item']);
    expect(fs.existsSync(path.join(tmpDir, 'Story Cards', 'Location'))).toBe(true);
  });

  test('returns the output file path', () => {
    const result = writeOutput(tmpDir, 'NPC', ['Item']);
    expect(result).toBe(path.join(tmpDir, 'Story Cards', 'NPC', 'NPC.md'));
  });
});

/**
 * The clean sweep visits branch *nodes*, not branch leaves.
 *
 * It swept only leaves until Phase 4's `Placeholders.yaml` made the hole visible. An
 * interior node owns a `Label.md` — and now a `Placeholders.yaml` — and Velvet Lattice
 * reads both and inherits them down the subtree, so a declaration deleted from an interior
 * node survived in the output and went on being inherited. The root had the same hole from
 * the other end: it entered the expected set only when the project had no branches at all.
 */
describe('cleanAndArchive sweeps every node, not just leaves', () => {
  let outDir;

  /** An output tree: root, one interior node, two leaves under it. */
  function buildTree() {
    outDir = withTmpDir();
    const nodes = {
      root: outDir,
      interior: path.join(outDir, 'Branches', 'tier'),
      alpha: path.join(outDir, 'Branches', 'tier', 'Branches', 'alpha'),
      beta: path.join(outDir, 'Branches', 'tier', 'Branches', 'beta'),
    };
    for (const dir of Object.values(nodes)) {
      fs.mkdirSync(path.join(dir, 'Story Cards'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Story Cards', 'Character.md'), 'stale card', 'utf8');
      fs.writeFileSync(path.join(dir, 'Label.md'), 'stale label', 'utf8');
      fs.writeFileSync(path.join(dir, 'Placeholders.yaml'), 'stale: placeholder\n', 'utf8');
    }
    return nodes;
  }

  const config = (branches) => ({ _resolvedOutput: outDir, branches });
  const TIER = { tier: { branches: { alpha: {}, beta: {} } } };

  test('an interior node is swept', () => {
    const nodes = buildTree();
    cleanAndArchive(config(TIER), [['tier', 'alpha'], ['tier', 'beta']], NULL_LOG);

    expect(fs.existsSync(path.join(nodes.interior, 'Placeholders.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(nodes.interior, 'Label.md'))).toBe(false);
    expect(fs.existsSync(path.join(nodes.interior, 'Story Cards'))).toBe(false);
  });

  test('the root of a branched project is swept too', () => {
    const nodes = buildTree();
    cleanAndArchive(config(TIER), [['tier', 'alpha'], ['tier', 'beta']], NULL_LOG);

    expect(fs.existsSync(path.join(nodes.root, 'Placeholders.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(nodes.root, 'Label.md'))).toBe(false);
  });

  test('leaves are still swept, and the tree itself survives', () => {
    const nodes = buildTree();
    cleanAndArchive(config(TIER), [['tier', 'alpha'], ['tier', 'beta']], NULL_LOG);

    expect(fs.existsSync(path.join(nodes.alpha, 'Placeholders.yaml'))).toBe(false);
    expect(fs.existsSync(nodes.alpha)).toBe(true);
    expect(fs.existsSync(nodes.beta)).toBe(true);
    expect(fs.existsSync(nodes.interior)).toBe(true);
  });

  test('a dropped leaf is removed, its siblings untouched', () => {
    // Nothing but compiler output, so there is nothing to keep. Archiving is for what the
    // compiler does not own; see the next test.
    const nodes = buildTree();
    cleanAndArchive(config({ tier: { branches: { alpha: {} } } }), [['tier', 'alpha']], NULL_LOG);

    expect(fs.existsSync(nodes.beta)).toBe(false);
    expect(fs.existsSync(nodes.alpha)).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'Archive'))).toBe(false);
  });

  test('a dropped node holding a hand-added file is archived, not deleted', () => {
    const nodes = buildTree();
    fs.writeFileSync(path.join(nodes.beta, 'notes.txt'), 'written by hand', 'utf8');

    cleanAndArchive(config({ tier: { branches: { alpha: {} } } }), [['tier', 'alpha']], NULL_LOG);

    const archive = path.join(outDir, 'Archive');
    const stamp = fs.readdirSync(archive)[0];
    expect(fs.readFileSync(
      path.join(archive, stamp, 'Branches', 'tier', 'Branches', 'beta', 'notes.txt'), 'utf8',
    )).toBe('written by hand');
  });

  test('a dropped interior node takes its whole subtree with it', () => {
    // Ancestors of a live leaf are live, so a stale node can never hold one — which is
    // what makes taking an interior node whole safe rather than destructive.
    buildTree();
    cleanAndArchive(config({ other: {} }), [['other']], NULL_LOG);

    expect(fs.existsSync(path.join(outDir, 'Branches', 'tier'))).toBe(false);
  });

  test('an emptied interior node does not survive as a shell around its lost children', () => {
    // The `Branches` container is what would keep it: its children are gone, so it holds
    // nothing, but an existing directory reads as content and would get the parent
    // archived rather than removed.
    const nodes = buildTree();
    fs.writeFileSync(path.join(nodes.alpha, 'notes.txt'), 'written by hand', 'utf8');

    cleanAndArchive(config({ other: {} }), [['other']], NULL_LOG);

    const archive = path.join(outDir, 'Archive');
    const stamp = fs.readdirSync(archive)[0];
    expect(fs.readdirSync(path.join(archive, stamp, 'Branches'))).toEqual(['tier']);
    expect(fs.existsSync(path.join(outDir, 'Branches', 'tier'))).toBe(false);
  });
});
