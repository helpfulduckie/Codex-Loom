'use strict';

/**
 * §8.5's caps, at every write point that has one — Phase 5 Steps 4 and 5.
 *
 * Integration rather than unit for the reason the placeholder integration file gives: the
 * question is *which write points are covered*, and no unit can answer it. `checkLimit` is
 * unit-tested on its own; what it cannot tell you is whether the leaf opening, the interior
 * node's framing, the root framing and the story-card body each reach it. Four different
 * functions write those, and two of them run outside the leaf loop where the merged
 * placeholder table lives — exactly how a destination gets forgotten.
 *
 * The post-substitution cases are the load-bearing ones. The golden corpus has no
 * placeholders at all, so every card it pins is the degenerate case where rendered length
 * equals stored length; nothing outside this file exercises the arithmetic against a real
 * compile.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics, CODES } = require('../../src/diag');

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Compile a one-off project and return every diagnostic it raised. */
function run(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-limits-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'templates', 'Character.template'), '{$body.Tagline}\n', 'utf8');

  const diagnostics = new Diagnostics();
  const spies = ['log', 'warn', 'error'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  try {
    compile(path.join(dir, 'compile.cl.yaml'), { diagnostics });
  } catch (err) { /* ERRORs are the subject; the throw carries only a count */ } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return diagnostics.all;
}

const codes = (diags, code) => diags.filter((d) => d.code === code);

const HEAD = [
  'version: 4',
  'title: Probe',
  'structure:',
  '  input:',
  "    items: ['./Codex']",
  "    templates: ['./templates']",
  "  output: './out'",
].join('\n');

const item = (tagline) => [
  '- id: Anchor',
  '  name: Anchor',
  '  aid: {type: Character, triggers: [Anchor]}',
  `  body: {Tagline: "${tagline}"}`,
  '',
].join('\n');

const filler = (n) => 'x'.repeat(n);

describe('the card body cap', () => {
  test('a body over 2,000 characters is an ERROR', () => {
    const found = codes(run({
      'compile.cl.yaml': `${HEAD}\n`,
      'Codex/items.cl.yaml': item(filler(2100)),
    }), CODES.CARD_BODY_OVER_LIMIT);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('Anchor');
  });

  test('a body in the 1,800–2,000 band WARNs', () => {
    const diags = run({
      'compile.cl.yaml': `${HEAD}\n`,
      'Codex/items.cl.yaml': item(filler(1850)),
    });
    expect(codes(diags, CODES.CARD_BODY_NEAR_LIMIT)).toHaveLength(1);
    expect(codes(diags, CODES.CARD_BODY_OVER_LIMIT)).toHaveLength(0);
  });

  test('an ordinary body reports neither', () => {
    const diags = run({
      'compile.cl.yaml': `${HEAD}\n`,
      'Codex/items.cl.yaml': item('Nothing interesting.'),
    });
    expect(codes(diags, CODES.CARD_BODY_NEAR_LIMIT)).toHaveLength(0);
    expect(codes(diags, CODES.CARD_BODY_OVER_LIMIT)).toHaveLength(0);
  });

  /**
   * §4.8's last row: soft heuristics skip reference items, hard limits do not. A field cap
   * is a platform constraint, and the platform does not care why the item exists.
   */
  test('a kind: reference item is not exempt', () => {
    const found = codes(run({
      'compile.cl.yaml': `${HEAD}\n`,
      'Codex/items.cl.yaml': [
        '- id: Anchor',
        '  name: Anchor',
        '  kind: reference',
        '  aid: {type: Character, triggers: []}',
        `  body: {Tagline: "${filler(2100)}"}`,
        '',
      ].join('\n'),
    }), CODES.CARD_BODY_OVER_LIMIT);
    expect(found).toHaveLength(1);
  });
});

