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
const { loadPEConfig, compilePE, writePE, blockAppliesTo } = require('./pe');

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
 * Resolve opening content: if the value is a path to an existing file, read it;
 * otherwise treat it as inline text.
 */
function resolveOpeningContent(opening, base) {
  const resolved = path.resolve(base, String(opening));
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return fs.readFileSync(resolved, 'utf8').trimEnd();
  }
  return String(opening).trimEnd();
}

/**
 * Write content to {outputDir}/Components/Opening.md.
 */
function writeOpening(outputDir, content) {
  const dir = path.join(outputDir, 'Components');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'Opening.md');
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

/**
 * Recursively write Opening.md for every branch level that has an opening: key.
 * outputBases is now an array of { path, label } objects.
 */
function writeOpenings(nodeOpening, branches, outputBases, configBase) {
  if (nodeOpening != null) {
    const content = resolveOpeningContent(nodeOpening, configBase);
    for (const base of outputBases) {
      const outPath = writeOpening(base.path, content);
      console.log(`    OK: Opening → ${outPath}`);
    }
  }
  if (!branches || typeof branches !== 'object') return;
  for (const [name, branchConfig] of Object.entries(branches)) {
    const childBases = outputBases.map(b => ({
      path: path.join(b.path, 'Branches', name),
      label: b.label,
    }));
    const childOpening = branchConfig && branchConfig.opening != null ? branchConfig.opening : null;
    const childBranches = branchConfig && branchConfig.branches ? branchConfig.branches : null;
    writeOpenings(childOpening, childBranches, childBases, configBase);
  }
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
 * Check whether a card/block/include applies to a given output label.
 *
 * only_output: [labels]   → include only for these output labels
 * except_output: [labels] → include for all outputs except these
 *
 * If the output has no label, only_output filters are ignored with a warning
 * and except_output filters are ignored silently (unlabelled outputs always compile).
 */
function outputAppliesTo(def, outputLabel) {
  const onlyOut  = def.only_output;
  const exceptOut = def.except_output;

  if (!onlyOut && !exceptOut) return true;

  if (!outputLabel) {
    if (onlyOut) {
      console.warn('  WARN: only_output filter on a card/block targeting an unlabelled output — filter ignored, card will compile');
    }
    return true;
  }

  const label = outputLabel.toLowerCase();

  function matchesAny(list) {
    const arr = Array.isArray(list) ? list : [list];
    return arr.some(l => String(l).toLowerCase() === label);
  }

  if (onlyOut  !== undefined && onlyOut  !== null) return  matchesAny(onlyOut);
  if (exceptOut !== undefined && exceptOut !== null) return !matchesAny(exceptOut);
  return true;
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
      // Stamp only/except and only_output/except_output from the include directive onto the card
      const stamped = { ...card, _source: fullPath };
      if (def.only        !== undefined && def.only        !== null) stamped.only        = def.only;
      if (def.except      !== undefined && def.except      !== null) stamped.except      = def.except;
      if (def.only_output !== undefined && def.only_output !== null) stamped.only_output = def.only_output;
      if (def.except_output !== undefined && def.except_output !== null) stamped.except_output = def.except_output;
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
 * Compile all cards for a single branch leaf into a single output directory.
 * outputLabel is the label for this output (may be null for unlabelled outputs).
 */
function compileBranch(cardDefs, registry, templates, partials, outputDir, branchPath, branchConfig, outputLabel, peCardIds = new Set(), includedFilePaths = new Set()) {
  const branchProtagonist = (
    branchConfig.protagonist || ''
  ).toLowerCase() || null;

  const grouped = new Map();

  for (const cardDef of cardDefs) {
    // Skip include directives — already resolved into cardDefs by caller
    if (cardDef.include) continue;

    // Apply only/except branch filter
    if (!cardAppliesTo(cardDef, branchPath)) continue;

    // Apply only_output/except_output filter
    if (!outputAppliesTo(cardDef, outputLabel)) continue;

    // Skip cards that are in PE and arrived via a full include (not an explicit import)
    const baseId = ((cardDef.id || cardDef.name) || '').toLowerCase();
    if (baseId && peCardIds.has(baseId) && cardDef._source && includedFilePaths.has(cardDef._source)) {
      continue;
    }

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
      rendered = render(template, context, partials);
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

  // Load templates and partials
  const { templates, partials } = loadTemplates(config._resolvedTemplates);
  console.log(`Loaded ${templates.size} template(s)${partials.size ? `, ${partials.size} partial(s)` : ''}.`);

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

  // Track which canon files are being fully included (for PE dedup later)
  const includedFilePaths = new Set(
    config._resolvedCanon
      ? rawProjectCards
          .filter(d => d.include)
          .map(d => path.resolve(config._resolvedCanon, d.include))
          .filter(p => fs.existsSync(p))
      : []
  );

  // All card definitions to compile: explicit project defs + included canon cards
  const allCardDefs = [...rawProjectCards, ...includedCards];

  // Build project registry from locally defined cards only (not imports/includes)
  const projectRegistry = buildRegistry(rawProjectCards, 'project');
  console.log(`Loaded ${projectRegistry.size} project card definition(s).`);

  // Merge registries — errors on collision
  const registry = mergeRegistries(canonRegistry, projectRegistry);

  // Enumerate branch leaves
  const leaves = enumerateLeaves(config.branches);
  console.log(`\nCompiling ${leaves.length} branch(es) × ${config._resolvedOutputs.length} output(s)...`);

  let totalFiles = 0;

  for (const branchPath of leaves) {
    const label = branchPath.length > 0 ? branchPath.join('/') : '(root)';
    console.log(`\n  Branch: ${label}`);

    const branchConfig = getBranchConfig(config.branches, branchPath);

    // Resolve protagonist for this branch
    const branchProtagonist = (
      branchConfig.protagonist || config.protagonist || ''
    ).toLowerCase() || null;

    for (const outputEntry of config._resolvedOutputs) {
      const outputBase = outputEntry.path;
      const outputLabel = outputEntry.label;

      if (outputLabel) {
        console.log(`    Output: [${outputLabel}]`);
      }

      // Build the branch-specific output path (Velvet Lattice folder structure)
      const branchOutputDir = branchPath.length > 0
        ? path.join(outputBase, ...branchPath.flatMap(b => ['Branches', b]))
        : outputBase;

      // Compute which PE card IDs apply to this branch+output combo (for Story Card dedup)
      const peCardIds = new Set(
        peBlocks
          .filter(b => blockAppliesTo(b, branchPath) && outputAppliesTo(b, outputLabel) && b.import)
          .map(b => b.import.split('/')[0].toLowerCase())
      );

      // Compile story cards for this branch × output
      const written = compileBranch(
        allCardDefs,
        registry,
        templates,
        partials,
        branchOutputDir,
        branchPath,
        { ...branchConfig, protagonist: branchProtagonist },
        outputLabel,
        peCardIds,
        includedFilePaths,
      );
      totalFiles += written.length;

      // Compile plot essentials for this branch × output
      if (peBlocks.length > 0) {
        const peContent = compilePE(peBlocks, registry, templates, partials, branchPath, branchProtagonist, outputLabel);
        const pePath = writePE(branchOutputDir, peContent);
        if (pePath) {
          console.log(`    OK: PlotEssentials → ${pePath}`);
          totalFiles++;
        }
      }
    }
  }

  console.log(`\nDone. Wrote ${totalFiles} file(s).`);

  // Write Opening.md files for all levels that have an opening: key
  writeOpenings(config.opening ?? null, config.branches, config._resolvedOutputs, config._base);

  if (config.overview) {
    const { runLeafReviewMode } = require('./overview');
    const overviewDir = path.resolve(config._base, config.overview);
    fs.mkdirSync(overviewDir, { recursive: true });
    console.log(`\nGenerating leaf review files → ${overviewDir}`);
    try {
      const written = runLeafReviewMode(config._resolvedOutputs[0].path, overviewDir);
      console.log(`Generated ${written.length} leaf review file(s).`);
    } catch (err) {
      console.warn(`  WARN: leaf review generation failed: ${err.message}`);
    }
  }
}

module.exports = { compile, compileBranch, cardAppliesTo, outputAppliesTo, getTemplate, writeOutput, resolveIncludes, writeOpening, resolveOpeningContent };

if (require.main === module) {
  const rawArgs = process.argv.slice(2);

  const leafReviewIdx = rawArgs.findIndex(a => a === '--leafReview' || a === '-l');
  const overviewIdx   = rawArgs.findIndex(a => a === '--overview'   || a === '-o');

  if (leafReviewIdx !== -1) {
    // ── Standalone leaf review mode (one file per leaf) ──────────────────────
    const { runLeafReviewMode } = require('./overview');
    const rest = rawArgs.filter((_, i) => i !== leafReviewIdx);

    let scenarioRoot;
    let outputDir;

    if (rest.length === 0) {
      // No args: load compile.yaml from cwd
      const cfgPath = path.join(process.cwd(), 'compile.yaml');
      if (!fs.existsSync(cfgPath)) {
        console.error('No compile.yaml in current directory and no path given.');
        process.exit(1);
      }
      const { loadCompileConfig } = require('./loader');
      const cfg = loadCompileConfig(cfgPath);
      scenarioRoot = cfg._resolvedOutputs[0].path;
      if (!cfg.overview) {
        console.error('compile.yaml has no "overview:" key — cannot determine output dir.');
        process.exit(1);
      }
      outputDir = path.resolve(path.dirname(cfgPath), cfg.overview);
    } else {
      scenarioRoot = path.resolve(rest[0]);
      outputDir    = path.resolve(rest[1] || 'leaf-review');
    }

    if (!fs.existsSync(scenarioRoot)) {
      console.error(`Scenario root not found: ${scenarioRoot}`);
      process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`\nLeaf review mode`);
    console.log(`Scenario root : ${scenarioRoot}`);
    console.log(`Output dir    : ${outputDir}\n`);

    try {
      const written = runLeafReviewMode(scenarioRoot, outputDir);
      console.log(`\nDone. Wrote ${written.length} leaf review file(s) to:\n  ${outputDir}\n`);
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      process.exit(1);
    }

  } else if (overviewIdx !== -1) {
    // ── Standalone overview mode (one whole-tree file) ────────────────────────
    const { runOverviewMode } = require('./overview');
    const rest = rawArgs.filter((_, i) => i !== overviewIdx);

    if (rest.length === 0) {
      console.error('Usage: codex-loom --overview|-o <scenario-root> [<output-dir>]');
      process.exit(1);
    }

    const scenarioRoot = path.resolve(rest[0]);
    const outputDir    = path.resolve(rest[1] || 'overview');

    if (!fs.existsSync(scenarioRoot)) {
      console.error(`Scenario root not found: ${scenarioRoot}`);
      process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`\nOverview mode`);
    console.log(`Scenario root : ${scenarioRoot}`);
    console.log(`Output dir    : ${outputDir}\n`);

    try {
      runOverviewMode(scenarioRoot, outputDir);
      console.log(`\nDone. Wrote overview file to:\n  ${outputDir}\n`);
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      process.exit(1);
    }

  } else {
    // ── Normal compile mode ──────────────────────────────────────────────────
    if (rawArgs.length === 0) {
      console.error(
        'Usage: codex-loom <path/to/compile.yaml or path/to/project/>\n' +
        '       codex-loom --leafReview|-l [<scenario-root>] [<output-dir>]\n' +
        '       codex-loom --overview|-o <scenario-root> [<output-dir>]'
      );
      process.exit(1);
    }

    let configPath = rawArgs[0];

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
}