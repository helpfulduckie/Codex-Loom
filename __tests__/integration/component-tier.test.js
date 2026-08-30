'use strict';

/**
 * Tiering a component, end to end (v4 spec §13.4 — Phase 14 Step 0).
 *
 * Phase 13's fix A stopped a `render.template` that only equals `aid.type` (the
 * `model/item.js` normaliser fill) from shadowing a branch's `templateFor.base` in the body
 * ladder. The component-target ladder (`renderPlacementBody`) never got the same guard, so
 * `templateFor.plotEssential` / `templateFor.base` was shadowed corpus-wide by the parallel
 * `model/item.js:384` fill of a component target's `template:` from `aid.type`. No golden
 * tiers a component, so nothing exercised it.
 *
 * This project renders two items only into a Plot Essentials `cast` slot and overrides that
 * slot with a terse field list on the `lowContext` branch. Pre-Step-0 the terse list was
 * dead and both items rendered full on `lowContext`; post-Step-0 the branch slot wins for
 * the item that names no per-target template, and Pattern 2 still opts the other back in.
 */

const fs = require('fs');
const { compile } = require('../../src/compile');
const { writeComponentTierProject, readComponent } = require('../helpers/tier-fixture');

let dir;

beforeAll(() => {
  dir = writeComponentTierProject();
  const quiet = ['log', 'warn'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  try {
    compile(`${dir}/compile.cl.yaml`);
  } finally {
    quiet.forEach((s) => s.mockRestore());
  }
});

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('templateFor.plotEssential on a branch selects a shorter field list', () => {
  test('the full branch renders every stanza of Aness into the cast slot', () => {
    const pe = readComponent(dir, ['full']);
    expect(pe).toContain('Name: Aness');
    expect(pe).toContain('Appearance: tall; freckled');
    expect(pe).toContain('Personality: warm; wry');
    expect(pe).toContain(
      'Background: She trained at the Academy for six years before the vault sealed.',
    );
  });

  test('the lowContext branch renders Aness terse — the branch slot is no longer shadowed by the type-fill target.template', () => {
    const pe = readComponent(dir, ['lowContext']);
    expect(pe).toContain('Name: Aness');
    expect(pe).toContain('Appearance: tall; freckled');
    // The bug: pre-Step-0 `target.template` was the `Character` fill, rung 1 resolved it
    // against the shared table's full `Character` list, and these stanzas survived.
    expect(pe).not.toContain('Personality: warm; wry');
    expect(pe).toContain('Background: Academy-trained researcher.');
    expect(pe).not.toContain('six years before the vault sealed');
  });

  test('Pattern 2: Grand names CharacterFull on its target and stays full on lowContext', () => {
    const pe = readComponent(dir, ['lowContext']);
    expect(pe).toContain('Name: Grand');
    expect(pe).toContain('Personality: exacting; courteous');
    expect(pe).toContain('Background: He founded the Institute and has run it for thirty years.');
  });
});
