'use strict';

const fs   = require('fs');
const path = require('path');

const {
  scanText,
  scanStoryCardStructure,

  findLintableFiles,
  runLintMode,
  scanNativePlaceholders,
} = require('../../src/lint');
const { SEVERITY, Diagnostics } = require('../../src/diag');
const { withTmpDir } = require('../helpers/project');

function makeTmp() {
  return withTmpDir();
}

/**
 * Run a scanner against a fresh bus and return what it raised.
 *
 * The scanners raise rather than return since Package 3, and they raise through
 * `Diagnostics.add` rather than constructing diagnostics, because `add` is where the
 * `lint.level` ceiling is applied. So a test for the ceiling constructs the bus *with* the
 * level and asserts on what survived — there is no longer a filter function to call on a
 * list, and asserting on a returned list would test nothing about the ceiling.
 */
function collect(scan, { lintLevel = null, file = null } = {}) {
  const bus = new Diagnostics({ lintLevel });
  scan({ diagnostics: bus, file });
  return bus.all;
}

const codes = (diags) => diags.map((d) => d.code);

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// ── scanText ─────────────────────────────────────────────────────────────────

describe('scanText', () => {
  test('flags unresolved field tokens', () => {
    const diags = collect((ctx) => scanText('one of the top mages, has built {$her~} reputation', ctx));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'CL0430', severity: SEVERITY.ERROR, line: 1 });
    expect(diags[0].message).toContain('{$her~}');
  });

  test('flags unexpanded compile variables', () => {
    const diags = collect((ctx) => scanText('Setting: {%setting}', ctx));
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe('CL0431');
    expect(diags[0].message).toContain('{%setting}');
  });

  test('flags leaked template render functions', () => {
    const diags = collect((ctx) => scanText('Physical Traits: {join("; ", $body.Physical Traits.gender)}', ctx));
    expect(codes(diags)).toContain('CL0432');
  });

  test('flags leaked template control tags', () => {
    const diags = collect((ctx) => scanText('{if $body.Background}\nBackground:\n{/if}', ctx));
    expect(codes(diags)).toContain('CL0433');
  });

  test('flags unresolved verb conjugation markers', () => {
    const diags = collect((ctx) => scanText('Aness love[s] magic research', ctx));
    expect(diags.some((d) => d.code === 'CL0434' && d.message.includes('[s]'))).toBe(true);
  });

  test('flags a made-up verb marker like [does] as a suspect marker, not silently', () => {
    const diags = collect((ctx) => scanText('Aness love[does] magic research', ctx));
    expect(diags).toContainEqual(expect.objectContaining({
      code: 'CL0436', severity: SEVERITY.WARN, message: expect.stringContaining('[does]'),
    }));
  });

  test('flags other guessed verb-marker typos ([have], [do])', () => {
    expect(collect((ctx) => scanText('Aness [have] the ring', ctx))
      .some((d) => d.code === 'CL0436' && d.message.includes('[have]'))).toBe(true);
    expect(collect((ctx) => scanText('Aness [do] not know', ctx))
      .some((d) => d.code === 'CL0436' && d.message.includes('[do]'))).toBe(true);
  });

  test('does not flag the real markers or [e] as suspect', () => {
    const diags = collect((ctx) => scanText('[e] Aness love[s] magic, love[es], love[is], love[was], love[has]', ctx));
    expect(diags.some((d) => d.code === 'CL0436')).toBe(false);
  });

  test('does not flag [Secret: ...] or other non-lowercase-word bracket usage as suspect', () => {
    const diags = collect((ctx) => scanText('[Secret: hidden detail the AI should not reveal]', ctx));
    expect(diags.some((d) => d.code === 'CL0436')).toBe(false);
  });

  test('does not flag a single-word AID trigger in the fence as a suspect marker', () => {
    const card = `## Door

~~~
triggers: [door]
encapsulate: true
~~~

[e] A plain wooden door leading to the cellar.
`;
    const diags = collect((ctx) => scanText(card, ctx));
    expect(diags.some((d) => d.code === 'CL0436')).toBe(false);
  });

  test('still flags a suspect marker in the body even when the fence has a single-word trigger', () => {
    const card = `## Aness

~~~
triggers: [magic]
encapsulate: true
~~~

[e] Aness love[does] magic research.
`;
    const diags = collect((ctx) => scanText(card, ctx));
    expect(diags).toContainEqual(expect.objectContaining({ code: 'CL0436', message: expect.stringContaining('[does]') }));
  });

  test('flags JS interpolation artifacts', () => {
    const diags = collect((ctx) => scanText('Background: [object Object]', ctx));
    expect(diags.some((d) => d.code === 'CL0435')).toBe(true);
  });

  test('flags bare undefined/NaN as warnings', () => {
    const diags = collect((ctx) => scanText('Age: undefined', ctx));
    expect(diags[0]).toMatchObject({ code: 'CL0437', severity: SEVERITY.WARN });
  });

  test('flags a repeated token once per occurrence, with its own line number', () => {
    const diags = collect((ctx) => scanText('{$her~}\nsecond line\n{$her~}', ctx));
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.line)).toEqual([1, 3]);
  });

  test('clean text produces no findings', () => {
    expect(collect((ctx) => scanText('Aness loves magic research — she leaps to conclusions.', ctx))).toEqual([]);
  });
});

