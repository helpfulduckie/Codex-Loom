'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');

const FIXTURE_DIR = path.resolve(__dirname, '../../test');
const FIXTURE_CONFIG = path.join(FIXTURE_DIR, 'compile.yaml');

let tmpDir;
let patchedConfigPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-test-'));

  // Write a patched compile.yaml that redirects output to tmpDir
  // but keeps all other paths pointing at the real test fixtures
  const patchedConfig = [
    `canon: ${FIXTURE_DIR}/canon`,
    `output: ${tmpDir}/output`,
    `templates: ${FIXTURE_DIR}/templates`,
    `cards: ${FIXTURE_DIR}/cards`,
    'protagonist: Aness',
    'branches:',
    '  subject:',
    '    protagonist: Aness',
    '  researcher:',
    '    protagonist: Veyrn',
    '  felix:',
    '    protagonist: Aness',
  ].join('\n');

  patchedConfigPath = path.join(tmpDir, 'compile.yaml');
  fs.writeFileSync(patchedConfigPath, patchedConfig, 'utf8');

  compile(patchedConfigPath);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function branchCardFile(branch, type) {
  return path.join(tmpDir, 'output', 'Branches', branch, 'Story Cards', type, `${type}.md`);
}

describe('output files exist', () => {
  test('subject branch produces Character.md', () => {
    expect(fs.existsSync(branchCardFile('subject', 'Character'))).toBe(true);
  });

  test('researcher branch produces Character.md', () => {
    expect(fs.existsSync(branchCardFile('researcher', 'Character'))).toBe(true);
  });

  test('felix branch produces Character.md', () => {
    expect(fs.existsSync(branchCardFile('felix', 'Character'))).toBe(true);
  });
});

describe('branch filtering', () => {
  test('subject-only variant text appears in subject branch', () => {
    const content = fs.readFileSync(branchCardFile('subject', 'Character'), 'utf8');
    expect(content).toContain('Fused-Squad Subject');
  });

  test('subject-only variant text is absent from researcher branch', () => {
    const content = fs.readFileSync(branchCardFile('researcher', 'Character'), 'utf8');
    expect(content).not.toContain('Fused-Squad Subject');
  });
});

describe('protagonist you-mode', () => {
  test('subject branch (protagonist=Aness): bare $Her~ resolves to "Your" (you-mode)', () => {
    const content = fs.readFileSync(branchCardFile('subject', 'Character'), 'utf8');
    // Aness.Personality.expanded has bare $Her~ — in subject branch protagonist=Aness → you-mode
    expect(content).toContain('Your polite nature');
    expect(content).toContain('you love magic research');
  });

  test('researcher branch (protagonist=Veyrn): bare $Her~ resolves via female pronoun set', () => {
    const content = fs.readFileSync(branchCardFile('researcher', 'Character'), 'utf8');
    // protagonist is Veyrn, not Aness → Aness card uses female pronouns
    expect(content).toContain('Her polite nature');
    expect(content).toContain('Aness Rozen loves magic research');
  });
});

describe('snapshot regression', () => {
  test('subject Character.md matches snapshot', () => {
    const content = fs.readFileSync(branchCardFile('subject', 'Character'), 'utf8');
    expect(content).toMatchSnapshot();
  });
});

// ── overview: key integration ─────────────────────────────────────────────────

