'use strict';

/**
 * `templateFor` and the field-list emitter, end to end (v4 spec §13.4, Phase 12 Step 2).
 *
 * The unit tests prove the resolvers in isolation and `field-list.test.js` proves the
 * emitter's output; this one proves the wiring between them — that a compile with a
 * `templateFor.base` field list actually renders its story cards through the emitter, and
 * that a branch overriding `templateFor.notes` for one type keeps the parent's entry for
 * every other type.
 *
 * The project is written into a tmp dir rather than committed, so the fixture and the
 * assertions read together.
 */

const path = require('path');
const fs = require('fs');

const { compile } = require('../../src/compile');
const { buildCompileContext } = require('../../src/branchCompile');
const { loadCompileConfig } = require('../../src/config/load');
const { Diagnostics } = require('../../src/diag');
const { withTmpDir, writeTree } = require('../helpers/project');

let dir;

const FIELDS = `
fields:
  name: { label: Name }
  vibe: { label: Vibe, join: "; " }
  count: { label: Count }
  flag: { label: Flag }
  secret: { label: Hidden, wrap: "[]", wrapLabel: true }
groups:
  head: [name, vibe]
templates:
  Character: [head, secret, count, flag]
  Faction: [name]
`;

const NOTES_ROOT = `
templates:
  Character: [{ field: known, label: Status }]
  Faction: [{ field: known, label: Status }]
`;

const NOTES_MODA = `
templates:
  Character: [{ field: modFlag, label: Mod }]
`;

const CONFIG = `
version: 4
structure:
  input:
    templates:
      - ./templates
    items:
      - ./items
  output: ./out
components:
  plotEssential: components/plot.cl.yaml
templateFor:
  base: fields.cl.yaml
  notes: [notes-root.cl.yaml]
  plotEssential: [fields.cl.yaml]
branches:
  plain: {}
  modA:
    templateFor:
      notes: notes-modA.cl.yaml
`;

const ITEMS = `
- id: Aness
  name: Aness
  aid: { type: Character, triggers: [Aness] }
  render:
    plotEssential: { slot: roster }
  notes: { known: false }
  body:
    vibe: [warm, unhurried]
    count: 0
    flag: false
    secret: sealed the vault
`;

beforeAll(() => {
  dir = writeTree(withTmpDir(), {
    'templates/fields.cl.yaml': FIELDS.trimStart(),
    'templates/notes-root.cl.yaml': NOTES_ROOT.trimStart(),
    'templates/notes-modA.cl.yaml': NOTES_MODA.trimStart(),
    'components/plot.cl.yaml': 'sections:\n  roster: { slot: true }\n',
    'compile.cl.yaml': CONFIG.trimStart(),
    'items/items.cl.yaml': ITEMS.trimStart(),
  });
});

function cardText(branch) {
  const p = path.join(dir, 'out', 'Branches', branch, 'Story Cards', 'Character', 'Character.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function findFile(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) return full;
  }
  return null;
}

describe('templateFor.base renders story cards through the field-list emitter', () => {
  beforeAll(() => {
    const diagnostics = new Diagnostics();
    try {
      compile(path.join(dir, 'compile.cl.yaml'), { diagnostics });
    } catch (error) {
      throw new Error(`${error.message}\n${diagnostics.all.map((d) => d.format()).join('\n')}`);
    }
  });

  test('the body is the field list, not a verbatim dump', () => {
    const text = cardText('plain');
    expect(text).toContain('Vibe: warm; unhurried');
    expect(text).toContain('[Hidden: sealed the vault]');
    // Name has no value on this item, so its conditional stanza produced nothing.
    expect(text).not.toMatch(/Name:/);
    expect(text).toContain('Count: 0');
    expect(text).toContain('Flag: false');
  });

  test('the notes ladder resolves templateFor.notes on the plain branch (root entry)', () => {
    // The notes field list preserves false, whose truth value remains false.
    expect(cardText('plain')).toMatch(/Status: false/);
  });

  test('component-slot field lists preserve zero and false', () => {
    const p = findFile(path.join(dir, 'out'), 'Plot Essentials.md');
    expect(p).toBeTruthy();
    expect(fs.readFileSync(p, 'utf8')).toContain('Count: 0\nFlag: false');
  });

  test('modA overrides Character notes but inherits Faction from the root entry', () => {
    // The Character card on modA now renders through notes-modA.cl.yaml, which reads
    // `modFlag` (unset) — so no Status line, and no Mod line either.
    const text = cardText('modA');
    expect(text).not.toMatch(/Status:/);

    // The inheritance claim is about the *map*, checked directly: modA's merged
    // templateFor.notes still carries the Faction entry it never redeclared.
    const diagnostics = new Diagnostics();
    const config = loadCompileConfig(path.join(dir, 'compile.cl.yaml'), { diagnostics });
    const ctx = buildCompileContext(config, ['modA'], { diagnostics });
    expect(Object.keys(ctx.templateFor.notes).sort()).toEqual(['Character', 'Faction']);
    expect(ctx.templateFor.notes.Character).toEqual([{ field: 'modFlag', label: 'Mod' }]);
    expect(ctx.templateFor.notes.Faction).toEqual([{ field: 'known', label: 'Status' }]);
    // base is inherited untouched from the root.
    expect(Object.keys(ctx.templateFor.base).sort()).toEqual(['Character', 'Faction']);
  });
});
