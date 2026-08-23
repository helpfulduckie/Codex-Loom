'use strict';

/**
 * Phase 8 Step 3's pseudo-role conversion (§9.1, §9.2, §9.5) — the migrator's own end of
 * the roles feature: a v3 variable whose value names an item, standing in for the
 * indirection `roles:` gives a name.
 *
 * `migratePseudoRoles` needs a registry, so it runs the project back through the
 * compiler's own loader (`loadCompileConfig`) the same way `wireNotesTemplate` does — which
 * makes this an integration-shaped unit test, in `roles.integration.test.js`'s style,
 * rather than a pure-function test. The pure helpers it's built from (`rewritePseudoRoleTokens`,
 * `GENDERED_PRONOUN_RE`) get their own direct coverage below.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const YAML = require('yaml');
const {
  migratePseudoRoles, migrateProjectFully, rewritePseudoRoleTokens,
  GENDERED_PRONOUN_RE, GENDERED_PRONOUN_WORDS,
} = require('../../src/migrate');

const dirs = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function buildProject(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-pseudo-role-'));
  dirs.push(tmpDir);
  const slash = (p) => p.replace(/\\/g, '/');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.replace(/%TMP%/g, slash(tmpDir)), 'utf8');
  }
  return tmpDir;
}

const BASE = {
  'templates/Full.template': '{$name.full} - {$body.Tagline}',
};

const ITEM_WITH_LI = [
  '- id: Malcolm',
  '  name: {display: Malcolm, full: Malcolm Vale}',
  '  pronouns: male',
  '  aid: {type: Character, triggers: [Malcolm]}',
  '  render: {template: Full}',
  '  body:',
  '    Tagline: "You think of {%li} and how his silence still stings."',
].join('\n');

/** A minimal v4-loadable project with one pseudo-role variable, in item body and inline
 * component text alike — §9.7's claim that the queue covers both. */
function pseudoRoleProject() {
  return {
    ...BASE,
    'Codex/items.yaml': ITEM_WITH_LI,
    'compile.yaml': [
      'version: 4',
      'structure:',
      '  input:',
      '    items: [%TMP%/Codex]',
      '    templates: [%TMP%/templates]',
      '  output: %TMP%/output',
      'variables:',
      '  li: Malcolm',
      'components:',
      '  branchFraming: "Everyone here knows {%li}; his reputation precedes him."',
      'branches:',
      '  main: {}',
      '',
    ].join('\n'),
  };
}

describe('rewritePseudoRoleTokens', () => {
  test('rewrites a plain token', () => {
    const { text, changed } = rewritePseudoRoleTokens('You see {%li} waiting.', 'li', 'LI');
    expect(changed).toBe(true);
    expect(text).toBe('You see {$LI} waiting.');
  });

  test('moves a trailing possessive inside the brace, per pronouns.js\'s possessive form', () => {
    const { text, changed } = rewritePseudoRoleTokens("touch {%li}'s hand", 'li', 'LI');
    expect(changed).toBe(true);
    expect(text).toBe("touch {$LI's} hand");
  });

  test('matches the source token case-insensitively and writes the role name as given', () => {
    const { text } = rewritePseudoRoleTokens('{%LI} arrives', 'li', 'LI');
    expect(text).toBe('{$LI} arrives');
  });

  test('leaves unrelated text untouched', () => {
    const { text, changed } = rewritePseudoRoleTokens('nothing to see here', 'li', 'LI');
    expect(changed).toBe(false);
    expect(text).toBe('nothing to see here');
  });
});

describe('GENDERED_PRONOUN_RE — built from PRONOUN_SETS, not a hand-written word list', () => {
  test('matches every female and male pronoun field', () => {
    for (const word of GENDERED_PRONOUN_WORDS) {
      expect(GENDERED_PRONOUN_RE.test(`about ${word} yesterday`)).toBe(true);
    }
  });

  test('does not match "is"/"was", shared by every pronoun set including gendered ones', () => {
    expect(GENDERED_PRONOUN_RE.test('this is fine, it was there')).toBe(false);
  });

  test('does not match nonbinary or "you" pronouns', () => {
    expect(GENDERED_PRONOUN_RE.test('they walked, you walked, them and their things')).toBe(false);
  });
});

