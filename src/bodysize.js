'use strict';


const fs   = require('fs');
const path = require('path');

const { buildTree, flattenNodes, resolveAt } = require('./compiledTree');
const { LIMITS, measure }                    = require('./limits');
const { NULL_LOG }                           = require('./log');
const { csvCell, branchLabel }               = require('./report');


function discoverNodes(nodeDir) {
  return flattenNodes(buildTree(nodeDir))
    .map((n) => ({ nodeDir: n.dir, branchNames: n.branchNames, isLeaf: n.isLeaf }));
}

function mergedPlaceholders(nodeDir) {
  return resolveAt(nodeDir).resolved.placeholders;
}

function collectLeafCardsForSizing(leafDir) {
  return resolveAt(leafDir).resolved.cards.filter((card) => card.hasFence);
}


function statusOf(stored, limit) {
  if (stored > limit.cap)     return 'OVER';
  if (stored >= limit.warnAt) return 'NEAR';
  return 'OK';
}

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

function collectRows(rootAbs, rootDirName, { log = NULL_LOG } = {}) {
  const rows  = [];
  const nodes = discoverNodes(rootAbs);

  for (const node of nodes) {
    const label     = branchLabel(node.branchNames, rootDirName);
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
    log.verbose(`  sized: ${label} (${cards.length} cards)`);
  }

  rows.sort((a, b) => (
    a.remaining - b.remaining
    || a.branchLabel.localeCompare(b.branchLabel)
    || a.title.localeCompare(b.title)
  ));

  return { rows, nodes };
}


const n = (value) => Number(value).toLocaleString('en-US');

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

function formatBodySizeMd(rootDirName, leafless, rows) {
  const parts = [`# Body Sizes — ${rootDirName}`];

  const summary = ['| Target | Measured | Over | Near | Tightest |', '|---|---|---|---|---|'];
  for (const section of SECTIONS) {
    const group = rows.filter(section.match);
    if (group.length === 0) {
      summary.push(`| ${section.heading} | 0 | — | — | — |`);
      continue;
    }
    const over = group.filter((r) => r.status === 'OVER').length;
    const near = group.filter((r) => r.status === 'NEAR').length;
    const worst = group[0];
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


function runBodySizeMode(scenarioRoot, outputDir, options = {}) {
  const { log = NULL_LOG } = options;
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);

  const { rows, nodes } = collectRows(rootAbs, rootDirName, { log });

  if (rows.length === 0) return { written: [] };

  const leafless = nodes.length === 1 && nodes[0].branchNames.length === 0;

  const csvPath = path.join(outputDir, `${rootDirName}.bodysize.csv`);
  const mdPath  = path.join(outputDir, `${rootDirName}.bodysize.md`);

  fs.writeFileSync(csvPath, formatBodySizeCsv(leafless, rows) + '\n', 'utf8');
  fs.writeFileSync(mdPath,  formatBodySizeMd(rootDirName, leafless, rows) + '\n', 'utf8');

  return { written: [csvPath, mdPath], csvPath, mdPath };
}

module.exports = {
  runBodySizeMode,
  discoverNodes,
  mergedPlaceholders,
  collectLeafCardsForSizing,
  collectRows,
};
