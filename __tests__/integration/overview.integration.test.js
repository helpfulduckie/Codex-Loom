'use strict';

const fs   = require('fs');
const path = require('path');

const { runLeafReviewMode } = require('../../src/overview');
const { withTmpDir } = require('../helpers/project');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// ── two-branch fixture ────────────────────────────────────────────────────────

describe('runLeafReviewMode on two-branch fixture', () => {
  let tmp, outDir;

  beforeAll(() => {
    tmp    = withTmpDir();
    outDir = path.join(tmp, 'overview');
    fs.mkdirSync(outDir);

    // Root-level Components
    write(path.join(tmp, 'Components', 'Opening.md'), 'Once upon a time...');
    write(path.join(tmp, 'Components', 'Plot Essentials.md'), 'The main quest.');

    // branch: subject
    write(
      path.join(tmp, 'Branches', 'subject', 'Story Cards', 'Character', 'Character.md'),
      'Subject character content'
    );

    // branch: researcher
    write(
      path.join(tmp, 'Branches', 'researcher', 'Story Cards', 'Character', 'Character.md'),
      'Researcher character content'
    );

    runLeafReviewMode(tmp, outDir);
  });

  test('writes exactly one .leaf.md per leaf, named for the leaf', () => {
    expect(fs.readdirSync(outDir).sort()).toEqual([
      'researcher.leaf.md',
      'subject.leaf.md',
    ]);
  });

  test('subject.leaf.md contains its own card content', () => {
    const content = fs.readFileSync(path.join(outDir, 'subject.leaf.md'), 'utf8');
    expect(content).toContain('Subject character content');
  });

  test('subject.leaf.md contains inherited Opening', () => {
    const content = fs.readFileSync(path.join(outDir, 'subject.leaf.md'), 'utf8');
    expect(content).toContain('Once upon a time...');
  });

  test('researcher.leaf.md does not contain subject-only card content', () => {
    const content = fs.readFileSync(path.join(outDir, 'researcher.leaf.md'), 'utf8');
    expect(content).not.toContain('Subject character content');
  });
});

// ── single-leaf fixture ───────────────────────────────────────────────────────

describe('runLeafReviewMode on single-leaf fixture', () => {
  let tmp, outDir;

  beforeAll(() => {
    tmp    = withTmpDir();
    outDir = path.join(tmp, 'overview');
    fs.mkdirSync(outDir);

    write(path.join(tmp, 'Story Cards', 'Char', 'Card.md'), 'Single branch card');

    runLeafReviewMode(tmp, outDir);
  });

  test('single file uses root folder name', () => {
    const files = fs.readdirSync(outDir);
    expect(files).toHaveLength(1);
    // filename should be the tmp folder's basename + .leaf.md
    const expected = path.basename(tmp) + '.leaf.md';
    expect(files[0]).toBe(expected);
  });
});
