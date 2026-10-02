'use strict';

/**
 * The arity silence rule and CL0326, end to end (v4 Phase 6, Step 0).
 *
 * These are integration tests because arity is a property of the *directive*, not of the
 * variant walk. `collectVariantDeltas` sees one item and cannot know whether the name it
 * was handed was aimed at that item alone or at every item in a lore file; only the loader
 * knows, and only the loader can count the matches CL0326 reports on. A unit test of the
 * walk asserts the parameter is honored — `resolver.test.js` does that — and says nothing
 * about whether the right callers pass it.
 *
 * The arity-1 half is here for the same reason and matters more: `import:` +
 * `importVariants:` and an item's own `branches:` share `collectVariantDeltas` with the two
 * arms that just went silent, so a shared-parameter refactor is exactly the change that
 * could take their warnings with it.
 */

const path = require('path');
const fs = require('fs');
const { compileProject } = require('../helpers/project');

const codes = (diagnostics, code) => diagnostics.all.filter((d) => d.code === code);

const CONFIG = [
  'version: 4',
  'variables: {here: .}',
  'structure:',
  '  input:',
  '    items: [%TMP%/Codex]',
  '    templates: [%TMP%/templates]',
  '  output: %TMP%/output',
  'branches:',
  '  plain: {}',
].join('\n');

/** Three items, exactly one of which defines `warm` — the shape an include produces. */
const LORE = [
  '- id: Chandler',
  '  name: Chandler',
  '  aid: {type: Character, triggers: [Chandler]}',
  '  body: {Tagline: Keeps the ledger.}',
  '  variants:',
  '    warm:',
  '      body: {Tagline: The lamp is lit.}',
  '- id: Doorman',
  '  name: Doorman',
  '  aid: {type: Character, triggers: [Doorman]}',
  '  body: {Tagline: Defines no variants.}',
  '- id: Errand',
  '  name: Errand',
  '  aid: {type: Character, triggers: [Errand]}',
  '  body: {Tagline: Defines no variants either.}',
].join('\n');

const BASE = {
  'templates/Character.template': '{$body.Tagline}',
  'compile.yaml': CONFIG,
  'canon/lore.yaml': LORE,
};

const compiled = (tmpDir) => fs.readFileSync(
  path.join(tmpDir, 'output', 'Branches', 'plain', 'Story Cards', 'Character', 'Character.md'),
  'utf8',
);

// ── The silence, and that it is silence rather than skipping ─────────────────

describe("an include's importVariants: is silent where an item does not define the name", () => {
  const project = (selectors) => compileProject({
    ...BASE,
    'Codex/items.yaml': [
      `- include: '{%here}/canon/lore.yaml'`,
      `  importVariants: ${selectors}`,
    ].join('\n'),
  });

  test('two items missing the variant raise no CL0321 at all', () => {
    expect(codes(project('warm').diagnostics, 'CL0321')).toHaveLength(0);
  });

  test('the item that does define it still gets the variant applied', () => {
    // Silence must not become skipping. Before Step 0 this worked and warned twice; the
    // risk in silencing is applying nothing at all and looking identical on the bus.
    const text = compiled(project('warm').tmpDir);
    expect(text).toContain('The lamp is lit.');
    expect(text).not.toContain('Keeps the ledger.');
  });

  test('a selector matching no item at all raises CL0326 once, naming the count', () => {
    const found = codes(project('[warm, wrm]').diagnostics, 'CL0326');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"wrm"');
    expect(found[0].message).toContain('3 items');
    expect(found[0].severity).toBe('warn');
  });

  test('CL0326 fires once for the compile, not once per branch', () => {
    // `importVariants:` selects from the imported source unconditionally, so its answer does
    // not depend on the branch (§7.6.2a). Reporting it per leaf would put one typo warning
    // on all 32 of The Institute's leaves.
    const { diagnostics } = compileProject({
      ...BASE,
      'compile.yaml': CONFIG.replace('  plain: {}', '  plain: {}\n  gated: {}'),
      'Codex/items.yaml': [
        `- include: '{%here}/canon/lore.yaml'`,
        '  importVariants: [wrm]',
      ].join('\n'),
    });
    expect(codes(diagnostics, 'CL0326')).toHaveLength(1);
  });

  test('a selector that does match raises nothing', () => {
    expect(codes(project('warm').diagnostics, 'CL0326')).toHaveLength(0);
  });
});

describe("an include's branches: is silent on the same rule", () => {
  const project = (dispatch) => compileProject({
    ...BASE,
    'Codex/items.yaml': [
      `- include: '{%here}/canon/lore.yaml'`,
      '  branches:',
      `    plain: ${dispatch}`,
    ].join('\n'),
  });

  test('two items missing the variant raise no CL0321', () => {
    expect(codes(project('warm').diagnostics, 'CL0321')).toHaveLength(0);
  });

  test('the item defining it is still dispatched', () => {
    expect(compiled(project('warm').tmpDir)).toContain('The lamp is lit.');
  });

  test('a dispatch matching no item raises CL0326 naming the branch', () => {
    const found = codes(project('[warm, wrm]').diagnostics, 'CL0326');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"wrm"');
    expect(found[0].message).toContain('plain');
  });
});

