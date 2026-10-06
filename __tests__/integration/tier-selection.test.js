'use strict';

/**
 * Context tiering, end to end (v4 spec §7.8, §13.4 — Phase 13 Step 1).
 *
 * A tier is a branch: `lowContext` names `terse.cl.yaml` via `templateFor.base`, and that
 * slot file's shorter `templates:` list renders against the same field declarations the
 * full table uses.
 *
 * Phase 12 Session A shipped the `templateFor` branch-merge and the field-list render call,
 * but the mechanism was shadowed: `model/item.js` fills `render.template` with `aid.type`
 * for every card, and `resolveBodyRender`'s rung 1 then resolved that against the shared
 * field table, so `templateFor.base` never fired for any type in that table — the whole
 * corpus. Phase 13 Session A corrected rung 1 to ignore a `render.template` that only
 * equals `aid.type` (see `template-for-ladders.test.js`). This test pins the corrected
 * behaviour, including the Pattern 2 opt-back-in.
 */

const fs = require('fs');
const { compile } = require('../../src/compile');
const { writeTierProject, readCards, cardWrittenAt } = require('../helpers/tier-fixture');

let dir;

beforeAll(() => {
  dir = writeTierProject();
  compile(`${dir}/compile.cl.yaml`);
});

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('templateFor.base on a branch selects a shorter field list', () => {
  test('the full branch renders every stanza of Aness', () => {
    const text = readCards(dir, ['full']);
    expect(text).toContain('Name: Aness');
    expect(text).toContain('Appearance: tall; freckled');
    expect(text).toContain('Personality: warm; wry');
    expect(text).toContain(
      'Background: She trained at the Academy for six years before the vault sealed.',
    );
  });

  test('the lowContext branch keeps name + appearance, drops personality, swaps in backgroundBrief', () => {
    const text = readCards(dir, ['lowContext']);
    expect(text).toContain('Name: Aness');
    expect(text).toContain('Appearance: tall; freckled');
    // Omitted outright by the terse list — and Aness's terse card carries no other stanza.
    expect(text).not.toContain('Personality: warm; wry');
    // Same label, shorter value — from the `backgroundBrief` declaration, not `background`.
    expect(text).toContain('Background: Academy-trained researcher.');
    expect(text).not.toContain('six years before the vault sealed');
  });

  test('Pattern 2: an item naming CharacterFull stays full on the tiered branch', () => {
    const text = readCards(dir, ['lowContext']);
    // Grand renders through the terse slot file's `CharacterFull` list, not its terse
    // `Character` list — the one important card in an otherwise terse cast.
    expect(text).toContain('Name: Grand');
    expect(text).toContain('Personality: exacting; courteous');
    expect(text).toContain(
      'Background: He founded the Institute and has run it for thirty years.',
    );
  });

  test('Grand renders identically on both branches, so its card is written once at the root', () => {
    // CharacterFull is the same list on lowContext (from terse.cl.yaml) and on full (rung 3
    // falls to the type default, also the full four fields), so frontier placement lifts it.
    expect(cardWrittenAt(dir, [])).toBe(true);
    // Aness's terse card differs from its full card, so it is written per branch.
    expect(cardWrittenAt(dir, ['lowContext'])).toBe(true);
    expect(cardWrittenAt(dir, ['full'])).toBe(true);
  });
});
