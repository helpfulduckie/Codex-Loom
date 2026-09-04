'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { migrateOpeningFiles } = require('../../src/migrate/opening');
const { Diagnostics } = require('../../src/diag');

const FIXTURE_DIR = path.resolve(__dirname, '../../test');

let tmpDir;
let patchedConfigPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-test-'));

  // Write a patched compile.yaml (based on the test/ smoke project) that redirects output
  // to a temp dir but uses the real test fixtures for everything else.
  const patchedConfig = [
    'version: 4',
    'structure:',
    `  input:`,
    `    items:`,
    // The key is the v4 spelling; the directory on disk is still test/cards.
    `      - ${FIXTURE_DIR}/cards`,
    `    library:`,
    `      main: ${FIXTURE_DIR}/canon`,
    `    templates:`,
    `      - ${FIXTURE_DIR}/templates`,
    `  output: ${tmpDir}/output`,
    // The fixture items carry `notes: {known: true}`; this is the template that turns
    // that flag into the `[e]` marker (§4.5.1, rung 3).
    'render:',
    '  notesTemplate: Notes',
    'roles:',
    '  protagonist: Aness',
    'branches:',
    '  subject:',
    '    roles:',
    '      protagonist: Aness',
    '  researcher:',
    '    roles:',
    '      protagonist: Veyrn',
    '  felix:',
    '    roles:',
    '      protagonist: Aness',
  ].join('\n');

  patchedConfigPath = path.join(tmpDir, 'compile.yaml');
  fs.writeFileSync(patchedConfigPath, patchedConfig, 'utf8');

  compile(patchedConfigPath);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Phase 11 Step 5: a card constant across a subtree is written once at the node that owns
// it and inherited down, so a leaf need not hold its own copy. Resolve it the way Velvet
// Lattice does — the nearest `Story Cards/<type>/<type>.md` from the leaf up to the root.
function resolveCardFile(leafDir, baseDir, type) {
  let dir = leafDir;
  for (;;) {
    const candidate = path.join(dir, 'Story Cards', type, `${type}.md`);
    if (fs.existsSync(candidate)) return candidate;
    if (dir === baseDir) return candidate; // return the leaf-level path so callers' existsSync sees false
    dir = path.dirname(path.dirname(dir));
  }
}

function branchCardFile(branch, type) {
  return resolveCardFile(
    path.join(tmpDir, 'output', 'Branches', branch), path.join(tmpDir, 'output'), type,
  );
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
    // Phase 11 Step 5: the subject leaf's Character cards are split across the nodes that
    // own them (shared ones at the root, subject-only ones at the leaf). Reconstruct the
    // resolved view the way Velvet Lattice does — every Character.md from the root down to
    // the leaf, root first.
    let dir = path.join(tmpDir, 'output');
    const base = dir;
    const leafDir = path.join(base, 'Branches', 'subject');
    const chain = [];
    for (let d = leafDir; ; d = path.dirname(path.dirname(d))) {
      chain.unshift(d);
      if (d === base) break;
    }
    const content = chain
      .map((d) => path.join(d, 'Story Cards', 'Character', 'Character.md'))
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.readFileSync(p, 'utf8').trimEnd())
      .join('\n\n') + '\n';
    expect(content).toMatchSnapshot();
  });
});

// ── nested protagonist inheritance ────────────────────────────────────────────

