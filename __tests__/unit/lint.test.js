'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  scanText,
  scanStoryCardStructure,

  findLintableFiles,
  runLintMode,
} = require('../../src/lint');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-lint-test-'));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// ── scanText ─────────────────────────────────────────────────────────────────

describe('scanText', () => {
  test('flags unresolved field tokens', () => {
    const findings = scanText('one of the top mages, has built {$her~} reputation');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: 'unresolved-field-token', severity: 'ERROR', match: '{$her~}' });
    expect(findings[0].lines).toEqual([1]);
  });

  test('flags unexpanded compile variables', () => {
    const findings = scanText('Setting: {%setting}');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: 'unexpanded-variable', match: '{%setting}' });
  });

  test('flags leaked template render functions', () => {
    const findings = scanText('Physical Traits: {join("; ", $body.Physical Traits.gender)}');
    expect(findings.some(f => f.category === 'template-function')).toBe(true);
  });

  test('flags leaked template control tags', () => {
    const findings = scanText('{if $body.Background}\nBackground:\n{/if}');
    const categories = findings.map(f => f.category);
    expect(categories).toContain('template-tag');
  });

  test('flags unresolved verb conjugation markers', () => {
    const findings = scanText('Aness love[s] magic research');
    expect(findings.some(f => f.category === 'verb-conjugation-marker' && f.match === '[s]')).toBe(true);
  });

  test('flags a made-up verb marker like [does] as a suspect marker, not silently', () => {
    const findings = scanText('Aness love[does] magic research');
    expect(findings).toContainEqual(expect.objectContaining({ category: 'suspect-verb-marker', severity: 'WARN', match: '[does]' }));
  });

  test('flags other guessed verb-marker typos ([have], [do])', () => {
    expect(scanText('Aness [have] the ring').some(f => f.category === 'suspect-verb-marker' && f.match === '[have]')).toBe(true);
    expect(scanText('Aness [do] not know').some(f => f.category === 'suspect-verb-marker' && f.match === '[do]')).toBe(true);
  });

  test('does not flag the real markers or [e] as suspect', () => {
    const findings = scanText('[e] Aness love[s] magic, love[es], love[is], love[was], love[has]');
    expect(findings.some(f => f.category === 'suspect-verb-marker')).toBe(false);
  });

  test('does not flag [Secret: ...] or other non-lowercase-word bracket usage as suspect', () => {
    const findings = scanText('[Secret: hidden detail the AI should not reveal]');
    expect(findings.some(f => f.category === 'suspect-verb-marker')).toBe(false);
  });

  test('does not flag a single-word AID trigger in the fence as a suspect marker', () => {
    const card = `## Door

~~~
triggers: [door]
encapsulate: true
~~~

[e] A plain wooden door leading to the cellar.
`;
    const findings = scanText(card);
    expect(findings.some(f => f.category === 'suspect-verb-marker')).toBe(false);
  });

  test('still flags a suspect marker in the body even when the fence has a single-word trigger', () => {
    const card = `## Aness

~~~
triggers: [magic]
encapsulate: true
~~~

[e] Aness love[does] magic research.
`;
    const findings = scanText(card);
    expect(findings).toContainEqual(expect.objectContaining({ category: 'suspect-verb-marker', match: '[does]' }));
  });

  test('flags JS interpolation artifacts', () => {
    const findings = scanText('Background: [object Object]');
    expect(findings.some(f => f.category === 'js-interpolation-artifact')).toBe(true);
  });

  test('flags bare undefined/NaN as warnings', () => {
    const findings = scanText('Age: undefined');
    expect(findings[0]).toMatchObject({ category: 'js-interpolation-word', severity: 'WARN' });
  });

  test('groups repeated occurrences of the same token with all line numbers', () => {
    const text = '{$her~}\nsecond line\n{$her~}';
    const findings = scanText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].lines).toEqual([1, 3]);
  });

  test('clean text produces no findings', () => {
    expect(scanText('Aness loves magic research — she leaps to conclusions.')).toEqual([]);
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
    expect(scanStoryCardStructure('## Tone\n\nWrite in close third person.')).toEqual([]);
  });

  test('a trigger list inside the body does not satisfy the fence check', () => {
    // The check reads the parsed fence, not the text: prose that happens to contain
    // `triggers: [A]` below the fence must not make an empty card look populated.
    const card = '## A\n~~~\n~~~\ntriggers: [A]\n';
    expect(scanStoryCardStructure(card).map((f) => f.category))
      .toContain('empty-triggers');
  });
});

describe('scanStoryCardStructure', () => {
  test('valid [e] card produces no findings', () => {
    expect(scanStoryCardStructure(CARD_WITH_E)).toEqual([]);
  });

  test('valid discovery-marker card produces no findings', () => {
    expect(scanStoryCardStructure(CARD_DISCOVERED)).toEqual([]);
  });

  test('a card with no [e] and no /] is not a finding', () => {
    // `missing-discovery-marker` and `e-marker-conflict` were one mod's convention, and
    // fired on every card of every project that does not use it. Convention packs (§8.2.2)
    // are where rules of that shape belong.
    const card = `## Neither

~~~
triggers: [Neither]
~~~

Just a plain body with no marker.
`;
    expect(scanStoryCardStructure(card)).toEqual([]);
  });

  test('a card with both [e] and /] is not a finding', () => {
    const card = `## Conflicted

~~~
triggers: [Conflicted]
~~~

[e] Conflicted thing /]
`;
    expect(scanStoryCardStructure(card)).toEqual([]);
  });

  test('encapsulate is no longer checked — the emitter writes it, not the author', () => {
    const card = '## NoEncap\n~~~\ntriggers: [NoEncap]\n~~~\n[e] body\n';
    expect(scanStoryCardStructure(card)).toEqual([]);
  });

  test('flags empty trigger list', () => {
    const bad = `## NoTriggers

~~~
triggers: []
encapsulate: true
~~~

[e] NoTriggers has no triggers
`;
    const findings = scanStoryCardStructure(bad);
    expect(findings).toContainEqual(expect.objectContaining({ category: 'empty-triggers', card: 'NoTriggers' }));
  });

});

// ── findLintableFiles ─────────────────────────────────────────────────────────

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
  test('returns null when there is nothing to lint', () => {
    const tmp = makeTmp();
    const outDir = makeTmp();
    const result = runLintMode(tmp, outDir);
    expect(result).toBeNull();
    fs.rmSync(tmp, { recursive: true });
    fs.rmSync(outDir, { recursive: true });
  });

  test('writes a report file and returns counts', () => {
    const tmp = makeTmp();
    const outDir = makeTmp();
    write(path.join(tmp, 'Story Cards', 'Character', 'aness.md'), CARD_WITH_E);
    write(path.join(tmp, 'Components', 'Opening.md'), 'Hello {$her~}, welcome.');

    const result = runLintMode(tmp, outDir);
    expect(result).not.toBeNull();
    expect(result.errorCount).toBeGreaterThan(0);
    expect(fs.existsSync(result.reportPath)).toBe(true);
    const reportText = fs.readFileSync(result.reportPath, 'utf8');
    expect(reportText).toContain('unresolved-field-token');

    fs.rmSync(tmp, { recursive: true });
    fs.rmSync(outDir, { recursive: true });
  });
});