describe('the Opening cap, at all three write points', () => {
  const LONG = filler(4100);

  test('a leaf opening', () => {
    const found = codes(run({
      'compile.cl.yaml': [
        HEAD, 'branches:', '  north:', '    components:', `      opening: "${LONG}"`, '',
      ].join('\n'),
      'Codex/items.cl.yaml': item('Short.'),
    }), CODES.OPENING_OVER_LIMIT);
    expect(found).toHaveLength(1);
  });

  test('an interior node\'s branch framing', () => {
    const found = codes(run({
      'compile.cl.yaml': [
        HEAD, 'branches:', '  north:', '    components:', `      branchFraming: "${LONG}"`,
        '    branches:', '      near: {}', '      far: {}', '',
      ].join('\n'),
      'Codex/items.cl.yaml': item('Short.'),
    }), CODES.OPENING_OVER_LIMIT);
    expect(found).toHaveLength(1);
  });

  test('root branch framing, which sits outside both recursive writers', () => {
    const found = codes(run({
      'compile.cl.yaml': [
        HEAD, 'components:', `  branchFraming: "${LONG}"`,
        'branches:', '  north: {}', '  south: {}', '',
      ].join('\n'),
      'Codex/items.cl.yaml': item('Short.'),
    }), CODES.OPENING_OVER_LIMIT);
    expect(found).toHaveLength(1);
  });

  test('the band WARNs without erroring', () => {
    const diags = run({
      'compile.cl.yaml': [
        HEAD, 'branches:', '  north:', '    components:', `      opening: "${filler(3700)}"`, '',
      ].join('\n'),
      'Codex/items.cl.yaml': item('Short.'),
    });
    expect(codes(diags, CODES.OPENING_NEAR_LIMIT)).toHaveLength(1);
    expect(codes(diags, CODES.OPENING_OVER_LIMIT)).toHaveLength(0);
  });
});

/**
 * The case the whole 4→5 phase ordering exists to protect, run end to end.
 *
 * The opening is under 4,000 characters as written and over it once Velvet Lattice expands
 * `%hero%` to its question text. A check against the rendered string passes this and ships
 * an Opening AID will truncate.
 */
describe('measurement happens after placeholder substitution', () => {
  const QUESTION = 'What is your character called, and where did they grow up?';
  const project = (fillerLength, refs) => ({
    'compile.cl.yaml': [
      HEAD,
      'placeholders:',
      `  hero: "${QUESTION}"`,
      'branches:',
      '  north:',
      '    components:',
      `      opening: "${filler(fillerLength)}${'%hero%'.repeat(refs)}"`,
      '',
    ].join('\n'),
    'Codex/items.cl.yaml': item('Short.'),
  });

  test('an opening under the cap rendered, over it substituted, is an ERROR', () => {
    const rendered = 3700 + '%hero%'.length * 20;
    expect(rendered).toBeLessThan(4000);

    const found = codes(run(project(3700, 20)), CODES.OPENING_OVER_LIMIT);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('after placeholder substitution');
    expect(found[0].message).toContain('Rendered length is');
  });

  test('the same opening with the placeholders removed is clean', () => {
    const diags = run(project(3700, 0));
    expect(codes(diags, CODES.OPENING_OVER_LIMIT)).toHaveLength(0);
    expect(codes(diags, CODES.OPENING_NEAR_LIMIT)).toHaveLength(1);
  });

  /**
   * The expansion runs a second time here purely to measure, and it must stay silent —
   * `writePlaceholdersRecursive` already reports cycles and undeclared nested references
   * with the bus attached, so a second reporting pass would double every one of them.
   */
  test('measuring does not re-report what the placeholder writer already reported', () => {
    const diags = run({
      'compile.cl.yaml': [
        HEAD, 'placeholders:', '  a: "Ask about %b%?"', '  b: "Ask about %a%?"',
        'branches:', '  north:', '    components:', '      opening: "Hello %a%"', '',
      ].join('\n'),
      'Codex/items.cl.yaml': item('Short.'),
    });
    expect(codes(diags, CODES.PLACEHOLDER_CYCLE).length).toBeGreaterThan(0);
    const cycleMessages = codes(diags, CODES.PLACEHOLDER_CYCLE).map((d) => d.message);
    expect(new Set(cycleMessages).size).toBe(cycleMessages.length);
  });
});
