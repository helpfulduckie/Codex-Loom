#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadCardsFromDir, loadTemplates, loadCompileConfig,
  buildRegistry, mergeRegistries, loadYaml,
} = require('./loader');
const { resolveCard, enumerateLeaves, getBranchConfig } = require('./resolver');
const { applyPronounPasses } = require('./pronouns');
const { render, applyFieldInterpolation } = require('./template');
const { loadPEConfig, compilePE, writePE } = require('./pe');

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
  const typeDir = path.join(outputDir, 'Story Cards', type);
  fs.mkdirSync(typeDir, { recursive: true });
  const outputPath = path.join(typeDir, `${type}.md`);
  fs.writeFileSync(outputPath, renderedCards.join('\n\n') + '\n', 'utf8');
  return outputPath;
}

/**
 * Resolve include directives from project card definitions.
 * Returns additional card definitions loaded from canon files.
 *
 * For each `- include: path/to/file.yaml` entry:
 *   - Loads all cards from that file (relative to canonDir)
 *   - Skips any whose ID matches an explicitly imported/defined card
 *
 * Explicit imports/definitions always win — included cards are supplemental.
 */
function resolveIncludes(cardDefs, canonDir) {
  // Collect IDs of all explicitly imported or locally defined cards
  const explicitIds = new Set();
  const includeDefs = [];

  for (const def of cardDefs) {
    if (def.include) {
      includeDefs.push(def);
    } else if (def.import) {
      // Extract base ID from import path (e.g. "Zephon/human/noble" → "zephon")
      const baseId = def.import.split('/')[0].toLowerCase();
      explicitIds.add(baseId);
    } else if (def.id || def.name) {
      const id = (def.id || def.name).toLowerCase();
      explicitIds.add(id);
    }
  }

  if (includeDefs.length === 0) return [];

  const included = [];
  for (const def of includeDefs) {
    const includePath = def.include;
    const fullPath = path.resolve(canonDir, includePath);
    if (!fs.existsSync(fullPath)) {
      console.warn(`  WARN: include path not found: ${fullPath}`);
      continue;
    }

    const raw = loadYaml(fullPath);
    const cards = Array.isArray(raw) ? raw : [raw];

    for (const card of cards) {
      const id = ((card.id || card.name) || '').toLowerCase();
      if (explicitIds.has(id)) {
        // Explicit import takes precedence — skip included version
        continue;
      }
      // Stamp only/except from the include directive onto the card
      const stamped = { ...card, _source: fullPath };
      if (def.only !== undefined && def.only !== null) stamped.only = def.only;
      if (def.except !== undefined && def.except !== null) stamped.except = def.except;
      included.push(stamped);
    }
  }

  return included;
}

/**
 * Check whether a card definition should be compiled for a given branch leaf path.
 * 
 * If 'only' is set: include if the leaf path starts with any listed prefix.
 * If 'except' is set: exclude if the leaf path starts with any listed prefix.
 * If neither is set: always include.
 * Prefix matching is case-insensitive.
 */
function cardAppliesTo(cardDef, branchPath) {
  const only = cardDef.only;
  const except = cardDef.except;

  // Normalise branchPath to a slash-joined lowercase string for prefix matching
  const leafStr = branchPath.map(p => p.toLowerCase()).join('/');

  function matchesAnyPrefix(prefixList) {
    const prefixes = Array.isArray(prefixList) ? prefixList : [prefixList];
    return prefixes.some(prefix => {
      const p = prefix.toLowerCase();
      // Leaf starts with prefix, and either exact match or next char is '/'
      return leafStr === p || leafStr.startsWith(p + '/');
    });
  }

  if (only !== undefined && only !== null) {
    return matchesAnyPrefix(only);
  }
  if (except !== undefined && except !== null) {
    return !matchesAnyPrefix(except);
  }
  return true;
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
    // Skip include directives — already resolved into cardDefs by caller
    if (cardDef.include) continue;

    // Apply only/except branch filter
    if (!cardAppliesTo(cardDef, branchPath)) continue;

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

  // Load plot-essentials.yaml if present
  const peBlocks = loadPEConfig(config._base);
  if (peBlocks.length > 0) {
    console.log(`Loaded ${peBlocks.length} plot essentials block(s).`);
  }

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

  // Load project cards (includes include directives and explicit imports/definitions)
  const rawProjectCards = loadCardsFromDir(config._resolvedCards);

  // Resolve includes — load additional canon cards not explicitly imported
  const includedCards = config._resolvedCanon
    ? resolveIncludes(rawProjectCards, config._resolvedCanon)
    : [];

  if (includedCards.length > 0) {
    console.log(`Loaded ${includedCards.length} included canonical card(s).`);
  }

  // All card definitions to compile: explicit project defs + included canon cards
  const allCardDefs = [...rawProjectCards, ...includedCards];

  // Build project registry from locally defined cards only (not imports/includes)
  const projectRegistry = buildRegistry(rawProjectCards, 'project');
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
    // Velvet Lattice format: Branches/A/Branches/X/Story Cards/Type
    const branchOutputDir = branchPath.length > 0
      ? path.join(config._resolvedOutput, ...branchPath.flatMap(b => ['Branches', b]))
      : config._resolvedOutput;

    // Compile story cards
    const written = compileBranch(
      allCardDefs,
      registry,
      templates,
      branchOutputDir,
      branchPath,
      { ...branchConfig, protagonist: branchProtagonist },
    );
    totalFiles += written.length;

    // Compile plot essentials
    if (peBlocks.length > 0) {
      const peContent = compilePE(peBlocks, registry, templates, branchPath, branchProtagonist);
      const pePath = writePE(branchOutputDir, peContent);
      if (pePath) {
        console.log(`    OK: PlotEssentials → ${pePath}`);
        totalFiles++;
      }
    }
  }

  console.log(`\nDone. Wrote ${totalFiles} file(s).`);
}

module.exports = { compile, compileBranch, cardAppliesTo, getTemplate, writeOutput, resolveIncludes };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: codex-loom <path/to/compile.yaml or path/to/project/>');
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
}