'use strict';

/**
 * Shared builder for the Phase 13 context-tier fixtures.
 *
 * A tier is a branch (§7.8): the `lowContext` branch names a `terse.cl.yaml` via
 * `templateFor.base`, and that slot file holds shorter `templates:` lists that reference the
 * same field declarations as the full table. This builder writes such a project into a tmp
 * dir so the fixture and the assertions that read it stay together, the way
 * `template-for.integration.test.js` does.
 *
 * Two items:
 *   - `Aness` names no template, so it takes the tier default on each branch — full on
 *     `full`, terse on `lowContext`, with `background` -> `backgroundBrief` as a same-label
 *     substitution.
 *   - `Grand` writes `render.template: CharacterFull`, a name the terse slot file defines
 *     alongside its terse `Character` (§13.4 Pattern 2). It stays full on `lowContext` —
 *     the one important card in a terse cast.
 *
 * `readCard` resolves a compiled card the way Velvet Lattice does — nearest
 * `Story Cards/<type>/<type>.md` from the leaf up — because Phase 11 writes each card at the
 * node that owns it, not at every leaf.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

/** Field declarations. `background` is a paragraph, `backgroundBrief` a sentence, and both
 * carry `label: Background` so a terse list can swap one for the other (§13.4, Decision 1).
 * The full `Character` list lives here too, so the root's `templateFor.base` (which names
 * this file) resolves it. */
const DEFAULT_FIELDS = `
fields:
  name: { label: Name }
  appearance: { label: Appearance, join: "; " }
  personality: { label: Personality, join: "; " }
  background: { label: Background }
  backgroundBrief: { label: Background }
groups: {}
templates:
  Character: [name, appearance, personality, background]
`;

/** The terse slot file the `lowContext` branch names. `Character` is the terse default for
 * the type; `CharacterFull` is a free-standing name one card opts into (Pattern 2). */
const DEFAULT_TERSE = `
templates:
  Character:
    - name
    - appearance
    - { field: backgroundBrief, label: Background }
  CharacterFull:
    - name
    - appearance
    - personality
    - background
`;

const DEFAULT_ITEMS = `
- id: Aness
  name: Aness
  aid: { type: Character, triggers: [Aness] }
  body:
    name: Aness
    appearance: [tall, freckled]
    personality: [warm, wry]
    background: She trained at the Academy for six years before the vault sealed.
    backgroundBrief: Academy-trained researcher.

- id: Grand
  name: Grand
  aid: { type: Character, triggers: [Grand] }
  render:
    template: CharacterFull
  body:
    name: Grand
    appearance: [greying, upright]
    personality: [exacting, courteous]
    background: He founded the Institute and has run it for thirty years.
    backgroundBrief: Institute founder.
`;

/**
 * Write a tier project into a fresh tmp dir and return its root path.
 *
 * The root config renders `Character` through the full `fields.cl.yaml` table; the
 * `lowContext` branch overrides `templateFor.base` with `terse.cl.yaml`; a `full` branch
 * changes nothing, so its card is inherited from the root frontier and reads as the full
 * render.
 */
function writeTierProject({
  fields = DEFAULT_FIELDS,
  terse = DEFAULT_TERSE,
  items = DEFAULT_ITEMS,
  configExtra = '',
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-tier-'));
  fs.mkdirSync(path.join(dir, 'templates'));
  fs.mkdirSync(path.join(dir, 'items'));
  fs.writeFileSync(path.join(dir, 'templates', 'fields.cl.yaml'), fields.trimStart());
  fs.writeFileSync(path.join(dir, 'templates', 'terse.cl.yaml'), terse.trimStart());
  fs.writeFileSync(path.join(dir, 'items', 'items.cl.yaml'), items.trimStart());
  fs.writeFileSync(path.join(dir, 'compile.cl.yaml'), `${`
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
branches:
  full: {}
  lowContext:
    templateFor:
      base: terse.cl.yaml
`.trimStart()}${configExtra}`);
  return dir;
}

/**
 * The card text a leaf actually resolves. Phase 11 writes each card at the node that owns
 * it, so a leaf's view of `Story Cards/<type>/<type>.md` is the union of every copy from
 * the leaf up to the output root. Returns them concatenated — enough to assert which cards
 * a leaf sees and how each rendered, which is all the tier tests need.
 */
function readCards(dir, branchSegments, type = 'Character') {
  const base = path.join(dir, 'out');
  let cur = path.join(base, ...branchSegments.flatMap((s) => ['Branches', s]));
  const parts = [];
  for (;;) {
    const candidate = path.join(cur, 'Story Cards', type, `${type}.md`);
    if (fs.existsSync(candidate)) parts.push(fs.readFileSync(candidate, 'utf8'));
    if (cur === base) break;
    cur = path.dirname(path.dirname(cur));
  }
  if (parts.length === 0) throw new Error(`no ${type}.md from ${branchSegments.join('/')} up to out/`);
  return parts.join('\n');
}

/** True when this exact node (not an ancestor) owns a `<type>.md`. */
function cardWrittenAt(dir, branchSegments, type = 'Character') {
  const p = path.join(
    dir, 'out', ...branchSegments.flatMap((s) => ['Branches', s]), 'Story Cards', type, `${type}.md`,
  );
  return fs.existsSync(p);
}

module.exports = {
  writeTierProject, readCards, cardWrittenAt, DEFAULT_FIELDS, DEFAULT_TERSE, DEFAULT_ITEMS,
};
