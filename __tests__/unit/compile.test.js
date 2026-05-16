'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { getTemplate, writeOpening, resolveOpeningContent, resolveBranchFolderPath } = require('../../src/compile');

describe('getTemplate', () => {
  const templates = new Map([
    ['character', { content: 'char template', _source: 'x' }],
    ['npc', { content: 'npc template', _source: 'y' }],
  ]);

  test('returns template by render.template field', () => {
    const card = { render: { template: 'npc' }, aid: { type: 'character' } };
    expect(getTemplate(card, templates)).toBe('npc template');
  });

  test('falls back to aid.type when render.template absent', () => {
    const card = { render: {}, aid: { type: 'Character' } };
    expect(getTemplate(card, templates)).toBe('char template');
  });

  test('type lookup is case-insensitive', () => {
    const card = { aid: { type: 'CHARACTER' } };
    expect(getTemplate(card, templates)).toBe('char template');
  });

  test('returns null when neither render.template nor aid.type found', () => {
    const card = { aid: { type: 'Unknown' } };
    expect(getTemplate(card, templates)).toBeNull();
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

describe('resolveBranchFolderPath', () => {
  test('returns id path when no branches config', () => {
    expect(resolveBranchFolderPath(null, ['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });

  test('returns id path when no title on nodes', () => {
    const branches = {
      alpha: { branches: { beta: {} } },
    };
    expect(resolveBranchFolderPath(branches, ['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });

  test('uses title when present on a node', () => {
    const branches = {
      alpha: { title: 'The Alpha Path', branches: { beta: {} } },
    };
    expect(resolveBranchFolderPath(branches, ['alpha', 'beta'])).toEqual(['The Alpha Path', 'beta']);
  });

  test('uses title on nested node', () => {
    const branches = {
      alpha: { branches: { beta: { title: 'Beta Run' } } },
    };
    expect(resolveBranchFolderPath(branches, ['alpha', 'beta'])).toEqual(['alpha', 'Beta Run']);
  });

  test('uses title at all levels when both present', () => {
    const branches = {
      alpha: { title: 'Alpha Stage', branches: { beta: { title: 'Beta Stage' } } },
    };
    expect(resolveBranchFolderPath(branches, ['alpha', 'beta'])).toEqual(['Alpha Stage', 'Beta Stage']);
  });

  test('falls back to key when title is empty string', () => {
    const branches = {
      alpha: { title: '' },
    };
    expect(resolveBranchFolderPath(branches, ['alpha'])).toEqual(['alpha']);
  });

  test('falls back to key when title is null', () => {
    const branches = {
      alpha: { title: null },
    };
    expect(resolveBranchFolderPath(branches, ['alpha'])).toEqual(['alpha']);
  });

  test('returns id for unknown keys not in branches map', () => {
    const branches = {
      alpha: {},
    };
    expect(resolveBranchFolderPath(branches, ['alpha', 'unknown'])).toEqual(['alpha', 'unknown']);
  });

  test('id lookup is case-insensitive', () => {
    const branches = {
      Alpha: { title: 'The Alpha Path' },
    };
    expect(resolveBranchFolderPath(branches, ['alpha'])).toEqual(['The Alpha Path']);
  });

  test('empty id path returns empty folder path', () => {
    expect(resolveBranchFolderPath({}, [])).toEqual([]);
  });
});
