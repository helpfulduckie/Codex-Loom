'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { cardAppliesTo, getTemplate, writeOpening, resolveOpeningContent } = require('../../src/compile');

describe('cardAppliesTo', () => {
  test('no filter: always true', () => {
    expect(cardAppliesTo({}, ['any', 'path'])).toBe(true);
    expect(cardAppliesTo({}, ['subject'])).toBe(true);
  });

  test('only: exact match', () => {
    expect(cardAppliesTo({ only: 'subject' }, ['subject'])).toBe(true);
    expect(cardAppliesTo({ only: 'subject' }, ['researcher'])).toBe(false);
  });

  test('only: prefix match for deeper paths', () => {
    expect(cardAppliesTo({ only: 'subject' }, ['subject', 'A'])).toBe(true);
    expect(cardAppliesTo({ only: 'researcher' }, ['subject', 'A'])).toBe(false);
  });

  test('only: array of prefixes — any match passes', () => {
    expect(cardAppliesTo({ only: ['subject', 'felix'] }, ['felix'])).toBe(true);
    expect(cardAppliesTo({ only: ['subject', 'felix'] }, ['researcher'])).toBe(false);
  });

  test('except: excludes matching path', () => {
    expect(cardAppliesTo({ except: 'researcher' }, ['researcher'])).toBe(false);
    expect(cardAppliesTo({ except: 'researcher' }, ['subject'])).toBe(true);
  });

  test('except: prefix exclusion', () => {
    expect(cardAppliesTo({ except: 'A' }, ['A', 'X'])).toBe(false);
    expect(cardAppliesTo({ except: 'A' }, ['B', 'X'])).toBe(true);
  });

  test('case-insensitive prefix matching', () => {
    expect(cardAppliesTo({ only: 'Subject' }, ['subject'])).toBe(true);
    expect(cardAppliesTo({ except: 'RESEARCHER' }, ['researcher'])).toBe(false);
  });
});

describe('getTemplate', () => {
  const templates = new Map([
    ['character', { content: 'char template', _source: 'x' }],
    ['npc', { content: 'npc template', _source: 'y' }],
  ]);

  test('returns template by explicit template field', () => {
    expect(getTemplate({ template: 'npc', type: 'character' }, templates)).toBe('npc template');
  });

  test('falls back to type when template field absent', () => {
    expect(getTemplate({ type: 'Character' }, templates)).toBe('char template');
  });

  test('type lookup is case-insensitive', () => {
    expect(getTemplate({ type: 'CHARACTER' }, templates)).toBe('char template');
  });

  test('returns null when neither template nor type found', () => {
    expect(getTemplate({ type: 'Unknown' }, templates)).toBeNull();
  });

  test('returns null for card with no type or template', () => {
    expect(getTemplate({}, templates)).toBeNull();
  });
});

describe('resolveOpeningContent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-opening-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('inline text is returned as-is (trimmed)', () => {
    expect(resolveOpeningContent('Which role?  ', tmpDir)).toBe('Which role?');
  });

  test('valid file path returns file content (trimmed)', () => {
    const file = path.join(tmpDir, 'opening.md');
    fs.writeFileSync(file, 'File content\n', 'utf8');
    expect(resolveOpeningContent(file, tmpDir)).toBe('File content');
  });

  test('relative file path resolves from base', () => {
    fs.mkdirSync(path.join(tmpDir, 'openings'));
    const file = path.join(tmpDir, 'openings', 'q.md');
    fs.writeFileSync(file, 'Relative content', 'utf8');
    expect(resolveOpeningContent('./openings/q.md', tmpDir)).toBe('Relative content');
  });

  test('non-existent path returns string as inline text', () => {
    expect(resolveOpeningContent('./does-not-exist.md', tmpDir)).toBe('./does-not-exist.md');
  });
});

describe('writeOpening', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-opening-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates Components/Opening.md with content and trailing newline', () => {
    writeOpening(tmpDir, 'Hello world');
    const outPath = path.join(tmpDir, 'Components', 'Opening.md');
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('Hello world\n');
  });

  test('creates intermediate Components directory', () => {
    const nested = path.join(tmpDir, 'Branches', 'A');
    writeOpening(nested, 'Nested');
    expect(fs.existsSync(path.join(nested, 'Components', 'Opening.md'))).toBe(true);
  });
});
