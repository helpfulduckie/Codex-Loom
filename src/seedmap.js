'use strict';

const fs   = require('fs');
const path = require('path');

const { discoverLeaves } = require('./overview');

// ── parsing ──────────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a compiled Story Cards .md file into an array of card objects.
 * Each section starts with `## Title`, followed by a ~~~ fence, then body text.
 */
function parseCardsFromMd(content) {
  const cards = [];
  const sections = content.split(/^(?=## )/m);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const titleMatch = trimmed.match(/^## (.+)/);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim();

    // Find the ~~~ fence pair
    const firstFence = trimmed.indexOf('~~~');
    if (firstFence === -1) continue;
    const secondFence = trimmed.indexOf('~~~', firstFence + 3);
    if (secondFence === -1) continue;

    const fenceContent = trimmed.slice(firstFence + 3, secondFence);
    const triggerMatch = fenceContent.match(/^triggers:\s*\[(.+)\]/m);
    if (!triggerMatch) continue;

    const triggers = triggerMatch[1]
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    const body = trimmed.slice(secondFence + 3).trim();

    cards.push({ title, triggers, body });
  }

  return cards;
}

/**
 * Collect all parsed cards visible to a leaf node: read Story Cards .md files
 * from the leaf dir and each ancestor branch dir, accumulating upward.
 */
function collectLeafCards(leafDir) {
  const cards = [];
  const visited = new Set();

  // Walk from leafDir upward through Branches/ parent levels
  let dir = leafDir;
  const dirs = [];
  while (true) {
    dirs.unshift(dir); // collect root-first
    const parent     = path.dirname(dir);
    const parentName = path.basename(parent);
    if (parent === dir || parentName !== 'Branches') break;
    dir = path.dirname(parent);
  }

  for (const branchDir of dirs) {
    const storyCardsDir = path.join(branchDir, 'Story Cards');
    if (!fs.existsSync(storyCardsDir)) continue;

    const mdFiles = collectMdFiles(storyCardsDir);
    for (const file of mdFiles) {
      if (visited.has(file)) continue;
      visited.add(file);
      const content = fs.readFileSync(file, 'utf8');
      cards.push(...parseCardsFromMd(content));
    }
  }

  return cards;
}

function collectMdFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) results.push(full);
    }
  }
  walk(dir);
  return results;
}

// ── analysis ─────────────────────────────────────────────────────────────────

/**
 * For every card, find which other cards' bodies contain its triggers.
 * Returns an array of { seeder, seeded, via } objects.
 * Self-matches (seeder.title === seeded.title) are skipped.
 */
function buildSeedRelations(cards) {
  const relations = [];

  for (const seeded of cards) {
    for (const trigger of seeded.triggers) {
      const re = new RegExp(`\\b${escapeRegex(trigger)}\\b`, 'gi');
      for (const seeder of cards) {
        if (seeder.title === seeded.title) continue;
        if (re.test(seeder.body)) {
          relations.push({ seeder: seeder.title, seeded: seeded.title, via: trigger });
        }
      }
    }
  }

  return relations;
}

// ── formatting ────────────────────────────────────────────────────────────────

function formatSeedMap(rootDirName, leafResults) {
  const parts = [`# Seed Map — ${rootDirName}`];
  const singleLeaf = leafResults.length === 1 && leafResults[0].branchNames.length === 0;

  for (const { branchNames, cards, relations } of leafResults) {
    if (!singleLeaf) {
      const branchLabel = branchNames.length > 0 ? branchNames.join(' - ') : rootDirName;
      parts.push(`## Branch: ${branchLabel}`);
    }

    if (cards.length === 0) {
      parts.push('_No compiled cards found._');
      continue;
    }

    // Group relations by seeded card (inbound view)
    const inbound = new Map(); // seeded title → [{ seeder, via }]
    for (const rel of relations) {
      if (!inbound.has(rel.seeded)) inbound.set(rel.seeded, []);
      inbound.get(rel.seeded).push({ seeder: rel.seeder, via: rel.via });
    }

    const cardLines = [];
    for (const card of cards) {
      const triggerList = card.triggers.length > 0
        ? `\`[${card.triggers.join(', ')}]\``
        : '`[]`';
      const seeds = inbound.get(card.title) || [];

      const header = `**${card.title}** ${triggerList}`;
      if (seeds.length === 0) {
        cardLines.push(`${header}\n— _(no inbound seeds)_`);
      } else {
        const seedLines = seeds
          .map(s => `- seeded by **${s.seeder}** · via _${s.via}_`)
          .join('\n');
        cardLines.push(`${header}\n${seedLines}`);
      }
    }

    parts.push(cardLines.join('\n\n'));
  }

  return parts.join('\n\n');
}

function csvCell(value) {
  const s = String(value);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function formatSeedMapCsv(rootDirName, leafResults) {
  const singleLeaf = leafResults.length === 1 && leafResults[0].branchNames.length === 0;
  const rows = [];

  if (singleLeaf) {
    rows.push('Title,Triggers,Seeded By');
  } else {
    rows.push('Branch,Title,Triggers,Seeded By');
  }

  for (const { branchNames, cards, relations } of leafResults) {
    const branchLabel = branchNames.length > 0 ? branchNames.join(' - ') : rootDirName;

    // Count distinct seeder cards per seeded title
    const seederSets = new Map(); // seeded title → Set of seeder titles
    for (const rel of relations) {
      if (!seederSets.has(rel.seeded)) seederSets.set(rel.seeded, new Set());
      seederSets.get(rel.seeded).add(rel.seeder);
    }

    for (const card of cards) {
      const seededBy = (seederSets.get(card.title) || new Set()).size;
      if (singleLeaf) {
        rows.push([csvCell(card.title), card.triggers.length, seededBy].join(','));
      } else {
        rows.push([csvCell(branchLabel), csvCell(card.title), card.triggers.length, seededBy].join(','));
      }
    }
  }

  return rows.join('\n');
}

// ── runner ────────────────────────────────────────────────────────────────────

/**
 * Run seed-map mode on a scenario output root.
 * Discovers all leaf branches, collects their compiled cards, builds seed
 * relations, and writes a .seedmap.md and .seedmap.csv to outputDir.
 * Returns { mdPath, csvPath }.
 */
function runSeedMapMode(scenarioRoot, outputDir, verbose = false) {
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const leaves      = discoverLeaves(rootAbs, [], []);

  if (leaves.length === 0) {
    console.warn('  WARN: No branch leaves found — nothing to map.');
    return null;
  }

  const leafResults = [];
  for (const leaf of leaves) {
    const cards     = collectLeafCards(leaf.leafDir);
    const relations = buildSeedRelations(cards);
    leafResults.push({ branchNames: leaf.branchNames, cards, relations });
    if (verbose) {
      const label = leaf.branchNames.join(' - ') || rootDirName;
      console.log(`  mapped: ${label} (${cards.length} cards, ${relations.length} seeds)`);
    }
  }

  const mdPath  = path.join(outputDir, `${rootDirName}.seedmap.md`);
  const csvPath = path.join(outputDir, `${rootDirName}.seedmap.csv`);

  fs.writeFileSync(mdPath,  formatSeedMap(rootDirName, leafResults) + '\n', 'utf8');
  fs.writeFileSync(csvPath, formatSeedMapCsv(rootDirName, leafResults) + '\n', 'utf8');

  return { mdPath, csvPath };
}

module.exports = { runSeedMapMode, parseCardsFromMd, collectLeafCards, collectMdFiles };
