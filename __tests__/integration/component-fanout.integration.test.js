'use strict';

/**
 * The component-level `branches:` fan-out (v4 spec §7.6.2a, Phase 6 Step 2).
 *
 * `branches:` on a section names one target; `branches:` on the component document names
 * every section it holds. Position supplies arity, which is why the feature needed no new
 * key — and arity is also what decides the reporting, so the same file has to prove both
 * that the fan-out applies and that it stays quiet about the sections it misses.
 *
 * Integration because the exclusion arm is only observable at the file level: a
 * component-level `~` has to write no file *and* not raise CL0615, and those two facts live
 * in `emit/components.js` and `compile.js` respectively while the decision is made in
 * `model/component.js`.
 */

const path = require('path');
const fs = require('fs');
const { compileProject } = require('../helpers/project');

const codes = (diagnostics, code) => diagnostics.all.filter((d) => d.code === code);

const peFile = (tmpDir, branch) => path.join(
  tmpDir, 'output', 'Branches', branch, 'Components', 'Plot Essentials.md',
);
const pe = (tmpDir, branch) => fs.readFileSync(peFile(tmpDir, branch), 'utf8');

const BASE = {
  'templates/Character.template': '{$body.Tagline}',
  'compile.yaml': [
    'version: 4',
    'structure:',
    '  input:',
    '    items: [%TMP%/Codex]',
    '    templates: [%TMP%/templates]',
    '  output: %TMP%/output',
    'components:',
    '  plotEssential: ./components/pe.cl.yaml',
    'branches:',
    '  plain: {}',
    '  flashback: {}',
  ].join('\n'),
  'Codex/items.yaml': [
    '- id: Hero',
    '  name: Hero',
    '  aid: {type: Character, triggers: [Hero]}',
    '  body: {Tagline: Hero Vale}',
    '  render: {template: Character, plotEssential: {slot: cast}}',
  ].join('\n'),
};

/** Two sections define `lighter`, one does not, and one is the slot. */
const SECTIONS = [
  'sections:',
  '  genre:',
  '    text: "Genre: Thriller"',
  '    render: {position: 1}',
  '    variants:',
  '      lighter: {text: "Genre: Caper"}',
  '  tone:',
  '    text: "Write with weight."',
  '    render: {position: 2}',
  '    variants:',
  '      lighter: {text: "Write with a light touch."}',
  '  setting:',
  '    text: "The Royal Academy."',
  '    render: {position: 3}',
  '  cast:',
  '    slot: true',
  '    render: {position: 4}',
].join('\n');

// ── The fan-out ──────────────────────────────────────────────────────────────

describe('a component-level branches: applies across every section defining the variant', () => {
  const project = (dispatch) => compileProject({
    ...BASE,
    'components/pe.cl.yaml': [dispatch, SECTIONS].join('\n'),
  });

  const fanned = () => project([
    'branches:',
    '  flashback: lighter',
  ].join('\n'));

  test('both sections that define it get it, from one declaration', () => {
    // The ergonomic loss §7.6 accepted and §7.6.2a takes back: without this the dispatch
    // is written once per affected section.
    const text = pe(fanned().tmpDir, 'flashback');
    expect(text).toContain('Genre: Caper');
    expect(text).toContain('Write with a light touch.');
  });

  test('the section that does not define it is untouched and unreported', () => {
    const { tmpDir, diagnostics } = fanned();
    expect(pe(tmpDir, 'flashback')).toContain('The Royal Academy.');
    expect(codes(diagnostics, 'CL0604')).toHaveLength(0);
    expect(codes(diagnostics, 'CL0605')).toHaveLength(0);
  });

  test('the undispatched branch is unaffected', () => {
    const text = pe(fanned().tmpDir, 'plain');
    expect(text).toContain('Genre: Thriller');
    expect(text).toContain('Write with weight.');
  });

  test('a name no section defines is CL0605, once, naming the count', () => {
    const { diagnostics } = project([
      'branches:',
      '  flashback: lightre',
    ].join('\n'));
    const found = codes(diagnostics, 'CL0605');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"lightre"');
    expect(found[0].message).toContain('4 sections');
    expect(found[0].severity).toBe('warn');
  });

  test('CL0605 fires only on the branch that dispatches', () => {
    // Unlike an import selector, a dispatch has no answer without a branch path — so this
    // one is per branch by nature rather than by choice.
    const { diagnostics } = project([
      'branches:',
      '  flashback: lightre',
    ].join('\n'));
    expect(codes(diagnostics, 'CL0605')).toHaveLength(1);
  });

  test("a section's own dispatch still warns per miss — arity-1 is unchanged", () => {
    const { diagnostics } = compileProject({
      ...BASE,
      'components/pe.cl.yaml': [
        SECTIONS,
        '    branches: {flashback: nosuch}',
      ].join('\n'),
    });
    const found = codes(diagnostics, 'CL0604');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"nosuch"');
  });
});

// ── Both positions at once ───────────────────────────────────────────────────

