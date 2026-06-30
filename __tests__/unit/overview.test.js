'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  readComponents,
  buildStoryCardsBlock,
  discoverLeaves,
  compileLeaf,
  runLeafReviewMode,
} = require('../../src/overview');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-overview-test-'));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// ── readComponents ────────────────────────────────────────────────────────────

describe('readComponents', () => {
  test('returns {} for missing Components dir', () => {
    const tmp = makeTmp();
    expect(readComponents(tmp)).toEqual({});
    fs.rmSync(tmp, { recursive: true });
  });

  test('returns map of basename → content for .md files', () => {
    const tmp = makeTmp();
    write(path.join(tmp, 'Components', 'Opening.md'), 'Hello world');
    write(path.join(tmp, 'Components', 'Plot Essentials.md'), 'Some essentials');
    const result = readComponents(tmp);
    expect(result['Opening']).toBe('Hello world');
    expect(result['Plot Essentials']).toBe('Some essentials');
    fs.rmSync(tmp, { recursive: true });
  });

  test('skips empty files', () => {
    const tmp = makeTmp();
    write(path.join(tmp, 'Components', 'Empty.md'), '   ');
    const result = readComponents(tmp);
    expect(result).toEqual({});
    fs.rmSync(tmp, { recursive: true });
  });
});

// ── buildStoryCardsBlock ──────────────────────────────────────────────────────

describe('buildStoryCardsBlock', () => {
  test('returns null for missing/empty directory', () => {
    const tmp = makeTmp();
    expect(buildStoryCardsBlock(path.join(tmp, 'Story Cards'), 2)).toBeNull();
    fs.rmSync(tmp, { recursive: true });
  });

  test('groups files by immediate sub-folder with heading', () => {
    const tmp = makeTmp();
    write(path.join(tmp, 'Character', 'Alice.md'), 'Alice card');
    write(path.join(tmp, 'Character', 'Bob.md'), 'Bob card');
    const result = buildStoryCardsBlock(tmp, 2);
    expect(result).toContain('## Character');
    expect(result).toContain('Alice card');
    expect(result).toContain('Bob card');
    fs.rmSync(tmp, { recursive: true });
  });

  test('files at root of dir (no subdir) get no group heading', () => {
    const tmp = makeTmp();
    write(path.join(tmp, 'Card.md'), 'Root card');
    const result = buildStoryCardsBlock(tmp, 2);
    expect(result).not.toContain('##');
    expect(result).toContain('Root card');
    fs.rmSync(tmp, { recursive: true });
  });

  test('heading level controls hash depth', () => {
    const tmp = makeTmp();
    write(path.join(tmp, 'Type', 'Card.md'), 'content');
    const result = buildStoryCardsBlock(tmp, 4);
    expect(result).toContain('#### Type');
    fs.rmSync(tmp, { recursive: true });
  });
});

// ── discoverLeaves ────────────────────────────────────────────────────────────

describe('discoverLeaves', () => {
  test('flat root with no Branches/ returns single leaf', () => {
    const tmp = makeTmp();
    write(path.join(tmp, 'Story Cards', 'Char', 'Alice.md'), 'Alice');
    const leaves = discoverLeaves(tmp, [], []);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].branchNames).toEqual([]);
    expect(leaves[0].cards.join('')).toContain('Alice');
    fs.rmSync(tmp, { recursive: true });
  });

  test('nested Branches produces correct leaves with accumulated cards', () => {
    const tmp = makeTmp();
    // root-level cards
    write(path.join(tmp, 'Story Cards', 'Char', 'Root.md'), 'Root card');
    // branch A
    write(path.join(tmp, 'Branches', 'A', 'Story Cards', 'Char', 'A.md'), 'A card');
    // branch B
    write(path.join(tmp, 'Branches', 'B', 'Story Cards', 'Char', 'B.md'), 'B card');

    const leaves = discoverLeaves(tmp, [], []);
    expect(leaves).toHaveLength(2);

    const a = leaves.find(l => l.branchNames[0] === 'A');
    const b = leaves.find(l => l.branchNames[0] === 'B');

    // both inherit root card
    expect(a.cards.join('\n')).toContain('Root card');
    expect(b.cards.join('\n')).toContain('Root card');
    // each has its own card
    expect(a.cards.join('\n')).toContain('A card');
    expect(b.cards.join('\n')).toContain('B card');
    // no cross-contamination
    expect(a.cards.join('\n')).not.toContain('B card');
    expect(b.cards.join('\n')).not.toContain('A card');

    fs.rmSync(tmp, { recursive: true });
  });
});

