'use strict';

/**
 * Prose components report per section, like Plot Essentials (v4 spec §7.2).
 *
 * Step 8 moved AI Instructions and Author's Note onto the sectioned path, then folded
 * their segments back into one entry keyed by the component name so the report fixtures
 * would not move inside an implementation step. Step 10 took the per-section segments.
 *
 * The corpus cannot check this and never will: all three golden fixtures point
 * `aiInstructions:` at one shared `.md` passthrough, and both Author's Note files are a
 * single section holding a plain string, so every one of them has exactly one segment
 * under either scheme. The cross-branch diff report is not in the golden report fixtures
 * at all — `REPORT_MODES` freezes seed-map, card-sizes and lint. So this file is the only
 * thing standing between the change and a silent regression.
 *
 * What the segment key buys is the shared/delta partition, not the rendered text.
 * `renderComponentSections` never prints a key, and it joined collapsed text with the same
 * `\n\n` it now joins separate blocks with — so a component whose sections all fall in one
 * bucket reads identically either way. The difference appears the moment one section is
 * constant across branches and another is not: keyed per section, the constant one is
 * shared and only the varying one repeats into each delta. Keyed per component, one
 * varying line drags the whole document into every leaf.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');

let tmpDir;

const readReport = (name) => fs.readFileSync(
  path.join(tmpDir, 'output', 'Overview', 'diff', name), 'utf8',
);

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-segments-'));
  const write = (rel, content) => {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };

  // Two sections, and only one of them dispatches on the branch. The house rule is the
  // constant; the register line is what the `flashback` branch rewrites.
  write('components/authors-note.yaml', [
    'sections:',
    '  houseRule:',
    '    text: "Keep scenes in the present tense."',
    '    render: {position: 1}',
    '  register:',
    '    text: "Write with psychological weight."',
    '    render: {position: 2}',
    '    branches: {flashback: soft}',
    '    variants:',
    '      soft:',
    '        text: "Write with a light touch."',
  ].join('\n'));

  write('Codex/items.yaml', [
    '- id: Ally',
    '  name: {display: Ally, full: Ally Renn}',
    '  aid: {type: Character, triggers: [Ally]}',
    '  body: {tagline: the second}',
  ].join('\n'));

  write('templates/Character.template', '{$name.full}\nTagline: {$body.tagline}');

  write('compile.yaml', [
    'version: 4',
    'structure:',
    '  input:',
    `    items: [${tmpDir.replace(/\\/g, '/')}/Codex]`,
    `    templates: [${tmpDir.replace(/\\/g, '/')}/templates]`,
    `  output: ${tmpDir.replace(/\\/g, '/')}/output`,
    'components:',
    '  authorsNote: ./components/authors-note.yaml',
    'branches:',
    '  present: {}',
    '  flashback: {}',
  ].join('\n'));

  const quiet = ['log', 'warn'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { diff: true });
  } finally {
    quiet.forEach((s) => s.mockRestore());
  }
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Author's Note reports per section (step 10)", () => {
  test('a section constant across branches is shared, not repeated into every delta', () => {
    const shared = readReport('Shared.md');
    expect(shared).toContain('Keep scenes in the present tense.');
    // The whole point: under one collapsed segment per component, the varying register
    // line made the entire document varying and nothing here would be shared.
    expect(shared).not.toContain('Write with psychological weight.');
    expect(shared).not.toContain('Write with a light touch.');
  });

  test('only the branch-varying section lands in each leaf delta', () => {
    const present = readReport('present.delta.md');
    const flashback = readReport('flashback.delta.md');

    expect(present).toContain('Write with psychological weight.');
    expect(flashback).toContain('Write with a light touch.');

    // The constant section is in Shared.md, so a delta must not restate it.
    expect(present).not.toContain('Keep scenes in the present tense.');
    expect(flashback).not.toContain('Keep scenes in the present tense.');
  });
});
