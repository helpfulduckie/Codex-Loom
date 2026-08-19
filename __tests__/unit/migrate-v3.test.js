'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const {
  migrateConfigFile, migrateProject, collectComponentAliases, collectCanonNames,
  rewriteAtTokens, migrateItemDocument, migrateItemFiles, stripTemplateHeader,
  encodeTriggerPadding,
} = require('../../src/migrate/v3');
const { renameConfigToCl, migrateProjectFully } = require('../../src/migrate');

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mig-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeConfig(yaml) {
  const p = path.join(tmpDir, 'compile.yaml');
  fs.writeFileSync(p, yaml, 'utf8');
  return p;
}

const V3 = [
  '# A comment that must survive',
  'structure:',
  '  input:',
  '    cards:',
  '      - ./Codex',
  '    canon:',
  '      characters: ./canon/Characters',
  '    components:',
  '      plotEssential:',
  '        pe: ./components/pe.yaml',
  '      openingChoice:',
  '        ask: Which path?',
  '      scripts:',
  '        bundle: ./scripts/lib',
  '  output: ../out',
  '  overview: ./Review',
  'components:',
  "  plotEssential: '{@pe}'",
  "  openingChoice: '{@ask}'",
  "  scripts: '{@bundle}'",
  '',
].join('\n');

describe('the §14.2 config transformations', () => {
  let migrated;
  beforeEach(() => { migrated = migrateConfigFile(writeConfig(V3)).output; });

  test('adds version: 4 — its absence is what identifies a v3 project', () => {
    expect(migrated).toMatch(/^version: 4$/m);
  });

  test('renames structure.input.cards to items', () => {
    expect(migrated).toMatch(/^ {4}items:$/m);
    expect(migrated).not.toMatch(/^ {4}cards:$/m);
  });

  test('renames structure.overview to reports', () => {
    expect(migrated).toMatch(/^ {2}reports: \.\/Review$/m);
    expect(migrated).not.toContain('overview:');
  });

  test('deletes structure.input.components entirely', () => {
    expect(migrated).not.toMatch(/^ {4}components:$/m);
  });

  test('inlines a {@} component alias to the value it was declared as', () => {
    expect(migrated).toContain('plotEssential: ./components/pe.yaml');
    expect(migrated).not.toContain('{@pe}');
  });

  test('inlines a literal alias, not just a path', () => {
    expect(migrated).toContain('branchFraming: Which path?');
  });

  test('renames components.openingChoice to branchFraming', () => {
    expect(migrated).not.toContain('openingChoice');
  });

  test('moves components.scripts to top level', () => {
    expect(migrated).toMatch(/^scripts: \.\/scripts\/lib$/m);
  });

  test('preserves comments — a migrator that strips them is one you run once', () => {
    expect(migrated).toContain('# A comment that must survive');
  });

  test('leaves no {@} tokens behind', () => {
    expect(migrated).not.toContain('{@');
  });

  test('reports every transformation it applied', () => {
    const { changes } = migrateConfigFile(writeConfig(V3), { dryRun: true });
    expect(changes.join(' ')).toContain('cards → items');
    expect(changes.join(' ')).toContain('version: 4');
  });

  test('dryRun leaves the file untouched', () => {
    const p = writeConfig(V3);
    migrateConfigFile(p, { dryRun: true });
    expect(fs.readFileSync(p, 'utf8')).toBe(V3);
  });
});

describe('canon names become {%} variables', () => {
  test('a canon reference changes sigil rather than being inlined', () => {
    const migrated = migrateConfigFile(writeConfig([
      'structure:',
      '  input:',
      '    canon:',
      '      characters: ./canon/Characters',
      '  output: ./out',
      'components:',
      "  plotEssential: '{@characters}/pe.yaml'",
      '',
    ].join('\n'))).output;
    expect(migrated).toContain('{%characters}/pe.yaml');
  });

  test('collectCanonNames reads the declared names', () => {
    expect([...collectCanonNames({ structure: { input: { canon: { a: 1, b: 2 } } } })])
      .toEqual(['a', 'b']);
  });

  test('collectComponentAliases flattens every type into one map', () => {
    const aliases = collectComponentAliases({
      structure: { input: { components: { plotEssential: { pe: 'x' }, scripts: { s: 'y' } } } },
    });
    expect(aliases.get('pe')).toBe('x');
    expect(aliases.get('s')).toBe('y');
  });

  test('an absent components block yields no aliases', () => {
    expect(collectComponentAliases({}).size).toBe(0);
  });
});

