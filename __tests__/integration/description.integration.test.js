'use strict';

/**
 * Description as a component (v4 spec §7.7, Phase 6 Step 3).
 *
 * v3 gave the description its own loader and its own two-field file. Phase 6 replaces both
 * with the ordinary component grammar plus two new section sources, and splits the one key
 * into two: `description:` is the scenario blurb AID shows in listings, written once at the
 * output root and never inherited, while `adventureDescription:` is an ordinary inherited
 * component that lands at each leaf and becomes the description of the adventure started
 * there. The two share `Description.md` at different levels, exactly as `opening:` and
 * `branchFraming:` share `Opening.md`.
 *
 * Integration because almost nothing here is observable below the file level. Whether a
 * description inherits is a question about which leaves have a file; §7.7's opening guard
 * compares two writers that run in different phases of the compile; and `metadata:`
 * frontmatter is a property of the bytes rather than of the rendered text.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics, CODES } = require('../../src/diag');

const dirs = [];

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function compileProject(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-desc-'));
  dirs.push(tmpDir);
  const slash = (p) => p.replace(/\\/g, '/');

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.replace(/%TMP%/g, slash(tmpDir)), 'utf8');
  }

  const diagnostics = new Diagnostics();
  const spies = ['log', 'warn', 'error'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { diagnostics });
  } catch (err) {
    // Several of these raise ERRORs by construction.
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return { diagnostics, tmpDir };
}

const codes = (diagnostics, code) => diagnostics.all.filter((d) => d.code === code);
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8');

const rootDesc = (tmpDir) => path.join(tmpDir, 'output', 'Description.md');
const leafDesc = (tmpDir, branch) => path.join(tmpDir, 'output', 'Branches', branch, 'Description.md');
const leafOpening = (tmpDir, branch) => path.join(tmpDir, 'output', 'Branches', branch, 'Opening.md');

/** A project with two branches, each with an opening so §7.7's guard stays quiet. */
const config = (components, extra = []) => [
  'version: 4',
  'structure:',
  '  input:',
  '    items: [%TMP%/Codex]',
  '    templates: [%TMP%/templates]',
  '  output: %TMP%/output',
  'components:',
  ...components.map((line) => `  ${line}`),
  'branches:',
  '  calm:',
  '    components: {opening: ./openings/calm.md}',
  '  storm:',
  '    components: {opening: ./openings/storm.md}',
  ...extra,
].join('\n');

const BASE = {
  'templates/Character.template': '{$body.Tagline}',
  'Codex/items.yaml': [
    '- id: Hero',
    '  name: Hero',
    '  aid: {type: Character, triggers: [Hero]}',
    '  body: {Tagline: Hero Vale}',
    '  render: {template: Character}',
  ].join('\n'),
  'openings/calm.md': 'The harbor is still.',
  'openings/storm.md': 'The harbor is not still.',
};

// ── The two keys, and the levels they write at ───────────────────────────────

