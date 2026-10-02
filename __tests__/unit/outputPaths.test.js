'use strict';

const path = require('path');
const fs = require('fs');
const {
  writeOutput, buildBranchOutputDir, sweepOutput,
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
 * The sweep visits branch *nodes*, not branch leaves.
 *
 * An interior node owns a `Label.md` and a `Placeholders.yaml`, and Velvet Lattice reads
 * both and inherits them down the subtree, so a declaration deleted from an interior node
 * would survive in the output and go on being inherited. The root is a node too.
 *
 * These pass an empty ledger — a compile that wrote nothing — so everything the compiler
 * owns is stale; the next block covers what the ledger keeps.
 */
const sweepAll = (cfg, leaves) => sweepOutput(cfg, leaves, new Set(), NULL_LOG);

describe('sweepOutput visits every node, not just leaves', () => {
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
    sweepAll(config(TIER), [['tier', 'alpha'], ['tier', 'beta']]);

    expect(fs.existsSync(path.join(nodes.interior, 'Placeholders.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(nodes.interior, 'Label.md'))).toBe(false);
    expect(fs.existsSync(path.join(nodes.interior, 'Story Cards'))).toBe(false);
  });

  test('the root of a branched project is swept too', () => {
    const nodes = buildTree();
    sweepAll(config(TIER), [['tier', 'alpha'], ['tier', 'beta']]);

    expect(fs.existsSync(path.join(nodes.root, 'Placeholders.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(nodes.root, 'Label.md'))).toBe(false);
  });

  test('leaves are still swept, and the tree itself survives', () => {
    const nodes = buildTree();
    sweepAll(config(TIER), [['tier', 'alpha'], ['tier', 'beta']]);

    expect(fs.existsSync(path.join(nodes.alpha, 'Placeholders.yaml'))).toBe(false);
    expect(fs.existsSync(nodes.alpha)).toBe(true);
    expect(fs.existsSync(nodes.beta)).toBe(true);
    expect(fs.existsSync(nodes.interior)).toBe(true);
  });

  test('a dropped leaf is removed, its siblings untouched', () => {
    // Nothing but compiler output, so there is nothing to keep. Archiving is for what the
    // compiler does not own; see the next test.
    const nodes = buildTree();
    sweepAll(config({ tier: { branches: { alpha: {} } } }), [['tier', 'alpha']]);

    expect(fs.existsSync(nodes.beta)).toBe(false);
    expect(fs.existsSync(nodes.alpha)).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'Archive'))).toBe(false);
  });

  test('a dropped node holding a hand-added file is archived, not deleted', () => {
    const nodes = buildTree();
    fs.writeFileSync(path.join(nodes.beta, 'notes.txt'), 'written by hand', 'utf8');

    sweepAll(config({ tier: { branches: { alpha: {} } } }), [['tier', 'alpha']]);

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
    sweepAll(config({ other: {} }), [['other']]);

    expect(fs.existsSync(path.join(outDir, 'Branches', 'tier'))).toBe(false);
  });

  test('an emptied interior node does not survive as a shell around its lost children', () => {
    // The `Branches` container is what would keep it: its children are gone, so it holds
    // nothing, but an existing directory reads as content and would get the parent
    // archived rather than removed.
    const nodes = buildTree();
    fs.writeFileSync(path.join(nodes.alpha, 'notes.txt'), 'written by hand', 'utf8');

    sweepAll(config({ other: {} }), [['other']]);

    const archive = path.join(outDir, 'Archive');
    const stamp = fs.readdirSync(archive)[0];
    expect(fs.readdirSync(path.join(archive, stamp, 'Branches'))).toEqual(['tier']);
    expect(fs.existsSync(path.join(outDir, 'Branches', 'tier'))).toBe(false);
  });
});

describe('sweepOutput keeps what this compile wrote', () => {
  let outDir;
  const write = (rel, text = 'x') => {
    const file = path.join(outDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    return path.resolve(file);
  };
  const exists = (rel) => fs.existsSync(path.join(outDir, ...rel.split('/')));
  const config = { branches: { a: {} } };

  beforeEach(() => {
    outDir = withTmpDir();
    config._resolvedOutput = outDir;
  });

  test('a file in the ledger survives; an owned file beside it that is not goes', () => {
    const kept = new Set([write('Branches/a/Story Cards/npc/npc.md')]);
    write('Branches/a/Story Cards/faction/faction.md');
    sweepOutput(config, [['a']], kept, NULL_LOG);
    expect(exists('Branches/a/Story Cards/npc/npc.md')).toBe(true);
    expect(exists('Branches/a/Story Cards/faction')).toBe(false);
  });

  test('Description.md and the root manifests are owned, under their old names too', () => {
    write('Description.md');
    write('library-dependencies.json');
    write('canon-dependencies.json');
    sweepOutput(config, [['a']], new Set(), NULL_LOG);
    expect(exists('Description.md')).toBe(false);
    expect(exists('library-dependencies.json')).toBe(false);
    expect(exists('canon-dependencies.json')).toBe(false);
  });

  test("a live node keeps files the compiler does not own, such as VL's .short_id", () => {
    write('Branches/a/.short_id', 'abc123');
    write('Branches/a/Label.md');
    write('notes.txt');
    sweepOutput(config, [['a']], new Set(), NULL_LOG);
    expect(exists('Branches/a/.short_id')).toBe(true);
    expect(exists('notes.txt')).toBe(true);
    expect(exists('Branches/a/Label.md')).toBe(false);
  });
});
