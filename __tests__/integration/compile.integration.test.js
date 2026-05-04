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