describe('description: and adventureDescription: are two keys at two levels', () => {
  test('the scenario blurb is written once at the root and never inherited', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config(['description: ./components/desc.cl.yaml']),
      'components/desc.cl.yaml': 'sections:\n  pitch:\n    text: A story about a harbor.\n',
    });

    expect(read(rootDesc(tmpDir)).trim()).toBe('A story about a harbor.');
    // The whole reason the two are separate keys: inheriting the blurb would copy one
    // store listing into every leaf, which is what the goldens must never start doing.
    expect(exists(leafDesc(tmpDir, 'calm'))).toBe(false);
    expect(exists(leafDesc(tmpDir, 'storm'))).toBe(false);
  });

  test('an adventure description is written at each leaf and not at the root', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config(['adventureDescription: ./components/adv.cl.yaml']),
      'components/adv.cl.yaml': 'sections:\n  pitch:\n    text: You wake on the docks.\n',
    });

    expect(read(leafDesc(tmpDir, 'calm')).trim()).toBe('You wake on the docks.');
    expect(read(leafDesc(tmpDir, 'storm')).trim()).toBe('You wake on the docks.');
    expect(exists(rootDesc(tmpDir))).toBe(false);
  });

  test('both together write both files, and neither is the other', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'description: ./components/desc.cl.yaml',
        'adventureDescription: ./components/adv.cl.yaml',
      ]),
      'components/desc.cl.yaml': 'sections:\n  pitch:\n    text: A story about a harbor.\n',
      'components/adv.cl.yaml': 'sections:\n  pitch:\n    text: You wake on the docks.\n',
    });

    expect(read(rootDesc(tmpDir)).trim()).toBe('A story about a harbor.');
    expect(read(leafDesc(tmpDir, 'calm')).trim()).toBe('You wake on the docks.');
  });

  test('an adventure description declared at an interior node reaches the leaves under it', () => {
    // The reason `adventureDescription:` is INHERITED rather than node-local: an interior
    // node never needs a render path of its own, because the value flows down to leaves
    // where the items that fill slots actually exist.
    const { tmpDir } = compileProject({
      ...BASE,
      'openings/deep.md': 'Deeper still.',
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'branches:',
        '  calm:',
        '    components: {opening: ./openings/calm.md}',
        '  storm:',
        '    components: {adventureDescription: ./components/adv.cl.yaml}',
        '    branches:',
        '      deep:',
        '        components: {opening: ./openings/deep.md}',
      ].join('\n'),
      'components/adv.cl.yaml': 'sections:\n  pitch:\n    text: The storm took the docks.\n',
    });

    expect(read(leafDesc(tmpDir, path.join('storm', 'Branches', 'deep'))).trim())
      .toBe('The storm took the docks.');
    expect(exists(leafDesc(tmpDir, 'calm'))).toBe(false);
  });
});

// ── Routing ──────────────────────────────────────────────────────────────────

describe('items route into an adventure description, not into the scenario blurb', () => {
  test('a render.adventureDescription target fills a slot like any other component', () => {
    const { tmpDir, diagnostics } = compileProject({
      ...BASE,
      'Codex/items.yaml': [
        '- id: Hero',
        '  name: Hero',
        '  aid: {type: Character, triggers: [Hero]}',
        '  body: {Tagline: Hero Vale}',
        '  render:',
        '    template: Character',
        '    adventureDescription: {slot: cast}',
      ].join('\n'),
      'compile.yaml': config(['adventureDescription: ./components/adv.cl.yaml']),
      'components/adv.cl.yaml': [
        'sections:',
        '  pitch:',
        '    text: You wake on the docks.',
        '    render: {position: 1}',
        '  cast:',
        '    slot: true',
        '    render: {position: 2}',
      ].join('\n'),
    });

    expect(codes(diagnostics, CODES.TARGET_UNDECLARED_SLOT)).toHaveLength(0);
    expect(read(leafDesc(tmpDir, 'calm')).trim()).toBe('You wake on the docks.\n\nHero Vale');
  });

  test('the old render.description spelling is redirected rather than left unknown', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'Codex/items.yaml': [
        '- id: Hero',
        '  name: Hero',
        '  aid: {type: Character, triggers: [Hero]}',
        '  body: {Tagline: Hero Vale}',
        '  render: {template: Character, description: {slot: cast}}',
      ].join('\n'),
      'compile.yaml': config(['adventureDescription: ./components/adv.cl.yaml']),
      'components/adv.cl.yaml':
        'sections:\n  cast:\n    slot: true\n',
    });

    const unknown = diagnostics.all.filter((d) => d.hint && d.hint.includes('adventureDescription'));
    expect(unknown.length).toBeGreaterThan(0);
  });
});

// ── The two new section sources ──────────────────────────────────────────────

