#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadCardsFromDir, loadTemplates, loadCompileConfig,
  buildRegistry, mergeRegistries, buildOverlays, loadYaml,
} = require('./loader');
const {
  resolveCard, enumerateLeaves, getBranchConfig,
  resolveBranchSpec, parseVariantsList,
} = require('./resolver');
const { applyPronounPasses, applyCrossCardRefs } = require('./pronouns');
const { render, applyFieldInterpolation, applyVariableInterpolation, applyFieldRenderFunctions } = require('./template');
const { resolveVariables } = require('./util');
const { loadPEConfig, compilePE, writePE } = require('./pe');
const { loadAINConfig, compileAIN, writeAIN } = require('./ain');
const { loadANConfig, compileAN, writeAN } = require('./an');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Get the template for a card. Checks render.template first, then aid.type.
 */
function getTemplate(card, templates) {
  const keys = [
    card.render && card.render.template,
    card.aid && card.aid.type,
  ].filter(Boolean);
  for (const key of keys) {
    const t = templates.get(key.toLowerCase());
    if (t) return t.content;
  }
  return null;
}

/**
 * Resolve opening content: file path → read file; otherwise use as inline text.
 */
function resolveOpeningContent(opening, base, variables) {
  const expandedSpec = variables ? resolveVariables(String(opening), variables) : String(opening);
  const resolved = path.resolve(base, expandedSpec);
  let content;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    content = fs.readFileSync(resolved, 'utf8').trimEnd();
  } else {
    content = expandedSpec.trimEnd();
  }
  return variables ? resolveVariables(content, variables) : content;
}

/**
 * Expand {@Key} component key references in text (content mode: returns file contents).
 */
function resolveComponentKey(text, componentDirs) {
  if (!componentDirs || typeof text !== 'string') return text;
  return text.replace(/\{@([^}]+)\}/g, (match, key) => {
    const name = key.trim();
    // Search all component dir maps for a matching name
    for (const [type, dirMap] of Object.entries(componentDirs)) {
      const actualKey = [...dirMap.keys()].find(k => k.toLowerCase() === name.toLowerCase());
      if (actualKey !== undefined) {
        const dirPath = dirMap.get(actualKey);
        // Content mode: if it's a file read it, if a dir return path string
        if (fs.existsSync(dirPath)) {
          const stat = fs.statSync(dirPath);
          if (stat.isFile()) return fs.readFileSync(dirPath, 'utf8').trim();
          return dirPath; // folder — caller handles
        }
        return dirPath;
      }
    }
    console.warn(`  WARN: component key "{@${name}}" not found`);
    return match;
  });
}

/**
 * Resolve a component spec value (file path | literal string | {@Key}) to a file path.
 * Returns null if spec is null/undefined.
 * Returns a resolved absolute path if the spec points to an existing file.
 * Returns the literal string (for opening/openingChoice inline text).
 */
function resolveComponentSpec(spec, base, componentDirs) {
  if (spec == null) return null;
  // Expand {@Key} references (path mode: returns the folder/file path)
  let resolved = spec;
  if (typeof resolved === 'string') {
    resolved = resolved.replace(/\{@([^}]+)\}/g, (match, key) => {
      const name = key.trim();
      for (const [, dirMap] of Object.entries(componentDirs)) {
        const actualKey = [...dirMap.keys()].find(k => k.toLowerCase() === name.toLowerCase());
        if (actualKey !== undefined) return dirMap.get(actualKey);
      }
      return match;
    });
  }
  // Try resolving as file or directory path
  const filePath = path.resolve(base, String(resolved));
  if (fs.existsSync(filePath)) return filePath;
  // Otherwise return the raw value (inline string)
  return spec;
}

/**
 * Build the CompileContext for a given branch path.
 * Merges variables and components from root → branch chain.
 */
