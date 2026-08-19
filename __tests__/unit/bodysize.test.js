'use strict';

/**
 * `--card-sizes` after the Phase 5 Step 6 rework.
 *
 * The golden corpus pins the report's bytes but cannot test what the rework is *for*: it
 * holds no placeholders, no `kind: reference` card and nothing within a thousand characters
 * of either cap, so every golden row is the degenerate case — status OK, compiled length
 * equal to on-upload length, nothing in the pressured sections. What follows builds the
 * cases the corpus
 * cannot supply: a card the seed map's filter used to drop, an Opening measured per file
 * rather than per leaf, and the post-substitution arithmetic that makes a passing compiled
 * length ship over the cap.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  runBodySizeMode, discoverNodes, mergedPlaceholders, collectLeafCardsForSizing, collectRows,
} = require('../../src/bodysize');

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Write a compiled-output tree and return its root. `files` is relative path → content. */
function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-bodysize-'));
  dirs.push(dir);
  const root = path.join(dir, 'Velvet Lattice');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** A compiled story card as `emit/vl.js` writes it. */
const card = (title, body, fence = 'triggers:\n  - thing') => (
  `## ${title}\n\n~~~\n${fence}\n~~~\n\n${body}\n`
);

const run = (root) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-bodysize-out-'));
  dirs.push(out);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const log  = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const result = runBodySizeMode(root, out, false);
    return result && {
      csv: fs.readFileSync(result.csvPath, 'utf8'),
      md:  fs.readFileSync(result.mdPath, 'utf8'),
    };
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
};

describe('the collector is the report\'s own, not the seed map\'s', () => {
  test('a trigger-less card is measured — §4.8 puts hard limits on everything', () => {
    // The defect the rework fixes: `collectLeafCards` filters through `parseCardsFromMd`,
    // which keeps only cards with triggers, so a reference card over 2,000 characters was
    // invisible to the one report that exists to find it.
    const root = tree({
      'Story Cards/Reference/Atlas.md': card('Atlas', 'body text', 'kind: reference\ntriggers: []'),
    });
    expect(collectLeafCardsForSizing(root).map((c) => c.title)).toEqual(['Atlas']);
  });

  test('a headed section with no fence is prose, not a card', () => {
    // Matching `lint.js:241`. This is a judgment about what a card *is*, which is why it
    // survives the removal of the trigger filter that sat beside it.
    const root = tree({
      'Story Cards/Character/Mixed.md': `${card('Real', 'body')}\n## Just prose\n\nno fence here\n`,
    });
    expect(collectLeafCardsForSizing(root).map((c) => c.title)).toEqual(['Real']);
  });

  test('a card inherited from an ancestor is collected once per leaf that sees it', () => {
    const root = tree({
      'Story Cards/Character/Shared.md': card('Shared', 'body'),
      'Branches/Left/Components/Opening.md': 'left',
      'Branches/Right/Components/Opening.md': 'right',
    });
    const { rows } = collectRows(root, 'Velvet Lattice');
    expect(rows.filter((r) => r.title === 'Shared').map((r) => r.branchLabel).sort())
      .toEqual(['Left', 'Right']);
  });
});

describe('Openings are measured per file, not per leaf', () => {
  /**
   * `scenario.py:30` merges components per *filename*, so a leaf's `Opening.md` replaces an
   * ancestor's rather than extending it. Two files, two independent 4,000-character caps.
   */
  const root = () => tree({
    'Components/Opening.md': 'root framing',
    'Branches/Left/Components/Opening.md': 'left opening',
    'Branches/Right/Story Cards/Character/R.md': card('R', 'body'),
  });

  test('every Opening.md in the tree gets a row, interior nodes included', () => {
    const { rows } = collectRows(root(), 'Velvet Lattice');
    const openings = rows.filter((r) => r.target === 'Opening');
    expect(openings.map((r) => r.branchLabel).sort()).toEqual(['Left', 'Velvet Lattice']);
  });

  test('an interior node\'s Opening is marked framing, a leaf\'s is marked leaf', () => {
    const { rows } = collectRows(root(), 'Velvet Lattice');
    const byBranch = Object.fromEntries(
      rows.filter((r) => r.target === 'Opening').map((r) => [r.branchLabel, r.kind]),
    );
    expect(byBranch).toEqual({ 'Velvet Lattice': 'framing', Left: 'leaf' });
  });

  test('a branch inheriting an Opening does not get a second row for it', () => {
    // Right has no Opening.md of its own. It inherits the root's — which is already
    // measured at the root, and measuring it again under Right would double-count one file.
    const { rows } = collectRows(root(), 'Velvet Lattice');
    expect(rows.filter((r) => r.target === 'Opening' && r.branchLabel === 'Right')).toEqual([]);
  });

  test('discoverNodes returns interior nodes, which discoverLeaves cannot', () => {
    const nodes = discoverNodes(root());
    expect(nodes.map((n) => [n.branchNames.join('/'), n.isLeaf]))
      .toEqual([['', false], ['Left', true], ['Right', true]]);
  });
});