// ── parseStoryCards / scanStoryCardStructure ──────────────────────────────────

const CARD_WITH_E = `## Aness

~~~
triggers: [Aness, Rozen]
encapsulate: true
~~~

[e] Aness Rozen - Academy Mage
Tagline: top researcher
`;

const CARD_DISCOVERED = `## Hidden Vault

~~~
triggers: [Vault]
encapsulate: true
~~~

Hidden Vault beneath the Academy /]
`;

describe('structural checks read through the shared parser', () => {
  test('a heading with no fence beneath it is not a story card', () => {
    // AI Instructions and Author's Note are headed sections without fences. Treating
    // one as a card would fire every structural check on every section of them.
    expect(collect((ctx) => scanStoryCardStructure('## Tone\n\nWrite in close third person.', ctx))).toEqual([]);
  });

  test('a trigger list inside the body does not satisfy the fence check', () => {
    // The check reads the parsed fence, not the text: prose that happens to contain
    // `triggers: [A]` below the fence must not make an empty card look populated.
    const card = '## A\n~~~\n~~~\ntriggers: [A]\n';
    expect(codes(collect((ctx) => scanStoryCardStructure(card, ctx)))).toContain('CL0635');
  });
});

describe('scanStoryCardStructure', () => {
  test('valid [e] card produces no findings', () => {
    expect(collect((ctx) => scanStoryCardStructure(CARD_WITH_E, ctx))).toEqual([]);
  });

  test('valid discovery-marker card produces no findings', () => {
    expect(collect((ctx) => scanStoryCardStructure(CARD_DISCOVERED, ctx))).toEqual([]);
  });

  test('flags empty trigger list', () => {
    const bad = `## NoTriggers

~~~
triggers: []
encapsulate: true
~~~

[e] NoTriggers has no triggers
`;
    const diags = collect((ctx) => scanStoryCardStructure(bad, ctx));
    expect(diags).toContainEqual(expect.objectContaining({ code: 'CL0635', message: expect.stringContaining('NoTriggers') }));
  });

  /**
   * §4.8's first exemption row, and the reason `kind:` is written into the fence at all.
   * A mod-control card is trigger-less on purpose; telling its author so on every compile
   * is the noise the field exists to remove.
   */
  test('a kind: reference card is exempt — trigger-less is its intended state', () => {
    const card = `## WTG Time Config

~~~
triggers: []
kind: reference
encapsulate: false
~~~

startDate: 06/28/1320
`;
    expect(collect((ctx) => scanStoryCardStructure(card, ctx))).toEqual([]);
  });

  /**
   * The other half of Decision 2, and the reason the exemption reads the fence rather than
   * inferring reference-ness from the empty list: a narrative card that *lost* its triggers
   * is exactly what this check exists to catch, and inference would make it invisible.
   */
  test('a trigger-less card that does not declare kind: reference is still flagged', () => {
    const card = `## Lian Quay

~~~
triggers: []
encapsulate: false
~~~

A harbor town.
`;
    expect(collect((ctx) => scanStoryCardStructure(card, ctx)))
      .toContainEqual(expect.objectContaining({ code: 'CL0635', message: expect.stringContaining('Lian Quay') }));
  });

  test('empty-triggers is opinion-layer, so lint.level can reach it', () => {
    const card = '## X\n\n~~~\ntriggers: []\n~~~\n\nbody\n';
    expect(collect((ctx) => scanStoryCardStructure(card, ctx), { lintLevel: 'off' })).toEqual([]);
  });

});

