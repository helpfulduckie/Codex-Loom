'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  getTemplate, writeOpening, resolveOpeningContent, resolveBranchFolderPath,
  buildBranchOutputDir, buildCompileContext, writeOutput,
} = require('../../src/compile');

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

// ── buildCompileContext ───────────────────────────────────────────────────────

const baseCtxConfig = {
  _base: '/project',
  _resolvedComponents: {},
  variables: {},
  components: {},
  branches: null,
};

describe('buildCompileContext', () => {
  test('empty branchPath returns root variables', () => {
    const config = { ...baseCtxConfig, variables: { theme: 'dark' } };
    const { variables } = buildCompileContext(config, []);
    expect(variables).toEqual({ theme: 'dark' });
  });

  test('branch variables are merged over root', () => {
    const config = {
      ...baseCtxConfig,
      variables: { a: '1', b: '2' },
      branches: { main: { variables: { b: 'branch', c: '3' } } },
    };
    const { variables } = buildCompileContext(config, ['main']);
    expect(variables).toEqual({ a: '1', b: 'branch', c: '3' });
  });

  test('two-level nested path merges variables in order', () => {
    const config = {
      ...baseCtxConfig,
      variables: { a: 'root' },
      branches: {
        tier1: {
          variables: { b: 'tier1' },
          branches: { tier2: { variables: { c: 'tier2' } } },
        },
      },
    };
    const { variables } = buildCompileContext(config, ['tier1', 'tier2']);
    expect(variables).toEqual({ a: 'root', b: 'tier1', c: 'tier2' });
  });

  test('unknown branch key stops at root variables', () => {
    const config = {
      ...baseCtxConfig,
      variables: { a: 'root' },
      branches: { main: { variables: { b: 'branch' } } },
    };
    const { variables } = buildCompileContext(config, ['nonexistent']);
    expect(variables).toEqual({ a: 'root' });
  });

  test('branch key lookup is case-insensitive', () => {
    const config = {
      ...baseCtxConfig,
      branches: { Main: { variables: { role: 'knight' } } },
    };
    const { variables } = buildCompileContext(config, ['main']);
    expect(variables.role).toBe('knight');
  });

  test('all componentRefs are null when components block is empty', () => {
    const { componentRefs } = buildCompileContext(baseCtxConfig, []);
    for (const val of Object.values(componentRefs)) {
      expect(val).toBeNull();
    }
  });
});

// ── writeOutput ───────────────────────────────────────────────────────────────

describe('writeOutput', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-writeout-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes cards joined by \\n\\n with trailing newline', () => {
    writeOutput(tmpDir, 'Character', ['Card A', 'Card B']);
    const outPath = path.join(tmpDir, 'Story Cards', 'Character', 'Character.md');
    expect(fs.readFileSync(outPath, 'utf8')).toBe('Card A\n\nCard B\n');
  });

  test('creates Story Cards/{type}/ directory recursively', () => {
    writeOutput(tmpDir, 'Location', ['Card']);
    expect(fs.existsSync(path.join(tmpDir, 'Story Cards', 'Location'))).toBe(true);
  });

  test('returns the output file path', () => {
    const result = writeOutput(tmpDir, 'NPC', ['Card']);
    expect(result).toBe(path.join(tmpDir, 'Story Cards', 'NPC', 'NPC.md'));
  });
});