function buildCompileContext(config, branchPath) {
  // Walk branch chain merging variables and components
  let variables = Object.assign({}, config.variables || {});
  let components = Object.assign({}, config.components || {});

  let currentMap = config.branches;
  for (const part of branchPath) {
    if (!currentMap || typeof currentMap !== 'object') break;
    const actualKey = Object.keys(currentMap).find(k => k.toLowerCase() === part.toLowerCase());
    if (!actualKey) break;
    const node = currentMap[actualKey];
    if (node) {
      if (node.variables) Object.assign(variables, node.variables);
      if (node.components) Object.assign(components, node.components);
    }
    currentMap = node && node.branches ? node.branches : null;
  }

  // Resolve component specs to file paths
  const componentTypes = ['aiInstructions', 'opening', 'openingChoice', 'plotEssential', 'authorsNote', 'scripts'];
  const componentRefs = {};
  for (const type of componentTypes) {
    const spec = components[type] !== undefined ? components[type] : null;
    componentRefs[type] = resolveComponentSpec(spec, config._base, config._resolvedComponents);
  }

  return { variables, componentRefs };
}

/**
 * Write compiled cards to output directory.
 * One .md file per card type: Story Cards/{type}/{type}.md
 */
function writeOutput(outputDir, type, renderedCards) {
  const typeDir = path.join(outputDir, 'Story Cards', type);
  fs.mkdirSync(typeDir, { recursive: true });
  const outputPath = path.join(typeDir, `${type}.md`);
  fs.writeFileSync(outputPath, renderedCards.join('\n\n') + '\n', 'utf8');
  return outputPath;
}

/**
 * Delete Story Cards, Components, and Scripts subdirs from a branch output dir.
 */
