'use strict';

/**
 * `render.storyCards` — the swappable-instructions feature (v4 spec §7.8, Phase 13 Step 4).
 *
 * A component gains `render: { component: {variant?}, storyCards: [{title, variant?,
 * sections?, type?}] }`. Each `storyCards` entry renders the component again — with the
 * leaf's slot occupants in place — and is emitted as a **trigger-less `kind: reference`**
 * story card: the rendered component text as the `notes:` payload, a one-line orienting
 * string as the body. Placement is Phase 11's frontier mechanism, keyed on `(type, name)`.
 *
 * Integration because every claim is about which file lands where and what is inside it:
 * the card's AID `type` resolving on a three-rung ladder, the trigger-less card surviving
 * the `empty-triggers` lint, and two entries that render differently per branch each landing
 * on their own frontier.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics } = require('../../src/diag');
const { scanStoryCardStructure } = require('../../src/lint');

const dirs = [];
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function compileProject(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-storycards-'));
  dirs.push(tmpDir);
  const slash = (p) => p.replace(/\\/g, '/');

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.replace(/%TMP%/g, slash(tmpDir)), 'utf8');
  }

  const diagnostics = new Diagnostics();
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics });
  } catch (err) {
    // Some cases raise ERRORs by construction.
  }
  return { diagnostics, tmpDir };
}

const codes = (d, code) => d.all.filter((x) => x.code === code);
const cardFile = (tmpDir, type, ...branch) => {
  let p = path.join(tmpDir, 'output');
  for (const s of branch) p = path.join(p, 'Branches', s);
  return path.join(p, 'Story Cards', type, `${type}.md`);
};
const read = (p) => fs.readFileSync(p, 'utf8');

// ── A project whose AI Instructions ships alternates ─────────────────────────

const AIN = [
  'sections:',
  '  house:',
  '    heading: House Style',
  '    text: "Write in close third person."',
  '    render: {position: 1}',
  '    variants:',
  '      full: {text: "Write in close third person. Never break the fourth wall. Keep scenes moving."}',
  '  institute:',
  '    heading: The Institute',
  '    text: "The Institute runs the trials."',
  '    render: {position: 2}',
  '  pacing:',
  '    heading: Pacing',
  '    text: "One beat per turn."',
  '    render: {position: 3}',
].join('\n');

/** `%TYPES%` / `%STORYCARDS%` / `%SCT%` are filled per case. */
const BASE = {
  'templates/Character.template': '{$body.Tagline}',
  'Codex/items.yaml': [
    '- id: Warden',
    '  name: Warden',
    '  aid: {type: Character, triggers: [Warden]}',
    '  body: {Tagline: The Warden watches.}',
    '  render: {template: Character}',
  ].join('\n'),
};

function project(storyCardsBlock, { sct = '', componentVariant = '' } = {}) {
  return compileProject({
    ...BASE,
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'components:',
      '  aiInstructions: ./components/ain.cl.yaml',
      sct,
    ].join('\n'),
    'components/ain.cl.yaml': [
      AIN,
      'render:',
      componentVariant ? `  component: {variant: ${componentVariant}}` : '  component: {}',
      '  storyCards:',
      storyCardsBlock,
    ].join('\n'),
  });
}

// ── The card itself ─────────────────────────────────────────────────────────

