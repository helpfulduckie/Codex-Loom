'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');

const FIXTURE_DIR = path.resolve(__dirname, '../../test');

let tmpDir;
let patchedConfigPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-test-'));

  // Write a patched compile.yaml (v3 structure: format) that redirects output
  // to a temp dir but uses the real test fixtures for everything else.
  const patchedConfig = [
    'structure:',
    `  input:`,
    `    cards:`,
    `      - ${FIXTURE_DIR}/cards`,
    `    canon:`,
    `      main: ${FIXTURE_DIR}/canon`,
    `    templates:`,
    `      - ${FIXTURE_DIR}/templates`,
    `  output: ${tmpDir}/output`,
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
  test('subject branch (protagonist=Aness): {$Aness.her~} resolves to "your" (you-mode)', () => {
    const content = fs.readFileSync(branchCardFile('subject', 'Character'), 'utf8');
    expect(content).toContain('your polite nature');
    expect(content).toContain('you love magic research');
  });

  test('researcher branch (protagonist=Veyrn): {$Aness.her~} resolves via female pronoun set', () => {
    const content = fs.readFileSync(branchCardFile('researcher', 'Character'), 'utf8');
    expect(content).toContain('her polite nature');
    expect(content).toContain('Aness loves magic research');
  });
});

describe('snapshot regression', () => {
  test('subject Character.md matches snapshot', () => {
    const content = fs.readFileSync(branchCardFile('subject', 'Character'), 'utf8');
    expect(content).toMatchSnapshot();
  });
});

// ── overview: key integration ─────────────────────────────────────────────────

describe('overview generated automatically by compile', () => {
  // compile() always writes Overview/ inside the output dir — use the
  // outer tmpDir/output that was already compiled in beforeAll.
  const overviewDir = () => path.join(tmpDir, 'output', 'Overview');

  test('Overview/ directory is created inside output', () => {
    expect(fs.existsSync(overviewDir())).toBe(true);
  });

  test('one .overview.md file is written per branch leaf', () => {
    const files = fs.readdirSync(overviewDir());
    expect(files.every(f => f.endsWith('.overview.md'))).toBe(true);
    expect(files).toHaveLength(3); // subject, researcher, felix
  });

  test('subject.overview.md contains subject Character card content', () => {
    const content = fs.readFileSync(
      path.join(overviewDir(), 'subject.overview.md'), 'utf8'
    );
    expect(content).toContain('Fused-Squad Subject');
  });

  test('researcher.overview.md does not contain subject-only content', () => {
    const content = fs.readFileSync(
      path.join(overviewDir(), 'researcher.overview.md'), 'utf8'
    );
    expect(content).not.toContain('Fused-Squad Subject');
  });
});

// ── Opening.md integration ────────────────────────────────────────────────────

