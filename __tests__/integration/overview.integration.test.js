'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { runLeafReviewMode } = require('../../src/overview');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// ── two-branch fixture ────────────────────────────────────────────────────────

describe('runLeafReviewMode on two-branch fixture', () => {
  let tmp, outDir;

  beforeAll(() => {
    tmp    = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ov-int-'));
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

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('writes one file per leaf', () => {
    const files = fs.readdirSync(outDir);
    expect(files).toHaveLength(2);
  });

  test('all output files have .overview.md extension', () => {
    const files = fs.readdirSync(outDir);
    expect(files.every(f => f.endsWith('.overview.md'))).toBe(true);
  });

  test('subject.overview.md is created', () => {
    expect(fs.existsSync(path.join(outDir, 'subject.overview.md'))).toBe(true);
  });

  test('researcher.overview.md is created', () => {
    expect(fs.existsSync(path.join(outDir, 'researcher.overview.md'))).toBe(true);
  });

  test('subject.overview.md contains its own card content', () => {
    const content = fs.readFileSync(path.join(outDir, 'subject.overview.md'), 'utf8');
    expect(content).toContain('Subject character content');
  });

  test('subject.overview.md contains inherited Opening', () => {
    const content = fs.readFileSync(path.join(outDir, 'subject.overview.md'), 'utf8');
    expect(content).toContain('Once upon a time...');
  });

  test('researcher.overview.md does not contain subject-only card content', () => {
    const content = fs.readFileSync(path.join(outDir, 'researcher.overview.md'), 'utf8');
    expect(content).not.toContain('Subject character content');
  });

  test('no non-.overview.md files are written to outputDir', () => {
    const files = fs.readdirSync(outDir);
    expect(files.filter(f => !f.endsWith('.overview.md'))).toHaveLength(0);
  });
});

// ── single-leaf fixture ───────────────────────────────────────────────────────

describe('runLeafReviewMode on single-leaf fixture', () => {
  let tmp, outDir;

  beforeAll(() => {
    tmp    = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ov-single-'));
    outDir = path.join(tmp, 'overview');
    fs.mkdirSync(outDir);

    write(path.join(tmp, 'Story Cards', 'Char', 'Card.md'), 'Single branch card');

    runLeafReviewMode(tmp, outDir);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('single file uses root folder name', () => {
    const files = fs.readdirSync(outDir);
    expect(files).toHaveLength(1);
    // filename should be the tmp folder's basename + .overview.md
    const expected = path.basename(tmp) + '.overview.md';
    expect(files[0]).toBe(expected);
  });
});
