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

// ── nested protagonist inheritance ────────────────────────────────────────────

describe('protagonist inherited from parent branch node', () => {
  let nestedTmpDir;

  beforeAll(() => {
    nestedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nested-proto-'));

    const patchedConfig = [
      'structure:',
      '  input:',
      `    cards:`,
      `      - ${FIXTURE_DIR}/cards`,
      `    canon:`,
      `      main: ${FIXTURE_DIR}/canon`,
      `    templates:`,
      `      - ${FIXTURE_DIR}/templates`,
      `  output: ${nestedTmpDir}/output`,
      // protagonist declared on parent node only — leaf nodes have none
      'branches:',
      '  Aness:',
      '    protagonist: Aness',
      '    branches:',
      '      Cult: {}',
      '  Veyrn:',
      '    protagonist: Veyrn',
      '    branches:',
      '      Cult: {}',
    ].join('\n');

    const cfgPath = path.join(nestedTmpDir, 'compile.yaml');
    fs.writeFileSync(cfgPath, patchedConfig, 'utf8');
    compile(cfgPath);
  });

  afterAll(() => {
    fs.rmSync(nestedTmpDir, { recursive: true, force: true });
  });

  function nestedCardFile(tier1, tier2, type) {
    return path.join(
      nestedTmpDir, 'output', 'Branches', tier1, 'Branches', tier2,
      'Story Cards', type, `${type}.md`
    );
  }

  test('Aness/Cult leaf inherits protagonist=Aness: {$Aness} resolves to "you"', () => {
    const content = fs.readFileSync(nestedCardFile('Aness', 'Cult', 'Character'), 'utf8');
    expect(content).toContain('you love magic research');
    expect(content).toContain('your polite nature');
  });

  test('Veyrn/Cult leaf with non-matching protagonist: {$Aness} resolves to display name', () => {
    const content = fs.readFileSync(nestedCardFile('Veyrn', 'Cult', 'Character'), 'utf8');
    expect(content).toContain('Aness loves magic research');
    expect(content).toContain('her polite nature');
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

// ── cross-card render function refs in body fields ────────────────────────────

describe('cross-card refs inside body field render functions', () => {
  let xrefTmpDir;

  beforeAll(() => {
    xrefTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-xref-int-'));
    fs.mkdirSync(path.join(xrefTmpDir, 'cards'), { recursive: true });
    fs.mkdirSync(path.join(xrefTmpDir, 'templates'), { recursive: true });

    // Cards: Alice and Carol cross-ref Bishop's hair (plain token, resolved by applyCrossCardRefs).
    // Bishop's familyMembers use join() on Alice/Carol's physicalTraits (new cross-card render fn).
    // Store's employees use join() on Bishop's familyMembers (chained, order-dependent without multi-pass).
    // Cards are deliberately ordered Store → Bishop → Carol → Alice (deepest-dependent first)
    // to exercise the multi-pass convergence loop.
    fs.writeFileSync(path.join(xrefTmpDir, 'cards', 'cards.yaml'), [
      '- id: Store',
      '  name: Store',
      '  aid:',
      '    type: Item',
      '    title: Store',
      '  render:',
      '    template: Item',
      '  body:',
      "    employees: \"{join('; ', $Bishop.body.familyMembers)}\"",
      '',
      '- id: Bishop',
      '  name: Bishop',
      '  aid:',
      '    type: Item',
      '    title: Bishop',
      '  render:',
      '    template: Item',
      '  body:',
      '    physicalTraits:',
      '      hair: blond',
      '    familyMembers:',
      "      - 'Alice ({join(\"; \", $Alice.body.physicalTraits)})'",
      "      - 'Carol ({join(\"; \", $Carol.body.physicalTraits)})'",
      '',
      '- id: Carol',
      '  name: Carol',
      '  aid:',
      '    type: Item',
      '    title: Carol',
      '  render:',
      '    template: Item',
      '  body:',
      '    physicalTraits:',
      "      hair: '{$Bishop.body.physicalTraits.hair}'",
      '      eyes: green',
      '',
      '- id: Alice',
      '  name: Alice',
      '  aid:',
      '    type: Item',
      '    title: Alice',
      '  render:',
      '    template: Item',
      '  body:',
      '    physicalTraits:',
      "      hair: '{$Bishop.body.physicalTraits.hair}'",
      '      eyes: blue',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(xrefTmpDir, 'templates', 'Item.template'), [
      '## {$aid.title}',
      '~~~',
      '{$body.employees}',
      '{join("; ", $body.familyMembers)}',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(xrefTmpDir, 'compile.yaml'), [
      'structure:',
      '  input:',
      `    cards: [${xrefTmpDir}/cards]`,
      `    templates: [${xrefTmpDir}/templates]`,
      `  output: ${xrefTmpDir}/output`,
      'branches:',
      '  main: {}',
    ].join('\n'), 'utf8');

    compile(path.join(xrefTmpDir, 'compile.yaml'));
  });

  afterAll(() => {
    fs.rmSync(xrefTmpDir, { recursive: true, force: true });
  });

  function xrefCard(name) {
    return fs.readFileSync(
      path.join(xrefTmpDir, 'output', 'Branches', 'main', 'Story Cards', 'Item', 'Item.md'), 'utf8'
    );
  }

  test('Bishop familyMembers: join() on cross-card mapping resolves hair+eyes', () => {
    const content = xrefCard('Item');
    expect(content).toContain('Alice (blond; blue)');
    expect(content).toContain('Carol (blond; green)');
  });

  test('Store employees: chained cross-card join() resolves fully despite deepest-first ordering', () => {
    const content = xrefCard('Item');
    expect(content).toContain('Alice (blond; blue); Carol (blond; green)');
  });

  test('Alice physicalTraits.hair: plain cross-card token resolved to Bishop hair', () => {
    const content = xrefCard('Item');
    // Carol's physicalTraits are referenced in Bishop's familyMembers and appear resolved
    expect(content).toContain('Carol (blond; green)');
  });
});

// ── YAML block-opening (opening.yaml) integration ─────────────────────────────

describe('YAML block opening (opening.yaml)', () => {
  let blkTmpDir;

  beforeAll(() => {
    blkTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-blk-opening-'));

    fs.mkdirSync(path.join(blkTmpDir, 'cards'), { recursive: true });
    fs.mkdirSync(path.join(blkTmpDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(blkTmpDir, 'paragraphs'), { recursive: true });

    fs.writeFileSync(path.join(blkTmpDir, 'cards', 'cards.yaml'), [
      '- id: Widget',
      '  name: Widget',
      '  aid: { type: Item, title: Widget }',
      '  render: { template: Item }',
      '  body: { Desc: a widget }',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(blkTmpDir, 'templates', 'Item.template'), [
      '## {$aid.title}',
      '~~~',
      '{$body.Desc}',
    ].join('\n'), 'utf8');

    // A paragraph stored as an external file
    fs.writeFileSync(
      path.join(blkTmpDir, 'paragraphs', 'knight-oath.md'),
      'You have sworn an oath to protect the realm.',
      'utf8'
    );

    // The opening.yaml block sequence
    // Note: _: ~ is the fallback key for "exclude unmatched branches"
    fs.writeFileSync(path.join(blkTmpDir, 'opening.yaml'), [
      // Universal block — no branches: key
      '- text: "A world of magic and intrigue awaits."',
      '',
      // Role blocks — [] = include with no variant; _: ~ = exclude unmatched branches
      '- text: "You serve the empire as a subject."',
      '  branches:',
      '    subject: []',
      '    _: ~',
      '',
      '- text: "You investigate ancient mysteries as a researcher."',
      '  branches:',
      '    researcher: []',
      '    _: ~',
      '',
      // Specialisation block with a variant — shared across subject/mage and researcher/mage
      '- text: "You have mastered the arcane arts."',
      '  variants:',
      '    researcher-mage:',
      '      text: "You have mastered the arcane arts, informed by archival research."',
      '  branches:',
      '    subject:',
      '      branches:',
      '        mage: []',
      '        _: ~',
      '    researcher:',
      '      branches:',
      '        mage: researcher-mage',
      '        _: ~',
      '    _: ~',
      '',
      // File-path text block — knight leaves only
      `- text: ./paragraphs/knight-oath.md`,
      '  branches:',
      '    subject:',
      '      branches:',
      '        knight: []',
      '        _: ~',
      '    researcher:',
      '      branches:',
      '        knight: []',
      '        _: ~',
      '    _: ~',
      '',
      // Variable expansion block
      '- text: "Your role is {%role}."',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(blkTmpDir, 'compile.yaml'), [
      'structure:',
      '  input:',
      `    cards: [${blkTmpDir}/cards]`,
      `    templates: [${blkTmpDir}/templates]`,
      `  output: ${blkTmpDir}/output`,
      'components:',
      `  opening: ${blkTmpDir}/opening.yaml`,
      'branches:',
      '  subject:',
      '    variables:',
      '      role: subject',
      '    branches:',
      '      mage: {}',
      '      knight: {}',
      '  researcher:',
      '    variables:',
      '      role: researcher',
      '    branches:',
      '      mage: {}',
      '      knight: {}',
    ].join('\n'), 'utf8');

    compile(path.join(blkTmpDir, 'compile.yaml'));
  });

  afterAll(() => {
    fs.rmSync(blkTmpDir, { recursive: true, force: true });
  });

  function opening(branchPath) {
    const segments = branchPath.split('/');
    let p = path.join(blkTmpDir, 'output', 'Branches');
    for (const s of segments) p = path.join(p, s, segments.indexOf(s) < segments.length - 1 ? 'Branches' : '');
    // rebuild cleanly
    p = path.join(blkTmpDir, 'output');
    for (const s of segments) p = path.join(p, 'Branches', s);
    return fs.readFileSync(path.join(p, 'Components', 'Opening.md'), 'utf8');
  }

  test('universal block (no branches:) appears in all leaves', () => {
    expect(opening('subject/mage')).toContain('A world of magic and intrigue awaits.');
    expect(opening('subject/knight')).toContain('A world of magic and intrigue awaits.');
    expect(opening('researcher/mage')).toContain('A world of magic and intrigue awaits.');
    expect(opening('researcher/knight')).toContain('A world of magic and intrigue awaits.');
  });

  test('role block included only for its top-level branch', () => {
    expect(opening('subject/mage')).toContain('You serve the empire as a subject.');
    expect(opening('subject/knight')).toContain('You serve the empire as a subject.');
    expect(opening('researcher/mage')).not.toContain('You serve the empire as a subject.');
    expect(opening('researcher/mage')).toContain('You investigate ancient mysteries as a researcher.');
    expect(opening('subject/mage')).not.toContain('You investigate ancient mysteries as a researcher.');
  });

  test('mage block shared across subject/mage and researcher/mage, absent from knight leaves', () => {
    expect(opening('subject/mage')).toContain('You have mastered the arcane arts.');
    expect(opening('researcher/mage')).toContain('You have mastered the arcane arts');
    expect(opening('subject/knight')).not.toContain('You have mastered the arcane arts');
    expect(opening('researcher/knight')).not.toContain('You have mastered the arcane arts');
  });

  test('variant text applied for researcher/mage', () => {
    expect(opening('researcher/mage')).toContain('informed by archival research');
    expect(opening('subject/mage')).not.toContain('informed by archival research');
  });

  test('file-path text block resolved for knight leaves', () => {
    expect(opening('subject/knight')).toContain('You have sworn an oath to protect the realm.');
    expect(opening('researcher/knight')).toContain('You have sworn an oath to protect the realm.');
    expect(opening('subject/mage')).not.toContain('You have sworn an oath');
  });

  test('variable expansion in block text', () => {
    expect(opening('subject/mage')).toContain('Your role is subject.');
    expect(opening('researcher/knight')).toContain('Your role is researcher.');
  });

  test('paragraphs joined with double newline', () => {
    const content = opening('subject/mage');
    expect(content).toContain('awaits.\n\nYou serve');
  });

  test('existing .md opening still works (regression)', () => {
    // Use a separate minimal project that points opening: to a .md file
    const mdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-blk-md-'));
    try {
      fs.mkdirSync(path.join(mdDir, 'cards'), { recursive: true });
      fs.mkdirSync(path.join(mdDir, 'templates'), { recursive: true });
      fs.writeFileSync(path.join(mdDir, 'cards', 'c.yaml'), [
        '- id: W',
        '  name: W',
        '  aid: { type: Item, title: W }',
        '  render: { template: Item }',
        '  body: { Desc: w }',
      ].join('\n'), 'utf8');
      fs.writeFileSync(path.join(mdDir, 'templates', 'Item.template'), '## {$aid.title}\n~~~\n{$body.Desc}', 'utf8');
      fs.writeFileSync(path.join(mdDir, 'opening.md'), 'Legacy inline opening.', 'utf8');
      fs.writeFileSync(path.join(mdDir, 'compile.yaml'), [
        'structure:',
        `  input: { cards: [${mdDir}/cards], templates: [${mdDir}/templates] }`,
        `  output: ${mdDir}/output`,
        'components:',
        `  opening: ${mdDir}/opening.md`,
        'branches:',
        '  only: {}',
      ].join('\n'), 'utf8');
      compile(path.join(mdDir, 'compile.yaml'));
      const p = path.join(mdDir, 'output', 'Branches', 'only', 'Components', 'Opening.md');
      expect(fs.readFileSync(p, 'utf8').trim()).toBe('Legacy inline opening.');
    } finally {
      fs.rmSync(mdDir, { recursive: true, force: true });
    }
  });
});