// ── compileLeaf ───────────────────────────────────────────────────────────────

describe('compileLeaf', () => {
  test('output filename uses .leaf.md extension', () => {
    const tmp    = makeTmp();
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);
    const leaf = { branchNames: ['subject'], cards: [], leafDir: tmp };
    compileLeaf(leaf, outDir, 'MyScenario', false);
    const files = fs.readdirSync(outDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('subject.leaf.md');
    fs.rmSync(tmp, { recursive: true });
  });

  test('single-leaf scenario uses rootDirName', () => {
    const tmp    = makeTmp();
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);
    const leaf = { branchNames: [], cards: [], leafDir: tmp };
    compileLeaf(leaf, outDir, 'MyScenario', true);
    const files = fs.readdirSync(outDir);
    expect(files[0]).toBe('MyScenario.leaf.md');
    fs.rmSync(tmp, { recursive: true });
  });

  test('output contains title, Story Cards section when cards present', () => {
    const tmp    = makeTmp();
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);
    const leaf = { branchNames: ['hero'], cards: ['Card content here'], leafDir: tmp };
    compileLeaf(leaf, outDir, 'Root', false);
    const content = fs.readFileSync(path.join(outDir, 'hero.leaf.md'), 'utf8');
    expect(content).toContain('# Root: hero');
    expect(content).toContain('## Story Cards');
    expect(content).toContain('Card content here');
    fs.rmSync(tmp, { recursive: true });
  });

  test('Opening and Plot Essentials resolved from Components/', () => {
    const tmp    = makeTmp();
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);
    write(path.join(tmp, 'Components', 'Opening.md'), 'Welcome!');
    write(path.join(tmp, 'Components', 'Plot Essentials.md'), 'The quest begins.');
    const leaf = { branchNames: ['alpha'], cards: [], leafDir: tmp };
    compileLeaf(leaf, outDir, 'Root', false);
    const content = fs.readFileSync(path.join(outDir, 'alpha.leaf.md'), 'utf8');
    expect(content).toContain('## Opening');
    expect(content).toContain('Welcome!');
    expect(content).toContain('## Plot Essentials');
    expect(content).toContain('The quest begins.');
    fs.rmSync(tmp, { recursive: true });
  });
});

// ── runLeafReviewMode ─────────────────────────────────────────────────────────────

describe('runLeafReviewMode', () => {
  test('creates outputDir implicitly if called after mkdirSync', () => {
    const tmp    = makeTmp();
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);
    write(path.join(tmp, 'Story Cards', 'Char', 'Card.md'), 'content');
    const written = runLeafReviewMode(tmp, outDir);
    expect(written).toHaveLength(1);
    fs.rmSync(tmp, { recursive: true });
  });

  test('returns correct written paths', () => {
    const tmp    = makeTmp();
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);
    write(path.join(tmp, 'Branches', 'A', 'Story Cards', 'T', 'x.md'), 'x');
    write(path.join(tmp, 'Branches', 'B', 'Story Cards', 'T', 'y.md'), 'y');
    const written = runLeafReviewMode(tmp, outDir);
    expect(written).toHaveLength(2);
    expect(written.every(p => p.endsWith('.leaf.md'))).toBe(true);
    fs.rmSync(tmp, { recursive: true });
  });

  test('returns empty array when no leaves found', () => {
    const tmp    = makeTmp();
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);
    // No Story Cards, no Branches — but IS a leaf, just empty
    const written = runLeafReviewMode(tmp, outDir);
    // one empty leaf still counts
    expect(written).toHaveLength(1);
    fs.rmSync(tmp, { recursive: true });
  });
});
