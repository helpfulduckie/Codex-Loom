'use strict';

const fs   = require('fs');
const path = require('path');

const { discoverLeaves, sanitizeFilename } = require('./overview');

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
 * Walk from a leaf dir upward through Branches/ parent levels.
 * Returns dirs root-first (ancestors before the leaf).
 */
function ancestorDirs(leafDir) {
  let dir = leafDir;
  const dirs = [];
  while (true) {
    dirs.unshift(dir);
    const parent     = path.dirname(dir);
    const parentName = path.basename(parent);
    if (parent === dir || parentName !== 'Branches') break;
    dir = path.dirname(parent);
  }
  return dirs;
}

/**
 * Collect all parsed cards visible to a leaf node: read Story Cards .md files
 * from the leaf dir and each ancestor branch dir, accumulating upward.
 */
function collectLeafCards(leafDir) {
  const cards = [];
  const visited = new Set();

  for (const branchDir of ancestorDirs(leafDir)) {
    const storyCardsDir = path.join(branchDir, 'Story Cards');
    if (!fs.existsSync(storyCardsDir)) continue;

    const mdFiles = collectMdFiles(storyCardsDir);
    for (const file of mdFiles) {
      if (visited.has(file)) continue;
      visited.add(file);
      const content = fs.readFileSync(file, 'utf8');
      const cardType = path.basename(path.dirname(file));
      const parsed = parseCardsFromMd(content).map(c => ({ ...c, type: cardType }));
      cards.push(...parsed);
    }
  }

  return cards;
}

/**
 * Collect the text of Plot Essentials.md and Opening.md visible to a leaf node.
 * Reads from each ancestor dir's Components/ folder (leaf overrides ancestor).
 * Returns { peText, openingText } — empty string when not found.
 */
