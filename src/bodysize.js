'use strict';

/**
 * `--card-sizes` — the diagnostic tool for §8.5's platform caps (Phase 5 Step 6).
 *
 * The compiler enforces the caps at emit time; this reports on them afterward, against a
 * tree that may have been compiled by an earlier run. That post-hoc stance is deliberate
 * (§8.6): the mode whose whole job is inspection should not require a recompile to answer
 * a question about output already on disk. The cost is that the placeholder table has to
 * be rebuilt from the written `Placeholders.yaml` chain rather than handed over in memory,
 * which `mergedPlaceholders` below does exactly.
 *
 * ## Why the numbers are distances, not sizes
 *
 * The old report printed `Body Size` and left the author holding 2,000 in their head while
 * reading a column that never mentioned it — and that contained no Openings at all, since
 * they were not measured. What an author acts on is *headroom*: how much a card can still
 * grow, and which one is closest to being silently truncated on upload. So every row
 * carries its own limit and what remains of it, and rows sort by what remains rather than
 * by size, which puts the actionable end of a 2,400-row corpus first.
 *
 * ## Why this collector is not the seed map's
 *
 * `collectLeafCards` filters through `parseCardsFromMd`, which keeps only cards with
 * triggers. That filter is right for the seed map — a trigger-less card is genuinely
 * unseedable — and wrong here, because §4.8 puts hard limits on everything including
 * `kind: reference` items. A reference card over 2,000 characters was invisible to the one
 * report that exists to find it. Both collectors share the same walk and the same merge now
 * (`compiledTree.js`, Phase 10 Step 1); what this one declines is the trigger filter.
 *
 * `hasFence` is still required, matching `lint.js`'s `scanStoryCardStructure`. That is not a seedability judgment
 * but the definition of a card: a headed section with no fence is prose in a Story Cards
 * file, and Codex Loom fences every card it emits.
 *
 * ## Why Openings are walked per node rather than per leaf
 *
 * §8.5's 4,000 cap lands on each `Opening.md` file independently. `scenario.py:30` merges
 * components as `{**parent, **local}` keyed by *filename*, so a leaf's opening replaces an
 * ancestor's rather than extending it — an interior node's `branchFraming` and a leaf's
 * opening are two files under two separate caps, not one accumulating total. Walking leaves
 * would measure an inherited opening once per leaf that inherits it, and would never
 * measure a framing file that every leaf overrides.
 *
 * Story cards go the other way, and per-leaf is right for them: one card file inherited by
 * eight leaves is measured eight times because the merged placeholder table differs per
 * leaf, so its post-substitution length does too.
 */

const fs   = require('fs');
const path = require('path');

const { buildTree, flattenNodes, resolveAt } = require('./compiledTree');
const { LIMITS, measure }                    = require('./limits');

// ── collection ────────────────────────────────────────────────────────────────

/**
 * Every node in the compiled tree, root first, depth-first through `Branches/`.
 *
 * A thin adapter over the shared tree (`compiledTree.js`, Phase 10 Decision 1/Step 1) kept
 * at this shape and this name because it is a tested public entry point; the traversal
 * itself lives in one place now. `discoverLeaves` cannot serve here: it returns only the
 * leaves, and the interior nodes it passes through are exactly where `branchFraming` lives.
 */
function discoverNodes(nodeDir) {
  return flattenNodes(buildTree(nodeDir))
    .map((n) => ({ nodeDir: n.dir, branchNames: n.branchNames, isLeaf: n.isLeaf }));
}

/**
 * Rebuild the placeholder table Velvet Lattice will hold at a node.
 *
 * A plain `{...parent, ...local}` down the ancestor chain, which is VL's own merge
 * (`scenario.py:30`) — and it needs no further expansion because `emit/placeholders.js`
 * already resolved nesting on the way out, precisely so that VL's single substitution pass
 * produces the right text regardless of declaration order. `compiledTree.js:resolveAt` folds
 * the chain; this just names the half of it this report wants.
 */
function mergedPlaceholders(nodeDir) {
  return resolveAt(nodeDir).resolved.placeholders;
}

/**
 * Every card visible to a leaf, unfiltered by triggers.
 *
 * Keyed by name, matching VL's own merge (Decision 3): a leaf that overrides one card of
 * a name measures that one card, not the ancestor's copy as well — two names collide the
 * same way they collide for AID, and only the winner is sized. `hasFence` is still
 * required here, matching `lint.js`'s `scanStoryCardStructure` — a headed section with no fence is prose, not a
 * card — and is this report's own filter over `compiledTree.js`'s `resolved.cards`, not a
 * merge rule.
 */
function collectLeafCardsForSizing(leafDir) {
  return resolveAt(leafDir).resolved.cards.filter((card) => card.hasFence);
}

// ── measurement ───────────────────────────────────────────────────────────────