// ── Directory includes ───────────────────────────────────────────────────────

describe('an include naming a directory', () => {
  /** `warm` lives only in the nested file, so a per-file count would miss it in lore.yaml. */
  const NESTED = [
    '- id: Lamplighter',
    '  name: Lamplighter',
    '  aid: {type: Character, triggers: [Lamplighter]}',
    '  body: {Tagline: Walks the rounds.}',
  ].join('\n');
  const project = (include, extra = {}) => compileProject({
    ...BASE,
    'canon/deeper/rounds.yaml': NESTED,
    'Codex/items.yaml': include,
    ...extra,
  });

  test('loads the items of every YAML file under it, nested ones included', () => {
    const text = compiled(project(`- include: '{%here}/canon'`).tmpDir);
    expect(text).toContain('Keeps the ledger.');
    expect(text).toContain('Walks the rounds.');
  });

  test('an importVariants: selector defined in one file of the directory raises no CL0326', () => {
    const { diagnostics, tmpDir } = project([
      `- include: '{%here}/canon'`,
      '  importVariants: [warm]',
    ].join('\n'));
    expect(codes(diagnostics, 'CL0326')).toHaveLength(0);
    expect(compiled(tmpDir)).toContain('The lamp is lit.');
  });

  test('a selector no file defines raises CL0326 once, counting every item in the directory', () => {
    const found = codes(project([
      `- include: '{%here}/canon'`,
      '  importVariants: [wrm]',
    ].join('\n')).diagnostics, 'CL0326');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('4 items');
    expect(found[0].message).toContain('canon/');
  });

  test('a branches: dispatch is counted across the directory, not per file', () => {
    const dispatch = (name) => project([
      `- include: '{%here}/canon'`,
      '  branches:',
      `    plain: ${name}`,
    ].join('\n')).diagnostics;
    expect(codes(dispatch('warm'), 'CL0326')).toHaveLength(0);
    const found = codes(dispatch('wrm'), 'CL0326');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('4 items');
  });

  test('a file under the directory included again on its own raises CL0131', () => {
    const { diagnostics } = project([
      `- include: '{%here}/canon'`,
      `- include: '{%here}/canon/lore.yaml'`,
    ].join('\n'));
    expect(codes(diagnostics, 'CL0131')).toHaveLength(1);
  });

  test('a directory holding no YAML files raises CL0130', () => {
    const { diagnostics } = project(`- include: '{%here}/notes'`, { 'notes/readme.txt': 'not items' });
    const found = codes(diagnostics, 'CL0130');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('holds no YAML files');
  });
});

// ── Included items are normalized like any other ────────────────────────────

describe('an included item', () => {
  test('reads a `variables:` block as `v`, as a library or project item does', () => {
    const { tmpDir } = compileProject({
      ...BASE,
      'canon/church.yaml': [
        '- id: Church',
        '  name: Church',
        '  aid: {type: Character, triggers: [Church]}',
        '  variables: {empire: Heliador}',
        '  body: {Tagline: "Religion of {$v.empire}"}',
      ].join('\n'),
      'Codex/items.yaml': `- include: '{%here}/canon/church.yaml'`,
    });
    expect(compiled(tmpDir)).toContain('Religion of Heliador');
  });
});

// ── The arity-1 half, unchanged ──────────────────────────────────────────────

describe('the arity-1 positions still warn per miss', () => {
  test("an item's own branches: naming a variant it does not define warns", () => {
    const { diagnostics } = compileProject({
      'templates/Character.template': '{$body.Tagline}',
      'compile.yaml': CONFIG,
      'Codex/items.yaml': [
        '- id: Solo',
        '  name: Solo',
        '  aid: {type: Character, triggers: [Solo]}',
        '  body: {Tagline: One target, one selector.}',
        '  branches: {plain: nosuch}',
      ].join('\n'),
    });
    const found = codes(diagnostics, 'CL0321');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"nosuch"');
  });

  test('import: + importVariants: on a single item warns on a miss', () => {
    // The half most at risk from a shared-parameter refactor: this call site and the
    // include's sit six lines apart in `model/item.js` and share one function.
    const { diagnostics } = compileProject({
      'templates/Character.template': '{$body.Tagline}',
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    library: {general: %TMP%/canon}',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'branches:',
        '  plain: {}',
      ].join('\n'),
      'canon/lore.cl.yaml': LORE,
      'Codex/items.yaml': [
        '- id: Porter',
        '  import: general:Doorman',
        '  importVariants: warm',
      ].join('\n'),
    });
    const found = codes(diagnostics, 'CL0321');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"warm"');
    expect(codes(diagnostics, 'CL0326')).toHaveLength(0);
  });
});