describe('rewriteAtTokens', () => {
  const aliases = new Map([['pe', './pe.yaml']]);
  const canon = new Set(['characters']);

  test('canon name → {%}', () => {
    expect(rewriteAtTokens('{@characters}/A.yaml', aliases, canon, [])).toBe('{%characters}/A.yaml');
  });

  test('component alias → its value', () => {
    expect(rewriteAtTokens('{@pe}', aliases, canon, [])).toBe('./pe.yaml');
  });

  test('matches an alias case-insensitively', () => {
    expect(rewriteAtTokens('{@PE}', aliases, canon, [])).toBe('./pe.yaml');
  });

  test('an unknown name is left alone and reported rather than guessed at', () => {
    const unresolved = [];
    expect(rewriteAtTokens('{@nope}', aliases, canon, unresolved)).toBe('{@nope}');
    expect(unresolved).toEqual(['nope']);
  });

  test('rewrites several tokens in one string', () => {
    expect(rewriteAtTokens('{@characters}/{@pe}', aliases, canon, [])).toBe('{%characters}/./pe.yaml');
  });

  test('leaves text with no tokens untouched', () => {
    expect(rewriteAtTokens('plain', aliases, canon, [])).toBe('plain');
  });

  test.each([null, undefined, 42])('returns %p unchanged', (value) => {
    expect(rewriteAtTokens(value, aliases, canon, [])).toBe(value);
  });
});