describe('overview key in compile.yaml', () => {
  let overviewTmpDir;
  let overviewConfigPath;

  beforeAll(() => {
    overviewTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-overview-int-'));

    const cfg = [
      `canon: ${FIXTURE_DIR}/canon`,
      `output: ${overviewTmpDir}/output`,
      `templates: ${FIXTURE_DIR}/templates`,
      `cards: ${FIXTURE_DIR}/cards`,
      'protagonist: Aness',
      `overview: ${overviewTmpDir}/overview`,
      'branches:',
      '  subject:',
      '    protagonist: Aness',
      '  researcher:',
      '    protagonist: Veyrn',
      '  felix:',
      '    protagonist: Aness',
    ].join('\n');

    overviewConfigPath = path.join(overviewTmpDir, 'compile.yaml');
    fs.writeFileSync(overviewConfigPath, cfg, 'utf8');

    compile(overviewConfigPath);
  });

  afterAll(() => {
    fs.rmSync(overviewTmpDir, { recursive: true, force: true });
  });

  test('overview directory is created', () => {
    expect(fs.existsSync(path.join(overviewTmpDir, 'overview'))).toBe(true);
  });

  test('one .overview.md file is written per branch leaf', () => {
    const files = fs.readdirSync(path.join(overviewTmpDir, 'overview'));
    expect(files.every(f => f.endsWith('.overview.md'))).toBe(true);
    expect(files).toHaveLength(3); // subject, researcher, felix
  });

  test('subject.overview.md contains subject Character card content', () => {
    const content = fs.readFileSync(
      path.join(overviewTmpDir, 'overview', 'subject.overview.md'), 'utf8'
    );
    expect(content).toContain('Fused-Squad Subject');
  });

  test('researcher.overview.md does not contain subject-only content', () => {
    const content = fs.readFileSync(
      path.join(overviewTmpDir, 'overview', 'researcher.overview.md'), 'utf8'
    );
    expect(content).not.toContain('Fused-Squad Subject');
  });

  test('no overview dir created when overview: key absent', () => {
    // The main tmpDir compile (patchedConfig) has no overview: key
    // so no overview dir should appear next to it
    expect(fs.existsSync(path.join(tmpDir, 'overview'))).toBe(false);
  });
});

// ── PE + full-include dedup ───────────────────────────────────────────────────

describe('PE import suppresses Story Card for full-include cards', () => {
  let peTmpDir;

  beforeAll(() => {
    peTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pe-dedup-'));

    const write = (p, content) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
    };

    // Canon: two minimal Character cards
    write(path.join(peTmpDir, 'canon', 'characters.yaml'), [
      '- id: HeroCard',
      '  name: HeroCard',
      '  type: Character',
      '  fields:',
      '    Tagline: The chosen one',
      '- id: SidekickCard',
      '  name: SidekickCard',
      '  type: Character',
      '  fields:',
      '    Tagline: Always there',
    ].join('\n'));

    // Project cards: full-file include (no explicit import)
    write(path.join(peTmpDir, 'cards', 'project.yaml'), [
      '- include: characters.yaml',
    ].join('\n'));

    // Plot Essentials: import only HeroCard
    write(path.join(peTmpDir, 'plot-essentials.yaml'), [
      '- import: HeroCard',
    ].join('\n'));

    // Minimal Character template
    write(path.join(peTmpDir, 'templates', 'Character.template'), [
      '## {$name}',
      '~~~',
      '{$name} - {$fields.Tagline}',
    ].join('\n'));

    // compile.yaml
    write(path.join(peTmpDir, 'compile.yaml'), [
      `canon: ${peTmpDir}/canon`,
      `output: ${peTmpDir}/output`,
      `templates: ${peTmpDir}/templates`,
      `cards: ${peTmpDir}/cards`,
      'branches:',
      '  main: {}',
    ].join('\n'));

    compile(path.join(peTmpDir, 'compile.yaml'));
  });

  afterAll(() => {
    fs.rmSync(peTmpDir, { recursive: true, force: true });
  });

  function peCardFile(branch, type) {
    return path.join(peTmpDir, 'output', 'Branches', branch, 'Story Cards', type, `${type}.md`);
  }

  test('SidekickCard (not in PE) appears in Story Cards', () => {
    const content = fs.readFileSync(peCardFile('main', 'Character'), 'utf8');
    expect(content).toContain('SidekickCard');
  });

  test('HeroCard (in PE, from full include) is suppressed from Story Cards', () => {
    const content = fs.readFileSync(peCardFile('main', 'Character'), 'utf8');
    expect(content).not.toContain('HeroCard');
  });

  test('Plot Essentials.md is written and contains HeroCard', () => {
    const pePath = path.join(peTmpDir, 'output', 'Branches', 'main', 'Components', 'Plot Essentials.md');
    expect(fs.existsSync(pePath)).toBe(true);
    const content = fs.readFileSync(pePath, 'utf8');
    expect(content).toContain('HeroCard');
  });
});