describe('Opening.md generation', () => {
  let openingTmpDir;

  beforeAll(() => {
    openingTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-opening-int-'));

    // Minimal v3-format card + template so compile has something to do
    fs.mkdirSync(path.join(openingTmpDir, 'cards'), { recursive: true });
    fs.mkdirSync(path.join(openingTmpDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(openingTmpDir, 'openings'), { recursive: true });

    fs.writeFileSync(path.join(openingTmpDir, 'cards', 'cards.yaml'), [
      '- id: Widget',
      '  name: Widget',
      '  aid:',
      '    type: Item',
      '    title: Widget',
      '  render:',
      '    template: Item',
      '  body:',
      '    Desc: a widget',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(openingTmpDir, 'templates', 'Item.template'), [
      '## {$aid.title}',
      '~~~',
      '{$body.Desc}',
    ].join('\n'), 'utf8');

    // File-based opening content
    fs.writeFileSync(path.join(openingTmpDir, 'openings', 'b-opening.md'), 'Leaf B from file\n', 'utf8');

    // v3 format compile.yaml — opening under components: at root and branch levels
    // opening: inherits to leaves; openingChoice: writes to branch node directly
    fs.writeFileSync(path.join(openingTmpDir, 'compile.yaml'), [
      'structure:',
      '  input:',
      `    cards: [${openingTmpDir}/cards]`,
      `    templates: [${openingTmpDir}/templates]`,
      `  output: ${openingTmpDir}/output`,
      'components:',
      '  opening: "Root question"',
      'branches:',
      '  A:',
      '    opening: "Leaf A inline"',
      '  B:',
      `    opening: ${openingTmpDir}/openings/b-opening.md`,
      '  nested:',
      '    openingChoice: "Branch question"',
      '    branches:',
      '      X: {}',
      '      Y: {}',
    ].join('\n'), 'utf8');

    compile(path.join(openingTmpDir, 'compile.yaml'));
  });

  afterAll(() => {
    fs.rmSync(openingTmpDir, { recursive: true, force: true });
  });

  test('leaf A inline opening written to Branches/A/Components/Opening.md', () => {
    const p = path.join(openingTmpDir, 'output', 'Branches', 'A', 'Components', 'Opening.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('Leaf A inline\n');
  });

  test('leaf B file opening reads file content', () => {
    const p = path.join(openingTmpDir, 'output', 'Branches', 'B', 'Components', 'Opening.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('Leaf B from file\n');
  });

  test('root opening inherited by leaves X and Y (via nested that has no own opening)', () => {
    const x = path.join(openingTmpDir, 'output', 'Branches', 'nested', 'Branches', 'X', 'Components', 'Opening.md');
    const y = path.join(openingTmpDir, 'output', 'Branches', 'nested', 'Branches', 'Y', 'Components', 'Opening.md');
    expect(fs.existsSync(x)).toBe(true);
    expect(fs.readFileSync(x, 'utf8')).toBe('Root question\n');
    expect(fs.existsSync(y)).toBe(true);
    expect(fs.readFileSync(y, 'utf8')).toBe('Root question\n');
  });

  test('branch-node openingChoice written to nested/Components/Opening.md', () => {
    const p = path.join(openingTmpDir, 'output', 'Branches', 'nested', 'Components', 'Opening.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('Branch question\n');
  });

  test('non-leaf branch node with only openingChoice does not get a leaf Opening.md at its own level', () => {
    // nested itself is not a leaf — its Opening.md is for openingChoice
    // but the leaves X and Y have the inherited root opening
    const nested = path.join(openingTmpDir, 'output', 'Branches', 'nested', 'Components', 'Opening.md');
    const x = path.join(openingTmpDir, 'output', 'Branches', 'nested', 'Branches', 'X', 'Components', 'Opening.md');
    expect(fs.readFileSync(nested, 'utf8')).toBe('Branch question\n'); // openingChoice
    expect(fs.readFileSync(x, 'utf8')).toBe('Root question\n');      // inherited root opening
  });
});

// ── openingChoice {@Key} token resolution ──────────────────────────────────────

describe('openingChoice {@Key} resolution', () => {
  let atKeyTmpDir;

  beforeAll(() => {
    atKeyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atkey-int-'));

    fs.mkdirSync(path.join(atKeyTmpDir, 'cards'), { recursive: true });
    fs.mkdirSync(path.join(atKeyTmpDir, 'templates'), { recursive: true });

    fs.writeFileSync(path.join(atKeyTmpDir, 'cards', 'cards.yaml'), [
      '- id: Widget',
      '  name: Widget',
      '  aid:',
      '    type: Item',
      '    title: Widget',
      '  render:',
      '    template: Item',
      '  body:',
      '    Desc: a widget',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(atKeyTmpDir, 'templates', 'Item.template'), [
      '## {$aid.title}',
      '~~~',
      '{$body.Desc}',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(atKeyTmpDir, 'compile.yaml'), [
      'structure:',
      '  input:',
      `    cards: [${atKeyTmpDir}/cards]`,
      `    templates: [${atKeyTmpDir}/templates]`,
      '    components:',
      '      openingChoice:',
      '        roleChoice: Are you the mage or the employer?',
      '        mageChoice: Who is your mage?',
      '        employerChoice: Who is your employer?',
      `  output: ${atKeyTmpDir}/output`,
      'components:',
      "  openingChoice: '{@roleChoice}'",
      'branches:',
      '  employer:',
      '    title: Employer',
      '    components:',
      "      openingChoice: '{@mageChoice}'",
      '    branches:',
      '      alice: {}',
      '  mage:',
      '    title: Personal Mage',
      '    components:',
      "      openingChoice: '{@employerChoice}'",
      '    branches:',
      '      bob: {}',
    ].join('\n'), 'utf8');

    compile(path.join(atKeyTmpDir, 'compile.yaml'));
  });

  afterAll(() => {
    fs.rmSync(atKeyTmpDir, { recursive: true, force: true });
  });

  test('root openingChoice {@roleChoice} resolves to literal string', () => {
    const p = path.join(atKeyTmpDir, 'output', 'Components', 'Opening.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('Are you the mage or the employer?\n');
  });

  test('employer branch openingChoice {@mageChoice} resolves to literal string', () => {
    const p = path.join(atKeyTmpDir, 'output', 'Branches', 'Employer', 'Components', 'Opening.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('Who is your mage?\n');
  });

  test('mage branch openingChoice {@employerChoice} resolves to literal string', () => {
    const p = path.join(atKeyTmpDir, 'output', 'Branches', 'Personal Mage', 'Components', 'Opening.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('Who is your employer?\n');
  });

  test('leaf nodes do not get openingChoice Opening.md', () => {
    const alice = path.join(atKeyTmpDir, 'output', 'Branches', 'Employer', 'Branches', 'alice', 'Components', 'Opening.md');
    expect(fs.existsSync(alice)).toBe(false);
  });
});