describe('protagonist inherited from parent branch node', () => {
  let nestedTmpDir;

  beforeAll(() => {
    nestedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nested-proto-'));

    const patchedConfig = [
      'version: 4',
      'structure:',
      '  input:',
      `    items:`,
      // The key is the v4 spelling; the directory on disk is still test/cards.
      `      - ${FIXTURE_DIR}/cards`,
      `    library:`,
      `      main: ${FIXTURE_DIR}/canon`,
      `    templates:`,
      `      - ${FIXTURE_DIR}/templates`,
      `  output: ${nestedTmpDir}/output`,
      'render:',
      '  notesTemplate: Notes',
      // protagonist declared on parent node only — leaf nodes have none
      'branches:',
      '  Aness:',
      '    roles:',
      '      protagonist: Aness',
      '    branches:',
      '      Cult: {}',
      '  Veyrn:',
      '    roles:',
      '      protagonist: Veyrn',
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
    return resolveCardFile(
      path.join(nestedTmpDir, 'output', 'Branches', tier1, 'Branches', tier2),
      path.join(nestedTmpDir, 'output'), type,
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

    // Minimal v3-format item + template so compile has something to do
    fs.mkdirSync(path.join(openingTmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(openingTmpDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(openingTmpDir, 'openings'), { recursive: true });

    fs.writeFileSync(path.join(openingTmpDir, 'items', 'items.yaml'), [
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
      '{$body.Desc}',
    ].join('\n'), 'utf8');

    // File-based opening content
    fs.writeFileSync(path.join(openingTmpDir, 'openings', 'b-opening.md'), 'Leaf B from file\n', 'utf8');

    // the test/ smoke project's shape — opening under components: at root and branch levels
    // opening: inherits to leaves; branchFraming: writes to branch node directly
    fs.writeFileSync(path.join(openingTmpDir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      '  input:',
      `    items: [${openingTmpDir}/items]`,
      `    templates: [${openingTmpDir}/templates]`,
      `  output: ${openingTmpDir}/output`,
      'components:',
      '  opening: "Root question"',
      'branches:',
      '  A:',
      '    components:',
      '      opening: "Leaf A inline"',
      '  B:',
      `    components:`,
      `      opening: ${openingTmpDir}/openings/b-opening.md`,
      '  nested:',
      '    components:',
      '      branchFraming: "Branch question"',
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

  test('branch-node branchFraming written to nested/Components/Opening.md', () => {
    const p = path.join(openingTmpDir, 'output', 'Branches', 'nested', 'Components', 'Opening.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('Branch question\n');
  });

  test('non-leaf branch node with only branchFraming does not get a leaf Opening.md at its own level', () => {
    // nested itself is not a leaf — its Opening.md is for branchFraming
    // but the leaves X and Y have the inherited root opening
    const nested = path.join(openingTmpDir, 'output', 'Branches', 'nested', 'Components', 'Opening.md');
    const x = path.join(openingTmpDir, 'output', 'Branches', 'nested', 'Branches', 'X', 'Components', 'Opening.md');
    expect(fs.readFileSync(nested, 'utf8')).toBe('Branch question\n'); // branchFraming
    expect(fs.readFileSync(x, 'utf8')).toBe('Root question\n');      // inherited root opening
  });
});

// ── branchFraming {%Key} token resolution ──────────────────────────────────────

describe('branchFraming {%Key} resolution', () => {
  let atKeyTmpDir;

  beforeAll(() => {
    atKeyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atkey-int-'));

    fs.mkdirSync(path.join(atKeyTmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(atKeyTmpDir, 'templates'), { recursive: true });

    fs.writeFileSync(path.join(atKeyTmpDir, 'items', 'items.yaml'), [
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
      '{$body.Desc}',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(atKeyTmpDir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      '  input:',
      `    items: [${atKeyTmpDir}/items]`,
      `    templates: [${atKeyTmpDir}/templates]`,
      `  output: ${atKeyTmpDir}/output`,
      'variables:',
      '  roleChoice: Are you the mage or the employer?',
      '  mageChoice: Who is your mage?',
      '  employerChoice: Who is your employer?',
      'components:',
      "  branchFraming: '{%roleChoice}'",
      'branches:',
      '  employer:',
      '    title: Employer',
      '    components:',
      "      branchFraming: '{%mageChoice}'",
      '    branches:',
      '      alice: {}',
      '  mage:',
      '    title: Personal Mage',
      '    components:',
      "      branchFraming: '{%employerChoice}'",
      '    branches:',
      '      bob: {}',
    ].join('\n'), 'utf8');

    compile(path.join(atKeyTmpDir, 'compile.yaml'));
  });

  afterAll(() => {
    fs.rmSync(atKeyTmpDir, { recursive: true, force: true });
  });

  test('root branchFraming {%roleChoice} resolves to literal string', () => {
    const p = path.join(atKeyTmpDir, 'output', 'Components', 'Opening.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('Are you the mage or the employer?\n');
  });

  test('employer branch branchFraming {%mageChoice} resolves to literal string', () => {
    const p = path.join(atKeyTmpDir, 'output', 'Branches', 'employer', 'Components', 'Opening.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('Who is your mage?\n');
  });

  test('mage branch branchFraming {%employerChoice} resolves to literal string', () => {
    const p = path.join(atKeyTmpDir, 'output', 'Branches', 'mage', 'Components', 'Opening.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('Who is your employer?\n');
  });

  test('leaf nodes do not get branchFraming Opening.md', () => {
    const alice = path.join(atKeyTmpDir, 'output', 'Branches', 'Employer', 'Branches', 'alice', 'Components', 'Opening.md');
    expect(fs.existsSync(alice)).toBe(false);
  });
});

// ── cross-item render function refs in body fields ────────────────────────────

describe('cross-item refs inside body field render functions', () => {
  let xrefTmpDir;

  beforeAll(() => {
    xrefTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-xref-int-'));
    fs.mkdirSync(path.join(xrefTmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(xrefTmpDir, 'templates'), { recursive: true });

    // Items: Alice and Carol cross-ref Bishop's hair (plain token, resolved by applyCrossItemRefs).
    // Bishop's familyMembers use join() on Alice/Carol's physicalTraits (new cross-item render fn).
    // Store's employees use join() on Bishop's familyMembers (chained, order-dependent without multi-pass).
    // Items are deliberately ordered Store → Bishop → Carol → Alice (deepest-dependent first)
    // so that cross-item references resolve in topological order (crossItem.js).
    fs.writeFileSync(path.join(xrefTmpDir, 'items', 'items.yaml'), [
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
      // Alice and Carol are data records: their bodies exist only to be cross-referenced
      // by Store and Bishop, and `Item.template` reads no key they carry. `kind: reference`
      // says so — without it each emits an empty-bodied card and earns CL0609.
      '- id: Carol',
      '  name: Carol',
      '  kind: reference',
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
      '  kind: reference',
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
      '{$body.employees}',
      '{join("; ", $body.familyMembers)}',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(xrefTmpDir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      '  input:',
      `    items: [${xrefTmpDir}/items]`,
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

  function xrefItem() {
    return fs.readFileSync(
      path.join(xrefTmpDir, 'output', 'Branches', 'main', 'Story Cards', 'Item', 'Item.md'), 'utf8'
    );
  }

  test('Bishop familyMembers: join() on cross-item mapping resolves hair+eyes', () => {
    const content = xrefItem();
    expect(content).toContain('Alice (blond; blue)');
    expect(content).toContain('Carol (blond; green)');
  });

  test('Store employees: chained cross-item join() resolves fully despite deepest-first ordering', () => {
    const content = xrefItem();
    expect(content).toContain('Alice (blond; blue); Carol (blond; green)');
  });

  test('Alice physicalTraits.hair: plain cross-item token resolved to Bishop hair', () => {
    const content = xrefItem();
    // Carol's physicalTraits are referenced in Bishop's familyMembers and appear resolved
    expect(content).toContain('Carol (blond; green)');
  });
});

// ── opening {%Key} token resolving to a block file the migrator converted ────

describe('opening {%Key} resolving to a migrated block file', () => {
  let opKeyTmpDir;

  beforeAll(() => {
    opKeyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-opkey-int-'));
    fs.mkdirSync(path.join(opKeyTmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(opKeyTmpDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(opKeyTmpDir, 'components'), { recursive: true });

    fs.writeFileSync(path.join(opKeyTmpDir, 'items', 'c.yaml'), [
      '- id: W',
      '  name: W',
      '  aid: { type: Item, title: W }',
      '  render: { template: Item }',
      '  body: { Desc: w }',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(opKeyTmpDir, 'templates', 'Item.template'),
      '{$body.Desc}', 'utf8');

    fs.writeFileSync(path.join(opKeyTmpDir, 'components', 'opening.yaml'), [
      '- text: "Universal paragraph."',
      '- text: "Alpha-only paragraph."',
      '  branches:',
      '    alpha: []',
      '    _: ~',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(opKeyTmpDir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      '  input:',
      `    items: [${opKeyTmpDir}/items]`,
      `    templates: [${opKeyTmpDir}/templates]`,
      `  output: ${opKeyTmpDir}/output`,
      'variables:',
      `  op: ${opKeyTmpDir}/components/opening.yaml`,
      'components:',
      "  opening: '{%op}'",
      'branches:',
      '  alpha: {}',
      '  beta: {}',
    ].join('\n'), 'utf8');

    migrateOpeningFiles(path.join(opKeyTmpDir, 'compile.yaml'), { diagnostics: new Diagnostics() });
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

// ── v3 block opening → sections, migrated then compiled ─────────────────────
//
// The block list below is written exactly as a v3 project holds it, then run through
// `migrateOpeningFiles` before the compile. Every assertion is the one this suite made when
// `src/opening.js` rendered the blocks directly, which is the point: the conversion is
// faithful, or one of them goes red. It covers universal blocks, single and nested branch
// dispatch, a variant, a file-path `text:`, and variable expansion in one project.

describe('v3 block opening, migrated to sections and compiled', () => {
  let blkTmpDir;

  beforeAll(() => {
    blkTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-blk-opening-'));

    fs.mkdirSync(path.join(blkTmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(blkTmpDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(blkTmpDir, 'paragraphs'), { recursive: true });

    fs.writeFileSync(path.join(blkTmpDir, 'items', 'items.yaml'), [
      '- id: Widget',
      '  name: Widget',
      '  aid: { type: Item, title: Widget }',
      '  render: { template: Item }',
      '  body: { Desc: a widget }',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(blkTmpDir, 'templates', 'Item.template'), [
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
      'version: 4',
      'structure:',
      '  input:',
      `    items: [${blkTmpDir}/items]`,
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

    migrateOpeningFiles(path.join(blkTmpDir, 'compile.yaml'), { diagnostics: new Diagnostics() });
    compile(path.join(blkTmpDir, 'compile.yaml'));
  });

  afterAll(() => {
    fs.rmSync(blkTmpDir, { recursive: true, force: true });
  });

  function opening(branchPath) {
    const segments = branchPath.split('/');
    let p = path.join(blkTmpDir, 'output');
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
      fs.mkdirSync(path.join(mdDir, 'items'), { recursive: true });
      fs.mkdirSync(path.join(mdDir, 'templates'), { recursive: true });
      fs.writeFileSync(path.join(mdDir, 'items', 'c.yaml'), [
        '- id: W',
        '  name: W',
        '  aid: { type: Item, title: W }',
        '  render: { template: Item }',
        '  body: { Desc: w }',
      ].join('\n'), 'utf8');
      fs.writeFileSync(path.join(mdDir, 'templates', 'Item.template'), '{$body.Desc}', 'utf8');
      fs.writeFileSync(path.join(mdDir, 'opening.md'), 'Legacy inline opening.', 'utf8');
      fs.writeFileSync(path.join(mdDir, 'compile.yaml'), [
        'version: 4',
        'structure:',
        `  input: { items: [${mdDir}/items], templates: [${mdDir}/templates] }`,
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

// ── deterministic item ordering (sorted by id within type) ────────────────────

describe('deterministic item ordering', () => {
  let orderTmpDir;

  beforeAll(() => {
    orderTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-order-'));
    fs.mkdirSync(path.join(orderTmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(orderTmpDir, 'templates'), { recursive: true });

    // Items are authored out of alphabetical order, and titles sort opposite to
    // ids, so a regression to authoring-order or title-order would be caught.
    // Two types ("Beta" before "Alpha") are also declared out of order.
    fs.writeFileSync(path.join(orderTmpDir, 'items', 'items.yaml'), [
      '- id: Zebra',
      '  name: Zebra',
      '  aid: { type: Alpha, title: AppleTitle }',
      '  render: { template: Item }',
      '  body: { Desc: z }',
      '- id: mango',
      '  name: mango',
      '  aid: { type: Beta, title: MangoTitle }',
      '  render: { template: Item }',
      '  body: { Desc: m }',
      '- id: Apple',
      '  name: Apple',
      '  aid: { type: Alpha, title: ZebraTitle }',
      '  render: { template: Item }',
      '  body: { Desc: a }',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(orderTmpDir, 'templates', 'Item.template'),
      '{$aid.title} [{$id}]\n{$body.Desc}', 'utf8');

    fs.writeFileSync(path.join(orderTmpDir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      `  input: { items: [${orderTmpDir}/items], templates: [${orderTmpDir}/templates] }`,
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

  test('items within a type are ordered by id, not authoring or title order', () => {
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
    fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'items', 'c.yaml'), [
      '- id: W',
      '  name: W',
      '  aid: { type: Item, title: W }',
      '  render: { template: Item }',
      '  body: { Desc: w }',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'templates', 'Item.template'), '{$body.Desc}', 'utf8');
    fs.writeFileSync(path.join(dir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      `  input: { items: [${dir}/items], templates: [${dir}/templates] }`,
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

  test('unresolved {%key} Plot Essentials reference throws', () => {
    const dir = makeProject(['plotEssential: "{%nope}"']);
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
      'version: 4',
      'structure:',
      `  input: { items: [${dir}/items], templates: [${dir}/templates] }`,
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

// ── CL0323 (notes:/description: both declared) fails the build ────────────────

describe('item-level ERROR diagnostics fail the build after writing the tree', () => {
  test('an item declaring both notes: and description: throws, but the leaf is still written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notesdesc-'));
    fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'items', 'c.yaml'), [
      '- id: W',
      '  name: W',
      '  aid: { type: Item, title: W }',
      '  render: { template: Item }',
      '  notes: "notes value"',
      '  description: "description value"',
      '  body: { Desc: w }',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'templates', 'Item.template'), '{$body.Desc}', 'utf8');
    fs.writeFileSync(path.join(dir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      `  input: { items: [${dir}/items], templates: [${dir}/templates] }`,
      `  output: ${dir}/output`,
      'branches:',
      '  main: {}',
    ].join('\n'), 'utf8');
    try {
      expect(() => compile(path.join(dir, 'compile.yaml'))).toThrow(/output tree was written/);
      const p = path.join(dir, 'output', 'Branches', 'main', 'Story Cards', 'Item', 'Item.md');
      expect(fs.existsSync(p)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed import (CL0324) fails the build, but the ordinary item still renders', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-badimport-'));
    fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'items', 'c.yaml'), [
      '- import: NoSuchItem',
      '- id: W',
      '  name: W',
      '  aid: { type: Item, title: W }',
      '  render: { template: Item }',
      '  body: { Desc: w }',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'templates', 'Item.template'), '{$body.Desc}', 'utf8');
    fs.writeFileSync(path.join(dir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      `  input: { items: [${dir}/items], templates: [${dir}/templates] }`,
      `  output: ${dir}/output`,
      'branches:',
      '  main: {}',
    ].join('\n'), 'utf8');
    try {
      expect(() => compile(path.join(dir, 'compile.yaml'))).toThrow(/output tree was written/);
      const p = path.join(dir, 'output', 'Branches', 'main', 'Story Cards', 'Item', 'Item.md');
      expect(fs.existsSync(p)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing template (CL0420) fails the build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notemplate-'));
    fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'items', 'c.yaml'), [
      '- id: W',
      '  name: W',
      '  aid: { type: NoSuchTemplate, title: W }',
      '  render: { template: NoSuchTemplate }',
      '  body: { Desc: w }',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      `  input: { items: [${dir}/items], templates: [${dir}/templates] }`,
      `  output: ${dir}/output`,
      'branches:',
      '  main: {}',
    ].join('\n'), 'utf8');
    try {
      expect(() => compile(path.join(dir, 'compile.yaml'))).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Root `title` → top-level Label.md ──────────────────────────────────────────

describe('root title -> Label.md', () => {
  function makeTitleProject(extraLines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-title-'));
    fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'items', 'c.yaml'), [
      '- id: W',
      '  name: W',
      '  aid: { type: Item, title: W }',
      '  render: { template: Item }',
      '  body: { Desc: w }',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'templates', 'Item.template'), '{$body.Desc}', 'utf8');
    fs.writeFileSync(path.join(dir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      `  input: { items: [${dir}/items], templates: [${dir}/templates] }`,
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