describe('the placeholder table is rebuilt from the written tree', () => {
  test('a child node inherits its ancestors\' declarations', () => {
    const root = tree({
      'Placeholders.yaml': 'heroName: Who are you?\n',
      'Branches/Left/Placeholders.yaml': 'town: Where do you live?\n',
    });
    expect(mergedPlaceholders(path.join(root, 'Branches', 'Left')))
      .toEqual({ heroName: 'Who are you?', town: 'Where do you live?' });
  });

  test('a local key overrides an inherited one — VL\'s {**parent, **local}', () => {
    const root = tree({
      'Placeholders.yaml': 'heroName: Who are you?\n',
      'Branches/Left/Placeholders.yaml': 'heroName: What is your name?\n',
    });
    expect(mergedPlaceholders(path.join(root, 'Branches', 'Left')))
      .toEqual({ heroName: 'What is your name?' });
  });

  test('an unparseable file is skipped rather than throwing', () => {
    // A malformed Placeholders.yaml is the compiler's to report. A report mode that dies on
    // one is a report mode that cannot be used to investigate the tree that has one.
    const root = tree({ 'Placeholders.yaml': 'this: [is: not\n  valid: yaml\n' });
    expect(() => mergedPlaceholders(root)).not.toThrow();
  });
});

describe('measurement is post-substitution — the reason the report is not text.length', () => {
  const question = 'What is your character\'s name?';

  test('on-upload length exceeds compiled length where a placeholder is declared', () => {
    const root = tree({
      'Placeholders.yaml': `heroName: ${question}\n`,
      'Story Cards/Character/H.md': card('H', 'Hello %heroName%.'),
    });
    const [row] = collectRows(root, 'Velvet Lattice').rows.filter((r) => r.title === 'H');
    expect(row.compiled).toBe('Hello %heroName%.'.length);
    expect(row.onUpload).toBe(`Hello \${${question}}.`.length);
    expect(row.refs).toBe(1);
  });

  test('a card passing on compiled length can be OVER on upload', () => {
    // §8.5's failure in miniature: 1,990 compiled characters is under the 2,000 cap, and
    // the same card is over it once Velvet Lattice expands the placeholder.
    const body = `%heroName%${'x'.repeat(1980)}`;
    const root = tree({
      'Placeholders.yaml': `heroName: ${question}\n`,
      'Story Cards/Character/Big.md': card('Big', body),
    });
    const [row] = collectRows(root, 'Velvet Lattice').rows.filter((r) => r.title === 'Big');
    expect(row.compiled).toBeLessThan(2000);
    expect(row.onUpload).toBeGreaterThan(2000);
    expect(row.status).toBe('OVER');
    expect(row.remaining).toBeLessThan(0);
  });

  test('a leaf measures against its own branch\'s table, not the root\'s', () => {
    const root = tree({
      'Story Cards/Character/H.md': card('H', 'Hello %heroName%.'),
      'Branches/Declared/Placeholders.yaml': `heroName: ${question}\n`,
      'Branches/Bare/Components/Opening.md': 'nothing here',
    });
    const rows = collectRows(root, 'Velvet Lattice').rows.filter((r) => r.title === 'H');
    const byBranch = Object.fromEntries(rows.map((r) => [r.branchLabel, r.added]));
    expect(byBranch.Declared).toBeGreaterThan(0);
    expect(byBranch.Bare).toBe(0);
  });
});

describe('status bands', () => {
  const bodyOf = (length) => 'x'.repeat(length);
  const statusFor = (length) => {
    const root = tree({ 'Story Cards/Character/C.md': card('C', bodyOf(length)) });
    return collectRows(root, 'Velvet Lattice').rows[0].status;
  };

  test('below the WARN band is OK', () => expect(statusFor(1799)).toBe('OK'));
  test('at the WARN band is NEAR', () => expect(statusFor(1800)).toBe('NEAR'));
  test('at the cap is still NEAR — the cap is what AID stores, not what it refuses',
    () => expect(statusFor(2000)).toBe('NEAR'));
  test('past the cap is OVER', () => expect(statusFor(2001)).toBe('OVER'));
});