describe('sections take their text from a file or from a named transform', () => {
  test('file: includes a file verbatim, and from: reads one through an extractor', () => {
    const { tmpDir, diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': config(['description: ./components/desc.cl.yaml']),
      'components/body.md': 'A story about a harbor.',
      'scripts/library.js': [
        '// ============================================================',
        '// ============= Standard Build - 1.2.3 - library ============',
        '// ============================================================',
        '// - HarborMod@1.0.0',
        '// ============================================================',
        '// Paste this ONLY into the library tab',
        '// ============================================================',
        '',
        'const x = 1;',
      ].join('\n'),
      'components/desc.cl.yaml': [
        'sections:',
        '  body:',
        '    file: ./components/body.md',
        '    render: {position: 1}',
        '  modBanner:',
        '    from: {script: ./scripts/library.js, extract: scriptBanner}',
        '    render: {position: 2}',
      ].join('\n'),
    });

    expect(codes(diagnostics, CODES.SECTION_SOURCE_NOT_FOUND)).toHaveLength(0);
    // Two sections, joined as blocks — which reproduces v3's body-then-banner layout
    // exactly, and is why converting the goldens moved no bytes.
    expect(read(rootDesc(tmpDir))).toBe(
      'A story about a harbor.\n\n=== Standard Build - 1.2.3 - library ===\n- HarborMod@1.0.0\n',
    );
  });

  test('the trailing instruction group is always dropped — the flag is gone', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config(['description: ./components/desc.cl.yaml']),
      'scripts/library.js': [
        '// ====',
        '// - ModA@1.0.0',
        '// ====',
        '// Paste this ONLY into the library tab',
        'const x = 1;',
      ].join('\n'),
      'components/desc.cl.yaml':
        'sections:\n  modBanner:\n    from: {script: ./scripts/library.js, extract: scriptBanner}\n',
    });

    expect(read(rootDesc(tmpDir))).toBe('- ModA@1.0.0\n');
  });

  test('a banner whose last group is itself a list keeps every group', () => {
    // The heuristic needs an earlier bulleted group *and* an unbulleted last one, which is
    // what makes unconditional stripping safe to ship without the flag.
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config(['description: ./components/desc.cl.yaml']),
      'scripts/library.js': ['// ====', '// - ModA@1.0.0', '// ====', '// - ModB@2.0.0', 'const x = 1;'].join('\n'),
      'components/desc.cl.yaml':
        'sections:\n  modBanner:\n    from: {script: ./scripts/library.js, extract: scriptBanner}\n',
    });

    expect(read(rootDesc(tmpDir))).toBe('- ModA@1.0.0\n- ModB@2.0.0\n');
  });

  test('a source that does not resolve is CL0617, reported once rather than once per leaf', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': config(['adventureDescription: ./components/adv.cl.yaml']),
      'components/adv.cl.yaml': 'sections:\n  body:\n    file: ./components/missing.md\n',
    });

    // Two leaves, one report: sources resolve inside the load that caches by path.
    expect(codes(diagnostics, CODES.SECTION_SOURCE_NOT_FOUND)).toHaveLength(1);
  });

  test('an unknown extract: is CL0618 and names the roster', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': config(['description: ./components/desc.cl.yaml']),
      'scripts/library.js': '// - ModA@1.0.0\nconst x = 1;',
      'components/desc.cl.yaml':
        'sections:\n  modBanner:\n    from: {script: ./scripts/library.js, extract: scriptBnner}\n',
    });

    const raised = codes(diagnostics, CODES.SECTION_EXTRACT_UNKNOWN);
    expect(raised).toHaveLength(1);
    expect(raised[0].message).toContain('"scriptBanner"');
  });

  test('text: alongside a source is CL0619, and the text is what survives', () => {
    const { tmpDir, diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': config(['description: ./components/desc.cl.yaml']),
      'components/body.md': 'From the file.',
      'components/desc.cl.yaml':
        'sections:\n  body:\n    text: From the document.\n    file: ./components/body.md\n',
    });

    expect(codes(diagnostics, CODES.SECTION_TEXT_AND_SOURCE)).toHaveLength(1);
    expect(read(rootDesc(tmpDir)).trim()).toBe('From the document.');
  });

  test('an import supplying file: is overridden by a local text:, without CL0619', () => {
    // The merge clears the counterpart source, so replacing inherited content with a
    // literal is the ordinary override it looks like rather than a both-declared ERROR.
    const { tmpDir, diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': config(['description: ./components/desc.cl.yaml']),
      'components/base.md': 'From the shared file.',
      'components/base.cl.yaml': 'sections:\n  body:\n    file: ./components/base.md\n',
      'components/desc.cl.yaml': [
        'imports:',
        '  - from: ./components/base.cl.yaml',
        'sections:',
        '  body:',
        '    text: From this project.',
      ].join('\n'),
    });

    expect(codes(diagnostics, CODES.SECTION_TEXT_AND_SOURCE)).toHaveLength(0);
    expect(read(rootDesc(tmpDir)).trim()).toBe('From this project.');
  });

  test('a field op against an inherited file: applies to the file\'s contents', () => {
    // `rawSections` hands back the source-resolved record, so by the time the importing
    // document's `+{…}` runs the file has been read and there is text to append to.
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config(['description: ./components/desc.cl.yaml']),
      'components/base.md': 'From the shared file.',
      'components/base.cl.yaml': 'sections:\n  body:\n    file: ./components/base.md\n',
      'components/desc.cl.yaml': [
        'imports:',
        '  - from: ./components/base.cl.yaml',
        'sections:',
        '  body:',
        '    text: "+{And from this project.}"',
      ].join('\n'),
    });

    // `+{}` appends on its own line, which is what it does everywhere else.
    expect(read(rootDesc(tmpDir)).trim()).toBe('From the shared file.\nAnd from this project.');
  });
});

