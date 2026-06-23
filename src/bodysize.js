'use strict';

const fs   = require('fs');
const path = require('path');

const { discoverLeaves }               = require('./overview');
const { collectLeafCards }             = require('./seedmap');

// ── formatting ────────────────────────────────────────────────────────────────

function csvCell(value) {
  const s = String(value);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function formatBodySizeCsv(rootDirName, leafResults) {
  const singleLeaf = leafResults.length === 1 && leafResults[0].branchNames.length === 0;
  const rows = [singleLeaf ? 'Title,Body Size' : 'Branch,Title,Body Size'];

  for (const { branchNames, cards } of leafResults) {
    const branchLabel = branchNames.length > 0 ? branchNames.join(' - ') : rootDirName;
    for (const card of cards) {
      if (singleLeaf) {
        rows.push([csvCell(card.title), card.body.length].join(','));
      } else {
        rows.push([csvCell(branchLabel), csvCell(card.title), card.body.length].join(','));
      }
    }
  }

  return rows.join('\n');
}

// ── runner ────────────────────────────────────────────────────────────────────

/**
 * Run card-sizes mode on a scenario output root.
 * Discovers all leaf branches, collects their compiled cards, counts body
 * characters per card, and writes a .bodysize.csv to outputDir.
 * Returns { csvPath }.
 */
function runBodySizeMode(scenarioRoot, outputDir, verbose = false) {
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const leaves      = discoverLeaves(rootAbs, [], []);

  if (leaves.length === 0) {
    console.warn('  WARN: No branch leaves found — nothing to size.');
    return null;
  }

  const leafResults = [];
  for (const leaf of leaves) {
    const cards = collectLeafCards(leaf.leafDir);
    leafResults.push({ branchNames: leaf.branchNames, cards });
    if (verbose) {
      const label = leaf.branchNames.join(' - ') || rootDirName;
      console.log(`  sized: ${label} (${cards.length} cards)`);
    }
  }

  const csvPath = path.join(outputDir, `${rootDirName}.bodysize.csv`);
  fs.writeFileSync(csvPath, formatBodySizeCsv(rootDirName, leafResults) + '\n', 'utf8');

  return { csvPath };
}

module.exports = { runBodySizeMode };
