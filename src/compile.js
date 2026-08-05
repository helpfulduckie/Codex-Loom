#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadCardsFromDir, loadTemplates, loadCompileConfig,
  buildRegistry, mergeRegistries, buildOverlays, loadYaml,
} = require('./loader');
const {
  resolveItem, enumerateLeaves, walkBranchChain, walkBranchTree,
} = require('./resolver');
const { applyPronounPasses, applyCrossItemRefs } = require('./model/pronouns');
const { render, applyFieldInterpolation, applyVariableInterpolation, applyFieldRenderFunctions } = require('./template');
const { resolveVariables, warnUnexpandedVariables, warnUnresolvedFieldTokens, warnMechanicalArtifacts, consoleWarner } = require('./util');
const { expandTokens } = require('./tokens');
const { resolveIncludes, buildCanonRegistry } = require('./loader/registry');
const { Diagnostics } = require('./diag');
const { loadPEConfig, compilePE, compilePEBlocks, writePE } = require('./pe');
const { loadAINConfig, compileAIN, writeAIN } = require('./ain');
const { loadANConfig, compileAN, writeAN } = require('./an');
const { loadDescConfig, extractScriptBanner, writeDescription } = require('./description');
const { loadOpeningConfig, compileOpening } = require('./opening');
const { DOCUMENT_COMPONENTS, emitDocumentComponent } = require('./emit/components');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Characters illegal in a Windows/Unix path segment (mirrors overview.js sanitizeFilename
// plus control chars). aid.type becomes both a folder and a filename, so it must be safe.
const INVALID_TYPE_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

/**
 * Validate a item's aid.type after variable expansion. aid.type is written to disk
 * as Story Cards/{type}/{type}.md, so it must be a legal path segment. Throws (aborts
 * the compile) on an invalid type. No-op when the item has no aid.type (that case is
 * already warned about during item resolution).
 */
function validateCardType(item) {
  const type = item.aid && item.aid.type;
  if (typeof type !== 'string' || type === '') return;
  const trimmed = type.trim();
  const name = item.id || (typeof item.name === 'string' ? item.name : '(unknown)');
  const src = item._source ? ` (${item._source})` : '';
  let reason = null;
  if (trimmed === '') reason = 'is empty/whitespace';
  else if (INVALID_TYPE_CHARS.test(type)) reason = 'contains an illegal path character (one of < > : " / \\ | ? *)';
  else if (trimmed === '.' || trimmed === '..') reason = 'is "." or ".."';
  else if (/[ .]$/.test(type)) reason = 'ends with a space or period';
  if (reason) {
    throw new Error(`Invalid aid.type "${type}" for item "${name}"${src}: ${reason}. aid.type becomes a folder/file name and must be a legal path segment.`);
  }
}

/**
 * Get the template for a item. Checks render.template first, then aid.type.
 */
function getTemplate(item, templates) {
  const keys = [
    item.render && item.render.template,
    item.aid && item.aid.type,
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
 * Resolve a component spec (a file path, or literal text) against branch-merged variables.
 *
 * Returns null for an absent spec, an absolute path when the spec names a file that
 * exists, and otherwise the literal string — `branchFraming` is often a question rather
 * than a path, and that fallback is what lets one key carry both.
 */
function resolveComponentSpec(spec, base, variables) {
  if (spec == null) return null;
  let resolved = spec;
  if (typeof resolved === 'string') {
    resolved = expandTokens(resolved, { variables });
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
  const chain = walkBranchChain(config.branches, branchPath);
  const variables = Object.assign({}, config._variables || config.variables || {}, chain.variables);
  const components = Object.assign({}, config.components || {}, chain.components);

  // `scripts:` is top-level as of §6.3: it is a file copy, not a rendered document, and
  // it was the one row in the component table that shared none of the row's behavior. It
  // still merges down the branch chain like everything else, so it is folded back in
  // here rather than resolved separately.
  const scripts = chain.scripts !== undefined ? chain.scripts : config.scripts;
  if (scripts !== undefined) components.scripts = scripts;

  // Resolve component specs to file paths
  const componentTypes = ['aiInstructions', 'opening', 'branchFraming', 'plotEssential', 'authorsNote', 'scripts'];
  const componentRefs = {};
  for (const type of componentTypes) {
    const spec = components[type] !== undefined ? components[type] : null;
    componentRefs[type] = resolveComponentSpec(spec, config._base, variables);
  }

  return { variables, componentRefs };
}

/**
 * Write compiled items to output directory.
 * One .md file per item type: Story Cards/{type}/{type}.md
 */
function writeOutput(outputDir, type, renderedItems) {
  const typeDir = path.join(outputDir, 'Story Cards', type);
  fs.mkdirSync(typeDir, { recursive: true });
  const outputPath = path.join(typeDir, `${type}.md`);
  fs.writeFileSync(outputPath, renderedItems.join('\n\n') + '\n', 'utf8');
  return outputPath;
}

/**
 * Delete Story Cards, Components, Scripts subdirs and Label.md from a branch output dir.
 */
function cleanBranchOutputDir(dir) {
  for (const sub of ['Story Cards', 'Components', 'Scripts']) {
    const target = path.join(dir, sub);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
  const label = path.join(dir, 'Label.md');
  if (fs.existsSync(label)) fs.rmSync(label);
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
 * Uses the internal key name (case-preserved from the YAML) for each folder segment.
 *
 * @param {object|null} branches - root branches mapping from config
 * @param {string[]}    idPath   - branch identifier path (e.g. ['tier2', 'alpha'])
 * @returns {string[]}           - folder name path (e.g. ['tier2', 'alpha'])
 */
function resolveBranchFolderPath(branches, idPath) {
  return walkBranchChain(branches, idPath).folderPath;
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
 * Returns array of resolved items (after Phase A), in place for Phase B caller.
 *
 * Phase A: resolve + field interpolation
 * Phase B (caller): cross-item refs + pronouns + render
 */
function compileBranchPhaseA(allCardDefs, registry, branchPath, variables) {
  const resolvedItems = [];

  for (const itemDef of allCardDefs) {
    if (itemDef.include) continue; // include directives already expanded

    let item;
    try {
      item = resolveItem(itemDef, registry, branchPath, consoleWarner);
    } catch (err) {
      const label = itemDef.id || itemDef.import || itemDef.name || '?';
      const src = itemDef._source ? ` (${itemDef._source})` : '';
      console.error(`  ERR resolving item "${label}"${src}: ${err.message}`);
      continue;
    }

    if (!item) continue; // excluded by branch spec

    applyFieldInterpolation(item);
    applyVariableInterpolation(item, variables);
    resolvedItems.push(item);
  }

  return resolvedItems;
}

/**
 * Phase B: apply cross-item refs, pronouns, render, and write output.
 */
function compileBranchPhaseB(resolvedItems, registry, templates, partials, outputDir, branchProtagonist, suppressIds = new Set(), variables = {}, verbose = false, renderedById = null) {
  // Build early so render functions can resolve cross-item refs during field expansion.
  const resolvedById = new Map();
  for (const item of resolvedItems) {
    const id = (item.id || '').toLowerCase();
    if (id) resolvedById.set(id, item);
  }

  applyCrossItemRefs(resolvedItems, registry, consoleWarner);

  // Expand render functions in body field values now that cross-item refs are resolved.
  // Multi-pass: repeat until no body fields change, to handle order-dependent chains
  // where A.field = join($B.body.x) and B.body.x itself contains a cross-item render
  // function. Cap at N+1 passes (N = item count): a non-circular graph of N items has
  // at most N-1 chain depth, so N-1 resolve passes + 1 convergence pass = N total.
  // The +1 ensures the worst-case linear chain doesn't falsely trigger the warning —
  // only a true cycle can exceed this bound.
  const maxPasses = resolvedItems.length + 1;
  let changed = true;
  let pass = 0;
  while (changed && pass < maxPasses) {
    changed = false;
    pass++;
    for (const item of resolvedItems) {
      const snapshot = JSON.stringify(item.body);
      applyFieldRenderFunctions(item, resolvedById);
      if (JSON.stringify(item.body) !== snapshot) changed = true;
    }
  }
  if (pass === maxPasses) {
    console.warn(`  WARN: cross-item render functions may have circular dependencies — stopped after ${maxPasses} passes`);
  }

  const grouped = new Map();

  for (const item of resolvedItems) {
    applyPronounPasses(item, registry, branchProtagonist, resolvedById);

    if (suppressIds.has((item.id || '').toLowerCase())) continue; // fully rendered in PE; skip story card

    // Validate the fully-resolved aid.type (it becomes a folder/file name). Runs here,
    // after all {%}/{$} passes, so it sees the final on-disk type. Aborts on invalid.
    validateCardType(item);

    const template = getTemplate(item, templates);
    if (!template) {
      const name = item.id || (typeof item.name === 'string' ? item.name : String(item.name));
      const type = (item.aid && item.aid.type) || (item.render && item.render.template) || '?';
      const src = item._source ? ` (${item._source})` : '';
      console.error(`  ERR: no template found for item "${name}"${src} (type: ${type})`);
      continue;
    }

    // Build render context: top-level item fields + body for {$body.X} access
    const context = {
      id:       item.id,
      name:     item.name,
      pronouns: item.pronouns,
      aid:      item.aid || {},
      render:   item.render || {},
      body:     item.body || {},
      v:        item.v || {},
    };

    let rendered;
    try {
      rendered = render(template, context, partials, variables);
    } catch (err) {
      const name = item.id || String(item.name);
      const src = item._source ? ` (${item._source})` : '';
      console.error(`  ERR rendering item "${name}"${src}: ${err.message}`);
      continue;
    }

    const type = (item.aid && item.aid.type) || 'Uncategorized';
    const itemLabel = item.id || (typeof item.name === 'string' ? item.name : String(item.name));
    warnUnexpandedVariables(rendered, `item "${itemLabel}" (${type})`);
    warnUnresolvedFieldTokens(rendered, `item "${itemLabel}" (${type})`);
    warnMechanicalArtifacts(rendered, `item "${itemLabel}" (${type})`);
    if (!grouped.has(type)) grouped.set(type, []);
    // Carry a sort key (the item's real id, lowercased) so output order is
    // deterministic regardless of authoring order in the source YAML.
    grouped.get(type).push({ sortKey: String(itemLabel).toLowerCase(), rendered });
    // Capture the rendered block per item id for cross-branch diff/annotate reports.
    if (renderedById && item.id) renderedById.set(item.id.toLowerCase(), { type, rendered });
  }

  // Emit types alphabetically, and items within each type sorted by id, so the
  // compiled Story Cards (and every downstream review/seed-map artifact) diff
  // cleanly across branches and builds. Story Cards load by trigger in AID, so
  // physical order has no gameplay effect.
  const written = [];
  for (const type of [...grouped.keys()].sort((a, b) => a.localeCompare(b))) {
    const items = grouped.get(type)
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.rendered.localeCompare(b.rendered))
      .map(c => c.rendered);
    const outPath = writeOutput(outputDir, type, items);
    written.push(outPath);
    if (verbose) console.log(`    OK: ${type} (${items.length} item(s)) → ${outPath}`);
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
  warnMechanicalArtifacts(content, `component ${filename}`);
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
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
 * Write Opening.md across the branch tree.
 *
 * Two components share one output file, and the difference is where they land in AID,
 * not how they are written (§7.3). `opening` inherits down and is written at a leaf,
 * where AID reads it as the first move. `openingChoice` — `branchFraming` in v4 — is
 * written at a non-leaf, where AID reads it as the framing shown while the player
 * chooses among the children below it. The inheritance asymmetry follows from that:
 * an opening is shared across branches because straight VL cannot share one, while
 * framing belongs to the node whose children it frames.
 *
 * Node-level writes are why this uses the tree visitor rather than the leaf loop.
 */
function writeOpeningsRecursive(branches, outputBase, configBase, inheritedOpening, variables, currentPath = [], verbose = false) {
  const writtenLeaves = new Set();

  const emitOpening = (spec, outputDir, leafPath, vars) => {
    // {@Key} expands in path mode here — the result is a path, not file contents.
    const expanded = spec;
    const yamlPath = resolveYamlOpeningPath(expanded, configBase, vars);
    const content = yamlPath
      ? compileOpening(loadOpeningConfig(yamlPath), leafPath, vars, configBase)
      : resolveOpeningContent(expanded, configBase, vars);
    if (!content) return;
    const outPath = writeComponentFile(outputDir, 'Opening.md', content);
    if (verbose) console.log(`    OK: Opening → ${outPath}`);
    writtenLeaves.add(leafPath.join('/') || '(root)');
  };

  // An unbranched project: the root is itself the only leaf.
  if (!branches || typeof branches !== 'object') {
    if (inheritedOpening != null) emitOpening(inheritedOpening, outputBase, currentPath, variables);
    return writtenLeaves;
  }

  walkBranchTree(branches, ({ name, node, path: nodePath, isLeaf, state }) => {
    const nodeOutput = path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    // v3 accepted these both under components: and directly on the branch node.
    const declaredOpening = node && node.components && node.components.opening !== undefined
      ? node.components.opening
      : undefined;
    const effectiveOpening = declaredOpening !== undefined ? declaredOpening : state.inheritedOpening;

    const framing = node && node.components && node.components.branchFraming !== undefined
      ? node.components.branchFraming
      : null;

    if (framing != null) {
      if (isLeaf) {
        console.warn(`  WARN: branchFraming on leaf branch "${name}" — ignoring`);
      } else {
        const expanded = framing;
        const outPath = writeComponentFile(
          nodeOutput, 'Opening.md', resolveOpeningContent(expanded, configBase, branchVars)
        );
        if (verbose) console.log(`    OK: OpeningChoice → ${outPath}`);
      }
    }

    if (isLeaf && effectiveOpening != null) {
      emitOpening(effectiveOpening, nodeOutput, [...currentPath, ...nodePath], branchVars);
    }

    return { outputBase: nodeOutput, inheritedOpening: effectiveOpening, variables: branchVars };
  }, { outputBase, inheritedOpening, variables });

  return writtenLeaves;
}

/**
 * Write Label.md at every node in the branch tree.
 *
 * Node-level, not leaf-level, which is why it uses the tree visitor rather than the
 * leaf loop: a branch label belongs to the node the player is choosing.
 */
function writeLabelsRecursive(branches, outputBase, variables, verbose = false) {
  walkBranchTree(branches, ({ name, node, state }) => {
    const nodeOutput = path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    const rawTitle = (node && node.title) || name;
    fs.mkdirSync(nodeOutput, { recursive: true });
    const outPath = path.join(nodeOutput, 'Label.md');
    fs.writeFileSync(outPath, resolveVariables(rawTitle, branchVars) + '\n', 'utf8');
    if (verbose) console.log(`    OK: Label → ${outPath}`);

    return { outputBase: nodeOutput, variables: branchVars };
  }, { outputBase, variables });
}

/**
 * Print what the loading phase collected, and abort if any of it is an error.
 *
 * Errors stop the compile before anything is written. A schema violation means some part
 * of what the author wrote is not being read, so continuing would emit a tree that looks
 * complete and is quietly missing something — the exact failure mode §4.3 exists to end.
 */
function reportLoadDiagnostics(diagnostics) {
  if (diagnostics.isEmpty()) return;
  for (const diag of diagnostics.all) {
    if (diag.severity === 'error') console.error(diag.format());
    else console.warn(diag.format());
  }
  if (diagnostics.hasErrors()) {
    const count = diagnostics.errors.length;
    throw new Error(`${count} error${count === 1 ? '' : 's'} while loading; nothing was compiled.`);
  }
}

// ── Main compile function ─────────────────────────────────────────────────────

function compile(configPath, options = {}) {
  const verbose = !!options.verbose;

  // One bus for everything the loading phase reports, so item schema violations are
  // collected with their source positions and reported together rather than as a stream
  // of console warnings interleaved with progress output. The compile phases still warn
  // directly; they move onto the bus as their modules are decomposed.
  const loadDiagnostics = new Diagnostics();

  const config = loadCompileConfig(configPath, { diagnostics: loadDiagnostics });

  fs.mkdirSync(config._resolvedOutput, { recursive: true });

  const { templates, partials } = loadTemplates(config._resolvedTemplates);
  console.log(`Loaded ${templates.size} template(s)${partials.size ? `, ${partials.size} partial(s)` : ''}.`);

  // Build canon registry
  const canonRegistry = buildCanonRegistry(config._resolvedCanon, { diagnostics: loadDiagnostics });
  if (canonRegistry.size > 0) {
    console.log(`Loaded ${canonRegistry.size} canonical item(s).`);
  }

  // Load project items
  const rawProjectItems = loadCardsFromDir(config._resolvedItems, { diagnostics: loadDiagnostics });

  // Resolve includes
  const includedItems = resolveIncludes(rawProjectItems, canonRegistry, config, { diagnostics: loadDiagnostics });
  if (includedItems.length > 0) {
    console.log(`Loaded ${includedItems.length} included canonical item(s).`);
  }

  reportLoadDiagnostics(loadDiagnostics);

  const allCardDefs = [...rawProjectItems, ...includedItems];

  const projectRegistry = buildRegistry(rawProjectItems, 'project');
  console.log(`Loaded ${projectRegistry.size} project item definition(s).`);

  const overlays = buildOverlays(rawProjectItems, { diagnostics: loadDiagnostics });
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

  // Cross-branch review reports (--diff / --annotate) are built from data captured
  // during compilation — the resolver materializes identity-keyed items in memory that
  // the on-disk markdown has already discarded. Gated so a normal compile is unchanged.
  const captureReports = !!(options.diff || options.annotate);
  const rootDirName = path.basename(config._resolvedOutput);
  const leafData = [];

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

    // One traversal now serves what used to be four: the folder path, the inherited
    // protagonist, the terminal node, and (inside buildCompileContext) the merged
    // variables and components.
    const chain = walkBranchChain(config.branches, branchPath, {
      rootProtagonist: config.protagonist || '',
    });
    const inheritedProtagonist = chain.protagonist;
    const folderPath = chain.folderPath;
    const outputDir = buildBranchOutputDir(config._resolvedOutput, folderPath);
    const ctx = buildCompileContext(config, branchPath);
    // Expand {%var} in protagonist using branch-merged variables, before the
    // case-insensitive match against item ids.
    const branchProtagonist = resolveVariables(inheritedProtagonist, ctx.variables).toLowerCase() || null;
    const compileContext = { branchPath, branchProtagonist, ...ctx };

    // Compile Plot Essentials BEFORE story cards so suppression follows exactly what
    // PE actually emitted. A full-style import that renders into PE suppresses its
    // story card; one that PE excludes (or fails to render) is left as a story card —
    // PE can never cause a item to vanish from both outputs.
    const peSpec = compileContext.componentRefs.plotEssential;
    const peSuppressedIds = new Set();
    let peContent = null;
    let peUnresolved = false;
    let peNoBlocks = false;
    let peDiffBlocks = []; // per-block PE segments for cross-branch diff (capture only)
    if (peSpec) {
      if (typeof peSpec === 'string' && peSpec.includes('{')) {
        peUnresolved = true;
      } else {
        const peBlocks = loadPEConfig(typeof peSpec === 'string' ? peSpec : null);
        if (peBlocks.length === 0) {
          peNoBlocks = true;
        } else {
          peContent = compilePE(peBlocks, registry, templates, partials, compileContext, overlays, peSuppressedIds);
          if (captureReports) {
            peDiffBlocks = compilePEBlocks(peBlocks, registry, templates, partials, compileContext, overlays);
          }
        }
      }
    }

    // Phase A: resolve all story cards
    const resolvedItems = compileBranchPhaseA(allCardDefs, registry, branchPath, ctx.variables);

    // Accumulate unique item IDs and per-leaf stats for summary
    for (const item of resolvedItems) {
      if (item.id) allCardIds.add(item.id.toLowerCase());
    }
    const leafItems    = resolvedItems.length;
    const leafVariants = resolvedItems.filter(c => c._hasVariant).length;

    // Phase B: cross-item refs + pronouns + render + write
    const renderedById = captureReports ? new Map() : null;
    const written = compileBranchPhaseB(
      resolvedItems, registry, templates, partials, outputDir, branchProtagonist, peSuppressedIds, ctx.variables, verbose, renderedById
    );
    totalFiles += written.length;

    // Capture component text for cross-branch reports (set as each component compiles below).
    let ainBlockText = null;
    let anBlockText  = null;

    // Plot Essentials — write the content compiled above and record any gaps.
    let hasPE = false;
    if (peSpec) {
      if (peUnresolved) {
        recordGap(label, 'Plot Essentials', peSpec, 'unresolved reference — token did not expand to a path');
      } else if (peNoBlocks) {
        recordGap(label, 'Plot Essentials', peSpec, 'source loaded no blocks (missing or empty file)');
      } else {
        const pePath = writePE(outputDir, peContent);
        if (pePath) { hasPE = true; if (verbose) console.log(`    OK: PlotEssentials → ${pePath}`); totalFiles++; }
        else recordGap(label, 'Plot Essentials', peSpec, 'compiled to empty content (all blocks excluded or produced nothing)');
      }
    }

    // Document components (AI Instructions, Author's Note) — one table, iterated once.
    // Both were near-identical twenty-line blocks differing only in loader, compiler,
    // writer and label; those differences are now table columns (§3.3, §7.3).
    const componentText = {};
    const componentWritten = {};
    for (const descriptor of DOCUMENT_COMPONENTS) {
      const spec = compileContext.componentRefs[descriptor.key];
      if (!spec) continue;
      const { content, written, gap } = emitDocumentComponent(descriptor, spec, {
        outputDir, registry, compileContext, verbose,
      });
      if (captureReports) componentText[descriptor.key] = content;
      if (written) { componentWritten[descriptor.key] = true; totalFiles++; }
      if (gap) recordGap(label, descriptor.label, spec, gap);
    }
    const hasAIN = !!componentWritten.aiInstructions;
    const hasAN = !!componentWritten.authorsNote;
    ainBlockText = captureReports ? (componentText.aiInstructions ?? null) : null;
    anBlockText = captureReports ? (componentText.authorsNote ?? null) : null;

    // Scripts
    const scriptsSpec = compileContext.componentRefs.scripts;
    if (scriptsSpec && typeof scriptsSpec === 'string') {
      copyScripts(scriptsSpec, outputDir);
    }

    if (captureReports) {
      leafData.push({
        label,
        branchPath,
        fileBase: branchPath.length ? branchPath.join(' - ') : rootDirName,
        items: renderedById,
        components: {
          plotEssentials: peDiffBlocks,
          aiInstructions: ainBlockText != null ? [{ key: 'AI Instructions', text: ainBlockText }] : [],
          authorsNote:    anBlockText  != null ? [{ key: "Author's Note",   text: anBlockText  }] : [],
        },
      });
    }

    leafSummaries.push({ label, leafItems, leafVariants, hasPE, hasAIN, hasAN });
  }

  // Write Opening / OpeningChoice files (post-loop)

  // Root-level branchFraming: non-inheriting, written at the root output dir
  const rootOpeningChoice = config.components && config.components.branchFraming != null
    ? config.components.branchFraming
    : null;
  if (rootOpeningChoice != null) {
    const hasBranches = config.branches && Object.keys(config.branches).length > 0;
    if (!hasBranches) {
      console.warn(`  WARN: root branchFraming with no branches — ignoring`);
    } else {
      const expandedChoice = typeof rootOpeningChoice === 'string'
        ? rootOpeningChoice
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
    rootOpening, config._variables || config.variables || {},
    [], verbose
  );

  writeLabelsRecursive(config.branches, config._resolvedOutput, config._variables || config.variables || {}, verbose);

  // Root Label (project-level, written once to output root alongside Description.md)
  if (config.title != null) {
    const rootLabel = resolveVariables(String(config.title), config.variables || {});
    const labelPath = path.join(config._resolvedOutput, 'Label.md');
    fs.writeFileSync(labelPath, rootLabel + '\n', 'utf8');
    if (verbose) console.log(`  OK: Label → ${labelPath}`);
  }

  // Description (project-level, written once to output root alongside Branches/)
  const descRequested = config.components && config.components.description != null;
  const descSpec = descRequested
    ? resolveComponentSpec(config.components.description, config._base, config._variables || config.variables || null)
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
      const descCfg = loadDescConfig(descSpec, config._base, config._variables || config.variables || {});
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
  console.log(`\n  ${'Branch'.padEnd(lp)} ${'Items'.padStart(5)}  ${'Var'.padStart(3)}   Open   PE  AIN   AN`);
  for (const s of leafSummaries) {
    console.log(
      `  ${s.label.padEnd(lp)} ${String(s.leafItems).padStart(5)}  ${String(s.leafVariants).padStart(3)}  ` +
      ` ${c(s.hasOpening)}  ${c(s.hasPE)} ${c(s.hasAIN)} ${c(s.hasAN)}`
    );
  }
  console.log(`\n${allCardIds.size} unique items across project. Wrote ${totalFiles} file(s).`);

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

  // Cross-branch review reports — emitted from the per-leaf data captured above.
  if (captureReports && leafData.length > 0) {
    const reportBase = config._resolvedOverview || path.join(config._resolvedOutput, 'Overview');
    const { runDiffMode, runAnnotateMode } = require('./diff');
    const reportSummary = [];
    if (options.diff) {
      const diffDir = path.join(reportBase, 'diff');
      fs.mkdirSync(diffDir, { recursive: true });
      const w = runDiffMode(leafData, diffDir);
      reportSummary.push(`${w.length} diff file(s) (Shared + deltas)`);
    }
    if (options.annotate) {
      const annotateDir = path.join(reportBase, 'annotate');
      fs.mkdirSync(annotateDir, { recursive: true });
      const w = runAnnotateMode(leafData, allCardDefs, registry, annotateDir);
      reportSummary.push(`${w.length} annotation file(s)`);
    }
    if (reportSummary.length > 0) {
      console.log(`\nWrote ${reportSummary.join(' and ')} to:\n  ${reportBase}`);
    }
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
    ['lint',       ['--lint',       '-L']],
    ['diff',       ['--diff',       '-d']],
    ['annotate',   ['--annotate',   '-a']],
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

  // --diff / --annotate need data captured during compilation (the on-disk markdown is
  // lossy), so they are compile *options* — they force a compile rather than reading the
  // output dir like the post-hoc report modes (--leafReview/--overview/--seed-map/--card-sizes).
  const doCompile    = flags.compile || flags.diff || flags.annotate ||
    (!flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes && !flags.lint);
  const doLeafReview = flags.leafReview;
  const doOverview   = flags.overview;
  const doSeedMap    = flags.seedMap;
  const doCardSizes  = flags.cardSizes;
  const doLint       = flags.lint;

  if (positional.length === 0 && !flags.compile && !flags.diff && !flags.annotate &&
      !flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes && !flags.lint) {
    console.error(
      'Usage: codex-loom [--compile|-C] [--diff|-d] [--annotate|-a] [--clean|-c] [--verbose|-v] [--leafReview|-l] [--overview|-o] [--seed-map|-s] [--card-sizes|-b] [--lint|-L] [<folder | compile.yaml>]'
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
        compile(configPath, { clean: flags.clean, verbose: flags.verbose, diff: flags.diff, annotate: flags.annotate });
      } catch (err) {
        console.error(`\nFatal: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // ── Reports (leaf-review, overview, seed-map, card-sizes, lint) ──
  if (doLeafReview || doOverview || doSeedMap || doCardSizes || doLint) {
    if (!scenarioRoot) {
      console.error('No compile.yaml in current directory and no path given.');
      process.exit(1);
    }
    if (!fs.existsSync(scenarioRoot)) {
      console.error(`Scenario root not found: ${scenarioRoot}`);
      process.exit(1);
    }

    if (flags.verbose) {
      const modeLabel = [
        doLeafReview && 'leaf-review',
        doOverview   && 'overview',
        doSeedMap    && 'seed-map',
        doCardSizes  && 'card-sizes',
        doLint       && 'lint',
      ].filter(Boolean).join(' + ');
      console.log(`\n${modeLabel} mode\nScenario root : ${scenarioRoot}\nOutput dir    : ${outputDir}\n`);
    }

    try {
      const summaryParts = [];

      if (doLeafReview) {
        const { runLeafReviewMode } = require('./overview');
        const dir = path.join(outputDir, 'leaf-review');
        fs.mkdirSync(dir, { recursive: true });
        const written = runLeafReviewMode(scenarioRoot, dir, flags.verbose);
        summaryParts.push(`${written.length} leaf review file(s)`);
      }

      if (doSeedMap) {
        const { runSeedMapMode } = require('./seedmap');
        const dir = path.join(outputDir, 'seed-map');
        fs.mkdirSync(dir, { recursive: true });
        const result = runSeedMapMode(scenarioRoot, dir, flags.verbose);
        if (result) summaryParts.push('2 seed map files');
      }

      if (doOverview) {
        const { runOverviewMode } = require('./overview');
        const dir = path.join(outputDir, 'overview');
        fs.mkdirSync(dir, { recursive: true });
        runOverviewMode(scenarioRoot, dir, flags.verbose);
        summaryParts.push('an overview file');
      }

      if (doCardSizes) {
        const { runBodySizeMode } = require('./bodysize');
        const dir = path.join(outputDir, 'card-sizes');
        fs.mkdirSync(dir, { recursive: true });
        const result = runBodySizeMode(scenarioRoot, dir, flags.verbose);
        if (result) summaryParts.push('a item sizes file');
      }

      if (doLint) {
        const { runLintMode } = require('./lint');
        const dir = path.join(outputDir, 'lint');
        fs.mkdirSync(dir, { recursive: true });
        const result = runLintMode(scenarioRoot, dir, flags.verbose);
        if (result) summaryParts.push(`a lint report (${result.errorCount} error(s), ${result.warnCount} warning(s))`);
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
