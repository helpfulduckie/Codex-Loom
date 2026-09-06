'use strict';

const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { migrateOpeningFiles } = require('../../src/migrate/opening');
const { Diagnostics } = require('../../src/diag');
const { withTmpDir, writeTree, compileProject } = require('../helpers/project');

const FIXTURE_DIR = path.resolve(__dirname, '../../test');

let tmpDir;

beforeAll(() => {
  ({ tmpDir } = compileProject({
    'compile.yaml': [
      'version: 4',
      'structure:',
      `  input:`,
      `    items:`,
      `      - ${FIXTURE_DIR}/cards`,
      `    library:`,
      `      main: ${FIXTURE_DIR}/canon`,
      `    templates:`,
      `      - ${FIXTURE_DIR}/templates`,
      '  output: %TMP%/output',
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
    ].join('\n'),
  }));
});

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


describe('protagonist inherited from parent branch node', () => {
  let nestedTmpDir;

  beforeAll(() => {
    ({ tmpDir: nestedTmpDir } = compileProject({
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        `    items:`,
        `      - ${FIXTURE_DIR}/cards`,
        `    library:`,
        `      main: ${FIXTURE_DIR}/canon`,
        `    templates:`,
        `      - ${FIXTURE_DIR}/templates`,
        '  output: %TMP%/output',
        'render:',
        '  notesTemplate: Notes',
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
      ].join('\n'),
    }));
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


describe('Opening.md generation', () => {
  let openingTmpDir;

  beforeAll(() => {
    ({ tmpDir: openingTmpDir } = compileProject({
      'items/items.yaml': [
        '- id: Widget',
        '  name: Widget',
        '  aid:',
        '    type: Item',
        '    title: Widget',
        '  render:',
        '    template: Item',
        '  body:',
        '    Desc: a widget',
      ].join('\n'),
      'templates/Item.template': [
        '{$body.Desc}',
      ].join('\n'),
      'openings/b-opening.md': 'Leaf B from file\n',
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/items]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'components:',
        '  opening: "Root question"',
        'branches:',
        '  A:',
        '    components:',
        '      opening: "Leaf A inline"',
        '  B:',
        `    components:`,
        '      opening: %TMP%/openings/b-opening.md',
        '  nested:',
        '    components:',
        '      branchFraming: "Branch question"',
        '    branches:',
        '      X: {}',
        '      Y: {}',
      ].join('\n'),
    }));
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
    const nested = path.join(openingTmpDir, 'output', 'Branches', 'nested', 'Components', 'Opening.md');
    const x = path.join(openingTmpDir, 'output', 'Branches', 'nested', 'Branches', 'X', 'Components', 'Opening.md');
    expect(fs.readFileSync(nested, 'utf8')).toBe('Branch question\n'); // branchFraming
    expect(fs.readFileSync(x, 'utf8')).toBe('Root question\n');      // inherited root opening
  });
});


describe('branchFraming {%Key} resolution', () => {
  let atKeyTmpDir;

  beforeAll(() => {
    ({ tmpDir: atKeyTmpDir } = compileProject({
      'items/items.yaml': [
        '- id: Widget',
        '  name: Widget',
        '  aid:',
        '    type: Item',
        '    title: Widget',
        '  render:',
        '    template: Item',
        '  body:',
        '    Desc: a widget',
      ].join('\n'),
      'templates/Item.template': [
        '{$body.Desc}',
      ].join('\n'),
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/items]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
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
      ].join('\n'),
    }));
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


describe('cross-item refs inside body field render functions', () => {
  let xrefTmpDir;

  beforeAll(() => {
    ({ tmpDir: xrefTmpDir } = compileProject({
      'items/items.yaml': [
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
      ].join('\n'),
      'templates/Item.template': [
        '{$body.employees}',
        '{join("; ", $body.familyMembers)}',
      ].join('\n'),
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/items]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'branches:',
        '  main: {}',
      ].join('\n'),
    }));
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
    expect(content).toContain('Carol (blond; green)');
  });
});


describe('opening {%Key} resolving to a migrated block file', () => {
  let opKeyTmpDir;

  beforeAll(() => {
    opKeyTmpDir = writeTree(withTmpDir(), {
      'items/c.yaml': [
        '- id: W',
        '  name: W',
        '  aid: { type: Item, title: W }',
        '  render: { template: Item }',
        '  body: { Desc: w }',
      ].join('\n'),
      'templates/Item.template': '{$body.Desc}',
      'components/opening.yaml': [
        '- text: "Universal paragraph."',
        '- text: "Alpha-only paragraph."',
        '  branches:',
        '    alpha: []',
        '    _: ~',
      ].join('\n'),
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/items]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'variables:',
        '  op: %TMP%/components/opening.yaml',
        'components:',
        "  opening: '{%op}'",
        'branches:',
        '  alpha: {}',
        '  beta: {}',
      ].join('\n'),
    });

    migrateOpeningFiles(path.join(opKeyTmpDir, 'compile.yaml'), { diagnostics: new Diagnostics() });
    compile(path.join(opKeyTmpDir, 'compile.yaml'));
  });

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


describe('v3 block opening, migrated to sections and compiled', () => {
  let blkTmpDir;

  beforeAll(() => {
    blkTmpDir = withTmpDir();

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

    fs.writeFileSync(
      path.join(blkTmpDir, 'paragraphs', 'knight-oath.md'),
      'You have sworn an oath to protect the realm.',
      'utf8'
    );

    fs.writeFileSync(path.join(blkTmpDir, 'opening.yaml'), [
      '- text: "A world of magic and intrigue awaits."',
      '',
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
    const mdDir = withTmpDir();
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


describe('deterministic item ordering', () => {
  let orderTmpDir;

  beforeAll(() => {
    orderTmpDir = withTmpDir();
    fs.mkdirSync(path.join(orderTmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(orderTmpDir, 'templates'), { recursive: true });

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

  function typeFile(type) {
    return path.join(orderTmpDir, 'output', 'Branches', 'main', 'Story Cards', type, `${type}.md`);
  }

  test('items within a type are ordered by id, not authoring or title order', () => {
    const content = fs.readFileSync(typeFile('Alpha'), 'utf8');
    expect(content.indexOf('[Apple]')).toBeGreaterThanOrEqual(0);
    expect(content.indexOf('[Apple]')).toBeLessThan(content.indexOf('[Zebra]'));
    expect(content.indexOf('ZebraTitle')).toBeLessThan(content.indexOf('AppleTitle'));
  });

  test('id sort is case-insensitive and deterministic across builds', () => {
    const before = fs.readFileSync(typeFile('Alpha'), 'utf8');
    compile(path.join(orderTmpDir, 'compile.yaml'));
    const after = fs.readFileSync(typeFile('Alpha'), 'utf8');
    expect(after).toBe(before);
  });
});


describe('component gap detection', () => {
  function makeProject(extraComponents) {
    const dir = withTmpDir();
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


describe('item-level ERROR diagnostics fail the build after writing the tree', () => {
  test('an item declaring both notes: and description: throws, but the leaf is still written', () => {
    const dir = withTmpDir();
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
    const dir = withTmpDir();
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
    const dir = withTmpDir();
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


describe('root title -> Label.md', () => {
  function makeTitleProject(extraLines) {
    const dir = withTmpDir();
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


describe('opening paths resolve against branch variables', () => {
  const NL = String.fromCharCode(10);
  let tmpDir;

  beforeEach(() => { tmpDir = withTmpDir(); });

  const project = (lines) => {
    fs.mkdirSync(path.join(tmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'templates', 'Item.template'), '{$body.Desc}', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'items', 'i.yaml'), [
      '- id: W', '  name: W', '  aid: {type: Item, title: W}',
      '  render: {template: Item}', '  body: {Desc: w}',
    ].join(NL), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      '  input:',
      `    items: [${tmpDir.split(String.fromCharCode(92)).join('/')}/items]`,
      `    templates: [${tmpDir.split(String.fromCharCode(92)).join('/')}/templates]`,
      `  output: ${tmpDir.split(String.fromCharCode(92)).join('/')}/output`,
      ...lines,
    ].join(NL), 'utf8');
    compile(path.join(tmpDir, 'compile.yaml'));
  };

  const opening = (...segments) => {
    let p = path.join(tmpDir, 'output');
    for (const s of segments) p = path.join(p, 'Branches', s);
    return fs.readFileSync(path.join(p, 'Components', 'Opening.md'), 'utf8').trim();
  };

  test('a branch variable override is used when resolving the opening path', () => {
    const dir = path.join(tmpDir, 'openings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'E-Kaiden.md'), 'Kaiden opening content', 'utf8');
    fs.writeFileSync(path.join(dir, 'E-Zephon.md'), 'Zephon opening content', 'utf8');
    const spec = `${dir.split(String.fromCharCode(92)).join('/')}/E-{%pcName}.md`;

    project([
      'branches:',
      '  Kaiden:',
      '    variables: {pcName: Kaiden}',
      `    components: {opening: '${spec}'}`,
      '  Zephon:',
      '    variables: {pcName: Zephon}',
      `    components: {opening: '${spec}'}`,
    ]);

    expect(opening('Kaiden')).toBe('Kaiden opening content');
    expect(opening('Zephon')).toBe('Zephon opening content');
  });

  test('nested branch variables accumulate', () => {
    const dir = path.join(tmpDir, 'openings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PM-Felix-Pet.md'), 'Felix pet opening', 'utf8');

    project([
      'branches:',
      '  personalMage:',
      '    branches:',
      '      felix:',
      '        variables: {employerName: Felix}',
      '        branches:',
      '          pet:',
      `            components: {opening: '${dir.split(String.fromCharCode(92)).join('/')}/PM-{%employerName}-Pet.md'}`,
    ]);

    expect(opening('personalMage', 'felix', 'pet')).toBe('Felix pet opening');
  });
});


describe('config errors abort before filesystem work', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = withTmpDir();
  });

  test('a missing structure.output throws and never creates an output directory', () => {
    const configPath = path.join(tmpDir, 'compile.yaml');
    fs.writeFileSync(configPath, 'version: 4\nstructure:\n  input:\n    items: [./Codex]\n', 'utf8');

    expect(() => compile(configPath)).toThrow(/error/i);

    expect(fs.existsSync(path.join(tmpDir, 'output'))).toBe(false);
  });
});


describe('compile writes the VL envelope through emit/vl.js', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = withTmpDir();
    fs.mkdirSync(path.join(tmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
  });

  function compileItem(itemLines, templateContent, extraTemplates = {}, options = {}) {
    const { config = [], branches = ['  main: {}'], leaf = ['main'] } = options;
    fs.writeFileSync(path.join(tmpDir, 'items', 'items.yaml'), itemLines.join('\n'), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'templates', 'Item.template'), templateContent, 'utf8');
    for (const [name, content] of Object.entries(extraTemplates)) {
      fs.writeFileSync(path.join(tmpDir, 'templates', `${name}.template`), content, 'utf8');
    }
    fs.writeFileSync(path.join(tmpDir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      `  input: { items: [${tmpDir}/items], templates: [${tmpDir}/templates] }`,
      `  output: ${tmpDir}/output`,
      ...config,
      'branches:',
      ...branches,
    ].join('\n'), 'utf8');
    compile(path.join(tmpDir, 'compile.yaml'));
    let dir = leaf.reduce((acc, segment) => path.join(acc, 'Branches', segment),
      path.join(tmpDir, 'output'));
    const base = path.join(tmpDir, 'output');
    for (;;) {
      const candidate = path.join(dir, 'Story Cards', 'Item', 'Item.md');
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
      if (dir === base) throw new Error('no Item.md found from leaf up to output root');
      dir = path.dirname(path.dirname(dir)); // strip "<segment>/Branches"
    }
  }

  const ITEM = [
    '- id: Widget',
    '  name: { display: Widget, full: Widget of Power }',
    '  aid: { type: Item, triggers: [widget, _gizmo_] }',
    '  render: { template: Item }',
    '  body: { Desc: a widget }',
  ];

  test('the heading, fence and encapsulate come from the emitter, not the template', () => {
    const output = compileItem(ITEM, '{$body.Desc}');
    expect(output).toBe([
      '## Widget of Power',
      '~~~',
      "triggers: [widget, ' gizmo ']",
      'encapsulate: false',
      '~~~',
      'a widget',
      '',
    ].join('\n'));
  });

  test('notes: reaches the fence through the default rendering', () => {
    const output = compileItem([...ITEM, "  notes: '[e]'"], '{$body.Desc}');
    expect(output).toContain("notes: '[e]'");
  });

  test('render.notesTemplate renders the notes text', () => {
    const item = [...ITEM.slice(0, 3), '  render: { template: Item, notesTemplate: Marker }',
      '  body: { Desc: a widget }', '  notes: { known: true }'];
    const output = compileItem(item, '{$body.Desc}', { Marker: '{if $notes.known}[e]{/if}' });
    expect(output).toContain("notes: '[e]'");
  });

  test('an empty notes template emits no notes line at all', () => {
    const item = [...ITEM.slice(0, 3), '  render: { template: Item, notesTemplate: Marker }',
      '  body: { Desc: a widget }', '  notes: { known: false }'];
    const output = compileItem(item, '{$body.Desc}', { Marker: '{if $notes.known}[e]{/if}' });
    expect(output).not.toContain('notes:');
  });

  test('the wrapper is applied to the body and stays out of the fence', () => {
    const item = [...ITEM.slice(0, 3), '  render: { template: Item, wrapper: curly }',
      '  body: { Desc: a widget }'];
    const output = compileItem(item, '{$body.Desc}');
    expect(output).toContain('~~~\n{\na widget\n}');
  });
});


describe('CL0622 card-name collision', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = withTmpDir();
    fs.mkdirSync(path.join(tmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
  });

  function compileCollisionProject(itemsYaml) {
    fs.writeFileSync(path.join(tmpDir, 'items', 'items.yaml'), itemsYaml, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'templates', 'Character.template'), '{$body.Tagline}', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'templates', 'Location.template'), '{$body.Tagline}', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      `  input: { items: [${tmpDir}/items], templates: [${tmpDir}/templates] }`,
      `  output: ${tmpDir}/output`,
      'branches:',
      '  main: {}',
    ].join('\n'), 'utf8');

    const diagnostics = new Diagnostics();
    try {
      compile(path.join(tmpDir, 'compile.yaml'), { diagnostics });
    } catch {
    }
    return diagnostics;
  }

  test('errors when two cards share a name across types', () => {
    const diagnostics = compileCollisionProject([
      '- id: FirstCard',
      '  name: Shared Name',
      '  aid: { type: Character, triggers: [First] }',
      '  body: { Tagline: first }',
      '',
      '- id: SecondCard',
      '  name: Shared Name',
      '  aid: { type: Location, triggers: [Second] }',
      '  body: { Tagline: second }',
    ].join('\n'));

    const collision = diagnostics.errors.find((d) => d.code === 'CL0622');
    expect(collision).toBeTruthy();
    expect(collision.message).toContain('Shared Name');
    expect(collision.message).toContain('character');
    expect(collision.message).toContain('location');
  });

  test('errors when two cards share a name within one type', () => {
    const diagnostics = compileCollisionProject([
      '- id: FirstCard',
      '  name: Shared Name',
      '  aid: { type: Character, triggers: [First] }',
      '  body: { Tagline: first }',
      '',
      '- id: SecondCard',
      '  name: Shared Name',
      '  aid: { type: Character, triggers: [Second] }',
      '  body: { Tagline: second }',
    ].join('\n'));

    const collision = diagnostics.errors.find((d) => d.code === 'CL0622');
    expect(collision).toBeTruthy();
    expect(collision.message).toContain('Shared Name');
  });
});


describe('the notes ladder end to end', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = withTmpDir();
    fs.mkdirSync(path.join(tmpDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
  });

  const ITEM = [
    '- id: Widget',
    '  name: Widget',
    '  aid: { type: Item, triggers: [widget] }',
    '  body: { Desc: a widget }',
    '  notes: { known: true }',
  ];

  function build({ templates = {}, config = [], branches = ['  main: {}'] }) {
    fs.writeFileSync(path.join(tmpDir, 'items', 'items.yaml'), ITEM.join('\n'), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'templates', 'Item.template'), '{$body.Desc}', 'utf8');
    for (const [name, content] of Object.entries(templates)) {
      fs.writeFileSync(path.join(tmpDir, 'templates', `${name}.template`), content, 'utf8');
    }
    fs.writeFileSync(path.join(tmpDir, 'compile.yaml'), [
      'version: 4',
      'structure:',
      `  input: { items: [${tmpDir}/items], templates: [${tmpDir}/templates] }`,
      `  output: ${tmpDir}/output`,
      ...config,
      'branches:',
      ...branches,
    ].join('\n'), 'utf8');
    compile(path.join(tmpDir, 'compile.yaml'));
    return (...segments) => {
      let dir = path.join(tmpDir, 'output', ...segments.flatMap((s) => ['Branches', s]));
      const base = path.join(tmpDir, 'output');
      for (;;) {
        const candidate = path.join(dir, 'Story Cards', 'Item', 'Item.md');
        if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
        if (dir === base) throw new Error('no Item.md found from leaf up to output root');
        dir = path.dirname(path.dirname(dir));
      }
    };
  }

  test('the project default applies when no type template exists', () => {
    const read = build({
      templates: { ProjectNotes: '{if $notes.known}[e]{/if}' },
      config: ['render:', '  notesTemplate: ProjectNotes'],
    });
    expect(read('main')).toContain("notes: '[e]'");
  });

  test('a branch turns the marker off by pointing at a blank template', () => {
    const read = build({
      templates: { ProjectNotes: '{if $notes.known}[e]{/if}', NoNotes: '' },
      config: ['render:', '  notesTemplate: ProjectNotes'],
      branches: ['  wtg: {}', '  vanilla:', '    render:', '      notesTemplate: NoNotes'],
    });
    expect(read('wtg')).toContain("notes: '[e]'");
    expect(read('vanilla')).not.toContain('notes:');
  });

  test('~ unbinds the project default, falling through to the default rendering rather than suppressing', () => {
    const read = build({
      templates: { ProjectNotes: '{if $notes.known}[e]{/if}' },
      config: ['render:', '  notesTemplate: ProjectNotes'],
      branches: ['  wtg: {}', '  vanilla:', '    render:', '      notesTemplate: ~'],
    });
    expect(read('wtg')).toContain("notes: '[e]'");
    expect(read('vanilla')).toContain("notes: 'known: true'");
  });

  test('a branch swaps the project default for its own template', () => {
    const read = build({
      templates: {
        ProjectNotes: '{if $notes.known}[e]{/if}',
        OtherNotes: '{if $notes.known}[x]{/if}',
      },
      config: ['render:', '  notesTemplate: ProjectNotes'],
      branches: ['  a: {}', '  b:', '    render:', '      notesTemplate: OtherNotes'],
    });
    expect(read('a')).toContain("notes: '[e]'");
    expect(read('b')).toContain("notes: '[x]'");
  });

  test('the branch default is inherited by nested leaves', () => {
    const read = build({
      templates: { OtherNotes: '{if $notes.known}[x]{/if}' },
      branches: ['  outer:', '    render:', '      notesTemplate: OtherNotes',
        '    branches:', '      inner: {}'],
    });
    expect(read('outer', 'inner')).toContain("notes: '[x]'");
  });

  test('a project notesTemplate naming no loaded template is a load-time ERROR', () => {
    expect(() => build({ config: ['render:', '  notesTemplate: Missing'] }))
      .toThrow(/error/i);
  });

  test('a branch notesTemplate naming no loaded template is a load-time ERROR', () => {
    expect(() => build({
      branches: ['  a:', '    render:', '      notesTemplate: AlsoMissing'],
    })).toThrow(/error/i);
  });
});