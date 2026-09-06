'use strict';

const fs   = require('fs');
const path = require('path');

const { discoverLeaves } = require('./overview');
const { resolveAt } = require('./compiledTree');
const { NULL_LOG } = require('./log');
const { csvCell, sanitizeFilename, branchLabel } = require('./report');


function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function buildSeedRelations(cards, peText = '') {
  const relations = [];

  for (const seeded of cards) {
    for (const trigger of seeded.triggers) {
      const re = new RegExp(escapeRegex(trigger), 'i');

      for (const seeder of cards) {
        if (seeder.title === seeded.title) continue;
        if (re.test(seeder.body)) {
          relations.push({ seeder: seeder.title, seeded: seeded.title, via: trigger, source: 'card' });
        }
      }

      if (peText && re.test(peText)) {
        relations.push({ seeder: 'Plot Essentials', seeded: seeded.title, via: trigger, source: 'pe' });
      }
    }
  }

  return relations;
}

function buildOpeningFlags(cards, openingText = '') {
  const seededInOpening = new Set();
  if (!openingText) return seededInOpening;

  for (const card of cards) {
    for (const trigger of card.triggers) {
      const re = new RegExp(escapeRegex(trigger), 'i');
      if (re.test(openingText)) {
        seededInOpening.add(card.title);
        break;
      }
    }
  }

  return seededInOpening;
}


function formatSeedMap(rootDirName, leafResults) {
  const parts = [`# Seed Map — ${rootDirName}`];
  const singleLeaf = leafResults.length === 1 && leafResults[0].branchNames.length === 0;

  for (const { branchNames, cards, relations, seededInOpening } of leafResults) {
    if (!singleLeaf) {
      parts.push(`## Branch: ${branchLabel(branchNames, rootDirName)}`);
    }

    if (cards.length === 0) {
      parts.push('_No compiled cards found._');
      continue;
    }

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

function formatSeedMapCsv(rootDirName, leafResults) {
  const singleLeaf = leafResults.length === 1 && leafResults[0].branchNames.length === 0;
  const rows = [];

  if (singleLeaf) {
    rows.push('Title,Type,Triggers,Seeded By,Seeded in Opening');
  } else {
    rows.push('Branch,Title,Type,Triggers,Seeded By,Seeded in Opening');
  }

  for (const { branchNames, cards, relations, seededInOpening } of leafResults) {
    const label = branchLabel(branchNames, rootDirName);

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
        rows.push([csvCell(label), csvCell(card.title), csvCell(card.type || ''), card.triggers.length, seededBy, inOpening].join(','));
      }
    }
  }

  return rows.join('\n');
}


function runSeedMapMode(scenarioRoot, outputDir, options = {}) {
  const { log = NULL_LOG } = options;
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const leaves      = discoverLeaves(rootAbs);

  if (leaves.length === 0) return { written: [] };

  const leafResults = [];
  for (const leaf of leaves) {
    const cards                    = resolveAt(leaf.leafDir).resolved.cards
      .filter((card) => card.triggers.length > 0);
    const components                = resolveAt(leaf.leafDir).resolved.components;
    const peText                    = components['Plot Essentials'] || '';
    const openingText               = components['Opening'] || '';
    const relations                = buildSeedRelations(cards, peText);
    const seededInOpening          = buildOpeningFlags(cards, openingText);
    leafResults.push({ branchNames: leaf.branchNames, cards, relations, seededInOpening });
    const label = branchLabel(leaf.branchNames, rootDirName);
    log.verbose(`  mapped: ${label} (${cards.length} cards, ${relations.length} seeds)`);
  }

  const mdPath  = path.join(outputDir, `${rootDirName}.seedmap.md`);
  const csvPath = path.join(outputDir, `${rootDirName}.seedmap.csv`);
  const written = [mdPath, csvPath];

  fs.writeFileSync(mdPath,  formatSeedMap(rootDirName, leafResults) + '\n', 'utf8');
  fs.writeFileSync(csvPath, formatSeedMapCsv(rootDirName, leafResults) + '\n', 'utf8');

  const singleLeaf = leafResults.length === 1 && leafResults[0].branchNames.length === 0;
  if (!singleLeaf) {
    for (const leafResult of leafResults) {
      const fileBase   = branchLabel(leafResult.branchNames, rootDirName);
      const stem       = sanitizeFilename(fileBase);
      const leafMd     = path.join(outputDir, `${stem}.seedmap.md`);
      const leafCsv    = path.join(outputDir, `${stem}.seedmap.csv`);
      written.push(leafMd, leafCsv);
      const asSingle   = [{ ...leafResult, branchNames: [] }];
      fs.writeFileSync(leafMd,  formatSeedMap(rootDirName, asSingle) + '\n', 'utf8');
      fs.writeFileSync(leafCsv, formatSeedMapCsv(rootDirName, asSingle) + '\n', 'utf8');
    }
  }

  return { written, mdPath, csvPath };
}

module.exports = {
  runSeedMapMode,
  buildSeedRelations, buildOpeningFlags,
};