/** `OVER` past the cap, `NEAR` inside the WARN band, `OK` below it — `limits.js`'s bands. */
function statusOf(stored, limit) {
  if (stored > limit.cap)     return 'OVER';
  if (stored >= limit.warnAt) return 'NEAR';
  return 'OK';
}

/**
 * One measured string as a report row.
 *
 * `kind` carries what sort of thing this is within its target — `story`/`reference` for a
 * card, `leaf`/`framing` for an Opening. Both answer the same question for their target:
 * which file do I go and edit, and is it the sort an exemption might apply to.
 *
 * ## Why the keys are `compiled` and `onUpload` rather than `limits.js`'s words
 *
 * A row is a display model and speaks the vocabulary the columns do, so that grepping a
 * column header finds the code that produces it. `limits.js` keeps `rendered`/`expanded`,
 * which are this codebase's own words for the same two numbers — `rendered` meaning what
 * Codex Loom emitted, as in `compile.js` and `emit/vl.js`.
 *
 * The report cannot borrow those words, because its reader does not have the codebase to
 * read them against. "Rendered" to an author means what AID displays, and that is a *third*
 * length this report never shows: after the player answers the prompt, `${What is your
 * name?}` collapses to `Aness` and the text gets shorter. No cap applies to that one. The cap
 * applies to `onUpload`, which is the peak between Velvet Lattice's substitution and the
 * player answering.
 */
function measureRow(text, questions, limit, { branchLabel, target, title, kind }) {
  const result = measure(text, questions);
  return {
    branchLabel,
    target,
    title,
    kind,
    compiled:  result.rendered,
    onUpload:  result.expanded,
    added:     result.added,
    refs:      result.refs,
    limit:     limit.cap,
    remaining: limit.cap - result.expanded,
    status:    statusOf(result.expanded, limit),
  };
}

/**
 * Collect every row the report covers: one per `Opening.md` in the tree, and one per card
 * per leaf that sees it.
 *
 * Sorted by remaining ascending — the tightest first, which is the order the report exists
 * to produce. Ties break on branch then title so a re-run is byte-identical.
 */
function collectRows(rootAbs, rootDirName, { verbose = false } = {}) {
  const rows  = [];
  const nodes = discoverNodes(rootAbs);

  for (const node of nodes) {
    const label     = node.branchNames.length > 0 ? node.branchNames.join(' - ') : rootDirName;
    const questions = mergedPlaceholders(node.nodeDir);

    const openingPath = path.join(node.nodeDir, 'Components', 'Opening.md');
    if (fs.existsSync(openingPath)) {
      rows.push(measureRow(
        fs.readFileSync(openingPath, 'utf8'),
        questions,
        LIMITS.opening,
        {
          branchLabel: label,
          target: 'Opening',
          title: 'Opening.md',
          kind: node.isLeaf ? 'leaf' : 'framing',
        },
      ));
    }

    if (!node.isLeaf) continue;

    const cards = collectLeafCardsForSizing(node.nodeDir);
    for (const card of cards) {
      rows.push(measureRow(card.body, questions, LIMITS.cardBody, {
        branchLabel: label,
        target: 'Card',
        title: card.title === null || card.title === undefined ? '' : card.title,
        kind: card.kind,
      }));
    }
    if (verbose) console.log(`  sized: ${label} (${cards.length} cards)`);
  }

  rows.sort((a, b) => (
    a.remaining - b.remaining
    || a.branchLabel.localeCompare(b.branchLabel)
    || a.title.localeCompare(b.title)
  ));

  return { rows, nodes };
}

// ── formatting ────────────────────────────────────────────────────────────────