// ── findLintableFiles ─────────────────────────────────────────────────────────

describe('scanNativePlaceholders — the confusability check', () => {
  test('identifier-shaped content warns — that is the transposition', () => {
    // `{$she}` mistyped as `${she}` reaches the player as a prompt asking them to
    // type the word "she".
    const diags = collect((ctx) => scanNativePlaceholders('The wind caught ${she} hair.', ctx));
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe('CL0546');
    expect(diags[0].message).toContain('${she}');
  });

  test('dotted token shapes warn too', () => {
    const diags = collect((ctx) => scanNativePlaceholders('${Aria.she} and ${body.Field}', ctx));
    expect(diags).toHaveLength(2);
    expect(diags[0].message).toContain('${Aria.she}');
    expect(diags[1].message).toContain('${body.Field}');
  });

  test('a question is a real placeholder and stays silent', () => {
    // The whole reason this is a shape test rather than §12.4's blanket WARN: three live
    // projects author native placeholders on purpose, and a blanket check opens with
    // thirteen false positives.
    expect(collect((ctx) => scanNativePlaceholders('${What is your name?}', ctx))).toEqual([]);
    expect(collect((ctx) => scanNativePlaceholders('${Date: (MM/DD/YYYY)}', ctx))).toEqual([]);
    expect(collect((ctx) => scanNativePlaceholders('${Opening:}', ctx))).toEqual([]);
  });

  test("Latitude's premade specials stay silent", () => {
    // Identifier-shaped by construction, and unavoidable: VL's substitution produces a
    // question from a declared key and cannot produce a special, so every project wanting
    // them writes them raw forever.
    expect(collect((ctx) => scanNativePlaceholders('${character.name} and ${character.gender}', ctx))).toEqual([]);
    expect(collect((ctx) => scanNativePlaceholders('${character.pronoun.themselves}', ctx))).toEqual([]);
  });

  test('a nested placeholder is judged as one occurrence', () => {
    // Codex Loom emits nesting (§12.2), so a non-greedy matcher would split its own output
    // and then judge the fragments on the wrong content.
    expect(collect((ctx) => scanNativePlaceholders('${What is ${Their name?} like?}', ctx))).toEqual([]);
  });

  test('records a diagnostic per occurrence, each with its own line', () => {
    const diags = collect((ctx) => scanNativePlaceholders('${she}\nfiller\n${she}', ctx));
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.line)).toEqual([1, 3]);
    expect(diags.every((d) => d.severity === SEVERITY.WARN)).toBe(true);
  });

  test('the hint shows the token spelling that was probably meant', () => {
    const [diag] = collect((ctx) => scanNativePlaceholders('${she}', ctx));
    expect(diag.hint).toContain('{$she}');
  });
});

describe('the compiler / lint split in the offline scanner', () => {
  // The ceiling moved from a filter over a returned list to `Diagnostics.add`, so these
  // assert on what a levelled bus *accepted* rather than on what a filter removed. The
  // silenced diagnostic is never on the bus at all, which is the property worth having: the
  // report, the exit code and the terminal all read the same bus, and a filter applied to
  // one of them is how a silenced diagnostic still fails a build.
  const SAMPLE = '{$she} love[does] it {if $x}{/if} undefined';

  test('level: off silences the opinions and leaves every fact standing', () => {
    const kept = codes(collect((ctx) => scanText(SAMPLE, ctx), { lintLevel: 'off' }));
    expect(kept).toEqual(expect.arrayContaining(['CL0430', 'CL0433']));
    expect(kept).not.toContain('CL0436'); // suspect verb marker
    expect(kept).not.toContain('CL0437'); // bare undefined/NaN
  });

  test('level: warn keeps the opinions at WARN and does not touch the facts', () => {
    const kept = collect((ctx) => scanText('{$she} love[does] it', ctx), { lintLevel: 'warn' });
    expect(kept.find((d) => d.code === 'CL0430').severity).toBe(SEVERITY.ERROR);
    expect(kept.find((d) => d.code === 'CL0436').severity).toBe(SEVERITY.WARN);
  });

  test('no level raises everything the scan found', () => {
    const kept = codes(collect((ctx) => scanText(SAMPLE, ctx)));
    expect(kept).toEqual(expect.arrayContaining(['CL0430', 'CL0433', 'CL0436', 'CL0437']));
  });

  test('the two codes minted for the offline scanner are opinion-layer too', () => {
    // CL0546 and CL0635 had no code before Package 3 and so could not be reached through
    // `isOpinion`. Their reachability by `lint.level` is the thing the registry entry buys.
    const card = '## X\n\n~~~\ntriggers: []\n~~~\n\n${she}\n';
    const off = codes(collect((ctx) => {
      scanStoryCardStructure(card, ctx);
      scanNativePlaceholders(card, ctx);
    }, { lintLevel: 'off' }));
    expect(off).toEqual([]);

    const on = codes(collect((ctx) => {
      scanStoryCardStructure(card, ctx);
      scanNativePlaceholders(card, ctx);
    }));
    expect(on).toEqual(expect.arrayContaining(['CL0635', 'CL0546']));
  });
});

