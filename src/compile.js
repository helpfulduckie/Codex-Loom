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
const { resolveVariables, warnUnexpandedVariables, warnUnresolvedFieldTokens } = require('./util');
const { expandTokens } = require('./tokens');
const { loadPEConfig, compilePE, writePE } = require('./pe');
const { loadAINConfig, compileAIN, writeAIN } = require('./ain');
const { loadANConfig, compileAN, writeAN } = require('./an');
const { loadDescConfig, extractScriptBanner, writeDescription } = require('./description');
const { loadOpeningConfig, compileOpening } = require('./opening');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Characters illegal in a Windows/Unix path segment (mirrors overview.js sanitizeFilename
// plus control chars). aid.type becomes both a folder and a filename, so it must be safe.
const INVALID_TYPE_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

/**
 * Validate a card's aid.type after variable expansion. aid.type is written to disk
 * as Story Cards/{type}/{type}.md, so it must be a legal path segment. Throws (aborts
 * the compile) on an invalid type. No-op when the card has no aid.type (that case is
 * already warned about during card resolution).
 */
function validateCardType(card) {
  const type = card.aid && card.aid.type;
  if (typeof type !== 'string' || type === '') return;
  const trimmed = type.trim();
  const name = card.id || (typeof card.name === 'string' ? card.name : '(unknown)');
  const src = card._source ? ` (${card._source})` : '';
  let reason = null;
  if (trimmed === '') reason = 'is empty/whitespace';
  else if (INVALID_TYPE_CHARS.test(type)) reason = 'contains an illegal path character (one of < > : " / \\ | ? *)';
  else if (trimmed === '.' || trimmed === '..') reason = 'is "." or ".."';
  else if (/[ .]$/.test(type)) reason = 'ends with a space or period';
  if (reason) {
    throw new Error(`Invalid aid.type "${type}" for card "${name}"${src}: ${reason}. aid.type becomes a folder/file name and must be a legal path segment.`);
  }
}

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
 * Expand {@Key} references in text (content mode: returns file contents).
 * Resolves against components first, then canon.
 */
function resolveComponentKey(text, componentDirs, canon) {
  if (!componentDirs || typeof text !== 'string') return text;
  return expandTokens(text, { components: componentDirs, canon, mode: 'content' });
}

/**
 * Resolve a component spec value (file path | literal string | {%var} | {@Key}) to a file path.
 * Returns null if spec is null/undefined.
 * Returns a resolved absolute path if the spec points to an existing file.
 * Returns the literal string (for opening/openingChoice inline text).
 *
 * {@Key} resolves against components then canon (path mode); {%var} expands from
 * the supplied branch-merged variables. Missing {@Key} tokens pass through silently
 * (the spec may legitimately be inline text rather than a reference).
 */
function resolveComponentSpec(spec, base, componentDirs, canon, variables) {
  if (spec == null) return null;
  let resolved = spec;
  if (typeof resolved === 'string') {
    resolved = expandTokens(resolved, { variables, components: componentDirs, canon, mode: 'path', warnMissing: false });
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
    componentRefs[type] = resolveComponentSpec(spec, config._base, config._resolvedComponents, config._resolvedCanon, variables);
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
    const folderPath = resolveBranchFolderPath(config.branches, branchPath, config.variables);
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
 * A node's `title` may contain {%var} tokens; each is expanded using the variables
 * merged down to that node (root → this node), so an ancestor folder name stays
 * stable across its sibling leaves even if a deeper leaf overrides the variable.
 *
 * @param {object|null} branches - root branches mapping from config
 * @param {string[]}    idPath   - branch identifier path (e.g. ['tier2', 'alpha'])
 * @param {object}      [rootVariables] - config.variables (for {%var} expansion in titles)
 * @returns {string[]}           - folder name path (e.g. ['Tier Two', 'Alpha Path'])
 */
function resolveBranchFolderPath(branches, idPath, rootVariables) {
  const folderPath = [];
  let currentMap = branches;
  let variables = Object.assign({}, rootVariables || {});
  for (const id of idPath) {
    if (!currentMap || typeof currentMap !== 'object') {
      folderPath.push(id);
      continue;
    }
    const actualKey = Object.keys(currentMap).find(k => k.toLowerCase() === id.toLowerCase());
    const node = actualKey !== undefined ? currentMap[actualKey] : null;
    if (node && node.variables) variables = Object.assign(variables, node.variables);
    const rawName = (node && node.title) || (actualKey || id);
    folderPath.push(resolveVariables(rawName, variables));
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
  const seenFiles = new Map(); // fullPath → [importer _source, ...]
  for (const def of includeDefs) {
    // Resolve {%var} (root variables only — includes resolve once, before branch
    // enumeration) and {@Key} references (components then canon) in the include path.
    let includePath = expandTokens(String(def.include), {
      variables: config.variables || null,
      components: config._resolvedComponents,
      canon: config._resolvedCanon,
      mode: 'path',
      warnMissing: false,
    });

    // Normalize separators (handles mixed forward/back slashes from {@var}/path expansion)
    includePath = path.normalize(includePath);

    // Resolve relative to config base or as absolute
    const fullPath = path.isAbsolute(includePath) ? includePath : path.resolve(config._base, includePath);
    if (!fs.existsSync(fullPath)) {
      console.warn(`  WARN: include path not found: ${fullPath}`);
      continue;
    }

    const importerSource = def._source || '(unknown)';
    if (seenFiles.has(fullPath)) {
      seenFiles.get(fullPath).push(importerSource);
      const allImporters = seenFiles.get(fullPath);
      throw new Error(
        `File included more than once: ${fullPath}\n` +
        `Included by:\n` +
        allImporters.map(s => `  ${s}`).join('\n')
      );
    }
    seenFiles.set(fullPath, [importerSource]);

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
 * Build a canon dependency manifest for the output JSON file.
 */
function buildCanonManifest(config) {
  const { findFiles } = require('./loader');
  const manifest = {};
  for (const [name, resolvedPath] of config._resolvedCanon) {
    const expression = config._canonRaw ? String(config._canonRaw[name] ?? resolvedPath) : resolvedPath;
    const missing = !fs.existsSync(resolvedPath);
    const files = missing ? [] : findFiles(resolvedPath, '.yaml');
    manifest[name] = { expression, resolvedPath, files, ...(missing ? { missing: true } : {}) };
  }
  return manifest;
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
function compileBranchPhaseB(resolvedCards, registry, templates, partials, outputDir, branchProtagonist, suppressIds = new Set(), variables = {}, verbose = false) {
  // Build early so render functions can resolve cross-card refs during field expansion.
  const resolvedById = new Map();
  for (const card of resolvedCards) {
    const id = (card.id || '').toLowerCase();
    if (id) resolvedById.set(id, card);
  }

  applyCrossCardRefs(resolvedCards, registry);

  // Expand render functions in body field values now that cross-card refs are resolved.
  // Multi-pass: repeat until no body fields change, to handle order-dependent chains
  // where A.field = join($B.body.x) and B.body.x itself contains a cross-card render
  // function. Cap at N+1 passes (N = card count): a non-circular graph of N cards has
  // at most N-1 chain depth, so N-1 resolve passes + 1 convergence pass = N total.
  // The +1 ensures the worst-case linear chain doesn't falsely trigger the warning —
  // only a true cycle can exceed this bound.
  const maxPasses = resolvedCards.length + 1;
  let changed = true;
  let pass = 0;
  while (changed && pass < maxPasses) {
    changed = false;
    pass++;
    for (const card of resolvedCards) {
      const snapshot = JSON.stringify(card.body);
      applyFieldRenderFunctions(card, resolvedById);
      if (JSON.stringify(card.body) !== snapshot) changed = true;
    }
  }
  if (pass === maxPasses) {
    console.warn(`  WARN: cross-card render functions may have circular dependencies — stopped after ${maxPasses} passes`);
  }

  const grouped = new Map();

  for (const card of resolvedCards) {
    applyPronounPasses(card, registry, branchProtagonist, resolvedById);

    if (suppressIds.has((card.id || '').toLowerCase())) continue; // fully rendered in PE; skip story card

    // Validate the fully-resolved aid.type (it becomes a folder/file name). Runs here,
    // after all {%}/{$} passes, so it sees the final on-disk type. Aborts on invalid.
    validateCardType(card);

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
    const cardLabel = card.id || (typeof card.name === 'string' ? card.name : String(card.name));
    warnUnexpandedVariables(rendered, `card "${cardLabel}" (${type})`);
    warnUnresolvedFieldTokens(rendered, `card "${cardLabel}" (${type})`);
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(rendered);
  }

  const written = [];
  for (const [type, cards] of grouped) {
    const outPath = writeOutput(outputDir, type, cards);
    written.push(outPath);
    if (verbose) console.log(`    OK: ${type} (${cards.length} card(s)) → ${outPath}`);
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
  warnUnexpandedVariables(content, `component ${filename}`);
  warnUnresolvedFieldTokens(content, `component ${filename}`);
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

/**
 * Expand {@Key} component references in an opening spec, returning the stored
 * path/value without reading file contents (path mode vs resolveComponentKey's content mode).
 * Used so that opening: '{@op}' resolves to the file path, not the file contents.
 */
function expandOpeningKeyRef(spec, componentDirs, canon) {
  if (!spec || typeof spec !== 'string' || !componentDirs) return spec;
  return expandTokens(spec, { components: componentDirs, canon, mode: 'path' });
}

/**
 * Detect whether a raw opening spec resolves to a .yaml/.yml file.
 * Returns the absolute path if it is a YAML file, otherwise null.
 */
function resolveYamlOpeningPath(spec, base, variables) {
  if (spec == null || typeof spec !== 'string') return null;
  const expanded = variables ? resolveVariables(spec, variables) : spec;
  const absPath = path.resolve(base, expanded);
  if (fs.existsSync(absPath) && fs.statSync(absPath).isFile() && /\.ya?ml$/i.test(absPath)) {
    return absPath;
  }
  return null;
}

/**
 * Recursively write opening / openingChoice files through the branch tree.
 *
 * Rules:
 *   opening:       inherits down; written ONLY to leaf nodes' Components/Opening.md
 *                  If the resolved spec is a .yaml file, compiled as block-opening sequence.
 *   openingChoice: does NOT inherit; written to branch NODE's Components/Opening.md
 *                  if present on leaf, warn and skip
 *
 * @param {object} branches - branch tree
 * @param {string} outputBase - base output directory
 * @param {string} configBase - base path for resolving relative file paths
 * @param {string|null} inheritedOpening - effective opening spec carried from ancestor
 * @param {object} variables - merged branch variables
 * @param {object} componentDirs - resolved component directory map
 * @param {Map} canon - resolved canon name → path map (for {@Key} references)
 * @param {string[]} currentPath - branch path segments accumulated while descending
 */
function writeOpeningsRecursive(branches, outputBase, configBase, inheritedOpening, variables, componentDirs, canon, currentPath = [], verbose = false) {
  const writtenLeaves = new Set();

  if (!branches || typeof branches !== 'object') {
    // We're at the root level with no branches — the root itself is the only leaf
    if (inheritedOpening != null) {
      const expandedOpening = expandOpeningKeyRef(inheritedOpening, componentDirs, canon);
      const yamlPath = resolveYamlOpeningPath(expandedOpening, configBase, variables);
      let content;
      if (yamlPath) {
        const blocks = loadOpeningConfig(yamlPath);
        content = compileOpening(blocks, currentPath, variables, configBase);
      } else {
        content = resolveOpeningContent(expandedOpening, configBase, variables);
      }
      if (content) {
        const outPath = writeComponentFile(outputBase, 'Opening.md', content);
        if (verbose) console.log(`    OK: Opening → ${outPath}`);
        writtenLeaves.add(currentPath.join('/') || '(root)');
      }
    }
    return writtenLeaves;
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
          ? resolveComponentKey(openingChoice, componentDirs, canon)
          : openingChoice;
        const content = resolveOpeningContent(expandedChoice, configBase, branchVars);
        const outPath = writeComponentFile(nodeOutput, 'Opening.md', content);
        if (verbose) console.log(`    OK: OpeningChoice → ${outPath}`);
      }
    }

    if (isLeafNode) {
      // Write the inherited/overridden opening to this leaf
      if (effectiveOpening != null) {
        const leafPath = [...currentPath, name];
        // Expand {@Key} component references in path mode (returns path, not file contents)
        const expandedOpening = expandOpeningKeyRef(effectiveOpening, componentDirs, canon);
        const yamlPath = resolveYamlOpeningPath(expandedOpening, configBase, branchVars);
        let content;
        if (yamlPath) {
          const blocks = loadOpeningConfig(yamlPath);
          content = compileOpening(blocks, leafPath, branchVars, configBase);
        } else {
          content = resolveOpeningContent(expandedOpening, configBase, branchVars);
        }
        if (content) {
          const outPath = writeComponentFile(nodeOutput, 'Opening.md', content);
          if (verbose) console.log(`    OK: Opening → ${outPath}`);
          writtenLeaves.add(leafPath.join('/'));
        }
      }
    } else {
      // Recurse into sub-branches, tracking the current path
      const sub = writeOpeningsRecursive(subBranches, nodeOutput, configBase, effectiveOpening, branchVars, componentDirs, canon, [...currentPath, name], verbose);
      for (const k of sub) writtenLeaves.add(k);
    }
  }

  return writtenLeaves;
}

// ── Main compile function ─────────────────────────────────────────────────────

function compile(configPath, options = {}) {
  const verbose = !!options.verbose;
  const config = loadCompileConfig(configPath);

  fs.mkdirSync(config._resolvedOutput, { recursive: true });

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
  const allCardIds = new Set();
  const leafSummaries = [];

  // Track components that were requested (a spec/path was provided) but produced
  // no output file. A requested-but-unwritten component is almost always a silent
  // failure (bad path, unexpanded {%var}/{@key}, empty source) rather than intent —
  // collected here and reported as an error at the end of the compile.
  const componentGaps = [];
  const recordGap = (leaf, component, spec, reason) =>
    componentGaps.push({ leaf, component, spec: spec == null ? '(none)' : String(spec), reason });

  for (const branchPath of leaves) {
    const label = branchPath.length > 0 ? branchPath.join('/') : '(root)';
    if (verbose) console.log(`\n  Branch: ${label}`);

    const branchConfig = getBranchConfig(config.branches, branchPath);

    // Walk the full branch chain to find the nearest ancestor that declares protagonist
    let inheritedProtagonist = config.protagonist || '';
    let walkMap = config.branches;
    for (const part of branchPath) {
      if (!walkMap || typeof walkMap !== 'object') break;
      const actualKey = Object.keys(walkMap).find(k => k.toLowerCase() === part.toLowerCase());
      if (!actualKey) break;
      const node = walkMap[actualKey];
      if (node && node.protagonist) inheritedProtagonist = node.protagonist;
      walkMap = node && node.branches ? node.branches : null;
    }
    const folderPath = resolveBranchFolderPath(config.branches, branchPath, config.variables);
    const outputDir = buildBranchOutputDir(config._resolvedOutput, folderPath);
    const ctx = buildCompileContext(config, branchPath);
    // Expand {%var} in protagonist using branch-merged variables, before the
    // case-insensitive match against card ids.
    const branchProtagonist = resolveVariables(inheritedProtagonist, ctx.variables).toLowerCase() || null;
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

    // Accumulate unique card IDs and per-leaf stats for summary
    for (const card of resolvedCards) {
      if (card.id) allCardIds.add(card.id.toLowerCase());
    }
    const leafCards    = resolvedCards.length;
    const leafVariants = resolvedCards.filter(c => c._hasVariant).length;

    // Phase B: cross-card refs + pronouns + render + write
    const written = compileBranchPhaseB(
      resolvedCards, registry, templates, partials, outputDir, branchProtagonist, peSuppressedIds, ctx.variables, verbose
    );
    totalFiles += written.length;

    // Plot Essentials
    let hasPE = false;
    if (peSpec) {
      if (typeof peSpec === 'string' && peSpec.includes('{')) {
        recordGap(label, 'Plot Essentials', peSpec, 'unresolved reference — token did not expand to a path');
      } else {
        const peBlocks = loadPEConfig(typeof peSpec === 'string' ? peSpec : null);
        if (peBlocks.length === 0) {
          recordGap(label, 'Plot Essentials', peSpec, 'source loaded no blocks (missing or empty file)');
        } else {
          const peContent = compilePE(peBlocks, registry, templates, partials, compileContext, overlays);
          const pePath = writePE(outputDir, peContent);
          if (pePath) { hasPE = true; if (verbose) console.log(`    OK: PlotEssentials → ${pePath}`); totalFiles++; }
          else recordGap(label, 'Plot Essentials', peSpec, 'compiled to empty content (all blocks excluded or produced nothing)');
        }
      }
    }

    // AI Instructions
    let hasAIN = false;
    const ainSpec = compileContext.componentRefs.aiInstructions;
    if (ainSpec) {
      if (typeof ainSpec !== 'string' || !fs.existsSync(ainSpec)) {
        recordGap(label, 'AI Instructions', ainSpec, 'source not found');
      } else {
        const ainExt = path.extname(ainSpec).toLowerCase();
        if (ainExt === '.md' || ainExt === '.txt') {
          const content = fs.readFileSync(ainSpec, 'utf8').trimEnd() || null;
          const ainPath = writeAIN(outputDir, content);
          if (ainPath) { hasAIN = true; if (verbose) console.log(`    OK: AIInstructions → ${ainPath}`); totalFiles++; }
        } else {
          const ainDoc = loadAINConfig(ainSpec);
          const { ain } = compileAIN(ainDoc, registry, compileContext);
          const ainPath = writeAIN(outputDir, ain);
          if (ainPath) { hasAIN = true; if (verbose) console.log(`    OK: AIInstructions → ${ainPath}`); totalFiles++; }
        }
        if (!hasAIN) recordGap(label, 'AI Instructions', ainSpec, 'compiled to empty content');
      }
    }

    // Author's Note
    let hasAN = false;
    const anSpec = compileContext.componentRefs.authorsNote;
    if (anSpec) {
      if (typeof anSpec !== 'string' || !fs.existsSync(anSpec)) {
        recordGap(label, "Author's Note", anSpec, 'source not found');
      } else {
        const anExt = path.extname(anSpec).toLowerCase();
        if (anExt === '.md' || anExt === '.txt') {
          const content = fs.readFileSync(anSpec, 'utf8').trimEnd() || null;
          const anPath = writeAN(outputDir, content);
          if (anPath) { hasAN = true; if (verbose) console.log(`    OK: AuthorsNote → ${anPath}`); totalFiles++; }
        } else {
          const anDoc = loadANConfig(anSpec);
          const anContent = compileAN(anDoc, registry, compileContext);
          const anPath = writeAN(outputDir, anContent);
          if (anPath) { hasAN = true; if (verbose) console.log(`    OK: AuthorsNote → ${anPath}`); totalFiles++; }
        }
        if (!hasAN) recordGap(label, "Author's Note", anSpec, 'compiled to empty content');
      }
    }

    // Scripts
    const scriptsSpec = compileContext.componentRefs.scripts;
    if (scriptsSpec && typeof scriptsSpec === 'string') {
      copyScripts(scriptsSpec, outputDir);
    }

    leafSummaries.push({ label, leafCards, leafVariants, hasPE, hasAIN, hasAN });
  }

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
        ? resolveComponentKey(rootOpeningChoice, config._resolvedComponents, config._resolvedCanon)
        : rootOpeningChoice;
      const content = resolveOpeningContent(expandedChoice, config._base, config.variables || {});
      const outPath = writeComponentFile(config._resolvedOutput, 'Opening.md', content);
      if (verbose) console.log(`    OK: Root OpeningChoice → ${outPath}`);
    }
  }

  const rootOpening = config.components && config.components.opening != null
    ? config.components.opening
    : null;
  const leafOpeningKeys = writeOpeningsRecursive(
    config.branches, config._resolvedOutput, config._base,
    rootOpening, config.variables || {}, config._resolvedComponents, config._resolvedCanon,
    [], verbose
  );

  // Description (project-level, written once to output root alongside Branches/)
  const descRequested = config.components && config.components.description != null;
  const descSpec = descRequested
    ? resolveComponentSpec(config.components.description, config._base, config._resolvedComponents, config._resolvedCanon, config.variables || null)
    : null;
  if (descRequested && !(descSpec && typeof descSpec === 'string' && fs.existsSync(descSpec))) {
    recordGap('(project)', 'Description', descSpec, 'source not found');
  } else if (descSpec && typeof descSpec === 'string' && fs.existsSync(descSpec)) {
    const ext = path.extname(descSpec).toLowerCase();
    let bodyContent = null;
    let bannerContent = null;

    if (ext === '.md' || ext === '.txt') {
      bodyContent = fs.readFileSync(descSpec, 'utf8').trimEnd() || null;
    } else if (ext === '.js') {
      bannerContent = extractScriptBanner(descSpec, {});
    } else {
      const descCfg = loadDescConfig(descSpec, config._base, config._resolvedComponents, config.variables || {}, config._resolvedCanon);
      if (descCfg.bodyPath && fs.existsSync(descCfg.bodyPath))
        bodyContent = fs.readFileSync(descCfg.bodyPath, 'utf8').trimEnd() || null;
      if (descCfg.scriptPath && fs.existsSync(descCfg.scriptPath))
        bannerContent = extractScriptBanner(descCfg.scriptPath, { stripTrailingInstructions: descCfg.stripTrailingInstructions });
    }

    const combined = [bodyContent, bannerContent].filter(Boolean).join('\n');
    const descPath = writeDescription(config._resolvedOutput, combined);
    if (descPath) { if (verbose) console.log(`  OK: Description → ${descPath}`); }
    else recordGap('(project)', 'Description', descSpec, 'compiled to empty content');
  }

  // Per-leaf summary table (printed after all component writes so Opening status is known)
  for (const s of leafSummaries) {
    s.hasOpening = leafOpeningKeys.has(s.label);
  }
  const maxLabelLen = Math.max(...leafSummaries.map(s => s.label.length), 'Branch'.length);
  const lp = maxLabelLen + 2;
  const c = b => b ? ' ✓ ' : ' - ';
  console.log(`\n  ${'Branch'.padEnd(lp)} ${'Cards'.padStart(5)}  ${'Var'.padStart(3)}   Open   PE  AIN   AN`);
  for (const s of leafSummaries) {
    console.log(
      `  ${s.label.padEnd(lp)} ${String(s.leafCards).padStart(5)}  ${String(s.leafVariants).padStart(3)}  ` +
      ` ${c(s.hasOpening)}  ${c(s.hasPE)} ${c(s.hasAIN)} ${c(s.hasAN)}`
    );
  }
  console.log(`\n${allCardIds.size} unique cards across project. Wrote ${totalFiles} file(s).`);

  // Canon dependency manifest
  const canonManifest = buildCanonManifest(config);
  if (Object.keys(canonManifest).length > 0) {
    const manifestPath = path.join(config._resolvedOutput, 'canon-dependencies.json');
    const manifestData = {
      generatedAt: new Date().toISOString(),
      compileYaml: path.resolve(configPath),
      variables: config.variables || {},
      canon: canonManifest,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');
    if (verbose) console.log(`  OK: Canon manifest → ${manifestPath}`);
  }

  // Requested-but-unwritten components: surface as an error so the gap is never silent.
  if (componentGaps.length > 0) {
    console.error(`\nERROR: ${componentGaps.length} requested component(s) produced no output:`);
    for (const g of componentGaps) {
      console.error(`  - [${g.leaf}] ${g.component}: ${g.reason}`);
      console.error(`      spec: ${g.spec}`);
    }
    throw new Error(
      `${componentGaps.length} requested component(s) were not written — see errors above. ` +
      `Fix the source path/reference, or remove the component from compile.yaml if it is not wanted.`
    );
  }
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
  validateCardType,
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
 * Resolve configPath, scenarioRoot, and outputDir from a CLI positional argument.
 * Accepts a folder (looks for compile.yaml inside), a compile.yaml path, or undefined (uses cwd).
 *
 * @param {string|undefined} positional
 * @returns {{ configPath: string|null, scenarioRoot: string|null, outputDir: string|null, hasConfig: boolean }}
 */
function resolveArgs(positional) {
  let cfgPath = null;

  if (positional) {
    if (/\.ya?ml$/i.test(positional)) {
      cfgPath = path.resolve(positional);
    } else {
      const candidate = path.join(path.resolve(positional), 'compile.yaml');
      if (fs.existsSync(candidate)) cfgPath = candidate;
    }
  } else {
    const candidate = path.join(process.cwd(), 'compile.yaml');
    if (fs.existsSync(candidate)) cfgPath = candidate;
  }

  if (cfgPath) {
    const cfg = loadCompileConfig(cfgPath);
    return {
      configPath:   cfgPath,
      scenarioRoot: cfg._resolvedOutput,
      outputDir:    cfg._resolvedOverview || path.join(cfg._resolvedOutput, 'Overview'),
      hasConfig:    true,
    };
  }

  if (!positional) {
    return { configPath: null, scenarioRoot: null, outputDir: null, hasConfig: false };
  }

  return {
    configPath:   null,
    scenarioRoot: path.resolve(positional),
    outputDir:    path.resolve('overview'),
    hasConfig:    false,
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const rawArgs = process.argv.slice(2);

  const knownFlags = [
    ['compile',    ['--compile',    '-C']],
    ['leafReview', ['--leafReview', '-l']],
    ['overview',   ['--overview',   '-o']],
    ['seedMap',    ['--seed-map',   '-s']],
    ['cardSizes',  ['--card-sizes', '-b']],
    ['clean',      ['--clean',      '-c']],
    ['verbose',    ['--verbose',    '-v']],
  ];

  const flags = {};
  const flagIdxs = new Set();
  for (const [key, aliases] of knownFlags) {
    const idx = rawArgs.findIndex(a => aliases.includes(a));
    flags[key] = idx !== -1;
    if (idx !== -1) flagIdxs.add(idx);
  }

  const positional = rawArgs.filter((_, i) => !flagIdxs.has(i));

  const doCompile    = flags.compile || (!flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes);
  const doLeafReview = flags.leafReview;
  const doOverview   = flags.overview;
  const doSeedMap    = flags.seedMap;
  const doCardSizes  = flags.cardSizes;

  if (positional.length === 0 && !flags.compile && !flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes) {
    console.error(
      'Usage: codex-loom [--compile|-C] [--clean|-c] [--verbose|-v] [--leafReview|-l] [--overview|-o] [--seed-map|-s] [--card-sizes|-b] [<folder | compile.yaml>]'
    );
    process.exit(1);
  }

  const { configPath, scenarioRoot, outputDir, hasConfig } = resolveArgs(positional[0]);

  // ── Compile ──
  if (doCompile) {
    if (!hasConfig) {
      if (!scenarioRoot) {
        console.error('No compile.yaml in current directory and no path given.');
        process.exit(1);
      }
      if (doLeafReview || doOverview) {
        console.warn('Warning: compile.yaml not found; skipping compile.');
      } else {
        console.error(`No compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
        process.exit(1);
      }
    } else {
      try {
        compile(configPath, { clean: flags.clean, verbose: flags.verbose });
      } catch (err) {
        console.error(`\nFatal: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // ── Reports (leaf-review, overview, seed-map, card-sizes) ──
  if (doLeafReview || doOverview || doSeedMap || doCardSizes) {
    if (!scenarioRoot) {
      console.error('No compile.yaml in current directory and no path given.');
      process.exit(1);
    }
    if (!fs.existsSync(scenarioRoot)) {
      console.error(`Scenario root not found: ${scenarioRoot}`);
      process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });

    if (flags.verbose) {
      const modeLabel = [
        doLeafReview && 'leaf-review',
        doOverview   && 'overview',
        doSeedMap    && 'seed-map',
        doCardSizes  && 'card-sizes',
      ].filter(Boolean).join(' + ');
      console.log(`\n${modeLabel} mode\nScenario root : ${scenarioRoot}\nOutput dir    : ${outputDir}\n`);
    }

    try {
      const summaryParts = [];

      if (doLeafReview) {
        const { runLeafReviewMode } = require('./overview');
        const written = runLeafReviewMode(scenarioRoot, outputDir, flags.verbose);
        summaryParts.push(`${written.length} leaf review file(s)`);
      }

      if (doSeedMap) {
        const { runSeedMapMode } = require('./seedmap');
        const result = runSeedMapMode(scenarioRoot, outputDir, flags.verbose);
        if (result) summaryParts.push('2 seed map files');
      }

      if (doOverview) {
        const { runOverviewMode } = require('./overview');
        runOverviewMode(scenarioRoot, outputDir, flags.verbose);
        summaryParts.push('an overview file');
      }

      if (doCardSizes) {
        const { runBodySizeMode } = require('./bodysize');
        const result = runBodySizeMode(scenarioRoot, outputDir, flags.verbose);
        if (result) summaryParts.push('a card sizes file');
      }

      if (summaryParts.length > 0) {
        const joined = summaryParts.length === 1
          ? summaryParts[0]
          : summaryParts.slice(0, -1).join(', ') + ', and ' + summaryParts.at(-1);
        console.log(`\nWrote ${joined} to:\n  ${outputDir}\n`);
      }
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      process.exit(1);
    }
  }
}
