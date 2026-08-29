'use strict';

/**
 * The label-membership guard, exercised (v4 spec §13.4, Phase 13 Step 2 / Decision 2).
 *
 * The positive case is the Step 1 fixture — an omission plus a same-label substitution plus
 * a Pattern 2 opt-back-in, all well-formed. The negative cases hand the guard a malformed
 * terse list and prove it throws: an invented label, a reordering, and a hand-jammed stanza
 * that is not a declared substitution. Kitchen-sink is not used here — it is a
 * validate-only schema fixture with an empty templates dir and never compiles (see the
 * Phase 13 Session A record); the awkward shapes it would carry (a field supplied as both
 * array and scalar, a substitution) are in the fixtures below instead.
 */

const fs = require('fs');
const { writeTierProject } = require('../helpers/tier-fixture');
const { assertTierWellFormed } = require('../helpers/tier-wellformed');

const dirs = [];
function project(opts) {
  const d = writeTierProject(opts);
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const FIELDS = `
fields:
  name: { label: Name }
  appearance: { label: Appearance, join: "; " }
  personality: { label: Personality, join: "; " }
  background: { label: Background }
  backgroundBrief: { label: Background }
  secret: { label: Secret }
groups: {}
templates:
  Character: [name, appearance, personality, background]
`;

const ITEMS = `
- id: Aness
  name: Aness
  aid: { type: Character, triggers: [Aness] }
  body:
    name: Aness
    appearance: [tall, freckled]
    personality: [warm, wry]
    background: She trained at the Academy for six years before the vault sealed.
    backgroundBrief: Academy-trained researcher.
    secret: keeps the vault key
`;

test('the Step 1 fixture is well-formed — omission + same-label substitution + Pattern 2', () => {
  expect(() => assertTierWellFormed(project(), 'lowContext')).not.toThrow();
});

test('(a) a terse list that emits a label the full template lacks fails', () => {
  const terse = `
templates:
  Character:
    - name
    - { field: secret, label: Secret }
`;
  expect(() => assertTierWellFormed(project({ fields: FIELDS, items: ITEMS, terse }), 'lowContext'))
    .toThrow(/invents nothing|emits label "Secret"/);
});

test('(b) a terse list that reorders kept labels fails', () => {
  const terse = `
templates:
  Character:
    - appearance
    - name
`;
  expect(() => assertTierWellFormed(project({ fields: FIELDS, items: ITEMS, terse }), 'lowContext'))
    .toThrow(/reorders kept labels/);
});

test('(c) a hand-jammed stanza that is not a declared substitution fails', () => {
  const terse = `
templates:
  Character:
    - name
    - appearance
    - { raw: "Background: jammed in by hand" }
`;
  expect(() => assertTierWellFormed(project({ fields: FIELDS, items: ITEMS, terse }), 'lowContext'))
    .toThrow(/declares no same-label substitution/);
});