describe('a render.storyCards entry emits a trigger-less kind: reference card', () => {
  const built = () => project([
    '    - title: AI Instructions — Full',
    '      variant: full',
  ].join('\n'));

  test('lands under the component display label when nothing sets a type', () => {
    const { tmpDir } = built();
    expect(fs.existsSync(cardFile(tmpDir, 'AI Instructions'))).toBe(true);
  });

  test('carries kind: reference and no triggers: line', () => {
    const text = read(cardFile(built().tmpDir, 'AI Instructions'));
    expect(text).toContain('## AI Instructions — Full');
    expect(text).toContain('kind: reference');
    expect(text).not.toMatch(/^triggers:/m);
  });

  test('puts the rendered component in notes: and a one-liner in the body', () => {
    const text = read(cardFile(built().tmpDir, 'AI Instructions'));
    expect(text).toMatch(/notes: \|-?\n/);
    expect(text).toContain('Never break the fourth wall');      // the `full` variant
    expect(text).toContain("copy the description field below into your scenario's AI Instructions.");
  });

  test('the empty-triggers lint does not fire on it', () => {
    const text = read(cardFile(built().tmpDir, 'AI Instructions'));
    const diagnostics = new Diagnostics();
    scanStoryCardStructure(text, { diagnostics });
    expect(diagnostics.all.filter((d) => d.code === 'CL0635')).toEqual([]);
  });

  test('the component field still ships, unaffected', () => {
    const { tmpDir } = built();
    const ain = read(path.join(tmpDir, 'output', 'Components', 'AI Instructions.md'));
    expect(ain).toContain('Write in close third person.');
    expect(ain).not.toContain('Never break the fourth wall');   // field keeps the base text
  });
});

// ── The three-rung type ladder ──────────────────────────────────────────────

describe('the card type resolves on §7.8\'s three-rung ladder', () => {
  const entry = [
    '    - title: AI Instructions — Full',
    '      variant: full',
  ].join('\n');

  test('rung 1 — unset: the component display label', () => {
    const { tmpDir } = project(entry);
    expect(fs.existsSync(cardFile(tmpDir, 'AI Instructions'))).toBe(true);
  });

  test('rung 2 — storyCardType[<component>] in compile.yaml', () => {
    const { tmpDir } = project(entry, { sct: 'storyCardType:\n  aiInstructions: zz_AIN' });
    expect(fs.existsSync(cardFile(tmpDir, 'zz_AIN'))).toBe(true);
    expect(fs.existsSync(cardFile(tmpDir, 'AI Instructions'))).toBe(false);
  });

  test('rung 3 — the entry\'s own type: wins over the project default', () => {
    const { tmpDir } = project([
      '    - title: AI Instructions — Full',
      '      variant: full',
      '      type: xx_override',
    ].join('\n'), { sct: 'storyCardType:\n  aiInstructions: zz_AIN' });
    expect(fs.existsSync(cardFile(tmpDir, 'xx_override'))).toBe(true);
    expect(fs.existsSync(cardFile(tmpDir, 'zz_AIN'))).toBe(false);
  });
});

// ── Section selection ──────────────────────────────────────────────────────

describe('variant: and sections: select what an entry renders', () => {
  test('sections: is a subset — the named sections and no others', () => {
    const { tmpDir } = project([
      '    - title: AI Instructions — Rules Only',
      '      sections: [institute, pacing]',
    ].join('\n'));
    const text = read(cardFile(tmpDir, 'AI Instructions'));
    expect(text).toContain('The Institute runs the trials.');
    expect(text).toContain('One beat per turn.');
    expect(text).not.toContain('close third person');           // `house` omitted
  });

  test('variant: applies across every section that defines it', () => {
    const { tmpDir } = project([
      '    - title: AI Instructions — Full',
      '      variant: full',
    ].join('\n'));
    const text = read(cardFile(tmpDir, 'AI Instructions'));
    expect(text).toContain('Keep scenes moving.');
  });

  test('render.component.variant selects the section-variant for the component field', () => {
    const { tmpDir } = project('    - {title: X}', { componentVariant: 'full' });
    const ain = read(path.join(tmpDir, 'output', 'Components', 'AI Instructions.md'));
    expect(ain).toContain('Never break the fourth wall');
  });

  test('a sections: name the component does not declare is CL0624, and the entry still renders', () => {
    const { tmpDir, diagnostics } = project([
      '    - title: AI Instructions — Rules Only',
      '      sections: [institute, nosuch]',
    ].join('\n'));
    const found = codes(diagnostics, 'CL0624');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"nosuch"');
    expect(fs.existsSync(cardFile(tmpDir, 'AI Instructions'))).toBe(true);
  });
});

