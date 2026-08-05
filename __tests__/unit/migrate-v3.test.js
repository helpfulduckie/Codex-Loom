'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  migrateConfigFile, migrateProject, collectComponentAliases, collectCanonNames,
  rewriteAtTokens,
} = require('../../src/migrate/v3');

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mig-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeConfig(yaml) {
  const p = path.join(tmpDir, 'compile.yaml');
  fs.writeFileSync(p, yaml, 'utf8');
  return p;
}

const V3 = [
  '# A comment that must survive',
  'structure:',
  '  input:',
  '    cards:',
  '      - ./Codex',
  '    canon:',
  '      characters: ./canon/Characters',
  '    components:',
  '      plotEssential:',
  '        pe: ./components/pe.yaml',
  '      openingChoice:',
  '        ask: Which path?',
  '      scripts:',
  '        bundle: ./scripts/lib',
  '  output: ../out',
  '  overview: ./Review',
  'components:',
  "  plotEssential: '{@pe}'",
  "  openingChoice: '{@ask}'",
  "  scripts: '{@bundle}'",
  '',
].join('\n');

describe('the §14.2 config transformations', () => {
  let migrated;
  beforeEach(() => { migrated = migrateConfigFile(writeConfig(V3)).output; });

  test('adds version: 4 — its absence is what identifies a v3 project', () => {
    expect(migrated).toMatch(/^version: 4$/m);
  });

  test('renames structure.input.cards to items', () => {
    expect(migrated).toMatch(/^ {4}items:$/m);
    expect(migrated).not.toMatch(/^ {4}cards:$/m);
  });

  test('renames structure.overview to reports', () => {
    expect(migrated).toMatch(/^ {2}reports: \.\/Review$/m);
    expect(migrated).not.toContain('overview:');
  });

  test('deletes structure.input.components entirely', () => {
    expect(migrated).not.toMatch(/^ {4}components:$/m);
  });

  test('inlines a {@} component alias to the value it was declared as', () => {
    expect(migrated).toContain('plotEssential: ./components/pe.yaml');
    expect(migrated).not.toContain('{@pe}');
  });

  test('inlines a literal alias, not just a path', () => {
    expect(migrated).toContain('branchFraming: Which path?');
  });

  test('renames components.openingChoice to branchFraming', () => {
    expect(migrated).not.toContain('openingChoice');
  });

  test('moves components.scripts to top level', () => {
    expect(migrated).toMatch(/^scripts: \.\/scripts\/lib$/m);
  });

  test('preserves comments — a migrator that strips them is one you run once', () => {
    expect(migrated).toContain('# A comment that must survive');
  });

  test('leaves no {@} tokens behind', () => {
    expect(migrated).not.toContain('{@');
  });

  test('reports every transformation it applied', () => {
    const { changes } = migrateConfigFile(writeConfig(V3), { dryRun: true });
    expect(changes.join(' ')).toContain('cards → items');
    expect(changes.join(' ')).toContain('version: 4');
  });

  test('dryRun leaves the file untouched', () => {
    const p = writeConfig(V3);
    migrateConfigFile(p, { dryRun: true });
    expect(fs.readFileSync(p, 'utf8')).toBe(V3);
  });
});

describe('canon names become {%} variables', () => {
  test('a canon reference changes sigil rather than being inlined', () => {
    const migrated = migrateConfigFile(writeConfig([
      'structure:',
      '  input:',
      '    canon:',
      '      characters: ./canon/Characters',
      '  output: ./out',
      'components:',
      "  plotEssential: '{@characters}/pe.yaml'",
      '',
    ].join('\n'))).output;
    expect(migrated).toContain('{%characters}/pe.yaml');
  });

  test('collectCanonNames reads the declared names', () => {
    expect([...collectCanonNames({ structure: { input: { canon: { a: 1, b: 2 } } } })])
      .toEqual(['a', 'b']);
  });

  test('collectComponentAliases flattens every type into one map', () => {
    const aliases = collectComponentAliases({
      structure: { input: { components: { plotEssential: { pe: 'x' }, scripts: { s: 'y' } } } },
    });
    expect(aliases.get('pe')).toBe('x');
    expect(aliases.get('s')).toBe('y');
  });

  test('an absent components block yields no aliases', () => {
    expect(collectComponentAliases({}).size).toBe(0);
  });
});

describe('rewriteAtTokens', () => {
  const aliases = new Map([['pe', './pe.yaml']]);
  const canon = new Set(['characters']);

  test('canon name → {%}', () => {
    expect(rewriteAtTokens('{@characters}/A.yaml', aliases, canon, [])).toBe('{%characters}/A.yaml');
  });

  test('component alias → its value', () => {
    expect(rewriteAtTokens('{@pe}', aliases, canon, [])).toBe('./pe.yaml');
  });

  test('matches an alias case-insensitively', () => {
    expect(rewriteAtTokens('{@PE}', aliases, canon, [])).toBe('./pe.yaml');
  });

  test('an unknown name is left alone and reported rather than guessed at', () => {
    const unresolved = [];
    expect(rewriteAtTokens('{@nope}', aliases, canon, unresolved)).toBe('{@nope}');
    expect(unresolved).toEqual(['nope']);
  });

  test('rewrites several tokens in one string', () => {
    expect(rewriteAtTokens('{@characters}/{@pe}', aliases, canon, [])).toBe('{%characters}/./pe.yaml');
  });

  test('leaves text with no tokens untouched', () => {
    expect(rewriteAtTokens('plain', aliases, canon, [])).toBe('plain');
  });

  test.each([null, undefined, 42])('returns %p unchanged', (value) => {
    expect(rewriteAtTokens(value, aliases, canon, [])).toBe(value);
  });
});

describe('migrateProject — the whole tree, not just compile.yaml', () => {
  test('rewrites {@} in item and component files beside the config', () => {
    // `include: '{@characters}/You.yaml'` in an item file is the common case; migrating
    // only compile.yaml would leave the project half-converted.
    const cfg = writeConfig([
      'structure:',
      '  input:',
      '    canon:',
      '      characters: ./canon/Characters',
      '    components:',
      '      description:',
      '        body: ./components/body.md',
      '  output: ./out',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(tmpDir, 'Codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'Codex', 'items.yaml'), "- include: '{@characters}/You.yaml'\n", 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'desc.yaml'), "body: '{@body}'\n", 'utf8');

    const report = migrateProject(cfg);

    expect(fs.readFileSync(path.join(tmpDir, 'Codex', 'items.yaml'), 'utf8'))
      .toContain('{%characters}/You.yaml');
    expect(fs.readFileSync(path.join(tmpDir, 'desc.yaml'), 'utf8'))
      .toContain('./components/body.md');
    expect(report.filesTouched).toHaveLength(2);
    expect(report.unresolved).toEqual([]);
  });

  test('reports an unresolved reference rather than silently leaving it', () => {
    const cfg = writeConfig('structure:\n  output: ./out\n');
    fs.writeFileSync(path.join(tmpDir, 'x.yaml'), "a: '{@mystery}'\n", 'utf8');
    const report = migrateProject(cfg);
    expect(report.unresolved.map((u) => u.name)).toContain('mystery');
  });
});