describe('a component dispatch and a section dispatch that both fire', () => {
  /**
   * §7.6.2a's ordering rule, which the plan's queue left open: the import is applied first
   * and the component dispatch afterward, and the section's own dispatch is last. Neither
   * position is a denial of the other — a component-level name says "apply this wherever it
   * is defined" and a section-level one says "apply this here" — so they stack, and the
   * section gets the last word because it named that one target specifically.
   */
  const project = () => compileProject({
    ...BASE,
    'components/pe.cl.yaml': [
      'branches:',
      '  flashback: lighter',
      'sections:',
      '  genre:',
      '    text: "Genre: Thriller"',
      '    render: {position: 1}',
      '    branches: {flashback: noir}',
      '    variants:',
      '      lighter: {text: "Genre: Caper"}',
      '      noir: {text: "+{ (in monochrome) }"}',
      '  tone:',
      '    text: "Write with weight."',
      '    render: {position: 2}',
      '    variants:',
      '      lighter: {text: "Write with a light touch."}',
      '  cast:',
      '    slot: true',
      '    render: {position: 3}',
    ].join('\n'),
  });

  test('both apply, component first and section last', () => {
    const text = pe(project().tmpDir, 'flashback');
    expect(text).toContain('Genre: Caper');
    expect(text).toContain('(in monochrome)');
    expect(text).not.toContain('Thriller');
  });

  test('a section with no dispatch of its own still receives the fan-out', () => {
    expect(pe(project().tmpDir, 'flashback')).toContain('Write with a light touch.');
  });

  test('neither position reports anything, because both matched', () => {
    const { diagnostics } = project();
    expect(codes(diagnostics, 'CL0604')).toHaveLength(0);
    expect(codes(diagnostics, 'CL0605')).toHaveLength(0);
  });
});

// ── Exclusion ────────────────────────────────────────────────────────────────

describe('~ at component level excludes the component from the branch', () => {
  const project = () => compileProject({
    ...BASE,
    'components/pe.cl.yaml': [
      'branches:',
      '  flashback: ~',
      SECTIONS,
    ].join('\n'),
  });

  test('no component file is written on that branch', () => {
    expect(fs.existsSync(peFile(project().tmpDir, 'flashback'))).toBe(false);
  });

  test('the other branch still writes its file in full', () => {
    const { tmpDir } = project();
    expect(fs.existsSync(peFile(tmpDir, 'plain'))).toBe(true);
    expect(pe(tmpDir, 'plain')).toContain('Genre: Thriller');
  });

  test('it is not CL0615 — an exclusion is not a component that resolved away', () => {
    // The distinction the null return exists for. An empty render means every section
    // resolved away, which is an ERROR about the source; an exclusion is the author saying
    // this branch does not get this component, and writing no file is the whole request.
    const { diagnostics } = project();
    expect(codes(diagnostics, 'CL0615')).toHaveLength(0);
    expect(diagnostics.errors.map((d) => d.code)).not.toContain('CL0615');
  });

  test('an item whose only target was an excluded slot is CL0610 there', () => {
    // §7.4's third row, reached through the new position. Gating stays legitimate until it
    // makes an item vanish from every output it declared — and then it is the no-output
    // invariant that says so, not an undeclared-slot typo report.
    const { diagnostics } = compileProject({
      ...BASE,
      'Codex/items.yaml': [
        '- id: Ghost',
        '  name: Ghost',
        '  body: {Tagline: Ghost Vale}',
        '  render: {template: Character, storyCard: false, plotEssential: {slot: cast}}',
      ].join('\n'),
      'components/pe.cl.yaml': [
        'branches:',
        '  flashback: ~',
        SECTIONS,
      ].join('\n'),
    });
    const found = codes(diagnostics, 'CL0610');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('flashback');
    expect(codes(diagnostics, 'CL0611')).toHaveLength(0);
  });
});

// ── With imports ─────────────────────────────────────────────────────────────

describe('the fan-out reaches variants an import contributed', () => {
  test('a component dispatch finds a variant declared in the imported section', () => {
    // The queue item this closes: the import is resolved first, so by the time the dispatch
    // runs the imported variants are the section's own and nothing distinguishes them.
    const { tmpDir, diagnostics } = compileProject({
      ...BASE,
      'shared/base.cl.yaml': SECTIONS,
      'components/pe.cl.yaml': [
        'imports:',
        '  - from: ./shared/base.cl.yaml',
        'branches:',
        '  flashback: lighter',
      ].join('\n'),
    });
    expect(diagnostics.errors).toHaveLength(0);
    const text = pe(tmpDir, 'flashback');
    expect(text).toContain('Genre: Caper');
    expect(text).toContain('Write with a light touch.');
  });

  test('an imported section carrying its own branches: still dispatches under the fan-out', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'shared/base.cl.yaml': [
        'sections:',
        '  genre:',
        '    text: "Genre: Thriller"',
        '    render: {position: 1}',
        '    branches: {flashback: noir}',
        '    variants:',
        '      lighter: {text: "Genre: Caper"}',
        '      noir: {text: "+{ (in monochrome) }"}',
        '  cast:',
        '    slot: true',
        '    render: {position: 2}',
      ].join('\n'),
      'components/pe.cl.yaml': [
        'imports:',
        '  - from: ./shared/base.cl.yaml',
        'branches:',
        '  flashback: lighter',
      ].join('\n'),
    });
    const text = pe(tmpDir, 'flashback');
    expect(text).toContain('Genre: Caper');
    expect(text).toContain('(in monochrome)');
  });
});
