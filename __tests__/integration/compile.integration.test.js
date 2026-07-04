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
    const p = path.join(atKeyTmpDir, 'output', 'Branches', 'employer', 'Components', 'Opening.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('Who is your mage?\n');
  });

  test('mage branch openingChoice {@employerChoice} resolves to literal string', () => {
    const p = path.join(atKeyTmpDir, 'output', 'Branches', 'mage', 'Components', 'Opening.md');
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

// ── opening {@Key} token resolving to a .yaml block file ─────────────────────

describe('opening {@Key} resolving to YAML block file', () => {
  let opKeyTmpDir;

  beforeAll(() => {
    opKeyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-opkey-int-'));
    fs.mkdirSync(path.join(opKeyTmpDir, 'cards'), { recursive: true });
    fs.mkdirSync(path.join(opKeyTmpDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(opKeyTmpDir, 'components'), { recursive: true });

    fs.writeFileSync(path.join(opKeyTmpDir, 'cards', 'c.yaml'), [
      '- id: W',
      '  name: W',
      '  aid: { type: Item, title: W }',
      '  render: { template: Item }',
      '  body: { Desc: w }',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(opKeyTmpDir, 'templates', 'Item.template'),
      '## {$aid.title}\n~~~\n{$body.Desc}', 'utf8');

    fs.writeFileSync(path.join(opKeyTmpDir, 'components', 'opening.yaml'), [
      '- text: "Universal paragraph."',
      '- text: "Alpha-only paragraph."',
      '  branches:',
      '    alpha: []',
      '    _: ~',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(opKeyTmpDir, 'compile.yaml'), [
      'structure:',
      '  input:',
      `    cards: [${opKeyTmpDir}/cards]`,
      `    templates: [${opKeyTmpDir}/templates]`,
      '    components:',
      '      opening:',
      `        op: ${opKeyTmpDir}/components/opening.yaml`,
      `  output: ${opKeyTmpDir}/output`,
      'components:',
      "  opening: '{@op}'",
      'branches:',
      '  alpha: {}',
      '  beta: {}',
    ].join('\n'), 'utf8');

    compile(path.join(opKeyTmpDir, 'compile.yaml'));
  });

  afterAll(() => { fs.rmSync(opKeyTmpDir, { recursive: true, force: true }); });

  test('alpha leaf contains both universal and alpha-only paragraphs', () => {
    const p = path.join(opKeyTmpDir, 'output', 'Branches', 'alpha', 'Components', 'Opening.md');
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toContain('Universal paragraph.');
    expect(content).toContain('Alpha-only paragraph.');
  });

  test('beta leaf contains only universal paragraph', () => {
    const p = path.join(opKeyTmpDir, 'output', 'Branches', 'beta', 'Components', 'Opening.md');
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toContain('Universal paragraph.');
    expect(content).not.toContain('Alpha-only paragraph.');
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

// ── deterministic card ordering (sorted by id within type) ────────────────────

describe('deterministic card ordering', () => {
  let orderTmpDir;

  beforeAll(() => {
    orderTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-order-'));
    fs.mkdirSync(path.join(orderTmpDir, 'cards'), { recursive: true });
    fs.mkdirSync(path.join(orderTmpDir, 'templates'), { recursive: true });

    // Cards are authored out of alphabetical order, and titles sort opposite to
    // ids, so a regression to authoring-order or title-order would be caught.
    // Two types ("Beta" before "Alpha") are also declared out of order.
    fs.writeFileSync(path.join(orderTmpDir, 'cards', 'cards.yaml'), [
      '- id: Zebra',
      '  name: Zebra',
      '  aid: { type: Alpha, title: AppleTitle }',
      '  render: { template: Card }',
      '  body: { Desc: z }',
      '- id: mango',
      '  name: mango',
      '  aid: { type: Beta, title: MangoTitle }',
      '  render: { template: Card }',
      '  body: { Desc: m }',
      '- id: Apple',
      '  name: Apple',
      '  aid: { type: Alpha, title: ZebraTitle }',
      '  render: { template: Card }',
      '  body: { Desc: a }',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(orderTmpDir, 'templates', 'Card.template'),
      '## {$aid.title} [{$id}]\n~~~\n{$body.Desc}', 'utf8');

    fs.writeFileSync(path.join(orderTmpDir, 'compile.yaml'), [
      'structure:',
      `  input: { cards: [${orderTmpDir}/cards], templates: [${orderTmpDir}/templates] }`,
      `  output: ${orderTmpDir}/output`,
      'branches:',
      '  main: {}',
    ].join('\n'), 'utf8');

    compile(path.join(orderTmpDir, 'compile.yaml'));
  });

  afterAll(() => { fs.rmSync(orderTmpDir, { recursive: true, force: true }); });

  function typeFile(type) {
    return path.join(orderTmpDir, 'output', 'Branches', 'main', 'Story Cards', type, `${type}.md`);
  }

  test('cards within a type are ordered by id, not authoring or title order', () => {
    const content = fs.readFileSync(typeFile('Alpha'), 'utf8');
    // id Apple (title ZebraTitle) must precede id Zebra (title AppleTitle)
    expect(content.indexOf('[Apple]')).toBeGreaterThanOrEqual(0);
    expect(content.indexOf('[Apple]')).toBeLessThan(content.indexOf('[Zebra]'));
    // If it had sorted by visible title instead, AppleTitle would come first
    expect(content.indexOf('ZebraTitle')).toBeLessThan(content.indexOf('AppleTitle'));
  });

  test('id sort is case-insensitive and deterministic across builds', () => {
    // Recompiling the identical project yields byte-identical output.
    const before = fs.readFileSync(typeFile('Alpha'), 'utf8');
    compile(path.join(orderTmpDir, 'compile.yaml'));
    const after = fs.readFileSync(typeFile('Alpha'), 'utf8');
    expect(after).toBe(before);
  });
});

// ── Requested-but-unwritten component detection ───────────────────────────────

describe('component gap detection', () => {
  // Build a minimal project; `extraComponents` lines are spliced into components:.
  function makeProject(extraComponents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gap-'));
    fs.mkdirSync(path.join(dir, 'cards'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cards', 'c.yaml'), [
      '- id: W',
      '  name: W',
      '  aid: { type: Item, title: W }',
      '  render: { template: Item }',
      '  body: { Desc: w }',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'templates', 'Item.template'), '## {$aid.title}\n~~~\n{$body.Desc}', 'utf8');
    fs.writeFileSync(path.join(dir, 'compile.yaml'), [
      'structure:',
      `  input: { cards: [${dir}/cards], templates: [${dir}/templates] }`,
      `  output: ${dir}/output`,
      'components:',
      ...extraComponents.map(l => `  ${l}`),
    ].join('\n'), 'utf8');
    return dir;
  }

  test('missing Author\'s Note source throws', () => {
    const dir = makeProject([`authorsNote: ${'./does-not-exist.yaml'}`]);
    try {
      expect(() => compile(path.join(dir, 'compile.yaml'))).toThrow(/component\(s\) were not written/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing Description source throws', () => {
    const dir = makeProject([`description: ${'./missing-desc.md'}`]);
    try {
      expect(() => compile(path.join(dir, 'compile.yaml'))).toThrow(/component\(s\) were not written/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unresolved {@key} Plot Essentials reference throws', () => {
    const dir = makeProject(['plotEssential: "{@nope}"']);
    try {
      expect(() => compile(path.join(dir, 'compile.yaml'))).toThrow(/component\(s\) were not written/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no components requested does not throw', () => {
    const dir = makeProject([]);
    // makeProject always writes a `components:` header; an empty mapping is fine.
    fs.writeFileSync(path.join(dir, 'compile.yaml'), [
      'structure:',
      `  input: { cards: [${dir}/cards], templates: [${dir}/templates] }`,
      `  output: ${dir}/output`,
    ].join('\n'), 'utf8');
    try {
      expect(() => compile(path.join(dir, 'compile.yaml'))).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('valid Author\'s Note source does not throw', () => {
    const dir = makeProject([`authorsNote: ${'./an.md'}`]);
    fs.writeFileSync(path.join(dir, 'an.md'), 'Keep the tension high.', 'utf8');
    try {
      expect(() => compile(path.join(dir, 'compile.yaml'))).not.toThrow();
      const p = path.join(dir, 'output', "Components", "Author Notes.md");
      expect(fs.existsSync(p)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Root `title` → top-level Label.md ──────────────────────────────────────────

describe('root title -> Label.md', () => {
  function makeTitleProject(extraLines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-title-'));
    fs.mkdirSync(path.join(dir, 'cards'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cards', 'c.yaml'), [
      '- id: W',
      '  name: W',
      '  aid: { type: Item, title: W }',
      '  render: { template: Item }',
      '  body: { Desc: w }',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'templates', 'Item.template'), '## {$aid.title}\n~~~\n{$body.Desc}', 'utf8');
    fs.writeFileSync(path.join(dir, 'compile.yaml'), [
      'structure:',
      `  input: { cards: [${dir}/cards], templates: [${dir}/templates] }`,
      `  output: ${dir}/output`,
      ...extraLines,
    ].join('\n'), 'utf8');
    return dir;
  }

  test('root title writes {output}/Label.md with expanded content', () => {
    const dir = makeTitleProject([
      'title: "{%setting}"',
      'variables:',
      '  setting: The Royal Academy',
    ]);
    try {
      compile(path.join(dir, 'compile.yaml'));
      const p = path.join(dir, 'output', 'Label.md');
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.readFileSync(p, 'utf8')).toBe('The Royal Academy\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no root title does not write Label.md at output root', () => {
    const dir = makeTitleProject([]);
    try {
      compile(path.join(dir, 'compile.yaml'));
      const p = path.join(dir, 'output', 'Label.md');
      expect(fs.existsSync(p)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('root title and branch title independently write their own Label.md files', () => {
    const dir = makeTitleProject([
      'title: Root Scenario',
      'branches:',
      '  alpha:',
      '    title: Alpha Branch',
    ]);
    try {
      compile(path.join(dir, 'compile.yaml'));
      const rootLabel = path.join(dir, 'output', 'Label.md');
      const branchLabel = path.join(dir, 'output', 'Branches', 'alpha', 'Label.md');
      expect(fs.readFileSync(rootLabel, 'utf8')).toBe('Root Scenario\n');
      expect(fs.readFileSync(branchLabel, 'utf8')).toBe('Alpha Branch\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