// ── metadata: as frontmatter ─────────────────────────────────────────────────

describe('metadata: becomes Description.md frontmatter', () => {
  test('it is written above the body, as YAML VL can parse back out', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'compile.yaml': config(['description: ./components/desc.cl.yaml']),
      'components/desc.cl.yaml': [
        'metadata:',
        '  tags: [thriller, dark]',
        'sections:',
        '  pitch:',
        '    text: A story about a harbor.',
      ].join('\n'),
    });

    // A list has to arrive as a list: `scenario.py:193` reads scenario tags from here, and
    // a re-quoted string would be a silent failure at the far end.
    expect(read(rootDesc(tmpDir))).toBe(
      '---\ntags:\n  - thriller\n  - dark\n---\n\nA story about a harbor.\n',
    );
  });

  test('metadata: on a component with nowhere to put it is CL0620, once', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': config(['aiInstructions: ./components/ain.cl.yaml']),
      'components/ain.cl.yaml':
        'metadata:\n  tags: [thriller]\nsections:\n  rule:\n    text: Stay in character.\n',
    });

    expect(codes(diagnostics, CODES.COMPONENT_METADATA_UNSUPPORTED)).toHaveLength(1);
  });

  // §7.7 — the other half of the same flag. `adventureDescription` shares `Description.md`
  // with the scenario blurb and so inherits `frontmatter: true`, which is what let these two
  // keys through to a leaf with no diagnostic at all. They are Scenario fields VL reads at
  // the root and nowhere else, and the markdown one has no adventure equivalent a player
  // could undo, so they are refused here rather than written and left inert.
  test.each(['advanced: true', 'description: A plain blurb.'])(
    'adventureDescription declaring %s in metadata: is CL0629', (badKey) => {
      const { diagnostics } = compileProject({
        ...BASE,
        'compile.yaml': config([
          'adventureDescription: ./components/adv.cl.yaml',
          'opening: ./openings/calm.md',
        ]),
        'components/adv.cl.yaml':
          `metadata:\n  ${badKey}\nsections:\n  body:\n    text: A quiet harbor town.\n`,
      });

      expect(codes(diagnostics, CODES.ADVENTURE_DESCRIPTION_ADVANCED)).toHaveLength(1);
    }
  );

  test('other metadata keys on adventureDescription pass — no whitelist', () => {
    // VL does not read anything else from a leaf's frontmatter, so a stray key is inert
    // rather than dangerous. Only the two the root reads are refused.
    const { diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': config([
        'adventureDescription: ./components/adv.cl.yaml',
        'opening: ./openings/calm.md',
      ]),
      'components/adv.cl.yaml':
        'metadata:\n  tags: [thriller]\nsections:\n  body:\n    text: A quiet harbor town.\n',
    });

    expect(codes(diagnostics, CODES.ADVENTURE_DESCRIPTION_ADVANCED)).toHaveLength(0);
  });

  test('the scenario blurb still carries both keys freely', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': config(['description: ./components/desc.cl.yaml']),
      'components/desc.cl.yaml': [
        'metadata:',
        '  advanced: true',
        '  description: A plain blurb.',
        'sections:',
        '  pitch:',
        '    text: A story about a harbor.',
      ].join('\n'),
    });

    expect(codes(diagnostics, CODES.ADVENTURE_DESCRIPTION_ADVANCED)).toHaveLength(0);
  });
});