function collectLeafComponents(leafDir) {
  let peText      = '';
  let openingText = '';

  for (const branchDir of ancestorDirs(leafDir)) {
    const compDir = path.join(branchDir, 'Components');
    const pePath     = path.join(compDir, 'Plot Essentials.md');
    const openPath   = path.join(compDir, 'Opening.md');
    if (fs.existsSync(pePath))    peText      = fs.readFileSync(pePath, 'utf8');
    if (fs.existsSync(openPath))  openingText = fs.readFileSync(openPath, 'utf8');
  }

  return { peText, openingText };
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
 * For every card, find which other cards' bodies or Plot Essentials contain its triggers.
 * Returns an array of { seeder, seeded, via, source } objects.
 *   source: 'card' | 'pe'
 * Self-matches (seeder.title === seeded.title) are skipped.
 */
function buildSeedRelations(cards, peText = '') {
  const relations = [];

  for (const seeded of cards) {
    for (const trigger of seeded.triggers) {
      const re = new RegExp(escapeRegex(trigger), 'gi');

      // Card-to-card seeds
      for (const seeder of cards) {
        if (seeder.title === seeded.title) continue;
        if (re.test(seeder.body)) {
          relations.push({ seeder: seeder.title, seeded: seeded.title, via: trigger, source: 'card' });
        }
      }

      // Plot Essentials seeds
      if (peText && re.test(peText)) {
        relations.push({ seeder: 'Plot Essentials', seeded: seeded.title, via: trigger, source: 'pe' });
      }
    }
  }

  return relations;
}

/**
 * For every card, check whether any of its triggers appear in the Opening text.
 * Returns a Set of card titles that are seeded by the Opening.
 */
function buildOpeningFlags(cards, openingText = '') {
  const seededInOpening = new Set();
  if (!openingText) return seededInOpening;

  for (const card of cards) {
    for (const trigger of card.triggers) {
      const re = new RegExp(escapeRegex(trigger), 'gi');
      if (re.test(openingText)) {
        seededInOpening.add(card.title);
        break;
      }
    }
  }

  return seededInOpening;
}

// ── formatting ────────────────────────────────────────────────────────────────

function formatSeedMap(rootDirName, leafResults) {
  const parts = [`# Seed Map — ${rootDirName}`];
  const singleLeaf = leafResults.length === 1 && leafResults[0].branchNames.length === 0;

  for (const { branchNames, cards, relations, seededInOpening } of leafResults) {
    if (!singleLeaf) {
      const branchLabel = branchNames.length > 0 ? branchNames.join(' - ') : rootDirName;
      parts.push(`## Branch: ${branchLabel}`);
    }

    if (cards.length === 0) {
      parts.push('_No compiled cards found._');
      continue;
    }

    // Group relations by seeded card (inbound view)
    const inbound = new Map(); // seeded title → [{ seeder, via, source }]
    for (const rel of relations) {
      if (!inbound.has(rel.seeded)) inbound.set(rel.seeded, []);
      inbound.get(rel.seeded).push({ seeder: rel.seeder, via: rel.via, source: rel.source });
    }

    const cardLines = [];
    for (const card of cards) {
      const triggerList = card.triggers.length > 0
        ? `\`[${card.triggers.join(', ')}]\``
        : '`[]`';
      const seeds = inbound.get(card.title) || [];
      const inOpening = seededInOpening.has(card.title) ? ' _(seeded in Opening)_' : '';

      const header = `**${card.title}** ${triggerList}${inOpening}`;
      if (seeds.length === 0) {
        cardLines.push(`${header}\n— _(no inbound seeds)_`);
      } else {
        const seedLines = seeds
          .map(s => {
            const label = s.source === 'pe' ? '_Plot Essentials_' : `**${s.seeder}**`;
            return `- seeded by ${label} · via _${s.via}_`;
          })
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
    rows.push('Title,Type,Triggers,Seeded By,Seeded in Opening');
  } else {
    rows.push('Branch,Title,Type,Triggers,Seeded By,Seeded in Opening');
  }

  for (const { branchNames, cards, relations, seededInOpening } of leafResults) {
    const branchLabel = branchNames.length > 0 ? branchNames.join(' - ') : rootDirName;

    // Count distinct seeders (cards + PE) per seeded title
    const seederSets = new Map(); // seeded title → Set of seeder labels
    for (const rel of relations) {
      if (!seederSets.has(rel.seeded)) seederSets.set(rel.seeded, new Set());
      seederSets.get(rel.seeded).add(rel.seeder);
    }

    for (const card of cards) {
      const seededBy  = (seederSets.get(card.title) || new Set()).size;
      const inOpening = seededInOpening.has(card.title) ? 'TRUE' : 'FALSE';
      if (singleLeaf) {
        rows.push([csvCell(card.title), csvCell(card.type || ''), card.triggers.length, seededBy, inOpening].join(','));
      } else {
        rows.push([csvCell(branchLabel), csvCell(card.title), csvCell(card.type || ''), card.triggers.length, seededBy, inOpening].join(','));
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
    const cards                    = collectLeafCards(leaf.leafDir);
    const { peText, openingText }  = collectLeafComponents(leaf.leafDir);
    const relations                = buildSeedRelations(cards, peText);
    const seededInOpening          = buildOpeningFlags(cards, openingText);
    leafResults.push({ branchNames: leaf.branchNames, cards, relations, seededInOpening });
    if (verbose) {
      const label = leaf.branchNames.join(' - ') || rootDirName;
      console.log(`  mapped: ${label} (${cards.length} cards, ${relations.length} seeds)`);
    }
  }

  const mdPath  = path.join(outputDir, `${rootDirName}.seedmap.md`);
  const csvPath = path.join(outputDir, `${rootDirName}.seedmap.csv`);

  fs.writeFileSync(mdPath,  formatSeedMap(rootDirName, leafResults) + '\n', 'utf8');
  fs.writeFileSync(csvPath, formatSeedMapCsv(rootDirName, leafResults) + '\n', 'utf8');

  // Per-branch files (skipped for single-leaf scenarios with no branch names)
  const singleLeaf = leafResults.length === 1 && leafResults[0].branchNames.length === 0;
  if (!singleLeaf) {
    for (const leafResult of leafResults) {
      const fileBase   = leafResult.branchNames.join(' - ') || rootDirName;
      const stem       = sanitizeFilename(fileBase);
      const leafMd     = path.join(outputDir, `${stem}.seedmap.md`);
      const leafCsv    = path.join(outputDir, `${stem}.seedmap.csv`);
      // Format as a single-leaf doc (no "## Branch:" header — filename conveys the branch)
      const asSingle   = [{ ...leafResult, branchNames: [] }];
      fs.writeFileSync(leafMd,  formatSeedMap(rootDirName, asSingle) + '\n', 'utf8');
      fs.writeFileSync(leafCsv, formatSeedMapCsv(rootDirName, asSingle) + '\n', 'utf8');
    }
  }

  return { mdPath, csvPath };
}

module.exports = { runSeedMapMode, parseCardsFromMd, collectLeafCards, collectMdFiles };
