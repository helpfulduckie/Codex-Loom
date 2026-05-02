#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadCardsFromDir, loadTemplates, loadCompileConfig,
  buildRegistry, mergeRegistries,
} = require('./loader');
const { resolveCard, enumerateLeaves, getBranchConfig } = require('./resolver');
const { applyPronounPasses } = require('./pronouns');
const { render, applyFieldInterpolation } = require('./template');

/**
 * Get the template for a card. Checks card.template first, then card.type.
 * Both lookups are case-insensitive.
 */
function getTemplate(card, templates) {
  const keys = [card.template, card.type].filter(Boolean);
  for (const key of keys) {
    const t = templates.get(key.toLowerCase());
    if (t) return t.content;
  }
  return null;
}

/**
 * Write compiled cards to output directory.
 * One .md file per card type per branch leaf.
 */
function writeOutput(outputDir, type, renderedCards) {
  const typeDir = path.join(outputDir, type);
  fs.mkdirSync(typeDir, { recursive: true });
  const outputPath = path.join(typeDir, `${type}.md`);
  fs.writeFileSync(outputPath, renderedCards.join('\n\n') + '\n', 'utf8');
  return outputPath;
}

/**
 * Compile all cards for a single branch leaf.
 */
function compileBranch(cardDefs, registry, templates, outputDir, branchPath, branchConfig) {
  const branchProtagonist = (
    branchConfig.protagonist || ''
  ).toLowerCase() || null;

  const grouped = new Map();

  for (const cardDef of cardDefs) {
    let card;
    try {
      card = resolveCard(cardDef, registry, branchPath);
    } catch (err) {
      console.error(`  ERR resolving card: ${err.message}`);
      continue;
    }

    // Post-resolution passes
    applyFieldInterpolation(card);
    applyPronounPasses(card, registry, branchProtagonist);

    // Get template
    const template = getTemplate(card, templates);
    if (!template) {
      console.error(`  ERR: no template found for card "${card.name}" (type: ${card.type}, template: ${card.template})`);
      continue;
    }

    // Build render context — card fields merged with top-level card data
    const context = {
      ...card,
      fields: card.fields || {},
    };

    let rendered;
    try {
      rendered = render(template, context);
    } catch (err) {
      console.error(`  ERR rendering card "${card.name}": ${err.message}`);
      continue;
    }

    const type = card.type || 'Uncategorized';
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(rendered);
  }

  // Write output files
  const written = [];
  for (const [type, cards] of grouped) {
    const outPath = writeOutput(outputDir, type, cards);
    written.push(outPath);
    console.log(`    OK: ${type} (${cards.length} card(s)) → ${outPath}`);
  }
  return written;
}

/**
 * Main compile function.
 */
function compile(configPath) {
  const config = loadCompileConfig(configPath);

  // Load templates
  const templates = loadTemplates(config._resolvedTemplates);
  console.log(`Loaded ${templates.size} template(s).`);

  // Load canon registry
  let canonRegistry = new Map();
  if (config._resolvedCanon) {
    if (!fs.existsSync(config._resolvedCanon)) {
      console.warn(`  WARN: canon path not found: ${config._resolvedCanon}`);
    } else {
      const canonCards = loadCardsFromDir(config._resolvedCanon);
      canonRegistry = buildRegistry(canonCards, 'canon');
      console.log(`Loaded ${canonRegistry.size} canonical card(s).`);
    }
  }

  // Load project cards
  const projectCards = loadCardsFromDir(config._resolvedCards);
  const projectRegistry = buildRegistry(projectCards, 'project');
  console.log(`Loaded ${projectRegistry.size} project card definition(s).`);

  // Merge registries — errors on collision
  const registry = mergeRegistries(canonRegistry, projectRegistry);

  // Enumerate branch leaves
  const leaves = enumerateLeaves(config.branches);
  console.log(`\nCompiling ${leaves.length} branch(es)...`);

  let totalFiles = 0;

  for (const branchPath of leaves) {
    const label = branchPath.length > 0 ? branchPath.join('/') : '(root)';
    console.log(`\n  Branch: ${label}`);

    const branchConfig = getBranchConfig(config.branches, branchPath);

    // Resolve protagonist for this branch
    const branchProtagonist = (
      branchConfig.protagonist || config.protagonist || ''
    ).toLowerCase() || null;

    // Output dir for this branch
    const branchOutputDir = branchPath.length > 0
      ? path.join(config._resolvedOutput, ...branchPath)
      : config._resolvedOutput;

    const written = compileBranch(
      projectCards,
      registry,
      templates,
      branchOutputDir,
      branchPath,
      { ...branchConfig, protagonist: branchProtagonist },
    );

    totalFiles += written.length;
  }

  console.log(`\nDone. Wrote ${totalFiles} file(s).`);
}

// CLI entry point
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: compile-cards <path/to/compile.yaml or path/to/project/>');
  process.exit(1);
}

let configPath = args[0];

// If a directory is given, look for compile.yaml inside it
try {
  const stat = fs.statSync(configPath);
  if (stat.isDirectory()) {
    configPath = path.join(configPath, 'compile.yaml');
  }
} catch (err) {
  // statSync failed — path doesn't exist, let compile() surface the error
}

try {
  compile(configPath);
} catch (err) {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
}
