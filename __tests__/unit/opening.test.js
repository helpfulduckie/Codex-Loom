'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadOpeningConfig, compileOpening } = require('../../src/opening');

// ── loadOpeningConfig ─────────────────────────────────────────────────────────

describe('loadOpeningConfig', () => {
  let tmpDir;
  beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-opening-unit-')); });
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('loads a valid YAML sequence', () => {
    const f = path.join(tmpDir, 'ok.yaml');
    fs.writeFileSync(f, '- text: "Hello"\n- text: "World"\n', 'utf8');
    expect(loadOpeningConfig(f)).toEqual([{ text: 'Hello' }, { text: 'World' }]);
  });

  test('throws when YAML is a mapping (not a sequence)', () => {
    const f = path.join(tmpDir, 'bad.yaml');
    fs.writeFileSync(f, 'text: Hello\n', 'utf8');
    expect(() => loadOpeningConfig(f)).toThrow(/sequence/);
  });
});

// ── compileOpening ────────────────────────────────────────────────────────────

describe('compileOpening — basic', () => {
  const BASE = '/';

  test('empty block list returns null', () => {
    expect(compileOpening([], ['subject'], {}, BASE)).toBeNull();
  });

  test('single block with no branches: included for all leaves', () => {
    const blocks = [{ text: 'Universal.' }];
    expect(compileOpening(blocks, ['subject'], {}, BASE)).toBe('Universal.');
    expect(compileOpening(blocks, ['researcher', 'mage'], {}, BASE)).toBe('Universal.');
  });

  test('multiple blocks joined with \\n\\n', () => {
    const blocks = [{ text: 'First.' }, { text: 'Second.' }];
    expect(compileOpening(blocks, ['leaf'], {}, BASE)).toBe('First.\n\nSecond.');
  });

  test('block with null/missing text is skipped', () => {
    const blocks = [{ text: 'Keep.' }, { /* no text */ }, { text: null }];
    expect(compileOpening(blocks, ['leaf'], {}, BASE)).toBe('Keep.');
  });

  test('blank-only text is filtered out', () => {
    const blocks = [{ text: '   ' }, { text: 'Keep.' }];
    expect(compileOpening(blocks, ['leaf'], {}, BASE)).toBe('Keep.');
  });

  test('all blocks excluded returns null', () => {
    const blocks = [
      { text: 'Nope.', branches: { subject: null } },
    ];
    expect(compileOpening(blocks, ['subject'], {}, BASE)).toBeNull();
  });
});

describe('compileOpening — branch dispatch', () => {
  const BASE = '/';

  test('block included via [] value (include, no variant)', () => {
    const blocks = [{ text: 'Yes.', branches: { subject: [] } }];
    expect(compileOpening(blocks, ['subject'], {}, BASE)).toBe('Yes.');
  });

  test('block excluded from non-matching branch via _ fallback null', () => {
    const blocks = [{ text: 'Subject only.', branches: { subject: [], _: null } }];
    expect(compileOpening(blocks, ['subject'], {}, BASE)).toBe('Subject only.');
    expect(compileOpening(blocks, ['researcher'], {}, BASE)).toBeNull();
  });

  test('block included in both subject and researcher, excluded from others via _: ~', () => {
    const blocks = [{ text: 'Both.', branches: { subject: [], researcher: [], _: null } }];
    expect(compileOpening(blocks, ['subject'], {}, BASE)).toBe('Both.');
    expect(compileOpening(blocks, ['researcher'], {}, BASE)).toBe('Both.');
    expect(compileOpening(blocks, ['other'], {}, BASE)).toBeNull();
  });

  test('nested branch dispatch — mage sub-branch only', () => {
    const blocks = [{
      text: 'Mage only.',
      branches: {
        subject: { branches: { mage: [], _: null } },
        _: null,
      },
    }];
    expect(compileOpening(blocks, ['subject', 'mage'], {}, BASE)).toBe('Mage only.');
    expect(compileOpening(blocks, ['subject', 'knight'], {}, BASE)).toBeNull();
    expect(compileOpening(blocks, ['researcher', 'mage'], {}, BASE)).toBeNull();
  });

  test('same block shared across subject/mage and researcher/mage via wildcard on depth-1', () => {
    const blocks = [{
      text: 'Arcane arts.',
      branches: {
        '*': { branches: { mage: [], _: null } },
      },
    }];
    expect(compileOpening(blocks, ['subject', 'mage'], {}, BASE)).toBe('Arcane arts.');
    expect(compileOpening(blocks, ['researcher', 'mage'], {}, BASE)).toBe('Arcane arts.');
    expect(compileOpening(blocks, ['subject', 'knight'], {}, BASE)).toBeNull();
  });
});

describe('compileOpening — variants', () => {
  const BASE = '/';

  test('variant text used when dispatch returns variant name', () => {
    const blocks = [{
      text: 'Base text.',
      variants: { alt: { text: 'Alternate text.' } },
      branches: { subject: [], researcher: 'alt', _: null },
    }];
    expect(compileOpening(blocks, ['subject'], {}, BASE)).toBe('Base text.');
    expect(compileOpening(blocks, ['researcher'], {}, BASE)).toBe('Alternate text.');
  });

  test('missing variant falls back to base text with a warning', () => {
    const blocks = [{
      text: 'Base.',
      variants: {},
      branches: { subject: 'nonexistent' },
    }];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = compileOpening(blocks, ['subject'], {}, BASE);
    expect(result).toBe('Base.');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
    warnSpy.mockRestore();
  });
});

describe('compileOpening — variable expansion', () => {
  const BASE = '/';

  test('{%var} tokens expanded in block text', () => {
    const blocks = [{ text: 'You are a {%role}.' }];
    expect(compileOpening(blocks, ['leaf'], { role: 'knight' }, BASE)).toBe('You are a knight.');
  });

  test('variable expansion applied even when no branches: key', () => {
    const blocks = [{ text: 'Hello, {%name}!' }];
    expect(compileOpening(blocks, [], { name: 'Aria' }, BASE)).toBe('Hello, Aria!');
  });
});

describe('compileOpening — file-path text', () => {
  let tmpDir;
  beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-opening-file-')); });
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('text: pointing to an existing file reads file content', () => {
    const f = path.join(tmpDir, 'para.md');
    fs.writeFileSync(f, 'From file.\n', 'utf8');
    const blocks = [{ text: f }];
    expect(compileOpening(blocks, ['leaf'], {}, tmpDir)).toBe('From file.');
  });

  test('text: that is not a file path used as inline string', () => {
    const blocks = [{ text: 'Just a string.' }];
    expect(compileOpening(blocks, ['leaf'], {}, tmpDir)).toBe('Just a string.');
  });

  test('variable in text: path expanded before file resolution', () => {
    const f = path.join(tmpDir, 'mage.md');
    fs.writeFileSync(f, 'Mage content.', 'utf8');
    const blocks = [{ text: path.join(tmpDir, '{%spec}.md') }];
    expect(compileOpening(blocks, ['leaf'], { spec: 'mage' }, tmpDir)).toBe('Mage content.');
  });
});