// ── Multiple entries, and frontier placement ───────────────────────────────

describe('two entries with distinct titles both land', () => {
  test('one Story Cards file per type, both cards inside it', () => {
    const { tmpDir } = project([
      '    - title: AI Instructions — Full',
      '      variant: full',
      '    - title: AI Instructions — Rules Only',
      '      sections: [institute, pacing]',
    ].join('\n'));
    const text = read(cardFile(tmpDir, 'AI Instructions'));
    expect(text).toContain('## AI Instructions — Full');
    expect(text).toContain('## AI Instructions — Rules Only');
  });
});

describe('an entry that renders differently per branch is placed per frontier', () => {
  const built = () => compileProject({
    ...BASE,
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'components:',
      '  aiInstructions: ./components/ain.cl.yaml',
      'branches:',
      '  calm: {}',
      '  tense: {}',
    ].join('\n'),
    'components/ain.cl.yaml': [
      'sections:',
      '  pacing:',
      '    heading: Pacing',
      '    text: "One beat per turn."',
      '    render: {position: 1}',
      '    branches:',
      '      tense: fast',
      '    variants:',
      '      fast: {text: "Two beats per turn, minimum."}',
      'render:',
      '  component: {}',
      '  storyCards:',
      '    - title: AI Instructions — Full',
    ].join('\n'),
  });

  test('each branch gets its own rendering of the card', () => {
    const { tmpDir } = built();
    expect(read(cardFile(tmpDir, 'AI Instructions', 'calm'))).toContain('One beat per turn.');
    expect(read(cardFile(tmpDir, 'AI Instructions', 'tense'))).toContain('Two beats per turn');
  });

  test('the card is not also written at the root', () => {
    expect(fs.existsSync(cardFile(built().tmpDir, 'AI Instructions'))).toBe(false);
  });
});

// ── Diagnostics ────────────────────────────────────────────────────────────

describe('malformed entries are reported, not swallowed', () => {
  test('an entry with no title is CL0623 (ERROR)', () => {
    const { diagnostics } = project('    - variant: full');
    const found = codes(diagnostics, 'CL0623');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
  });

  test('an entry whose selectors leave nothing is CL0625, and no card is written', () => {
    const { tmpDir, diagnostics } = project([
      '    - title: Empty',
      '      sections: [nosuch]',
    ].join('\n'));
    expect(codes(diagnostics, 'CL0625')).toHaveLength(1);
    expect(fs.existsSync(cardFile(tmpDir, 'AI Instructions'))).toBe(false);
  });

  test('two entries sharing a title under one type collide (CL0622)', () => {
    const { diagnostics } = project([
      '    - title: AI Instructions — Full',
      '      variant: full',
      '    - title: AI Instructions — Full',
      '      sections: [institute]',
    ].join('\n'));
    expect(codes(diagnostics, 'CL0622')).toHaveLength(1);
  });

  test('an entry title colliding with a real story card name collides too', () => {
    // `Warden` is a Character card from the item corpus.
    const { diagnostics } = project([
      '    - title: Warden',
      '      variant: full',
      '      type: Character',
    ].join('\n'));
    expect(codes(diagnostics, 'CL0622')).toHaveLength(1);
  });
});

// ── `card:` is gone ───────────────────────────────────────────────────────────

describe('the retired v3 card: key', () => {
  test('is an unknown-key ERROR pointing at render.storyCards', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'components:',
        '  aiInstructions: ./components/ain.cl.yaml',
      ].join('\n'),
      'components/ain.cl.yaml': [
        AIN,
        'card:',
        '  title: AI Instructions (reference copy)',
      ].join('\n'),
    });
    const unknown = diagnostics.all.filter((d) => d.code === 'CL0201' && /card/.test(d.message));
    expect(unknown).toHaveLength(1);
    expect(unknown[0].hint).toContain('render.storyCards');
  });
});