function csvCell(value) {
  const s = String(value);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

/** Thousands separators in prose, raw integers in the CSV — one is read, one is sorted. */
const n = (value) => Number(value).toLocaleString('en-US');

/**
 * The complete data, one row per measured string.
 *
 * `Compiled` and `On Upload` are separate columns because they differ exactly when
 * placeholders are involved, and the gap is what §8.5 is about: a project can pass a naive
 * length check on what Codex Loom wrote and overflow the cap once Velvet Lattice expands
 * the placeholders on the way to AID. `On Upload` is the column the cap applies to.
 */
function formatBodySizeCsv(leafless, rows) {
  const head = ['Target', 'Title', 'Kind', 'Compiled', 'On Upload', 'Limit', 'Remaining', 'Status'];
  const out  = [(leafless ? head : ['Branch', ...head]).join(',')];

  for (const row of rows) {
    const cells = [
      csvCell(row.target), csvCell(row.title), csvCell(row.kind),
      row.compiled, row.onUpload, row.limit, row.remaining, row.status,
    ];
    out.push((leafless ? cells : [csvCell(row.branchLabel), ...cells]).join(','));
  }

  return out.join('\n');
}

/** The three groups §4.8 distinguishes, in the order an author reads them. */
const SECTIONS = [
  {
    heading: 'Openings',
    one: 'Opening',
    limit: LIMITS.opening,
    match: (r) => r.target === 'Opening',
  },
  {
    heading: 'Story cards',
    one: 'story card',
    limit: LIMITS.cardBody,
    match: (r) => r.target === 'Card' && r.kind === 'story',
  },
  {
    heading: 'Reference cards',
    one: 'reference card',
    limit: LIMITS.cardBody,
    match: (r) => r.target === 'Card' && r.kind === 'reference',
  },
];

/** One pressured row, with the substitution gap spelled out when there is one. */
function formatRowLine(row, leafless) {
  const where = leafless ? '' : ` · _${row.branchLabel}_`;
  const gap = row.added > 0
    ? ` (${n(row.compiled)} compiled; ${row.refs} placeholder `
      + `${row.refs === 1 ? 'reference adds' : 'references add'} ${n(row.added)})`
    : '';
  const distance = row.remaining < 0
    ? `**${n(-row.remaining)} over** the ${n(row.limit)} limit`
    : `${n(row.remaining)} left of ${n(row.limit)}`;
  return `- **${row.title}** — ${n(row.onUpload)} on upload${gap}, ${distance}${where}`;
}

/**
 * The readable half: a summary table, then every row at NEAR or OVER.
 *
 * Filtered on purpose. The Institute measures over 2,400 strings, and listing them all in
 * markdown produces a document nobody reads; the CSV is where the full corpus lives. What
 * belongs here is what needs acting on, plus enough of a summary to show that the rest was
 * measured and is clear.
 */
function formatBodySizeMd(rootDirName, leafless, rows) {
  const parts = [`# Card Sizes — ${rootDirName}`];

  const summary = ['| Target | Measured | Over | Near | Tightest |', '|---|---|---|---|---|'];
  for (const section of SECTIONS) {
    const group = rows.filter(section.match);
    if (group.length === 0) {
      summary.push(`| ${section.heading} | 0 | — | — | — |`);
      continue;
    }
    const over = group.filter((r) => r.status === 'OVER').length;
    const near = group.filter((r) => r.status === 'NEAR').length;
    // `rows` is already sorted by remaining ascending, so the first match is the tightest.
    const worst = group[0];
    // The branch is what names the file. Sixty-one Openings are all called `Opening.md`,
    // and one card title can appear on every leaf that inherits it, so the title alone
    // does not say which one to go and edit.
    const which = leafless ? worst.title : `${worst.title} · ${worst.branchLabel}`;
    const tightest = worst.remaining < 0
      ? `${n(-worst.remaining)} over — ${which}`
      : `${n(worst.remaining)} left — ${which}`;
    summary.push(`| ${section.heading} (limit ${n(section.limit.cap)}) | ${n(group.length)} `
      + `| ${over} | ${near} | ${tightest} |`);
  }
  parts.push(summary.join('\n'));

  for (const section of SECTIONS) {
    const group     = rows.filter(section.match);
    const pressured = group.filter((r) => r.status !== 'OK');
    parts.push(`## ${section.heading}`);

    if (group.length === 0) {
      parts.push('_None in this project._');
    } else if (pressured.length === 0) {
      const subject = group.length === 1
        ? `The one ${section.one} is`
        : `All ${n(group.length)} ${section.heading.toLowerCase()} are`;
      parts.push(`_${subject} under ${n(section.limit.warnAt)} characters — `
        + `clear of the ${n(section.limit.cap)} limit._`);
    } else {
      parts.push(pressured.map((r) => formatRowLine(r, leafless)).join('\n'));
    }
  }

  return parts.join('\n\n');
}

// ── runner ────────────────────────────────────────────────────────────────────

/**
 * Run card-sizes mode on a scenario output root.
 *
 * Writes `{name}.bodysize.csv` (every measured string) and `{name}.bodysize.md` (the
 * summary, and everything at NEAR or OVER) to outputDir. Returns { csvPath, mdPath }.
 */
function runBodySizeMode(scenarioRoot, outputDir, verbose = false) {
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);

  const { rows, nodes } = collectRows(rootAbs, rootDirName, { verbose });

  if (rows.length === 0) {
    console.warn('  WARN: No cards or Openings found — nothing to size.');
    return null;
  }

  // The Branch column earns its place only when there is more than one node to name.
  const leafless = nodes.length === 1 && nodes[0].branchNames.length === 0;

  const csvPath = path.join(outputDir, `${rootDirName}.bodysize.csv`);
  const mdPath  = path.join(outputDir, `${rootDirName}.bodysize.md`);

  fs.writeFileSync(csvPath, formatBodySizeCsv(leafless, rows) + '\n', 'utf8');
  fs.writeFileSync(mdPath,  formatBodySizeMd(rootDirName, leafless, rows) + '\n', 'utf8');

  return { csvPath, mdPath };
}

module.exports = {
  runBodySizeMode,
  discoverNodes,
  mergedPlaceholders,
  collectLeafCardsForSizing,
  collectRows,
};