describe('findLintableFiles', () => {
  test('only collects .md files under Story Cards / Components segments', () => {
    const tmp = makeTmp();
    write(path.join(tmp, 'Story Cards', 'Character', 'aness.md'), CARD_WITH_E);
    write(path.join(tmp, 'Components', 'Opening.md'), 'You wake up.');
    write(path.join(tmp, 'Overview', 'report.overview.md'), '{$her~} should not be linted here');
    write(path.join(tmp, 'notes.md'), 'unrelated note');

    const files = findLintableFiles(tmp);
    expect(files.some(f => f.endsWith(path.join('Story Cards', 'Character', 'aness.md')))).toBe(true);
    expect(files.some(f => f.endsWith(path.join('Components', 'Opening.md')))).toBe(true);
    expect(files.some(f => f.includes('Overview'))).toBe(false);
    expect(files.some(f => f.endsWith('notes.md'))).toBe(false);

    fs.rmSync(tmp, { recursive: true });
  });
});

// ── runLintMode ───────────────────────────────────────────────────────────────

describe('runLintMode', () => {
  test('returns written: [] when there is nothing to lint', () => {
    const tmp = makeTmp();
    const outDir = makeTmp();
    const result = runLintMode(tmp, outDir);
    expect(result).toEqual({
      written: [], reportPath: null, errorCount: 0, warnCount: 0, fileCount: 0,
    });
    fs.rmSync(tmp, { recursive: true });
    fs.rmSync(outDir, { recursive: true });
  });

  test('writes a report file and returns counts', () => {
    const tmp = makeTmp();
    const outDir = makeTmp();
    write(path.join(tmp, 'Story Cards', 'Character', 'aness.md'), CARD_WITH_E);
    write(path.join(tmp, 'Components', 'Opening.md'), 'Hello {$her~}, welcome.');

    const result = runLintMode(tmp, outDir);
    expect(result.written.length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
    expect(fs.existsSync(result.reportPath)).toBe(true);
    const reportText = fs.readFileSync(result.reportPath, 'utf8');
    expect(reportText).toContain('CL0430');

    fs.rmSync(tmp, { recursive: true });
    fs.rmSync(outDir, { recursive: true });
  });

  test('writes seeded compile diagnostics without rescanning the output tree', () => {
    const tmp = makeTmp();
    const outDir = makeTmp();
    write(path.join(tmp, 'Story Cards', 'Character', 'aness.md'), CARD_WITH_E);
    const bus = new Diagnostics();
    bus.warn('CL0426', 'source-only finding', { file: 'Codex/items.cl.yaml' });

    const result = runLintMode(tmp, outDir, { diagnostics: bus, scan: false });
    const reportText = fs.readFileSync(result.reportPath, 'utf8');

    expect(result.warnCount).toBe(1);
    expect(reportText).toContain('CL0426');
    expect(reportText).not.toContain('CL0430');
    fs.rmSync(tmp, { recursive: true });
    fs.rmSync(outDir, { recursive: true });
  });

  test('writes seeded loader diagnostics when no compiled tree exists', () => {
    const tmp = makeTmp();
    const missingRoot = path.join(tmp, 'missing-output');
    const outDir = path.join(tmp, 'reports');
    const bus = new Diagnostics();
    bus.error('CL0140', 'item has no identity', { file: 'Codex/items.cl.yaml' });

    const result = runLintMode(missingRoot, outDir, { diagnostics: bus, scan: false });

    expect(result).toMatchObject({ errorCount: 1, warnCount: 0, fileCount: 0 });
    expect(fs.readFileSync(result.reportPath, 'utf8')).toContain('CL0140');
    fs.rmSync(tmp, { recursive: true });
  });

  test('a fenced block with no heading is reported as an untitled card, not a crash', () => {
    // `parseCards` gives such a block `title: null`. The finding used to carry that null as
    // `card`, and both renderings branch on `card` to pick a location form — so it fell to
    // the line-numbered form with no lines to read and threw from inside the report writer.
    const tmp = makeTmp();
    const outDir = makeTmp();
    write(path.join(tmp, 'Story Cards', 'Character', 'bare.md'), ['~~~', 'She walks in.', '~~~', ''].join('\n'));

    const bus = new Diagnostics();
    const result = runLintMode(tmp, outDir, { diagnostics: bus });
    expect(result.written.length).toBeGreaterThan(0);
    const untitled = bus.all.find((d) => d.code === 'CL0635');
    expect(untitled).toMatchObject({ file: path.join('Story Cards', 'Character', 'bare.md') });
    expect(untitled.message).toContain('card "(untitled)"');
    expect(fs.readFileSync(result.reportPath, 'utf8')).toContain('card "(untitled)"');

    fs.rmSync(tmp, { recursive: true });
    fs.rmSync(outDir, { recursive: true });
  });

  test('a wtg requireCard rule fires per leaf offline — names only the branch with no card', () => {
    const tmp = makeTmp();
    const outDir = makeTmp();
    const TC = [
      '## WTG Time Config', '~~~', 'encapsulate: false', '~~~',
      'Starting Date: 6/28/1326', 'Starting Era: AD', 'Starting Time: 9:00 AM', 'Initialized: true',
    ].join('\n');
    // Branch A resolves a WTG Time Config card; branch B does not.
    write(path.join(tmp, 'Branches', 'A', 'Story Cards', 'zz_Settings', 'tc.md'), TC);
    write(path.join(tmp, 'Branches', 'B', 'Story Cards', 'Character', 'y.md'), '## Y\n~~~\nencapsulate: false\n~~~\nbody\n');

    const result = runLintMode(tmp, outDir, { config: { lint: { packs: { wtg: {} } } } });
    const reportText = fs.readFileSync(result.reportPath, 'utf8');

    const hits = reportText.split('\n').filter((l) => l.includes('CL-wtg/0002'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('leaf "B"');
    expect(hits[0]).not.toContain('leaf "A"');

    fs.rmSync(tmp, { recursive: true });
    fs.rmSync(outDir, { recursive: true });
  });

  test('duckieConv offline runs budget + the meta role rule and does not crash on the item-rules path', () => {
    const tmp = makeTmp();
    const outDir = makeTmp();
    // A card whose fence carries meta.duckieConv.role, with an over-budget body and a
    // typo'd role — both of which the offline arm (evaluatePack) can see.
    const over = [
      '## Big NPC', '~~~', 'encapsulate: false',
      'meta:', '  duckieConv:', '    role: minr', '~~~',
      'x'.repeat(500),
    ].join('\n');
    write(path.join(tmp, 'Story Cards', 'Character', 'big.md'), over);

    const result = runLintMode(tmp, outDir, { config: { lint: { packs: { duckieConv: {} } } } });
    const reportText = fs.readFileSync(result.reportPath, 'utf8');
    const packLines = reportText.split('\n').filter((l) => l.includes('CL-duckieConv/'));

    // budget fired (fell back to standard), and the meta role rule flagged the bad value.
    expect(packLines.some((l) => /role "standard" targets 400/.test(l))).toBe(true);
    expect(packLines.some((l) => /"role" is "minr"/.test(l))).toBe(true);
    // count / mutexHint never run offline (Decision 5) — no item-count or merge-down text,
    // and no throw reached this line.
    expect(reportText).not.toMatch(/expected at (least|most) \d+/);
    expect(reportText).not.toContain('audit for overlap');

    fs.rmSync(tmp, { recursive: true });
    fs.rmSync(outDir, { recursive: true });
  });
});