describe('migrateProject — the whole tree, not just compile.yaml', () => {
  test('rewrites {@} in item and component files beside the config', () => {
    // `include: '{@characters}/You.yaml'` in an item file is the common case; migrating
    // only compile.yaml would leave the project half-converted.
    const cfg = writeConfig([
      'structure:',
      '  input:',
      '    canon:',
      '      characters: ./canon/Characters',
      '    components:',
      '      description:',
      '        body: ./components/body.md',
      '  output: ./out',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(tmpDir, 'Codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'Codex', 'items.yaml'), "- include: '{@characters}/You.yaml'\n", 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'desc.yaml'), "body: '{@body}'\n", 'utf8');

    const report = migrateProject(cfg);

    expect(fs.readFileSync(path.join(tmpDir, 'Codex', 'items.yaml'), 'utf8'))
      .toContain('{%characters}/You.yaml');
    expect(fs.readFileSync(path.join(tmpDir, 'desc.yaml'), 'utf8'))
      .toContain('./components/body.md');
    expect(report.filesTouched).toHaveLength(2);
    expect(report.unresolved).toEqual([]);
  });

  test('reports an unresolved reference rather than silently leaving it', () => {
    const cfg = writeConfig('structure:\n  output: ./out\n');
    fs.writeFileSync(path.join(tmpDir, 'x.yaml'), "a: '{@mystery}'\n", 'utf8');
    const report = migrateProject(cfg);
    expect(report.unresolved.map((u) => u.name)).toContain('mystery');
  });
});

// ── Phase 2: the item and template rules (§4.2, §8.3, §8.4) ──────────────────

describe('stripTemplateHeader', () => {
  test('removes everything up to and including the last fence', () => {
    const template = [
      '## {$name.full}',
      '~~~',
      'triggers: [{join(", ", $aid.triggers)}]',
      '{if $aid.known}',
      "notes: '[e]'",
      '{/if}',
      '~~~',
      '{wrapper}',
      '{$body.tagline}',
    ].join('\n');
    expect(stripTemplateHeader(template)).toBe('{wrapper}\n{$body.tagline}');
  });

  test('the LAST fence, not the second — a conditional notes: block moves the closing one', () => {
    expect(stripTemplateHeader('## A\n~~~\nx\n~~~\nbody\n~~~\ntail')).toBe('tail');
  });

  test('a template with no fence is already body-only and is left alone', () => {
    const body = '{wrapper}\n{$body.tagline}\n{/wrapper}';
    expect(stripTemplateHeader(body)).toBe(body);
  });
});

describe('encodeTriggerPadding', () => {
  test('a plainly padded value becomes the _ form', () => {
    expect(encodeTriggerPadding(' Era ').value).toBe('_Era_');
  });

  test("v3's quoting hack unwraps to the same _ form", () => {
    // The author wrote '" tea "' so the quotes would survive into the unquoted fence and
    // VL's own YAML parse would strip them, leaving the padding. Both spellings collapse.
    expect(encodeTriggerPadding('" tea "').value).toBe('_tea_');
    expect(encodeTriggerPadding("' meal '").value).toBe('_meal_');
  });

  test('padding on one side only encodes one side', () => {
    expect(encodeTriggerPadding('" bout"').value).toBe('_bout');
  });

  test('an unpadded value is untouched', () => {
    expect(encodeTriggerPadding('Kaiden').value).toBe('Kaiden');
    expect(encodeTriggerPadding('Kaiden').note).toBeNull();
  });

  test('an edge underscore is reported rather than rewritten', () => {
    // A v3 literal underscore and an already-encoded space are the same characters, so
    // the migrator cannot tell them apart and must not guess.
    const result = encodeTriggerPadding('_Aria');
    expect(result.value).toBe('_Aria');
    expect(result.note).toMatch(/edge underscore/);
  });
});

describe('migrateItemDocument', () => {
  const migrate = (yaml) => {
    const doc = YAML.parseDocument(yaml);
    const result = migrateItemDocument(doc);
    return { text: doc.toString({ lineWidth: 0, flowCollectionPadding: false }), ...result };
  };

  /**
   * §4.8's migration step, and it is deliberately not a transformation. `kind:` is new in
   * v4 with no v3 predecessor, so there is nothing to convert; what a v3 project offers is
   * a *candidate list*, and turning a candidate into a declaration is the guess the field
   * exists to stop the compiler making.
   */
  describe('kind: reference candidates (§4.8)', () => {
    test('a trigger-less card is listed for review and left untouched', () => {
      const { text, notes, changes } = migrate(
        '- id: WTG Time Config\n  aid:\n    type: System\n    triggers: []\n');
      expect(text).not.toContain('kind:');
      expect(changes.kindCandidates).toBe(1);
      expect(notes.join('\n')).toContain('"WTG Time Config" has no triggers');
      expect(notes.join('\n')).toContain('kind: reference');
    });

    test('a card with no aid.triggers key at all is a candidate too', () => {
      const { changes } = migrate('- id: Quiet\n  aid:\n    type: Character\n');
      expect(changes.kindCandidates).toBe(1);
    });

    test('a card with triggers is not a candidate', () => {
      const { notes, changes } = migrate(
        '- id: Aria\n  aid:\n    type: Character\n    triggers: [Aria]\n');
      expect(changes.kindCandidates).toBe(0);
      expect(notes).toEqual([]);
    });

    test('a variant is not listed — the queue names items, and a variant has no id', () => {
      const { changes } = migrate(
        '- id: Aria\n  aid:\n    type: Character\n    triggers: [Aria]\n'
        + '  variants:\n    Ghost:\n      aid:\n        triggers: []\n');
      expect(changes.kindCandidates).toBe(0);
    });
  });

  test('aid.known: true becomes a structured top-level notes marker', () => {
    // `notes: {known: true}` rather than the `notes: '[e]'` v3 literally emitted: a
    // convention pack cannot read `[e]` back out of free text, and a branch that does not
    // load the mod cannot switch a baked-in string off. The flag stays data; a template
    // renders it (§4.5.1).
    const { text } = migrate('- id: A\n  aid:\n    type: Character\n    known: true\n');
    expect(text).toContain('notes: {known: true}');
    expect(text).not.toContain('aid:\n    known:');
    expect(text).not.toContain('[e]');
  });

  test('converting any known: reports that a notes template is still needed', () => {
    const dir = path.join(tmpDir, 'items');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.yaml'), '- id: A\n  aid:\n    known: true\n', 'utf8');
    const { notes } = migrateItemFiles(dir);
    // Without one the flag is carried and never written, and every [e] in the project
    // disappears silently — the failure mode worth one loud line.
    expect(notes.map((n) => n.note).join(' ')).toMatch(/notes template/);
  });

  test('aid.known: false leaves no notes at all', () => {
    // The emitter omits the notes line for empty text, so these 28 items keep emitting
    // no `notes:` key — which is what makes the reshape byte-preserving.
    const { text } = migrate('- id: A\n  aid:\n    known: false\n');
    expect(text).not.toContain('notes');
  });

  test('the marker lands beside aid:, not appended after body:', () => {
    const { text } = migrate('- id: A\n  aid:\n    known: true\n  body:\n    tagline: x\n');
    expect(text.indexOf('notes:')).toBeLessThan(text.indexOf('body:'));
  });

  test('aid.encapsulate is dropped', () => {
    const { text, changes } = migrate('- id: A\n  aid:\n    encapsulate: false\n');
    expect(text).not.toContain('encapsulate');
    expect(changes.encapsulate).toBe(1);
  });

  test('a redundant aid.title is dropped, and a distinct one is kept', () => {
    const redundant = migrate('- id: A\n  name:\n    full: A Vale\n  aid:\n    title: A Vale\n');
    expect(redundant.text).not.toContain('title:');
    expect(redundant.notes[0]).toMatch(/aid\.title/);

    const distinct = migrate('- id: A\n  name:\n    full: A Vale\n  aid:\n    title: The Stranger\n');
    expect(distinct.text).toContain('title: The Stranger');
  });

  test('variants are migrated too, not just declarations', () => {
    // A variant carries its own aid: block, and `known:` surviving inside one is the
    // hardest case to spot by eye.
    const { text } = migrate([
      '- id: A',
      '  aid:',
      '    triggers: [a]',
      '  variants:',
      '    alt:',
      '      aid:',
      '        triggers: [" b "]',
      '        known: true',
    ].join('\n'));
    expect(text).toContain('triggers: [_b_]');
    // The flag moved out of aid: and onto the variant as notes data.
    expect(text).toContain('notes: {known: true}');
    expect(text).not.toMatch(/^\s+known:/m);
  });

  test('render.stripFence goes with the envelope it stripped', () => {
    const { text, changes } = migrate('- render:\n    stripFence: true\n    template: X\n');
    expect(text).not.toContain('stripFence');
    expect(changes.stripFence).toBe(1);
  });

  test('comments survive', () => {
    const { text } = migrate('# keep me\n- id: A\n  aid:\n    known: true\n');
    expect(text).toContain('# keep me');
  });
});

/**
 * §14.2's rename row, which the migrator half-implemented for four phases.
 *
 * The row reads "Add `version: 4`; rename to `.cl.yaml`" at high confidence. `version: 4`
 * landed; the rename never did, and nothing failed — the loader accepts `compile.yaml`, so
 * a migrated project kept the v3 name and the discrepancy was invisible. §4.6 is why it is
 * an option rather than a default: plain `.yaml` is not deprecated and `--migrate` renames
 * only when asked.
 */
describe('renaming the entry point to compile.cl.yaml (§4.6)', () => {
  test('off by default — a migrated project keeps compile.yaml', () => {
    // Not dryRun: the later stages read the project back through the compiler's loader,
    // which rejects a config the earlier stages were told not to write.
    const configPath = writeConfig(V3);
    migrateProjectFully(configPath);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'compile.cl.yaml'))).toBe(false);
  });

  test('on request, the file moves and the new path comes back', () => {
    const configPath = writeConfig(V3);
    const result = renameConfigToCl(configPath);

    expect(result.changed).toBe(true);
    expect(result.configPath).toBe(path.join(tmpDir, 'compile.cl.yaml'));
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.readFileSync(result.configPath, 'utf8')).toContain('A comment that must survive');
  });

  test('dryRun reports the rename it would make without making it', () => {
    const configPath = writeConfig(V3);
    const result = renameConfigToCl(configPath, { dryRun: true });

    expect(result.notes).toEqual([expect.stringMatching(/renamed compile\.yaml/)]);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  test('an existing compile.cl.yaml is never overwritten', () => {
    const configPath = writeConfig(V3);
    const target = path.join(tmpDir, 'compile.cl.yaml');
    fs.writeFileSync(target, 'version: 4\n', 'utf8');

    const result = renameConfigToCl(configPath);

    expect(result.changed).toBe(false);
    expect(result.notes).toEqual([expect.stringMatching(/already exists/)]);
    expect(fs.readFileSync(target, 'utf8')).toBe('version: 4\n');
    expect(fs.existsSync(configPath)).toBe(true);
  });

  test('a project already on compile.cl.yaml is left alone, silently', () => {
    const configPath = path.join(tmpDir, 'compile.cl.yaml');
    fs.writeFileSync(configPath, V3, 'utf8');

    expect(renameConfigToCl(configPath)).toEqual({
      notes: [], changed: false, configPath,
    });
  });

  test('renameToCl runs after every stage that reads the project back', () => {
    const configPath = writeConfig(V3);
    const result = migrateProjectFully(configPath, { renameToCl: true });

    expect(result.configPath).toBe(path.join(tmpDir, 'compile.cl.yaml'));
    expect(result.notes).toContainEqual(expect.stringMatching(/renamed compile\.yaml/));
    // The config transformations still landed, which is what proves the rename came last
    // rather than orphaning the stages that read `configPath`.
    expect(fs.readFileSync(result.configPath, 'utf8')).toMatch(/^version: 4$/m);
  });
});