describe('migratePseudoRoles', () => {
  test('converts the variable to a role at the node it was declared', () => {
    const tmpDir = buildProject(pseudoRoleProject());
    const configPath = path.join(tmpDir, 'compile.yaml');
    const result = migratePseudoRoles(configPath);

    expect(result.conversions).toEqual([{ name: 'li', roleName: 'LI', values: ['Malcolm'] }]);

    const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.roles.LI).toBe('Malcolm');
    expect(config.variables.li).toBeUndefined();
  });

  test('rewrites {%li} to {$LI} in the item body', () => {
    const tmpDir = buildProject(pseudoRoleProject());
    const configPath = path.join(tmpDir, 'compile.yaml');
    migratePseudoRoles(configPath);

    const itemText = fs.readFileSync(path.join(tmpDir, 'Codex', 'items.yaml'), 'utf8');
    expect(itemText).toContain('{$LI}');
    expect(itemText).not.toContain('{%li}');
  });

  test('reaches a component section written inline in compile.yaml, not only item bodies (§9.7)', () => {
    const tmpDir = buildProject(pseudoRoleProject());
    const configPath = path.join(tmpDir, 'compile.yaml');
    migratePseudoRoles(configPath);

    const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.components.branchFraming).toBe('Everyone here knows {$LI}; his reputation precedes him.');
  });

  test('the review queue names both the item body and the component section', () => {
    const tmpDir = buildProject(pseudoRoleProject());
    const configPath = path.join(tmpDir, 'compile.yaml');
    const result = migratePseudoRoles(configPath);

    const inItem = result.reviewQueue.find((e) => e.file.includes('items.yaml'));
    const inConfig = result.reviewQueue.find((e) => e.file === 'compile.yaml');
    expect(inItem).toBeDefined();
    expect(inItem.text).toContain('his silence');
    expect(inConfig).toBeDefined();
    expect(inConfig.text).toContain('his reputation');
  });

  test('a variable never written as {%name} in prose does not convert, even with an item-id value', () => {
    // The Institute's own false-positive risk: `protag`/`liname` resolve to item ids too,
    // but are only ever used to build another variable's value, never as {%name} in prose.
    const files = pseudoRoleProject();
    files['compile.yaml'] = files['compile.yaml'].replace(
      'variables:\n  li: Malcolm',
      'variables:\n  li: Malcolm\n  other: Malcolm',
    );
    const tmpDir = buildProject(files);
    const configPath = path.join(tmpDir, 'compile.yaml');
    const result = migratePseudoRoles(configPath);

    expect(result.conversions.map((c) => c.name)).toEqual(['li']);
    const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.variables.other).toBe('Malcolm');
  });

  test('a variable whose value never resolves to a known item id does not convert', () => {
    const files = pseudoRoleProject();
    files['compile.yaml'] = files['compile.yaml'].replace('li: Malcolm', 'li: Ghost');
    const tmpDir = buildProject(files);
    const configPath = path.join(tmpDir, 'compile.yaml');
    const result = migratePseudoRoles(configPath);

    expect(result.conversions).toEqual([]);
    const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.variables.li).toBe('Ghost');
    expect(config.roles).toBeUndefined();
  });

  test('a name used in prose but never declared as a variable produces no candidate', () => {
    const files = {
      ...BASE,
      'Codex/items.yaml': ITEM_WITH_LI,
      'compile.yaml': [
        'version: 4',
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'branches:',
        '  main: {}',
        '',
      ].join('\n'),
    };
    const tmpDir = buildProject(files);
    const configPath = path.join(tmpDir, 'compile.yaml');
    const result = migratePseudoRoles(configPath);

    expect(result).toEqual({ notes: [], touched: [], conversions: [], reviewQueue: [] });
    const itemText = fs.readFileSync(path.join(tmpDir, 'Codex', 'items.yaml'), 'utf8');
    expect(itemText).toContain('{%li}');
  });
});

describe('composing with renameProtagonist (carried from the Session A handoff\'s Watch)', () => {
  // A v3 project with both `protagonist: X` and a `{%li}`-style pseudo-role variable on the
  // same node should produce one `roles:` block with both entries, not two blocks or a
  // collision — `renameProtagonist` (migrate/v3.js) runs during the config break, before
  // `migratePseudoRoles` runs; both write into `roles:` at the same node path.
  test('protagonist: and a pseudo-role on the same node land in one roles: block', () => {
    const tmpDir = buildProject({
      ...BASE,
      'Codex/items.yaml': [
        ITEM_WITH_LI,
        '- id: Aness',
        '  name: {display: Aness, full: Aness Vale}',
        '  pronouns: nonbinary',
        '  aid: {type: Character, triggers: [Aness]}',
        '  render: {template: Full}',
        '  body: {Tagline: "hi"}',
      ].join('\n'),
      'compile.yaml': [
        'structure:',
        '  input:',
        '    items: [%TMP%/Codex]',
        '    templates: [%TMP%/templates]',
        '  output: %TMP%/output',
        'variables:',
        '  li: Malcolm',
        'protagonist: Aness',
        'branches:',
        '  main: {}',
        '',
      ].join('\n'),
    });
    const configPath = path.join(tmpDir, 'compile.yaml');

    const saved = { log: console.log, warn: console.warn };
    console.log = () => {}; console.warn = () => {};
    migrateProjectFully(configPath);
    Object.assign(console, saved);

    const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.roles).toEqual({ protagonist: 'Aness', LI: 'Malcolm' });
    expect('protagonist' in config).toBe(false);
  });
});