function cleanBranchOutputDir(dir) {
  for (const sub of ['Story Cards', 'Components', 'Scripts']) {
    const target = path.join(dir, sub);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Recursively collect leaf-level branch dirs on disk.
 * A dir is a leaf if it has no Branches/ child (or an empty one).
 */
function findLeafDirsOnDisk(dir) {
  if (!fs.existsSync(dir)) return [];
  const leaves = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    const sub = path.join(child, 'Branches');
    const hasBranchesSub = fs.existsSync(sub) && fs.readdirSync(sub).length > 0;
    if (hasBranchesSub) {
      leaves.push(...findLeafDirsOnDisk(sub));
    } else {
      leaves.push(child);
    }
  }
  return leaves;
}

function isDirEmpty(dir) {
  if (!fs.existsSync(dir)) return true;
  return fs.readdirSync(dir).length === 0;
}

/**
 * Pre-build clean: wipe output-type folders from active branches, then
 * detect and archive (or delete) any stale branch folders on disk.
 */
function cleanAndArchive(config, leaves) {
  const baseOutput = config._resolvedOutput;

  const expectedDirs = new Set();
  for (const branchPath of leaves) {
    const folderPath = resolveBranchFolderPath(config.branches, branchPath);
    expectedDirs.add(path.resolve(buildBranchOutputDir(baseOutput, folderPath)));
  }
  if (leaves.length === 1 && leaves[0].length === 0) {
    expectedDirs.add(path.resolve(baseOutput));
  }

  for (const dir of expectedDirs) {
    cleanBranchOutputDir(dir);
    console.log(`  Cleaned: ${path.relative(baseOutput, dir) || '(root)'}`);
  }

  const branchesRoot = path.join(baseOutput, 'Branches');
  const diskLeaves = findLeafDirsOnDisk(branchesRoot);
  const stale = diskLeaves.filter(d => !expectedDirs.has(path.resolve(d)));
  if (stale.length === 0) return;

  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  const archiveBase = path.join(baseOutput, 'Archive', ts);

  for (const staleDir of stale) {
    cleanBranchOutputDir(staleDir);
    if (isDirEmpty(staleDir)) {
      fs.rmSync(staleDir, { recursive: true, force: true });
      console.log(`  Removed empty stale branch: ${path.relative(baseOutput, staleDir)}`);
    } else {
      const rel = path.relative(baseOutput, staleDir);
      const dest = path.join(archiveBase, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(staleDir, dest);
      console.log(`  Archived stale branch → Archive/${ts}/${rel}`);
    }
  }
}

/**
 * Build the output directory path for a branch leaf.
 */
function buildBranchOutputDir(baseOutput, branchPath) {
  if (branchPath.length === 0) return baseOutput;
  return path.join(baseOutput, ...branchPath.flatMap(b => ['Branches', b]));
}

/**
 * Resolve the output folder path for a branch identifier path.
 * Uses each node's `title` field as the folder name when present; falls back to the key.
 *
 * @param {object|null} branches - root branches mapping from config
 * @param {string[]}    idPath   - branch identifier path (e.g. ['tier2', 'alpha'])
 * @returns {string[]}           - folder name path (e.g. ['Tier Two', 'Alpha Path'])
 */
function resolveBranchFolderPath(branches, idPath) {
  const folderPath = [];
  let currentMap = branches;
  for (const id of idPath) {
    if (!currentMap || typeof currentMap !== 'object') {
      folderPath.push(id);
      continue;
    }
    const actualKey = Object.keys(currentMap).find(k => k.toLowerCase() === id.toLowerCase());
    const node = actualKey !== undefined ? currentMap[actualKey] : null;
    folderPath.push((node && node.title) || (actualKey || id));
    currentMap = node && node.branches ? node.branches : null;
  }
  return folderPath;
}

/**
 * Resolve includes from project card defs.
 * Returns additional card definitions loaded from canon files.
 */
function resolveIncludes(cardDefs, canonRegistry, config) {
  const explicitIds = new Set();
  const includeDefs = [];

  for (const def of cardDefs) {
    if (def.include) {
      includeDefs.push(def);
    } else if (def.import) {
      explicitIds.add(String(def.import).toLowerCase());
    } else if (def.id || def.name) {
      const id = ((def.id || (typeof def.name === 'string' ? def.name : '')) || '').toLowerCase();
      explicitIds.add(id);
    }
  }

  if (includeDefs.length === 0) return [];

  const included = [];
  for (const def of includeDefs) {
    // Resolve {@Key} in include path
    let includePath = String(def.include);
    includePath = includePath.replace(/\{@([^}]+)\}/g, (match, key) => {
      const name = key.trim();
      for (const [, dirMap] of Object.entries(config._resolvedComponents)) {
        const actualKey = [...dirMap.keys()].find(k => k.toLowerCase() === name.toLowerCase());
        if (actualKey !== undefined) return dirMap.get(actualKey);
      }
      // Also check canon dirs
      const actualCanonKey = [...config._resolvedCanon.keys()].find(k => k.toLowerCase() === name.toLowerCase());
      if (actualCanonKey) return config._resolvedCanon.get(actualCanonKey);
      return match;
    });

    // Normalize separators (handles mixed forward/back slashes from {@var}/path expansion)
    includePath = path.normalize(includePath);

    // Resolve relative to config base or as absolute
    const fullPath = path.isAbsolute(includePath) ? includePath : path.resolve(config._base, includePath);
    if (!fs.existsSync(fullPath)) {
      console.warn(`  WARN: include path not found: ${fullPath}`);
      continue;
    }

    const raw = loadYaml(fullPath);
    const cards = Array.isArray(raw) ? raw : [raw];

    for (const card of cards) {
      const id = ((card.id || (typeof card.name === 'string' ? card.name : '')) || '').toLowerCase();
      if (explicitIds.has(id)) continue; // explicit import wins

      const stamped = { ...card, _source: fullPath };
      // Stamp include-level importVariants and branches onto card for resolveCard to use
      if (def.importVariants) stamped._include_variants = def.importVariants;
      if (def.branches) stamped._include_branch_spec = def.branches;
      included.push(stamped);
    }
  }

  return included;
}

/**
 * Build the combined canon registry from all named canon dirs.
 */
function buildCanonRegistry(resolvedCanon) {
  const registry = new Map();
  for (const [name, canonPath] of resolvedCanon) {
    if (!fs.existsSync(canonPath)) {
      console.warn(`  WARN: canon "${name}" path not found: ${canonPath}`);
      continue;
    }
    const { loadCardsFromDir: lcd, buildRegistry: br } = require('./loader');
    const cards = lcd([canonPath]);
    const sub = br(cards, `canon:${name}`);
    for (const [id, card] of sub) {
      if (registry.has(id)) {
        const existing = registry.get(id);
        throw new Error(
          `Duplicate card ID "${id}" across canon dirs:\n  ${existing._source}\n  ${card._source}`
        );
      }
      registry.set(id, card);
    }
  }
  return registry;
}

/**
 * Compile story cards for a single branch leaf.
 * Returns array of resolved cards (after Phase A), in place for Phase B caller.
 *
 * Phase A: resolve + field interpolation
 * Phase B (caller): cross-card refs + pronouns + render
 */
function compileBranchPhaseA(allCardDefs, registry, branchPath, variables) {
  const resolvedCards = [];

  for (const cardDef of allCardDefs) {
    if (cardDef.include) continue; // include directives already expanded

    let card;
    try {
      card = resolveCard(cardDef, registry, branchPath);
    } catch (err) {
      const label = cardDef.id || cardDef.import || cardDef.name || '?';
      const src = cardDef._source ? ` (${cardDef._source})` : '';
      console.error(`  ERR resolving card "${label}"${src}: ${err.message}`);
      continue;
    }

    if (!card) continue; // excluded by branch spec

    applyFieldInterpolation(card);
    applyVariableInterpolation(card, variables);
    resolvedCards.push(card);
  }

  return resolvedCards;
}

/**
 * Phase B: apply cross-card refs, pronouns, render, and write output.
 */
function compileBranchPhaseB(resolvedCards, registry, templates, partials, outputDir, branchProtagonist, suppressIds = new Set(), variables = {}) {
  applyCrossCardRefs(resolvedCards, registry);

  // Expand render functions in body field values now that cross-card refs are resolved.
  for (const card of resolvedCards) {
    applyFieldRenderFunctions(card);
  }

  const resolvedById = new Map();
  for (const card of resolvedCards) {
    const id = (card.id || '').toLowerCase();
    if (id) resolvedById.set(id, card);
  }

  const grouped = new Map();

  for (const card of resolvedCards) {
    applyPronounPasses(card, registry, branchProtagonist, resolvedById);

    if (suppressIds.has((card.id || '').toLowerCase())) continue; // fully rendered in PE; skip story card

    const template = getTemplate(card, templates);
    if (!template) {
      const name = card.id || (typeof card.name === 'string' ? card.name : String(card.name));
      const type = (card.aid && card.aid.type) || (card.render && card.render.template) || '?';
      const src = card._source ? ` (${card._source})` : '';
      console.error(`  ERR: no template found for card "${name}"${src} (type: ${type})`);
      continue;
    }

    // Build render context: top-level card fields + body for {$body.X} access
    const context = {
      id:       card.id,
      name:     card.name,
      pronouns: card.pronouns,
      aid:      card.aid || {},
      render:   card.render || {},
      body:     card.body || {},
      v:        card.v || {},
    };

    let rendered;
    try {
      rendered = render(template, context, partials, variables);
    } catch (err) {
      const name = card.id || String(card.name);
      const src = card._source ? ` (${card._source})` : '';
      console.error(`  ERR rendering card "${name}"${src}: ${err.message}`);
      continue;
    }

    const type = (card.aid && card.aid.type) || 'Uncategorized';
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(rendered);
  }

  const written = [];
  for (const [type, cards] of grouped) {
    const outPath = writeOutput(outputDir, type, cards);
    written.push(outPath);
    console.log(`    OK: ${type} (${cards.length} card(s)) → ${outPath}`);
  }
  return written;
}

/**
 * Copy scripts directory to target branch Scripts/ folder.
 */
function copyScripts(srcDir, targetDir) {
  if (!srcDir || !fs.existsSync(srcDir)) return;
  const dest = path.join(targetDir, 'Scripts');
  fs.cpSync(srcDir, dest, { recursive: true });
}

/**
 * Write Opening.md or Opening Choice.md to a branch node's Components folder.
 */
function writeComponentFile(outputDir, filename, content) {
  const dir = path.join(outputDir, 'Components');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, filename);
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

/**
 * Recursively write opening / openingChoice files through the branch tree.
 *
 * Rules:
 *   opening:       inherits down; written ONLY to leaf nodes' Components/Opening.md
 *   openingChoice: does NOT inherit; written to branch NODE's Components/Opening.md
 *                  if present on leaf, warn and skip
 *
 * @param {object} branches - branch tree
 * @param {string} baseOutput - base output directory
 * @param {string} configBase - base path for resolving relative file paths
 * @param {string|null} inheritedOpening - effective opening carried from ancestor
 * @param {boolean} isLeaf - whether this level is a leaf (no sub-branches)
 */
function writeOpeningsRecursive(branches, outputBase, configBase, inheritedOpening, variables, componentDirs) {
  if (!branches || typeof branches !== 'object') {
    // We're at the root level with no branches — the root itself is the only leaf
    if (inheritedOpening != null) {
      const content = resolveOpeningContent(inheritedOpening, configBase, variables);
      const outPath = writeComponentFile(outputBase, 'Opening.md', content);
      console.log(`    OK: Opening → ${outPath}`);
    }
    return;
  }

  for (const [name, branchConfig] of Object.entries(branches)) {
    const folderName = (branchConfig && branchConfig.title) || name;
    const nodeOutput = path.join(outputBase, 'Branches', folderName);
    const subBranches = branchConfig && branchConfig.branches;
    const isLeafNode = !subBranches || Object.keys(subBranches).length === 0;

    // Merge this branch node's variables on top of inherited variables
    const branchVars = (branchConfig && branchConfig.variables)
      ? Object.assign({}, variables, branchConfig.variables)
      : variables;

    // Determine effective opening for this node
    const nodeOpening = branchConfig && branchConfig.components && branchConfig.components.opening !== undefined
      ? branchConfig.components.opening
      : (branchConfig && branchConfig.opening !== undefined ? branchConfig.opening : undefined);
    const effectiveOpening = nodeOpening !== undefined ? nodeOpening : inheritedOpening;

    // openingChoice on this node
    const openingChoice = branchConfig && branchConfig.components && branchConfig.components.openingChoice !== undefined
      ? branchConfig.components.openingChoice
      : (branchConfig && branchConfig.openingChoice !== undefined ? branchConfig.openingChoice : null);

    if (openingChoice != null) {
      if (isLeafNode) {
        console.warn(`  WARN: openingChoice on leaf branch "${name}" — ignoring`);
      } else {
        const expandedChoice = (componentDirs && typeof openingChoice === 'string')
          ? resolveComponentKey(openingChoice, componentDirs)
          : openingChoice;
        const content = resolveOpeningContent(expandedChoice, configBase, branchVars);
        const outPath = writeComponentFile(nodeOutput, 'Opening.md', content);
        console.log(`    OK: OpeningChoice → ${outPath}`);
      }
    }

    if (isLeafNode) {
      // Write the inherited/overridden opening to this leaf
      if (effectiveOpening != null) {
        const content = resolveOpeningContent(effectiveOpening, configBase, branchVars);
        const outPath = writeComponentFile(nodeOutput, 'Opening.md', content);
        console.log(`    OK: Opening → ${outPath}`);
      }
    } else {
      // Recurse into sub-branches
      writeOpeningsRecursive(subBranches, nodeOutput, configBase, effectiveOpening, branchVars, componentDirs);
    }
  }
}

// ── Main compile function ─────────────────────────────────────────────────────

function compile(configPath, options = {}) {
  const config = loadCompileConfig(configPath);

  const { templates, partials } = loadTemplates(config._resolvedTemplates);
  console.log(`Loaded ${templates.size} template(s)${partials.size ? `, ${partials.size} partial(s)` : ''}.`);

  // Build canon registry
  const canonRegistry = buildCanonRegistry(config._resolvedCanon);
  if (canonRegistry.size > 0) {
    console.log(`Loaded ${canonRegistry.size} canonical card(s).`);
  }

  // Load project cards
  const rawProjectCards = loadCardsFromDir(config._resolvedCards);

  // Resolve includes
  const includedCards = resolveIncludes(rawProjectCards, canonRegistry, config);
  if (includedCards.length > 0) {
    console.log(`Loaded ${includedCards.length} included canonical card(s).`);
  }

  const allCardDefs = [...rawProjectCards, ...includedCards];

  const projectRegistry = buildRegistry(rawProjectCards, 'project');
  console.log(`Loaded ${projectRegistry.size} project card definition(s).`);

  const overlays = buildOverlays(rawProjectCards);
  if (overlays.size > 0) {
    console.log(`Loaded ${overlays.size} Codex overlay(s).`);
  }

  const registry = mergeRegistries(canonRegistry, projectRegistry);

  const leaves = enumerateLeaves(config.branches);

  if (options.clean) {
    console.log('\nClean build: clearing output folders...');
    cleanAndArchive(config, leaves);
  }

  console.log(`\nCompiling ${leaves.length} branch leaf/leaves...`);

  let totalFiles = 0;

  for (const branchPath of leaves) {
    const label = branchPath.length > 0 ? branchPath.join('/') : '(root)';
    console.log(`\n  Branch: ${label}`);

    const branchConfig = getBranchConfig(config.branches, branchPath);
    const branchProtagonist = (
      branchConfig.protagonist || config.protagonist || ''
    ).toLowerCase() || null;

    const folderPath = resolveBranchFolderPath(config.branches, branchPath);
    const outputDir = buildBranchOutputDir(config._resolvedOutput, folderPath);
    const ctx = buildCompileContext(config, branchPath);
    const compileContext = { branchPath, branchProtagonist, ...ctx };

    // Pre-scan PE blocks: full-style card imports suppress story card generation
    const peSpec = compileContext.componentRefs.plotEssential;
    const peSuppressedIds = new Set();
    if (peSpec && typeof peSpec === 'string' && !peSpec.includes('{')) {
      const peBlocksForScan = loadPEConfig(peSpec);
      for (const block of peBlocksForScan) {
        if (block.blocks) {
          // Section block — apply section-level branch filter then walk children
          const sectionBranch = resolveBranchSpec(block.branches, branchPath);
          if (sectionBranch === null) continue;
          for (const child of block.blocks) {
            if (!child.import) continue;
            const childBranch = resolveBranchSpec(child.branches, branchPath);
            if (childBranch === null) continue;
            const style = ((child.render && child.render.style) || 'full').toLowerCase();
            if (style === 'full') peSuppressedIds.add(String(child.import).toLowerCase());
          }
          continue;
        }
        if (!block.import) continue;
        const branchResult = resolveBranchSpec(block.branches, branchPath);
        if (branchResult === null) continue;
        const style = ((block.render && block.render.style) || 'full').toLowerCase();
        if (style === 'full') {
          peSuppressedIds.add(String(block.import).toLowerCase());
        }
      }
    }

    // Phase A: resolve all story cards
    const resolvedCards = compileBranchPhaseA(allCardDefs, registry, branchPath, ctx.variables);

    // Phase B: cross-card refs + pronouns + render + write
    const written = compileBranchPhaseB(
      resolvedCards, registry, templates, partials, outputDir, branchProtagonist, peSuppressedIds, ctx.variables
    );
    totalFiles += written.length;

    // Plot Essentials
    if (peSpec) {
      const peBlocks = loadPEConfig(typeof peSpec === 'string' && !peSpec.includes('{') ? peSpec : null);
      if (peBlocks.length > 0) {
        const peContent = compilePE(peBlocks, registry, templates, partials, compileContext, overlays);
        const pePath = writePE(outputDir, peContent);
        if (pePath) { console.log(`    OK: PlotEssentials → ${pePath}`); totalFiles++; }
      }
    }

    // AI Instructions
    const ainSpec = compileContext.componentRefs.aiInstructions;
    if (ainSpec && typeof ainSpec === 'string' && fs.existsSync(ainSpec)) {
      const ainDoc = loadAINConfig(ainSpec);
      const { ain } = compileAIN(ainDoc, registry, compileContext);
      const ainPath = writeAIN(outputDir, ain);
      if (ainPath) { console.log(`    OK: AIInstructions → ${ainPath}`); totalFiles++; }
    }

    // Author's Note
    const anSpec = compileContext.componentRefs.authorsNote;
    if (anSpec && typeof anSpec === 'string' && fs.existsSync(anSpec)) {
      const anDoc = loadANConfig(anSpec);
      const anContent = compileAN(anDoc, registry, compileContext);
      const anPath = writeAN(outputDir, anContent);
      if (anPath) { console.log(`    OK: AuthorsNote → ${anPath}`); totalFiles++; }
    }

    // Scripts
    const scriptsSpec = compileContext.componentRefs.scripts;
    if (scriptsSpec && typeof scriptsSpec === 'string') {
      copyScripts(scriptsSpec, outputDir);
    }
  }

  console.log(`\nDone. Wrote ${totalFiles} file(s).`);

  // Write Opening / OpeningChoice files (post-loop)

  // Root-level openingChoice: non-inheriting, written at the root output dir
  const rootOpeningChoice = config.components && config.components.openingChoice != null
    ? config.components.openingChoice
    : null;
  if (rootOpeningChoice != null) {
    const hasBranches = config.branches && Object.keys(config.branches).length > 0;
    if (!hasBranches) {
      console.warn(`  WARN: root openingChoice with no branches — ignoring`);
    } else {
      const expandedChoice = typeof rootOpeningChoice === 'string'
        ? resolveComponentKey(rootOpeningChoice, config._resolvedComponents)
        : rootOpeningChoice;
      const content = resolveOpeningContent(expandedChoice, config._base, config.variables || {});
      const outPath = writeComponentFile(config._resolvedOutput, 'Opening.md', content);
      console.log(`    OK: Root OpeningChoice → ${outPath}`);
    }
  }

  const rootOpening = config.components && config.components.opening != null
    ? config.components.opening
    : null;
  writeOpeningsRecursive(
    config.branches, config._resolvedOutput, config._base,
    rootOpening, config.variables || {}, config._resolvedComponents
  );

  // Overview (leaf review) — always generated after compile
  const { runLeafReviewMode } = require('./overview');
  const overviewDir = config._resolvedOverview || path.join(config._resolvedOutput, 'Overview');
  fs.mkdirSync(overviewDir, { recursive: true });
  console.log('\nGenerating overview...');
  runLeafReviewMode(config._resolvedOutput, overviewDir);
}

/**
 * Write content to Components/Opening.md inside outputDir.
 * Exposed for unit testing.
 */
function writeOpening(outputDir, content) {
  return writeComponentFile(outputDir, 'Opening.md', content);
}

module.exports = {
  compile,
  compileBranchPhaseA,
  compileBranchPhaseB,
  getTemplate,
  writeOutput,
  resolveIncludes,
  buildCompileContext,
  resolveVariables,
  buildBranchOutputDir,
  resolveBranchFolderPath,
  resolveOpeningContent,
  writeOpening,
  writeOpeningsRecursive,
};

/**
 * Resolve scenarioRoot and outputDir for overview/leaf-review CLI modes.
 * If `arg` is a .yaml/.yml file, load it as a compile config and derive both paths from it.
 * Otherwise treat `arg` as the scenario root directory.
 *
 * @param {string}      arg         - path argument from CLI
 * @param {string}      defaultOut  - fallback output dir name when arg is a directory
 * @returns {{ scenarioRoot: string, outputDir: string }}
 */
function resolveReviewArgs(arg, defaultOut) {
  if (/\.ya?ml$/i.test(arg)) {
    const cfg = loadCompileConfig(path.resolve(arg));
    return {
      scenarioRoot: cfg._resolvedOutput,
      outputDir:    cfg._resolvedOverview || path.join(cfg._resolvedOutput, 'Overview'),
    };
  }
  return {
    scenarioRoot: path.resolve(arg),
    outputDir:    path.resolve(defaultOut),
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const rawArgs = process.argv.slice(2);

  const leafReviewIdx = rawArgs.findIndex(a => a === '--leafReview' || a === '-l');
  const overviewIdx   = rawArgs.findIndex(a => a === '--overview'   || a === '-o');
  const doLeafReview  = leafReviewIdx !== -1;
  const doOverview    = overviewIdx   !== -1;

  if (doLeafReview || doOverview) {
    const { runLeafReviewMode, runOverviewMode } = require('./overview');
    const flagIdxs = new Set([leafReviewIdx, overviewIdx].filter(i => i !== -1));
    const rest = rawArgs.filter((_, i) => !flagIdxs.has(i));
    let scenarioRoot, outputDir;

    if (rest.length === 0) {
      const cfgPath = path.join(process.cwd(), 'compile.yaml');
      if (!fs.existsSync(cfgPath)) {
        console.error('No compile.yaml in current directory and no path given.');
        process.exit(1);
      }
      const cfg = loadCompileConfig(cfgPath);
      scenarioRoot = cfg._resolvedOutput;
      outputDir = cfg._resolvedOverview || path.resolve(path.dirname(cfgPath), 'leaf-review');
    } else {
      ({ scenarioRoot, outputDir } = resolveReviewArgs(rest[0], 'overview'));
    }

    if (!fs.existsSync(scenarioRoot)) {
      console.error(`Scenario root not found: ${scenarioRoot}`);
      process.exit(1);
    }

    const modeLabel = [doLeafReview && 'leaf-review', doOverview && 'overview'].filter(Boolean).join(' + ');
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`\n${modeLabel} mode\nScenario root : ${scenarioRoot}\nOutput dir    : ${outputDir}\n`);

    try {
      if (doLeafReview) {
        const written = runLeafReviewMode(scenarioRoot, outputDir);
        console.log(`\nWrote ${written.length} leaf review file(s) to:\n  ${outputDir}`);
      }
      if (doOverview) {
        runOverviewMode(scenarioRoot, outputDir);
        console.log(`\nWrote overview file to:\n  ${outputDir}`);
      }
      console.log('');
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      process.exit(1);
    }

  } else {
    const cleanIdx = rawArgs.findIndex(a => a === '--clean' || a === '-c');
    const isClean = cleanIdx !== -1;
    const compileArgs = rawArgs.filter((_, i) => i !== cleanIdx);

    if (compileArgs.length === 0) {
      console.error(
        'Usage: codex-loom [--clean|-c] <path/to/compile.yaml or project/>\n' +
        '       codex-loom [--leafReview|-l] [--overview|-o] [<scenario-root | compile.yaml>]'
      );
      process.exit(1);
    }

    let configPath = compileArgs[0];
    try {
      if (fs.statSync(configPath).isDirectory()) {
        configPath = path.join(configPath, 'compile.yaml');
      }
    } catch (_) {}

    try {
      compile(configPath, { clean: isClean });
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      process.exit(1);
    }
  }
}
