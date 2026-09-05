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

const os = require('os');
const path = require('path');
const fs = require('fs');

const { compile } = require('../../src/compile');
const { buildCompileContext } = require('../../src/branchCompile');
const { loadCompileConfig } = require('../../src/config/load');
const { Diagnostics } = require('../../src/diag');

let dir;

const FIELDS = `
fields:
  name: { label: Name }
  vibe: { label: Vibe, join: "; " }
  secret: { label: Hidden, wrap: "[]", wrapLabel: true }
groups:
  head: [name, vibe]
templates:
  Character: [head, secret]
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
templateFor:
  base: fields.cl.yaml
  notes: [notes-root.cl.yaml]
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
  notes: { known: enrolled }
  body:
    vibe: [warm, unhurried]
    secret: sealed the vault
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-templatefor-'));
  fs.mkdirSync(path.join(dir, 'templates'));
  fs.mkdirSync(path.join(dir, 'items'));
  fs.writeFileSync(path.join(dir, 'templates', 'fields.cl.yaml'), FIELDS.trimStart());
  fs.writeFileSync(path.join(dir, 'templates', 'notes-root.cl.yaml'), NOTES_ROOT.trimStart());
  fs.writeFileSync(path.join(dir, 'templates', 'notes-modA.cl.yaml'), NOTES_MODA.trimStart());
  fs.writeFileSync(path.join(dir, 'compile.cl.yaml'), CONFIG.trimStart());
  fs.writeFileSync(path.join(dir, 'items', 'items.cl.yaml'), ITEMS.trimStart());
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function cardText(branch) {
  const p = path.join(dir, 'out', 'Branches', branch, 'Story Cards', 'Character', 'Character.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

describe('templateFor.base renders story cards through the field-list emitter', () => {
  beforeAll(() => { compile(path.join(dir, 'compile.cl.yaml')); });

  test('the body is the field list, not a verbatim dump', () => {
    const text = cardText('plain');
    expect(text).toContain('Vibe: warm; unhurried');
    expect(text).toContain('[Hidden: sealed the vault]');
    // Name has no value on this item, so its conditional stanza produced nothing.
    expect(text).not.toMatch(/Name:/);
  });

  test('the notes ladder resolves templateFor.notes on the plain branch (root entry)', () => {
    // notes-root.cl.yaml renders `known` under the label "Status".
    expect(cardText('plain')).toMatch(/Status: enrolled/);
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