// ── §7.7's opening guard ─────────────────────────────────────────────────────

describe('a leaf description with no opening is CL0616', () => {
  test('the leaf missing an opening is named, and the one that has it is not', () => {
    const { tmpDir, diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'components:',
        '  adventureDescription: ./components/adv.cl.yaml',
        'branches:',
        '  calm:',
        '    components: {opening: ./openings/calm.md}',
        '  storm: {}',
      ].join('\n'),
      'components/adv.cl.yaml': 'sections:\n  pitch:\n    text: You wake on the docks.\n',
    });

    const raised = codes(diagnostics, CODES.LEAF_DESCRIPTION_NO_OPENING);
    expect(raised).toHaveLength(1);
    expect(raised[0].message).toContain('"storm"');
    expect(raised[0].severity).toBe('error');

    // The premise, stated as a fact rather than assumed: the file pairing that VL would
    // misread is exactly the one on disk.
    expect(exists(leafDesc(tmpDir, 'storm'))).toBe(true);
    expect(exists(leafOpening(tmpDir, 'storm'))).toBe(false);
  });

  test('no description means no guard, however many leaves lack an opening', () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'branches:',
        '  calm: {}',
        '  storm: {}',
      ].join('\n'),
    });

    expect(codes(diagnostics, CODES.LEAF_DESCRIPTION_NO_OPENING)).toHaveLength(0);
  });
});

// ── The unbranched collision ─────────────────────────────────────────────────

describe('an unbranched project is its own leaf, so both keys aim at one file', () => {
  test('declaring both is CL0621 and the scenario blurb is what survives', () => {
    const { tmpDir, diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'components:',
        '  opening: ./openings/calm.md',
        '  description: ./components/desc.cl.yaml',
        '  adventureDescription: ./components/adv.cl.yaml',
      ].join('\n'),
      'components/desc.cl.yaml': 'sections:\n  pitch:\n    text: A story about a harbor.\n',
      'components/adv.cl.yaml': 'sections:\n  pitch:\n    text: You wake on the docks.\n',
    });

    expect(codes(diagnostics, CODES.DESCRIPTION_KEYS_COLLIDE)).toHaveLength(1);
    expect(read(rootDesc(tmpDir)).trim()).toBe('A story about a harbor.');
  });

  test('either one alone is silent', () => {
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
        '  opening: ./openings/calm.md',
        '  adventureDescription: ./components/adv.cl.yaml',
      ].join('\n'),
      'components/adv.cl.yaml': 'sections:\n  pitch:\n    text: You wake on the docks.\n',
    });

    expect(codes(diagnostics, CODES.DESCRIPTION_KEYS_COLLIDE)).toHaveLength(0);
  });
});