describe('the CSV — every measured string, tightest first', () => {
  test('rows sort by remaining ascending', () => {
    const root = tree({
      'Story Cards/Character/A.md': card('Small', 'x'.repeat(10)),
      'Story Cards/Character/B.md': card('Large', 'x'.repeat(1500)),
    });
    const [, first, second] = run(root).csv.trim().split('\n');
    expect(first).toContain('Large');
    expect(second).toContain('Small');
  });

  test('the Branch column is dropped when the tree is a single unnamed node', () => {
    const root = tree({ 'Story Cards/Character/A.md': card('Solo', 'body') });
    expect(run(root).csv.split('\n')[0])
      .toBe('Target,Title,Kind,Compiled,On Upload,Limit,Remaining,Status');
  });

  test('the Branch column appears as soon as there is a branch to name', () => {
    const root = tree({ 'Branches/Left/Story Cards/Character/A.md': card('A', 'body') });
    expect(run(root).csv.split('\n')[0]).toMatch(/^Branch,Target,/);
  });

  test('a title containing a comma is quoted', () => {
    const root = tree({ 'Story Cards/Character/A.md': card('Quay, Lian', 'body') });
    expect(run(root).csv).toContain('"Quay, Lian"');
  });

  test('kind: reference reaches the CSV from the fence', () => {
    const root = tree({
      'Story Cards/Reference/A.md': card('Atlas', 'body', 'kind: reference\ntriggers: []'),
    });
    expect(run(root).csv).toContain('Card,Atlas,reference,');
  });
});

describe('the markdown report — the summary, and what needs acting on', () => {
  test('a clear section says so rather than listing every row', () => {
    const root = tree({
      'Story Cards/Character/A.md': card('A', 'short'),
      'Story Cards/Character/B.md': card('B', 'also short'),
    });
    const { md } = run(root);
    expect(md).toContain('All 2 story cards are under 1,800 characters');
    expect(md).not.toContain('- **A**');
  });

  test('a single clear row reads as one, not as "All 1"', () => {
    const root = tree({ 'Story Cards/Character/A.md': card('A', 'short') });
    expect(run(root).md).toContain('The one story card is under 1,800 characters');
  });

  test('an over-cap card is listed with how far over it is', () => {
    const root = tree({ 'Story Cards/Character/A.md': card('A', 'x'.repeat(2100)) });
    const { md } = run(root);
    expect(md).toContain('- **A**');
    expect(md).toContain('**100 over** the 2,000 limit');
  });

  test('a near-cap card is listed with what remains', () => {
    const root = tree({ 'Story Cards/Character/A.md': card('A', 'x'.repeat(1850)) });
    expect(run(root).md).toContain('150 left of 2,000');
  });

  test('the substitution gap is spelled out on a row that has one', () => {
    const question = 'What is your character\'s name?';
    const root = tree({
      'Placeholders.yaml': `heroName: ${question}\n`,
      'Story Cards/Character/A.md': card('A', `%heroName%${'x'.repeat(1850)}`),
    });
    expect(run(root).md).toMatch(/1 placeholder reference adds \d+/);
  });

  test('reference cards get their own section, separate from story cards', () => {
    const root = tree({
      'Story Cards/Character/A.md': card('Story', 'x'.repeat(1850)),
      'Story Cards/Reference/B.md': card('Atlas', 'x'.repeat(1900), 'kind: reference\ntriggers: []'),
    });
    const { md } = run(root);
    const storySection = md.slice(md.indexOf('## Story cards'), md.indexOf('## Reference cards'));
    const refSection   = md.slice(md.indexOf('## Reference cards'));
    expect(storySection).toContain('- **Story**');
    expect(storySection).not.toContain('- **Atlas**');
    expect(refSection).toContain('- **Atlas**');
  });

  test('a project with no reference cards says so rather than showing an empty section', () => {
    const root = tree({ 'Story Cards/Character/A.md': card('A', 'body') });
    const { md } = run(root);
    expect(md.slice(md.indexOf('## Reference cards'))).toContain('_None in this project._');
  });

  test('the summary names the branch of the tightest row', () => {
    // Sixty-one Openings are all called `Opening.md`, so the title alone does not locate one.
    const root = tree({
      'Branches/Left/Components/Opening.md': 'x'.repeat(3000),
      'Branches/Right/Components/Opening.md': 'x'.repeat(100),
    });
    expect(run(root).md).toContain('1,000 left — Opening.md · Left');
  });

  test('Openings and cards are counted against their own limits', () => {
    const root = tree({
      'Components/Opening.md': 'x'.repeat(100),
      'Story Cards/Character/A.md': card('A', 'x'.repeat(100)),
    });
    const { md } = run(root);
    expect(md).toContain('| Openings (limit 4,000) | 1 |');
    expect(md).toContain('| Story cards (limit 2,000) | 1 |');
  });
});

describe('an empty tree', () => {
  test('writes nothing and returns null rather than an empty CSV', () => {
    expect(run(tree({}))).toBeNull();
  });
});
