#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadItemsFromDir, loadTemplates, loadCompileConfig,
  buildRegistry, mergeRegistries, loadYaml,
} = require('./loader');
const {
  resolveItem, enumerateLeaves, walkBranchChain, walkBranchTree, mergePlaceholders,
  resolveBranchSpec, collectVariantDeltas, localRoleKeysOf,
} = require('./resolver');
const { resolvePlacements } = require('./model/item');
const { slotsForBranch } = require('./model/component');
const { loadComponentDocument } = require('./loader/component');
const { applyPronounPasses, applyCrossItemRefs } = require('./model/pronouns');
const { render, applyFieldInterpolation, applyVariableInterpolation, applyFieldRenderFunctions } = require('./template');
const { resolveVariables, checkUnexpandedVariables, checkUnresolvedFieldTokens, checkMechanicalArtifacts, itemContext, CONFIG_BASENAMES, normalizeVarKey } = require('./util');
const { expandTokens } = require('./tokens');
const { resolveIncludes, buildCanonRegistry } = require('./loader/registry');
const { Diagnostics, busWarner, severityOf, CODES: DIAG_CODES, LINT_LEVELS } = require('./diag');
const { renderCard, cardTitle } = require('./emit/vl');
const {
  FILENAME: PLACEHOLDERS_FILENAME, writeNodePlaceholders, checkUndeclaredPlaceholders,
  checkPlaceholderContext, reportUnusedPlaceholders, reportDuplicateQuestions, localKeysOf,
  expandQuestions,
} = require('./emit/placeholders');
const { LIMITS, checkLimit } = require('./limits');
const {
  SLOTTED_COMPONENTS, DESCRIPTION_DESCRIPTOR, FRAMING_DESCRIPTOR, isPassthrough, readPassthrough,
  renderSectionedComponent, writeSectionedComponent,
} = require('./emit/components');
const { syncLibrary, checkDrift } = require('./snapshot');
const { CODES: LOAD_CODES, isOutOfBase, normalize } = require('./config/load');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Characters illegal in a Windows/Unix path segment (mirrors overview.js sanitizeFilename
// plus control chars). aid.type becomes both a folder and a filename, so it must be safe.
const INVALID_TYPE_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

/**
 * Validate an item's aid.type after variable expansion. aid.type is written to disk
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

/** The suffix that makes a template the notes companion of another (§4.5, rung 2). */
const NOTES_SUFFIX = '.notes';

/** Codes this module reports. CL04xx is the render/template band (§4.4). */
const CODES = {
  NOTES_TEMPLATE_NOT_FOUND: 'CL0411',
  ITEM_NOTES_TEMPLATE_NOT_FOUND: 'CL0412',
};

/**
 * Check every `render.notesTemplate` declared in compile.yaml against the loaded set.
 *
 * At load rather than at render, because this one is a closed set — the root node and
 * every branch node, all known before a single card is compiled. Left to render time it
 * would report once per item per leaf, which for a project like The Institute means the
 * same typo printed thousands of times.
 */
function checkConfigNotesTemplates(config, templates, diagnostics, configPath) {
  if (!diagnostics) return;

  const check = (node, where) => {
    const name = node && node.render && node.render.notesTemplate;
    if (!name || templates.has(String(name).toLowerCase())) return;
    diagnostics.error(
      CODES.NOTES_TEMPLATE_NOT_FOUND,
      `${where} declares render.notesTemplate "${name}", which is not a loaded template.`,
      { file: configPath },
      { hint: 'Add a matching .template file, or remove the key to fall back to rendering '
        + 'the notes value itself. Use `notesTemplate: ~` to turn notes off for a branch.' },
    );
  };

  check(config, 'The project');
  const walk = (branches, prefix) => {
    if (!branches || typeof branches !== 'object') return;
    for (const [name, node] of Object.entries(branches)) {
      const label = prefix ? `${prefix}/${name}` : name;
      check(node, `Branch "${label}"`);
      if (node && node.branches) walk(node.branches, label);
    }
  };
  walk(config.branches, '');
}

/**
 * Which template renders this item's `notes:`, as a name — or null for §4.5's default.
 *
 * Four rungs, most specific first:
 *
 *   1. `render.notesTemplate` on the item.
 *   2. `<body template>.notes`, when such a template is loaded. The name is the one that
 *      actually resolved the body rather than `aid.type` or `render.template` picked in
 *      advance, so an item that overrides its body template cannot end up with its notes
 *      rendered by a different family. This is the mechanism `Character.hint` already
 *      uses — a suffixed sibling, resolved by filename.
 *   3. The branch's merged `render.notesTemplate` from compile.yaml. It lives on the
 *      branch node because which mods a branch loads is what decides whether a marker
 *      means anything there; `notesTemplate: ~` on a branch turns the control off for
 *      every card in it without touching an item.
 *   4. Nothing — §4.5 renders the notes value itself (scalar verbatim, mapping as
 *      `key: value` lines).
 */
function resolveNotesTemplateName(item, templates, projectNotesTemplate) {
  const explicit = item.render && item.render.notesTemplate;
  if (explicit) return String(explicit);

  const bodyName = getTemplateName(item, templates);
  if (bodyName && templates.has(`${bodyName.toLowerCase()}${NOTES_SUFFIX}`)) {
    return `${bodyName}${NOTES_SUFFIX}`;
  }

  return projectNotesTemplate ? String(projectNotesTemplate) : null;
}

/**
 * Render `notes:` through the resolved notes template, or return undefined (§4.5).
 *
 * Undefined rather than an empty string, because the two mean different things to the
 * emitter: undefined leaves §4.5's default rule in force (scalar verbatim, mapping as
 * `key: value` lines), while an empty string is a template that deliberately produced
 * nothing and suppresses the `notes:` line entirely. That is what lets one shared
 * template carry a whole convention: `{if $notes.known}[e]{/if}` writes nothing at all
 * for an item that never set the flag, so opting out needs no syntax.
 *
 * The wrapper is forced off for this render. `render.wrapper` describes the card body;
 * a notes template that did not spell out a {wrapper} block would otherwise be wrapped
 * by the post-render fallback and emit `notes: '{...}'`.
 */
function renderNotesText(item, context, templates, partials, variables, projectNotesTemplate, diagnostics) {
  const name = resolveNotesTemplateName(item, templates, projectNotesTemplate);
  if (!name) return undefined;
  const template = templates.get(name.toLowerCase());
  if (!template) {
    // Only rung 1 reaches here: rung 2 is existence-checked and rung 3 is validated at
    // load, so the name came from the item and naming the item is what helps.
    const label = item.id || (typeof item.name === 'string' ? item.name : String(item.name));
    if (diagnostics) {
      diagnostics.error(
        CODES.ITEM_NOTES_TEMPLATE_NOT_FOUND,
        `item "${label}" declares render.notesTemplate "${name}", which is not a loaded template.`,
        { file: item._source },
      );
    }
    return undefined;
  }
  const notesContext = { ...context, render: { ...context.render, wrapper: 'none' } };
  return render(template.content, notesContext, partials, variables, { diagnostics, file: template._source, name });
}

/**
 * The name of the template that renders this item's body: render.template, then aid.type.
 *
 * Returns the name rather than the content because the notes ladder appends a suffix to
 * it, and it must be the same answer `getTemplate` reached rather than a second guess.
 */
function getTemplateName(item, templates) {
  const keys = [
    item.render && item.render.template,
    item.aid && item.aid.type,
  ].filter(Boolean);
  for (const key of keys) {
    if (templates.has(key.toLowerCase())) return key;
  }
  return null;
}

/**
 * Get the template entry for an item. Checks render.template first, then aid.type.
 *
 * Returns the `{content, _source}` entry rather than the content string alone (Phase 9
 * Step 0) — `_source` is what lets a render-time diagnostic name the template file instead
 * of reporting a parse or eval failure with nowhere to point.
 */
function getTemplate(item, templates) {
  const name = getTemplateName(item, templates);
  return name ? templates.get(name.toLowerCase()) : null;
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
 * exists, and otherwise the literal string — `opening:` and `branchFraming:` are often a
 * sentence rather than a path, and that fallback is what lets one key carry both.
 *
 * **The literal arm returns the *expanded* string, not the raw one.** An inline spec is
 * content, and content has its variables expanded like any other text — returning the raw
 * spec left `opening: 'You wake in {%place}.'` carrying a live token past this point, where
 * the caller's unresolved-reference check reads any surviving `{` as a path that failed to
 * expand and records a component gap. A token that genuinely does not resolve still survives
 * `expandTokens` and still reaches that check, so the reporting is unchanged for the case it
 * was written for.
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
  return resolved;
}

/**
 * Build the CompileContext for a given branch path.
 * Merges variables, components and render defaults from root → branch chain.
 */
function buildCompileContext(config, branchPath, options = {}) {
  const chain = walkBranchChain(config.branches, branchPath, {
    rootPlaceholders: config.placeholders,
    // Seeded here rather than merged afterward: `~` deletes a key from `chain.variables`
    // directly (Decision 1), and re-merging the root table on top after the fact — the old
    // shape — would silently put a deleted root key right back.
    rootVariables: config._variables || config.variables || {},
    rootRoles: config.roles || {},
    onWarn: options.onWarn || null,
  });
  const variables = chain.variables;
  // `null` when no node in the chain ever declared `roles:`, distinct from an object that
  // merged down to no live bindings — a branch that unbinds its only inherited role is
  // still role-aware territory for CL0540's gating (`model/pronouns.js`), not the same as a
  // project that never mentioned roles at all.
  const roles = chain.rolesDeclared ? chain.roles : null;
  const components = Object.assign({}, config.components || {}, chain.components);
  const render = Object.assign({}, config.render || {}, chain.render);

  // `scripts:` is top-level as of §6.3: it is a file copy, not a rendered document, and
  // it was the one row in the component table that shared none of the row's behavior. It
  // still merges down the branch chain like everything else, so it is folded back in
  // here rather than resolved separately.
  const scripts = chain.scripts !== undefined ? chain.scripts : config.scripts;
  if (scripts !== undefined) components.scripts = scripts;

  // Resolve component specs to file paths
  // `adventureDescription` merges down the chain like the other sectioned components, which
  // is what makes §7.7's per-node description an ordinary row rather than a second writer:
  // a value declared at an interior node reaches the leaves beneath it here. `description`
  // is resolved here too — it is read at the root rather than per branch, but the migrator
  // and the root write both want the same expansion the other components get.
  const componentTypes = [
    'aiInstructions', 'opening', 'branchFraming', 'plotEssential', 'summary', 'authorsNote',
    'description', 'adventureDescription', 'scripts',
  ];
  const componentRefs = {};
  for (const type of componentTypes) {
    const spec = components[type] !== undefined ? components[type] : null;
    componentRefs[type] = resolveComponentSpec(spec, config._base, variables);
  }

  // The branch-merged placeholder table (§12.2). Sits beside `variables` because it is the
  // same kind of thing — a per-branch mapping every check and the emitter read — and
  // because §12.3's question text expands against `variables`, so the two are always
  // wanted together.
  return {
    variables, componentRefs, render, placeholders: chain.placeholders, roles,
  };
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
  for (const file of ['Label.md', PLACEHOLDERS_FILENAME]) {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) fs.rmSync(target);
  }
}

/**
 * Every branch *node* dir on disk beneath a `Branches/` container, deepest first.
 *
 * Was `findLeafDirsOnDisk`, which stopped at leaves. An interior node is a node: it owns
 * a `Label.md` and, since Phase 4, a `Placeholders.yaml`, and Velvet Lattice reads both
 * and inherits them down the subtree. A sweep that only sees leaves cannot clean an
 * interior node and cannot tell that one has gone stale.
 *
 * Deepest first so a caller removing empty directories meets a child before its parent.
 */
function findNodeDirsOnDisk(dir) {
  if (!fs.existsSync(dir)) return [];
  const nodes = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    nodes.push(...findNodeDirsOnDisk(path.join(child, 'Branches')));
    nodes.push(child);
  }
  return nodes;
}

/**
 * Every node dir from `leafDir` up to and including `baseOutput`.
 *
 * The `Branches` containers between them are skipped: they hold nodes and are not nodes,
 * so they carry no `Label.md` and nothing to clean.
 */
function nodeDirsUpTo(leafDir, baseOutput) {
  const chain = [];
  let current = path.resolve(leafDir);
  const stop = path.resolve(baseOutput);
  while (current.length >= stop.length) {
    if (path.basename(current) !== 'Branches') chain.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

function isDirEmpty(dir) {
  if (!fs.existsSync(dir)) return true;
  return fs.readdirSync(dir).length === 0;
}

/**
 * Pre-build clean: wipe output-type folders from every active branch node, then detect
 * and archive (or delete) any stale node on disk.
 *
 * **Nodes, not leaves.** This swept only leaf directories until Phase 4 raised it: a
 * declaration deleted from an interior node — its `Placeholders.yaml`, or the `Label.md`
 * that has the same shape and predates placeholders — survived in the output tree, and
 * Velvet Lattice went on reading it and inheriting it down the subtree. The compiler
 * rewrites what it emits, so only a key that stopped being emitted was affected, which is
 * exactly the edit an author makes when they mean to remove one.
 *
 * The root is a node too, and had the same hole: it was added to the expected set only
 * for a project with no branches at all, so a branched project's root `Label.md` and
 * `Placeholders.yaml` were never swept either.
 *
 * Ancestors of an expected leaf are expected, which gives the stale pass an invariant it
 * needs: a stale node can never contain a live descendant, so archiving one whole is safe.
 */
function cleanAndArchive(config, leaves) {
  const baseOutput = config._resolvedOutput;

  const expectedDirs = new Set();
  for (const branchPath of leaves) {
    const folderPath = resolveBranchFolderPath(config.branches, branchPath);
    const leafDir = buildBranchOutputDir(baseOutput, folderPath);
    for (const dir of nodeDirsUpTo(leafDir, baseOutput)) expectedDirs.add(dir);
  }
  expectedDirs.add(path.resolve(baseOutput));

  for (const dir of expectedDirs) {
    cleanBranchOutputDir(dir);
    console.log(`  Cleaned: ${path.relative(baseOutput, dir) || '(root)'}`);
  }

  const branchesRoot = path.join(baseOutput, 'Branches');
  const diskNodes = findNodeDirsOnDisk(branchesRoot);
  const stale = diskNodes.filter(d => !expectedDirs.has(path.resolve(d)));
  if (stale.length === 0) return;

  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  const archiveBase = path.join(baseOutput, 'Archive', ts);

  for (const staleDir of stale) {
    cleanBranchOutputDir(staleDir);
    // `stale` is deepest first, so a stale node's own stale children have already been
    // dealt with by the time it is reached — leaving behind an empty `Branches` container
    // that would otherwise read as content and get the node archived as a hollow shell.
    const container = path.join(staleDir, 'Branches');
    if (fs.existsSync(container) && isDirEmpty(container)) fs.rmSync(container, { recursive: true });
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
 * Build a library dependency manifest for the output JSON file.
 */
function buildLibraryManifest(config) {
  const { findFiles } = require('./loader');
  const manifest = {};
  for (const [name, resolvedPath] of config._resolvedLibrary) {
    const expression = config._libraryRaw ? String(config._libraryRaw[name] ?? resolvedPath) : resolvedPath;
    const missing = !fs.existsSync(resolvedPath);
    const files = missing ? [] : findFiles(resolvedPath, '.yaml');
    manifest[name] = { expression, resolvedPath, files, ...(missing ? { missing: true } : {}) };
  }
  return manifest;
}

/**
 * CL0326 for an include's `branches:` — the other half of the arity-N guard (§7.6.2a).
 *
 * **Per branch, because a branch dispatch has no answer without a branch path.** The
 * `importVariants:` half of this check runs once per compile inside `resolveIncludes`,
 * which is where a selector that does not depend on the branch belongs. These two
 * placements are not an inconsistency: they are the two axes §7.6.2a separates the keys
 * on — `importVariants:` selects from the imported source unconditionally, `branches:`
 * dispatches, and each is asked wherever its answer exists.
 *
 * A stamped spec is identical across every item from one include, so it resolves once per
 * group rather than once per item. Matching follows the same rule the other half uses: a
 * non-empty delta list or a `null` exclusion both count, and a partial path counts on the
 * segment that resolved.
 */
function reportUnmatchedIncludeDispatch(allItemDefs, branchPath, diagnostics) {
  const groups = new Map(); // included file → the items it contributed
  for (const def of allItemDefs) {
    if (!def._include_branch_spec) continue;
    const key = def._source || '(unknown)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(def);
  }

  for (const [source, items] of groups) {
    const names = resolveBranchSpec(items[0]._include_branch_spec, branchPath);
    if (names === null) continue; // the whole include is excluded from this branch
    for (const name of names) {
      const matched = items.filter((def) => {
        const deltas = collectVariantDeltas(def, name, null);
        return deltas === null || deltas.length > 0;
      }).length;
      if (matched > 0) continue;
      diagnostics.warn(
        DIAG_CODES.SELECTOR_MATCHED_NOTHING,
        `branch dispatch to variant "${name}" on branch "${branchPath.join('/') || '(root)'}" `
        + `matched none of the ${items.length} items included from ${path.basename(source)}. `
        + 'A dispatch stamped onto every item in a file is silent where an item does not '
        + 'define the name (§7.6.2a), so a misspelling applies to nothing and changes '
        + 'nothing — this is the only report it produces.',
        { file: source },
      );
    }
  }
}

/**
 * Compile story cards for a single branch leaf.
 * Returns array of resolved items (after Phase A), in place for Phase B caller.
 *
 * Phase A: resolve + field interpolation
 * Phase B (caller): cross-item refs + pronouns + render
 *
 * ── Why the duplicate-id check is here and not in the registry ──────────────
 *
 * `buildRegistry` throws on two defs claiming one id, but it never sees the whole
 * question: a bare `import:` def claims no id of its own — it *is* the item it names
 * (§17.4) — so it is filtered out before the registry's check runs. Two of them naming
 * one canon item, or a bare import alongside an explicit def of the same id, therefore
 * pass load and meet for the first time here, as two resolved items with one id. What
 * reaches AID is two entries in one Plot Essentials slot and two story cards sharing a
 * name and a trigger list, from a compile that reported nothing.
 *
 * **Per branch, because the answer is per branch.** `resolveItem` returns null for a def
 * the branch spec excludes, so two defs sharing an id collide only on the branches where
 * both survive dispatch — dispatching one of a pair away is the documented way to write
 * mutually exclusive versions of an item. Asking once over the def list would report
 * that legitimate pattern as an error.
 */
function resolveBranchItems(allItemDefs, registry, branchPath, variables, diagnostics = new Diagnostics()) {
  const resolvedItems = [];
  const claimedBy = new Map(); // lowercased resolved id → the source file that claimed it

  reportUnmatchedIncludeDispatch(allItemDefs, branchPath, diagnostics);

  for (const itemDef of allItemDefs) {
    let item;
    try {
      item = resolveItem(itemDef, registry, branchPath, busWarner(diagnostics, { file: itemDef._source }));
    } catch (err) {
      const label = itemDef.id || itemDef.import || itemDef.name || '?';
      diagnostics.error(
        DIAG_CODES.ITEM_RESOLUTION_FAILED,
        `item "${label}" could not be resolved: ${err.message}`,
        { file: itemDef._source },
      );
      continue;
    }

    if (!item) continue; // excluded by branch spec

    const claimKey = String(item.id || '').toLowerCase();
    if (claimKey) {
      if (claimedBy.has(claimKey)) {
        // The other def's *basename* only, and only when it differs. `loc.file` already
        // carries this def's position, and an absolute path in a message body escapes
        // every normalization a report or a snapshot applies to `file`.
        const rival = claimedBy.get(claimKey);
        const here = itemDef._source ? path.basename(itemDef._source) : null;
        const elsewhere = rival && rival !== here ? ` (the first is in ${rival})` : '';
        diagnostics.error(
          DIAG_CODES.DUPLICATE_RESOLVED_ID,
          `two item definitions resolve to id "${claimKey}" on this branch${elsewhere}.`,
          { file: itemDef._source },
          {
            hint: 'A def carrying `import:` with no `id:` of its own claims the id of the item '
              + 'it imports, so two of them — or one alongside an explicit def of that id — emit '
              + 'the same item twice. Give one of them its own `id:` to make it a copy (§17.4), '
              + 'or dispatch them to different branches.',
          },
        );
      } else {
        claimedBy.set(claimKey, itemDef._source ? path.basename(itemDef._source) : null);
      }
    }

    applyFieldInterpolation(item);
    applyVariableInterpolation(item, variables);
    resolvedItems.push(item);
  }

  return resolvedItems;
}

/**
 * Render one item body for one component target (§7.4).
 *
 * The wrapper is forced off: the slot owns the wrapping of everything placed in it, and
 * `emit/components.js` applies it once the occupants are in hand. Leaving the item's own
 * `render.wrapper` in the context is what would ship an item double-braced inside a slot
 * of the same wrapper — the bug §8.4 exists to eliminate, and the reason `render.wrapper`
 * governs story-card output alone.
 *
 * Returns null and reports when the target's template ladder runs out with nothing to
 * render, which is the one case the ladder's verbatim rung cannot cover: no template and
 * no text is not a pass-through, it is an item that has nothing to say.
 */
function renderPlacementBody(item, target, templates, partials, variables, diagnostics) {
  const template = target.template ? templates.get(String(target.template).toLowerCase()) : null;
  const context = itemContext(item, { render: { ...(item.render || {}), wrapper: 'none' } });
  const label = item.id || (typeof item.name === 'string' ? item.name : String(item.name));

  if (template) {
    try {
      return render(template.content, context, partials, variables, { diagnostics, file: template._source, name: target.template });
    } catch (err) {
      diagnostics.error(
        DIAG_CODES.RENDER_FAILED,
        `item "${label}" failed to render into ${target.component}: ${err.message}`,
        { file: item._source },
      );
      return null;
    }
  }

  // Verbatim pass-through — the last rung of §7.4's ladder.
  const raw = item.body && (item.body.text !== undefined ? item.body.text : item.body.content);
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    return resolveVariables(String(raw).trim(), variables);
  }

  diagnostics.error(
    DIAG_CODES.TEMPLATE_NOT_FOUND,
    `no template found for item "${label}" rendering into ${target.component}`
    + `${target.slot ? ` slot "${target.slot}"` : ''} (template: ${target.template || 'none'})`,
    { file: item._source },
  );
  return null;
}

/**
 * Resolve every sectioned component declared for this leaf, ahead of the items.
 *
 * Returns one entry per component that loaded, in `SLOTTED_COMPONENTS` order. A component
 * that cannot be found is recorded as a gap and omitted — the gap report already says a
 * requested component produced no file, and adding a placement ERROR for every item that
 * named one of its slots would bury that one fact under a per-item pile.
 */
function resolveSectionedComponents(compileContext, label, { loadSectioned, recordGap }) {
  const resolved = [];
  for (const descriptor of SLOTTED_COMPONENTS) {
    const spec = compileContext.componentRefs[descriptor.key];
    if (!spec) continue;
    if (typeof spec === 'string' && spec.includes('{')) {
      recordGap(label, descriptor.label, spec, 'unresolved reference — token did not expand to a path');
      continue;
    }

    // An opening is routinely a sentence rather than a path — `opening: "Who are you?"` —
    // and `resolveComponentSpec` hands back the raw string when nothing on disk matches.
    // Only the rows that declare `inlineProse` take that reading: for every other component
    // a spec naming no file is a broken path, and treating it as content would write the
    // path into the output instead of reporting it.
    if (descriptor.inlineProse && !(typeof spec === 'string' && fs.existsSync(spec))) {
      // Already variable-expanded by `resolveComponentSpec`; only trimmed here.
      const text = String(spec).trimEnd();
      if (!text) {
        recordGap(label, descriptor.label, spec, 'inline text is empty');
        continue;
      }
      resolved.push({ descriptor, spec, component: null, passthrough: text });
      continue;
    }

    // Prose copied verbatim, not a document to compile. It declares no sections and so no
    // slots, which is a fact the slot index needs — an item targeting a slot in a `.md`
    // component would otherwise be dropped in silence.
    if (isPassthrough(spec)) {
      if (!fs.existsSync(spec)) {
        recordGap(label, descriptor.label, spec, 'source not found');
        continue;
      }
      const text = readPassthrough(spec);
      if (text === null) {
        recordGap(label, descriptor.label, spec, 'source is empty');
        continue;
      }
      resolved.push({ descriptor, spec, component: null, passthrough: text });
      continue;
    }

    const component = loadSectioned(spec, descriptor);
    if (!component) {
      recordGap(label, descriptor.label, spec, 'source declared no sections (missing or empty file)');
      continue;
    }
    resolved.push({ descriptor, spec, component, passthrough: null });
  }
  return resolved;
}

/**
 * What a render target on this branch is allowed to name.
 *
 * Three sets, because §7.4 asks three different questions of a target's `slot:` and gives
 * three different answers. `slots` is what this branch will actually place into.
 * `documentSlots` is every slot the document declares, branch gating ignored — a slot
 * gated off on this branch is correctly spelled and must not be reported as a typo, which
 * is the whole content of §7.4's third and fifth rows. `sections` is every name in the
 * document, so naming a text section can be told apart from naming nothing at all. All
 * three are keyed lowercased, matching how `renderSectionedComponent` looks occupants up.
 *
 * A component key absent from this index is one that failed to load. Targets naming it are
 * left alone: the gap report owns that failure.
 */
function buildSlotIndex(sectionedForLeaf, branchPath) {
  const index = new Map();
  for (const { descriptor, component, passthrough } of sectionedForLeaf) {
    if (passthrough !== null && passthrough !== undefined) {
      index.set(descriptor.key, {
        slots: new Map(), documentSlots: new Set(), sections: new Set(),
        label: descriptor.label, passthrough: true,
      });
      continue;
    }
    const slots = new Map();
    for (const [name, section] of slotsForBranch(component, branchPath)) {
      slots.set(name.toLowerCase(), section);
    }
    const documentSlots = new Set(
      component.sections.filter((s) => s.isSlot).map((s) => s.name.toLowerCase()),
    );
    const sections = new Set(component.sections.map((s) => s.name.toLowerCase()));
    index.set(descriptor.key, {
      slots, documentSlots, sections, label: descriptor.label, passthrough: false,
    });
  }
  return index;
}

/**
 * Check one render target against the branch's slot set (§7.4).
 *
 * Returns true when the target may be placed. The three refusals are all ERRORs and all
 * name the item, because each is a typo class that otherwise ends as silence: v3 filed an
 * occupant under a slot key no section matched and dropped it, which made a misspelled
 * `slot:` and a deliberately excluded item indistinguishable in the output.
 *
 * A slot the component declares but this branch gates off is *not* one of them — §7.4's
 * third and fifth rows keep component-level gating legitimate, and the consequence of
 * gating it away is caught by the no-output invariant instead.
 */
function checkTargetSlot(target, itemId, slotIndex, label, diagnostics, file) {
  const known = slotIndex.get(target.component);
  if (!known) return true;

  if (known.passthrough) {
    diagnostics.error(
      DIAG_CODES.TARGET_UNDECLARED_SLOT,
      `item "${itemId}" targets slot "${target.slot || '(unnamed)'}" in ${known.label}, which is `
      + 'prose copied verbatim and declares no slots. Point the component at a YAML '
      + 'document with "sections:" to route items into it.',
      { file },
    );
    return false;
  }

  if (!target.slot) {
    diagnostics.error(
      DIAG_CODES.TARGET_NAMES_NO_SLOT,
      `item "${itemId}" renders into ${known.label} without naming a slot — `
      + `add "slot:" naming one of: ${[...known.documentSlots].join(', ') || '(the component declares none)'}.`,
      { file },
    );
    return false;
  }

  const key = target.slot.toLowerCase();
  // Active on this branch, or declared and gated off on it. The second places nothing and
  // says nothing — the name is right, and whether losing the placement matters is the
  // no-output invariant's question rather than this one's.
  if (known.documentSlots.has(key)) return true;

  if (known.sections.has(key)) {
    diagnostics.error(
      DIAG_CODES.TARGET_NOT_A_SLOT,
      `item "${itemId}" targets "${target.slot}" in ${known.label}, which is a section but `
      + 'not a slot — only a section declaring "slot: true" can hold items.',
      { file },
    );
    return false;
  }

  diagnostics.error(
    DIAG_CODES.TARGET_UNDECLARED_SLOT,
    `item "${itemId}" targets slot "${target.slot}" in ${known.label} on branch "${label}", `
    + `which declares no such slot. Declared here: ${[...known.documentSlots].join(', ') || '(none)'}.`,
    { file },
  );
  return false;
}

/**
 * A declared slot that no item filled on this branch (§7.4) — a WARN, not an error.
 *
 * An empty cast is a legitimate branch. The warning exists because an empty slot and a
 * slot whose occupants all mis-typed their `slot:` look identical in the output file, and
 * the second is worth a line on the way past.
 */
function warnEmptySlots(descriptor, slotIndex, filled, label, diagnostics, file) {
  const known = slotIndex.get(descriptor.key);
  if (!known) return;
  for (const name of known.slots.keys()) {
    const placed = filled.get(name);
    if (placed && placed.length > 0) continue;
    // Located at the component that declared the slot, not at the item that failed to
    // fill it — there is no such item, which is the whole finding. §4.4's "every
    // diagnostic names a file" otherwise has one exception, and an author reading
    // "slot X has no items" with no path has to guess which component declared X.
    diagnostics.warn(
      DIAG_CODES.SLOT_EMPTY,
      `slot "${name}" in ${known.label} has no items on branch "${label}".`,
      { file: file == null ? undefined : String(file) },
    );
  }
}

/**
 * Phase B: apply cross-item refs, pronouns, render, and write output.
 *
 * Returns `{ written, occupants }` — the story-card files, and the component slots those
 * same items routed into. One traversal produces both, which is the §7.2 inversion in its
 * smallest form: v3 ran this loop for story cards and a second resolver in `pe.js` for
 * component content, then reconciled them through a suppression side channel. There is
 * nothing to reconcile when one pass over one resolved item decides both.
 */

/**
 * The placeholder table as Velvet Lattice will hold it at this node, for §8.5's caps.
 *
 * VL substitutes `%key%` with the *question*, so measuring the stored length needs the
 * questions and needs them already nested — which is what `expandQuestions` produces and
 * what `Placeholders.yaml` therefore contains (§12.2). Expanding the merged table here
 * gives the same values a leaf's inherited chain of those files would.
 *
 * Deliberately given no `onWarn`: `writePlaceholdersRecursive` runs the same expansion
 * with the bus attached, so passing one here would report every cycle and every undeclared
 * nested reference a second time. This call wants the strings, not the findings.
 */
function questionsForMeasurement(table, variables) {
  if (!table || Object.keys(table).length === 0) return null;
  return expandQuestions(table, variables);
}

/**
 * `CL0545`: a role declared and never referenced by a resolved token anywhere in the
 * compile (§9.2's WARN half — `resolveRole` in `model/pronouns.js` calls `onRoleUsed` only
 * on success, so `roleUsage` names every role that actually did something).
 *
 * Whole-compile rather than `CL0535`'s subtree-scoped check, deliberately simpler: no
 * golden declares a role yet, so there is no corpus case where a role is legitimately used
 * on one branch and unused on a sibling that this coarser check would miss.
 */
function reportUnusedRoles(declarations, usage, { diagnostics, file } = {}) {
  if (!diagnostics) return [];
  const unused = [];
  for (const { label, keys } of declarations) {
    for (const key of keys) {
      if (usage.has(key.toLowerCase())) continue;
      unused.push(key);
      diagnostics.warn(
        DIAG_CODES.ROLE_UNUSED,
        `role "${key}" is declared ${label} but no resolved token anywhere references it.`,
        { file: file == null ? undefined : String(file) },
      );
    }
  }
  return unused;
}

/**
 * The fixed keys `itemContext` (`util.js`) attaches to every item's render context. A render
 * function's first path segment matching one of these resolves against the *current* item —
 * `resolveField`'s (`render/eval.js`) itemMap pivot only fires when the segment matches
 * neither this set nor the current item, so the dependency graph below must exclude them the
 * same way or it would draw an edge for every plain `$body.x` reference.
 */
const ITEM_CONTEXT_KEYS = new Set(['id', 'name', 'pronouns', 'aid', 'render', 'body', 'v', 'notes']);

/** The render-function call syntax `processFieldRenderFunctions` (`template.js`) dispatches on. */
const RENDER_FN_PREFIXES = ['inline(', 'join(', 'list(', 'and(', 'prose(', 'block(', 'keys('];

/**
 * Scan one item's body for cross-item render-function references (Phase 9 Step 2).
 *
 * An edge exists only when a render function's *first* path segment names another item —
 * exactly the case `resolveField`'s itemMap pivot resolves — so this scan has to mirror that
 * pivot's rule precisely rather than approximate it, or the graph would draw edges the
 * evaluator never actually chases (or miss ones it does). Plain `{$Other.body.X}` field
 * substitutions are `applyCrossItemRefs`'s pass, a different token family already resolved
 * before this runs, and are not scanned here.
 *
 * Returns `[{ target, field }]` — `target` the referenced item's lowercase id, `field` the
 * dotted body path the reference was found in, for `CL0418`'s message.
 */
function scanCrossItemRefs(body, resolvedById, selfId) {
  const refs = [];
  const scanString = (str, fieldPath) => {
    str.replace(/\{([^{}]+)\}/g, (match, inner) => {
      inner = inner.trim();
      if (!RENDER_FN_PREFIXES.some((prefix) => inner.startsWith(prefix))) return match;
      const tokens = inner.match(/\$[A-Za-z0-9_-]+/g) || [];
      for (const token of tokens) {
        const first = normalizeVarKey(token.slice(1)).toLowerCase();
        if (ITEM_CONTEXT_KEYS.has(first)) continue;
        if (first === selfId) continue;
        if (!resolvedById.has(first)) continue;
        refs.push({ target: first, field: fieldPath });
      }
      return match;
    });
  };
  const walk = (obj, fieldPath) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const nextPath = fieldPath ? `${fieldPath}.${key}` : key;
      if (typeof val === 'string') {
        scanString(val, nextPath);
      } else if (Array.isArray(val)) {
        for (const entry of val) {
          if (typeof entry === 'string') scanString(entry, nextPath);
        }
      } else if (typeof val === 'object' && val !== null) {
        walk(val, nextPath);
      }
    }
  };
  walk(body, '');
  return refs;
}

/**
 * Tarjan's SCC over the cross-item dependency graph. Returns only the multi-node groups —
 * every genuine cycle — because a single-node SCC is acyclic by construction once self-loops
 * are excluded from the graph (Decision 3's Unknowns: self-reference is tolerated, not a
 * cycle, and `scanCrossItemRefs` never records one).
 */
function findCycles(graph) {
  let counter = 0;
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const groups = [];

  const strongconnect = (v) => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) || []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const group = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) groups.push(group);
    }
  };

  for (const v of graph.keys()) {
    if (!index.has(v)) strongconnect(v);
  }
  return groups;
}

/**
 * Post-order DFS topological order: a dependency is pushed onto `order` before the item that
 * depends on it, because it is fully visited (recursed into) first. Safe to run on a graph
 * that contains cycles — a node already on the current stack (`state === 1`) is skipped
 * rather than re-entered, so every node still resolves to exactly one position in `order`.
 * The caller excludes cyclic nodes from evaluation; their position in this order is otherwise
 * unused.
 */
function topoOrder(graph) {
  const state = new Map();
  const order = [];
  const visit = (node) => {
    if (state.has(node)) return;
    state.set(node, 1);
    for (const dep of graph.get(node) || []) {
      visit(dep);
    }
    state.set(node, 2);
    order.push(node);
  };
  for (const node of graph.keys()) visit(node);
  return order;
}

/** `CL0418`, naming every item and field on the cycle's edges rather than the uncoded warning it replaces. */
function reportCycle(group, edgeFields, resolvedById, diagnostics) {
  if (!diagnostics) return;
  const groupSet = new Set(group);
  const parts = [];
  for (const from of group) {
    for (const to of groupSet) {
      const key = `${from}->${to}`;
      const fields = edgeFields.get(key);
      if (!fields) continue;
      const fromItem = resolvedById.get(from);
      const toItem = resolvedById.get(to);
      for (const field of fields) {
        parts.push(`"${fromItem.id}".${field} → "${toItem.id}"`);
      }
    }
  }
  diagnostics.error(
    DIAG_CODES.CROSS_ITEM_CYCLE,
    `Circular cross-item render dependency: ${parts.join(', ')}`,
  );
}

/**
 * Dependency-ordered cross-item render-function resolution (v4 spec §13, Phase 9 Step 2).
 *
 * Replaces the fixpoint loop that iterated to convergence: build the dependency graph the
 * corpus's cross-item render functions imply, evaluate it in one topological pass, and report
 * a genuine cycle by name instead of an uncoded warning after N passes.
 *
 * A render function that migrates from item `B` into item `A` is evaluated in `B`'s context —
 * where the author wrote it — because `B` is resolved (and its body mutated in place) before
 * `A` ever reads it. This is Decision 3's divergence, and the one place in the phase whose
 * compiled output may legitimately move.
 */
function resolveCrossItemRenderFunctions(resolvedItems, resolvedById, diagnostics) {
  const graph = new Map();
  const edgeFields = new Map();

  for (const item of resolvedItems) {
    const idLower = (item.id || '').toLowerCase();
    if (!idLower) continue;
    const deps = graph.get(idLower) || new Set();
    graph.set(idLower, deps);
    if (!item.body) continue;
    for (const { target, field } of scanCrossItemRefs(item.body, resolvedById, idLower)) {
      deps.add(target);
      const key = `${idLower}->${target}`;
      if (!edgeFields.has(key)) edgeFields.set(key, new Set());
      edgeFields.get(key).add(field);
    }
  }

  const cyclic = new Set();
  for (const group of findCycles(graph)) {
    for (const id of group) cyclic.add(id);
    reportCycle(group, edgeFields, resolvedById, diagnostics);
  }

  for (const id of topoOrder(graph)) {
    // Left unexpanded: the item's leaked render-function text is caught downstream by the
    // output sweep's CL0432 LEAKED_RENDER_FUNCTION, per Decision 3's Unknowns — two reports,
    // both correct, rather than a guess at which side of the cycle to break.
    if (cyclic.has(id)) continue;
    const item = resolvedById.get(id);
    applyFieldRenderFunctions(item, resolvedById, { diagnostics, file: item._source });
  }
}

function renderBranchItems(resolvedItems, registry, templates, partials, outputDir, branchProtagonist, variables = {}, options = {}) {
  const {
    verbose = false,
    renderedById = null,
    projectNotesTemplate = null,
    diagnostics = new Diagnostics(),
    slotIndex = new Map(),
    branchLabel = '(root)',
    placeholders = {},
    usage = null,
    usagePath = '',
    // §9.2's merged role table for this branch, and CL0545's usage callback — grouped with
    // the rest of the trailing options rather than appended as a 17th positional parameter.
    roles = null,
    onRoleUsed = null,
  } = options;
  // Build early so render functions can resolve cross-item refs during field expansion.
  const resolvedById = new Map();
  for (const item of resolvedItems) {
    const id = (item.id || '').toLowerCase();
    if (id) resolvedById.set(id, item);
  }

  // Undeclared names already reported against a specific item-and-slot, per component.
  // The assembled-component scan reads this so one mistake is not described twice for
  // one file, once well and once vaguely.
  const placeholderNoise = new Map();

  // §8.5 measures what AID stores, which is the *substituted* string, so the length check
  // needs the questions rather than the keys. Expanded once per branch and handed down.
  const questions = questionsForMeasurement(placeholders, variables);

  applyCrossItemRefs(resolvedItems, registry, busWarner(diagnostics), resolvedById);

  // Expand render functions in body field values now that cross-item refs are resolved.
  // Dependency-ordered: a scan-build-sort-evaluate sequence over the same graph a chain
  // like A.field = join($B.body.x) implies, replacing the fixpoint loop this used to be
  // (v4 spec §13, Phase 9 Step 2 — see Decision 3 of the Phase 9 plan for why evaluating
  // in topological order, rather than iterating to convergence, is the correction and not
  // just a performance change).
  resolveCrossItemRenderFunctions(resolvedItems, resolvedById, diagnostics);

  // §8.2: the envelope is the emitter's, not the template's. Templates render the body;
  // `emit/vl.js` writes the heading and the fence around it, and reports what it cannot
  // carry — a comma inside a trigger — onto the caller's bus. Nothing is printed or thrown
  // here: wrong output is still output, so the branch tree is finished either way and the
  // caller decides when to print and whether the run fails.
  const grouped = new Map();

  // component key → slot name (lowercased) → occupants, unsorted. `emit/components.js`
  // owns the sort, so `order:` then item id is stated in exactly one place (§7.4).
  const occupants = new Map();

  // Card-name collision detector (Phase 10 Step 3, CL0622). Keyed on the displayed card
  // name rather than the item id, because that is what VL's `_merge_story_cards` keys on.
  const seenNames = new Map(); // name → { type, file }
  const reportedCollisions = new Set(); // name

  for (const item of resolvedItems) {
    applyPronounPasses(
      item, registry, branchProtagonist, resolvedById, roles, busWarner(diagnostics), onRoleUsed,
    );

    // §7.2: the item says where it goes. Read once, here, and used for both outputs.
    const placement = resolvePlacements(item);
    const itemId = item.id || (typeof item.name === 'string' ? item.name : String(item.name));

    // Counts outputs, not targets: a target whose slot is gated off on this branch is
    // legitimate (§7.4's third and fifth rows) and simply does not produce one.
    let outputs = 0;

    for (const target of placement.targets) {
      if (!checkTargetSlot(target, itemId, slotIndex, branchLabel, diagnostics, item._source)) continue;
      const known = slotIndex.get(target.component);
      // A slot the component declares but this branch excludes: nothing is placed, and
      // nothing is said here. Whether that silence matters is the no-output invariant's
      // question, below, and it is the only one with enough context to answer it.
      if (known && !known.slots.has(String(target.slot).toLowerCase())) continue;
      const text = renderPlacementBody(item, target, templates, partials, variables, diagnostics);
      if (text === null) continue;
      // Scanned per placement rather than once on the assembled component, because the
      // same item body can land in two components on one branch and the author needs to
      // be told which routing carried the mistake.
      const reported = checkUndeclaredPlaceholders(text, placeholders, {
        diagnostics,
        file: item._source,
        where: `item "${itemId}" rendering into ${target.component} slot "${target.slot}"`,
        branch: branchLabel,
        usage,
        usagePath,
      });
      if (reported.length) {
        if (!placeholderNoise.has(target.component)) placeholderNoise.set(target.component, new Set());
        for (const name of reported) placeholderNoise.get(target.component).add(name);
      }
      if (!occupants.has(target.component)) occupants.set(target.component, new Map());
      const slots = occupants.get(target.component);
      const slotKey = String(target.slot || '').toLowerCase();
      if (!slots.has(slotKey)) slots.set(slotKey, []);
      slots.get(slotKey).push({ id: itemId, order: target.order, text, slot: target.slot });
      outputs++;
    }

    // The no-output invariant (§7.4) — the replacement for v3's suppression checks. An item
    // that resolved into this branch must leave a mark on it. Scoped by consequence rather
    // than by mechanism: gating a slot off at the component level stays a legitimate way to
    // drop a whole slot's contents from one branch, and only becomes an error when it would
    // make an item vanish from every output it declared.
    if (!placement.storyCard && outputs === 0) {
      diagnostics.error(
        DIAG_CODES.ITEM_NO_OUTPUT,
        `item "${itemId}" resolves on branch "${branchLabel}" but produces no output there: `
        + 'storyCard is false and no declared target placed it. Exclude it from the branch '
        + 'with "branches:" if that is what was meant.',
        { file: item._source },
      );
    }

    // `storyCard: false` is now the only thing that suppresses a card (§7.4). An item that
    // renders only into a component never produces one, so there is nothing to suppress.
    if (!placement.storyCard) continue;

    // Before the template ladder, deliberately. `aid.type` selects the template when no
    // explicit one is named, so a placeholder in it also fails to match a template — and
    // that failure `continue`s past every later check. Reported here, the author is told
    // the cause; reported after, they get CL0420 about a template they never wrote.
    //
    // Per branch rather than once per item, because a variant can change `aid.type` and
    // only some branches may apply it.
    checkPlaceholderContext(item.aid && item.aid.type, {
      diagnostics,
      file: item._source,
      where: `the type of story card "${itemId}"`,
      branch: branchLabel,
      reason: 'AID does not fill placeholders in a card’s type. It is a category, and '
        + 'Codex Loom also makes it a folder and file name in the compiled tree, so the '
        + 'raw text would become part of a path.',
    });

    // Validate the fully-resolved aid.type (it becomes a folder/file name). Runs here,
    // after all {%}/{$} passes, so it sees the final on-disk type. Aborts on invalid.
    validateCardType(item);

    const templateEntry = getTemplate(item, templates);
    if (!templateEntry) {
      const type = (item.aid && item.aid.type) || (item.render && item.render.template) || '?';
      diagnostics.error(
        DIAG_CODES.TEMPLATE_NOT_FOUND,
        `no template found for item "${itemId}" (type: ${type})`,
        { file: item._source },
      );
      continue;
    }

    // Build render context: top-level item fields + body for {$body.X} access
    const context = itemContext(item);

    let rendered;
    try {
      const bodyText = render(templateEntry.content, context, partials, variables, {
        diagnostics, file: templateEntry._source, name: getTemplateName(item, templates),
      });
      // The body arrives already wrapped — `render` applies render.wrapper — which is
      // what §8.5 needs when Phase 5 measures the final string.
      rendered = renderCard({
        item,
        bodyText,
        notesText: renderNotesText(item, context, templates, partials, variables, projectNotesTemplate, diagnostics),
        diagnostics,
        loc: { file: item._source },
        questions,
      }).text;
    } catch (err) {
      diagnostics.error(
        DIAG_CODES.RENDER_FAILED,
        `item "${itemId}" failed to render: ${err.message}`,
        { file: item._source },
      );
      continue;
    }

    const type = (item.aid && item.aid.type) || 'Uncategorized';

    // Phase 10 Step 3: warn when two cards on this leaf share a name across types. VL's
    // card merge keys on name alone, so the collision is real and becomes position-dependent
    // once inheritance arrives. Report once per collision, naming both types and files.
    const cardName = cardTitle(item);
    const existing = seenNames.get(cardName);
    if (existing && existing.type !== type && !reportedCollisions.has(cardName)) {
      reportedCollisions.add(cardName);
      diagnostics.warn(
        DIAG_CODES.CARD_NAME_COLLISION,
        `story cards "${cardName}" collide across types: ${existing.type} in ${path.basename(existing.file)} and ${type} in ${path.basename(item._source)}. Velvet Lattice merges cards by name, so the later declaration wins; under inheritance this winner becomes position-dependent.`,
        { file: item._source },
      );
    }
    if (!existing) {
      seenNames.set(cardName, { type, file: item._source });
    }

    const leakSink = { diagnostics, file: item._source };
    checkUnexpandedVariables(rendered, `item "${itemId}" (${type})`, leakSink);
    checkUnresolvedFieldTokens(rendered, `item "${itemId}" (${type})`, leakSink);
    checkMechanicalArtifacts(rendered, `item "${itemId}" (${type})`, leakSink);
    // The whole rendered card, so one call covers name, triggers, notes and body — every
    // story-card field AID accepts a placeholder in.
    checkUndeclaredPlaceholders(rendered, placeholders, {
      diagnostics, file: item._source, where: `story card "${itemId}"`, branch: branchLabel,
      usage, usagePath,
    });
    if (!grouped.has(type)) grouped.set(type, []);
    // Carry a sort key (the item's real id, lowercased) so output order is
    // deterministic regardless of authoring order in the source YAML.
    grouped.get(type).push({ sortKey: String(itemId).toLowerCase(), rendered });
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
  return { written, occupants, placeholderNoise };
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
function writeComponentFile(outputDir, filename, content, sink) {
  const dir = path.join(outputDir, 'Components');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, filename);
  checkUnexpandedVariables(content, `component ${filename}`, sink);
  checkUnresolvedFieldTokens(content, `component ${filename}`, sink);
  checkMechanicalArtifacts(content, `component ${filename}`, sink);
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

/**
 * Write branch framing across the branch tree (§7.3).
 *
 * Framing is the only component that belongs to a *non-leaf* node — AID reads it as what
 * is shown while the player chooses among the children below it — which is why this uses
 * the tree visitor while every other component is written by the leaf loop. It lands in
 * `Opening.md`, the name a leaf's `opening:` uses, because Velvet Lattice reads a node's
 * prompt from that filename at every level.
 *
 * **The opening half of this walker moved into the leaf loop in Phase 6 Step 6.** An
 * `opening:` is an ordinary inherited component now, so the chain-merge this function used
 * to do by hand — `declaredOpening !== undefined ? … : state.inheritedOpening` — is what
 * `buildCompileContext` already does for every component. What is left here is the node
 * write the leaf loop genuinely cannot reach.
 */
function writeFramingRecursive(branches, outputBase, configBase, variables, currentPath = [], verbose = false, rootPlaceholders = null, diagnostics = null, usage = null, loadSectioned = null, registry = null) {
  // An unbranched project has no interior nodes, so there is no framing to write.
  if (!branches || typeof branches !== 'object') return;

  const renderFraming = (spec, nodePath, vars, table, name) => {
    const resolvedSpec = resolveComponentSpec(spec, configBase, vars);
    const isFile = typeof resolvedSpec === 'string' && fs.existsSync(resolvedSpec)
      && fs.statSync(resolvedSpec).isFile();

    // Three shapes, the same three an opening has: a component document, a prose file, and
    // a literal sentence. Framing is a question far more often than it is a path, which is
    // why the literal arm is the common one here.
    if (isFile && !isPassthrough(resolvedSpec)) {
      const component = loadSectioned
        ? loadSectioned(resolvedSpec, FRAMING_DESCRIPTOR)
        : null;
      if (!component) return null;
      // An empty occupant map: framing sits at an interior node, and items are resolved per
      // leaf, so there is no cast here to route into it. Same call the scenario blurb makes.
      const { text } = renderSectionedComponent(component, nodePath, new Map(), {
        defaultHeadingLevel: FRAMING_DESCRIPTOR.defaultHeadingLevel,
        variables: vars, registry, branchProtagonist: null,
        onWarn: busWarner(diagnostics, { file: String(resolvedSpec) }),
      });
      return text;
    }
    return resolveOpeningContent(spec, configBase, vars);
  };

  walkBranchTree(branches, ({ name, node, path: nodePath, isLeaf, state }) => {
    const nodeOutput = path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    const framing = node && node.components && node.components.branchFraming !== undefined
      ? node.components.branchFraming
      : null;

    const table = mergePlaceholders(state.table, node);

    if (framing != null) {
      if (isLeaf) {
        console.warn(`  WARN: branchFraming on leaf branch "${name}" — ignoring`);
      } else {
        const framingText = renderFraming(framing, nodePath, branchVars, table, name);
        if (framingText) {
          checkUndeclaredPlaceholders(framingText, table, {
            diagnostics, where: `the branch framing on "${name}"`,
            usage, usagePath: nodePath.join('/'),
          });
          // Framing lands in the same `Opening.md` filename at an interior node, and VL caps
          // the file rather than the chain — components merge per filename, so a leaf's
          // opening replaces this rather than adding to it (§8.5).
          checkLimit(framingText, questionsForMeasurement(table, branchVars), LIMITS.opening, {
            diagnostics, label: `branch "${name}" (framing)`,
          });
          const outPath = writeComponentFile(nodeOutput, 'Opening.md', framingText, { diagnostics });
          if (verbose) console.log(`    OK: BranchFraming → ${outPath}`);
        }
      }
    }

    return { outputBase: nodeOutput, variables: branchVars, table };
  }, { outputBase, variables, table: Object.assign({}, rootPlaceholders || {}) });
}

/**
 * Write Label.md at every node in the branch tree.
 *
 * Node-level, not leaf-level, which is why it uses the tree visitor rather than the
 * leaf loop: a branch label belongs to the node the player is choosing.
 */
function writeLabelsRecursive(branches, outputBase, variables, verbose = false, rootPlaceholders = null, diagnostics = null, configPath = null, usage = null) {
  walkBranchTree(branches, ({ name, node, path: path_, state }) => {
    const nodeOutput = path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    const table = mergePlaceholders(state.table, node);
    const rawTitle = (node && node.title) || name;
    fs.mkdirSync(nodeOutput, { recursive: true });
    const outPath = path.join(nodeOutput, 'Label.md');
    const labelText = resolveVariables(rawTitle, branchVars);
    // A branch title is the one destination where a placeholder half-works: AID fills
    // the prompt correctly, then keeps the raw text in the saved adventure's title.
    // Undeclared is still simply broken, so it errors here like anywhere else; the
    // half-working case is Step 4's WARN.
    checkUndeclaredPlaceholders(labelText, table, {
      diagnostics, file: configPath, where: `the title of branch "${name}"`,
      usage, usagePath: path_.join('/'),
    });
    checkPlaceholderContext(labelText, {
      diagnostics,
      file: configPath,
      where: `the title of branch "${name}"`,
      severity: 'warn',
      reason: 'a branch title half-works. AID fills the prompt and shows the answer while '
        + 'the player is choosing, then keeps the raw placeholder text in the saved '
        + 'adventure’s title. Deliberate is possible; usually it is not.',
    });
    fs.writeFileSync(outPath, labelText + '\n', 'utf8');
    if (verbose) console.log(`    OK: Label → ${outPath}`);

    return { outputBase: nodeOutput, variables: branchVars, table };
  }, { outputBase, variables, table: Object.assign({}, rootPlaceholders || {}) });
}

/**
 * Write `Placeholders.yaml` across the branch tree (§12.2).
 *
 * Node-level, like `Label.md` and for the same reason: Velvet Lattice reads one file per
 * scenario node and merges them down itself, so the leaf loop is the wrong shape — it
 * would emit a leaf's accumulated table and never write the interior nodes at all.
 *
 * Each node emits only the keys it declares. What it emits are those keys' *expanded*
 * questions, resolved against the merged table so a local question nesting an inherited
 * key carries that key's question inline — see `emit/placeholders.js` for why the nesting
 * cannot be left to VL.
 */
function writePlaceholdersRecursive(branches, outputBase, rootPlaceholders, variables, configPath, diagnostics, verbose = false, usage = null, declarations = null, duplicates = null) {
  const onWarn = (code, message, file) => diagnostics.add(
    severityOf(code), code, message, { file: file || configPath },
  );

  const rootNode = { placeholders: rootPlaceholders };
  const rootTable = Object.assign({}, rootPlaceholders || {});
  if (declarations && rootPlaceholders) {
    declarations.push({
      path: '', label: 'at the project root', keys: localKeysOf(rootNode),
    });
  }
  const written = writeNodePlaceholders(outputBase, rootNode, rootTable, variables, {
    onWarn, file: configPath, diagnostics, usage, usagePath: '', duplicates,
  });
  if (written && verbose) console.log(`    OK: Placeholders → ${written}`);

  walkBranchTree(branches, ({ name, node, path: path_, state }) => {
    const nodeOutput = path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    // The merged table at this node, by the same rules `walkBranchChain` applies along a
    // path: local keys override inherited ones, `~` deletes. Accumulated here rather than
    // looked up because the tree walk already has the chain in hand as `state`.
    const table = mergePlaceholders(state.table, node);

    if (declarations) {
      const keys = localKeysOf(node);
      if (keys.length) {
        declarations.push({
          path: path_.join('/'), label: `on branch "${path_.join('/')}"`, keys,
        });
      }
    }

    const outPath = writeNodePlaceholders(nodeOutput, node, table, branchVars, {
      onWarn, file: configPath, diagnostics, usage, usagePath: path_.join('/'), duplicates,
    });
    if (outPath && verbose) console.log(`    OK: Placeholders → ${outPath}`);

    return { outputBase: nodeOutput, variables: branchVars, table };
  }, { outputBase, variables, table: rootTable });
}

/**
 * Print what the loading phase has collected since `since`, and abort if any of it —
 * checked across the whole bus, not just what's new — is an error.
 *
 * Errors stop the compile before anything is written. A schema violation means some part
 * of what the author wrote is not being read, so continuing would emit a tree that looks
 * complete and is quietly missing something — the exact failure mode §4.3 exists to end.
 *
 * Takes a cursor and returns the new one so a caller can check more than once — config
 * loading and item/canon loading each add to the same bus, and a config-level error must
 * stop the compile before item loading ever touches disk, not only once both have run.
 * Without the cursor, calling this twice would reprint whatever the first call already
 * printed.
 */
function reportLoadDiagnostics(diagnostics, since = 0) {
  const items = diagnostics.all;
  for (const diag of items.slice(since)) {
    if (diag.severity === 'error') console.error(diag.format());
    else console.warn(diag.format());
  }
  if (diagnostics.hasErrors()) {
    const count = diagnostics.errors.length;
    throw new Error(`${count} error${count === 1 ? '' : 's'} while loading; nothing was compiled.`);
  }
  return items.length;
}

// ── Main compile function ─────────────────────────────────────────────────────

/**
 * Compile a project, optionally handing the caller the diagnostics as data.
 *
 * `compileRun` reports through the console and signals failure by throwing a *count* —
 * which is right for an author at a terminal and useless to a test that wants to assert
 * on codes. Passing `options.diagnostics` (a `Diagnostics`) collects everything both
 * internal buses saw, on every exit path: the early load throw, the component-gap throw,
 * the final error throw, and success alike. That is what the `finally` is for — a compile
 * that failed is precisely the one whose diagnostics are worth reading, so merging only
 * on the success path would collect nothing in the interesting case.
 *
 * The buses stay separate internally because their abort semantics differ (§4.3): a load
 * error stops the compile before anything is written, a compile error lets the tree land
 * and fails the run afterward. The sink flattens them because a caller reading
 * diagnostics wants the whole stream in one place.
 */
function compile(configPath, options = {}) {
  const buses = {};
  try {
    return compileRun(configPath, options, buses);
  } finally {
    if (options.diagnostics) {
      if (buses.load) options.diagnostics.merge(buses.load);
      if (buses.compile) options.diagnostics.merge(buses.compile);
    }
  }
}

function compileRun(configPath, options, buses) {
  const verbose = !!options.verbose;

  // One bus for everything the loading phase reports, so item schema violations are
  // collected with their source positions and reported together rather than as a stream
  // of console warnings interleaved with progress output. The compile phases still warn
  // directly; they move onto the bus as their modules are decomposed.
  const loadDiagnostics = new Diagnostics();
  buses.load = loadDiagnostics;

  // A second bus for everything the compile phases report — item resolution, cross-item
  // refs, emit. Unlike the load bus this one never aborts mid-run: its errors mean the tree
  // that gets written is wrong, not that it cannot be written, so it is checked once at the
  // end and the author gets both the artifact and a failed build.
  const compileDiagnostics = new Diagnostics();
  buses.compile = compileDiagnostics;
  let compileCursor = 0;
  const reportCompileDiagnostics = () => {
    for (const diag of compileDiagnostics.all.slice(compileCursor)) {
      if (diag.severity === 'error') console.error(diag.format());
      else console.warn(diag.format());
    }
    compileCursor = compileDiagnostics.length;
  };

  const config = loadCompileConfig(configPath, { diagnostics: loadDiagnostics, live: options.live });

  // Phase 7's drift notice: a complete no-op unless the project has opted into a snapshot
  // (§Decision 4 — drift is informational, never a warning, never a non-zero exit; the one
  // exception is CL0115, corruption of the frozen copy itself, which is an ERROR).
  if (config) checkDrift(config, loadDiagnostics);

  // Checked immediately, before any filesystem work — an unknown key, a missing required
  // field, or a bad path token in compile.yaml itself must stop the compile before
  // mkdirSync ever runs, not merely before the compiled tree is written. Folding this into
  // the single check below meant a config error still created the output directory and
  // read canon/item files from disk before the throw was reached.
  let loadCursor = reportLoadDiagnostics(loadDiagnostics);

  // The §12.5 ceiling, set here because this is the first moment both halves of it exist:
  // `lint.level` has just been read off the config, and `--lint-level` came in with the
  // options. The CLI flag wins, on the general rule that a flag is what someone typed for
  // this run and the config is what the project says every run.
  //
  // The load bus is deliberately left alone. Nothing it raises is an opinion — it is
  // schema violations and unreadable files — and it has already been reported by the line
  // above, so a ceiling applied here could only ever arrive too late to mean anything.
  compileDiagnostics.setLintLevel(
    options.lintLevel || (config.lint && config.lint.level) || null,
  );

  fs.mkdirSync(config._resolvedOutput, { recursive: true });

  const { templates, partials } = loadTemplates(config._resolvedTemplates, { diagnostics: loadDiagnostics });
  // Checked before anything renders: a template that still carries a fence would emit a
  // double envelope on every card it owns (§8.3), and the report names the files. The
  // notes-template check needs both halves in hand, so it runs against the same bus.
  checkConfigNotesTemplates(config, templates, loadDiagnostics, configPath);
  loadCursor = reportLoadDiagnostics(loadDiagnostics, loadCursor);
  console.log(`Loaded ${templates.size} template(s)${partials.size ? `, ${partials.size} partial(s)` : ''}.`);

  // Build canon registry
  const canonRegistry = buildCanonRegistry(config._resolvedLibrary, { diagnostics: loadDiagnostics });
  // itemCount, not size: an id two canon sets both define holds no plain key (§17.3), and
  // "loaded 40 items" would otherwise quietly drop the very items worth mentioning.
  if (canonRegistry.itemCount > 0) {
    console.log(`Loaded ${canonRegistry.itemCount} canonical item(s).`);
  }

  // Load project items
  const rawProjectItems = loadItemsFromDir(config._resolvedItems, { diagnostics: loadDiagnostics });

  // Resolve includes
  const includedItems = resolveIncludes(rawProjectItems, canonRegistry, config, { diagnostics: loadDiagnostics });
  if (includedItems.length > 0) {
    console.log(`Loaded ${includedItems.length} included canonical item(s).`);
  }

  loadCursor = reportLoadDiagnostics(loadDiagnostics, loadCursor);

  // include: directives are spent once resolveIncludes has read them — drop them here so
  // nothing downstream has to know they ever existed. `import:` defs are NOT dropped:
  // they are real items awaiting resolution against the id they name.
  const projectItems = rawProjectItems.filter((d) => !d.include);

  const allItemDefs = [...projectItems, ...includedItems];

  const projectRegistry = buildRegistry(projectItems, 'project');
  console.log(`Loaded ${projectRegistry.size} project item definition(s).`);

  const registry = mergeRegistries(canonRegistry, projectRegistry);

  // Every declared key referenced by any text this compile writes, keyed by the branch path
  // the text belongs to, and every node that declared one. §12.3's unused check needs both:
  // the declarations say what was promised and where, the usage says what was spent.
  const placeholderUsage = new Map();
  const placeholderDeclarations = [];
  const placeholderDuplicates = new Map();

  // `CL0545`: every role name a resolved token actually bound to, project-wide — a
  // whole-compile check rather than `CL0535`'s subtree-scoped one (Decision recorded in
  // the Session A record: no golden declares a role yet, so there is no branch with a
  // differently-scoped sibling to get wrong, and the simpler check is the cheaper one to
  // build correctly today). `protagonist` is exempt: it is read structurally, by comparing
  // an item id against `branchProtagonist`, wherever any `{$Id}` token resolves — not only
  // where `{$protagonist}` is literally written — so "unused" is never a fact about it.
  const roleUsage = new Set();
  const onRoleUsed = (key) => roleUsage.add(String(key).toLowerCase());
  const roleDeclarations = [];
  if (config.roles) {
    const keys = localRoleKeysOf({ roles: config.roles }).filter((k) => k.toLowerCase() !== 'protagonist');
    if (keys.length) roleDeclarations.push({ path: '', label: 'at the project root', keys });
  }
  walkBranchTree(config.branches, ({ node, path: path_ }) => {
    const keys = localRoleKeysOf(node).filter((k) => k.toLowerCase() !== 'protagonist');
    if (keys.length) {
      roleDeclarations.push({ path: path_.join('/'), label: `on branch "${path_.join('/')}"`, keys });
    }
  });

  const leaves = enumerateLeaves(config.branches);

  if (options.clean) {
    console.log('\nClean build: clearing output folders...');
    cleanAndArchive(config, leaves);
  }

  console.log(`\nCompiling ${leaves.length} branch leaf/leaves...`);

  let totalFiles = 0;
  const allItemIds = new Set();
  const leafSummaries = [];

  // Cross-branch review reports (--diff / --annotate) are built from data captured
  // during compilation — the resolver materializes identity-keyed items in memory that
  // the on-disk markdown has already discarded. Gated so a normal compile is unchanged.
  const captureReports = !!(options.diff || options.annotate);
  const rootDirName = path.basename(config._resolvedOutput);
  const leafData = [];

  // `--inventory` reads the slot index and the occupant map, which exist only inside the
  // leaf loop and are gone by the time an output tree is on disk — the file records what a
  // slot rendered to, never who filled it. Captured separately from `leafData` because it
  // needs neither the rendered item bodies nor the component segments that make that
  // structure expensive.
  const inventoryData = [];

  // Track components that were requested (a spec/path was provided) but produced
  // no output file. A requested-but-unwritten component is almost always a silent
  // failure (bad path, unexpanded {%var}/{@key}, empty source) rather than intent —
  // collected here and reported as an error at the end of the compile.
  const componentGaps = [];
  const recordGap = (leaf, component, spec, reason) =>
    componentGaps.push({ leaf, component, spec: spec == null ? '(none)' : String(spec), reason });

  // A sectioned component document is read, validated and normalized once per file rather
  // than once per leaf. Which sections apply is a per-branch question that
  // `sectionsForBranch` answers from the normalized document, so nothing is lost — and a
  // schema violation in a component reaches the author once instead of once per leaf,
  // which for The Institute's 32 leaves is the difference between a diagnostic and a wall.
  //
  // §7.6's `imports:` resolve inside that one load, which is why cycle detection and the
  // import diagnostics belong there rather than in the leaf loop: a chain resolved once per
  // file reports a cycle once, and a chain resolved once per leaf reports it 32 times for
  // The Institute. `from:` expands against the *root* variable table for the same reason the
  // cache is keyed by path — a branch-varying `from:` would make one cache key stand for two
  // documents.
  const sectionedDocs = new Map();
  // Every resolved path any `loadSectioned` call reads, *including* what its `imports:`
  // chain pulls in — unlike `sectionedDocs`, which is keyed by top-level spec only and
  // says nothing about a file reached solely through `imports:`. This is the ledger the
  // dependency-coverage check (below) actually needs: the gap it exists to catch is a
  // shared component reached through a plain variable rather than a `components:` spec,
  // which by definition never appears as a `sectionedDocs` key.
  const dependencyLedger = new Set();
  const rootVariables = config._variables || config.variables || null;
  const loadSectioned = (spec, descriptor) => {
    if (!sectionedDocs.has(spec)) {
      const loaded = loadComponentDocument(spec, {
        diagnostics: compileDiagnostics,
        label: descriptor.label,
        variables: rootVariables,
        base: config._base,
        dependencyLedger,
      });
      // §7.7's `metadata:` is declared on every component and emitted by the ones whose
      // output has somewhere to put frontmatter — Description today. Reported on the cache
      // miss so the author hears it once, rather than once per leaf.
      if (loaded && loaded.metadata && !descriptor.frontmatter) {
        compileDiagnostics.warn(
          DIAG_CODES.COMPONENT_METADATA_UNSUPPORTED,
          `"${descriptor.label}" declares metadata:, which is written as frontmatter and `
          + `only ${DESCRIPTION_DESCRIPTOR.file} carries any — Velvet Lattice reads scenario `
          + 'tags from there. The metadata is ignored here.',
          { file: String(spec) },
        );
      }
      sectionedDocs.set(spec, loaded);
    }
    return sectionedDocs.get(spec);
  };

  // The two sets §7.7's guard compares. Both are filled by the leaf loop below, which is
  // what makes CL0616 a comparison of two facts rather than of two passes.
  const descriptionLeaves = new Set();
  const openingLeaves = new Set();

  for (const branchPath of leaves) {
    const label = branchPath.length > 0 ? branchPath.join('/') : '(root)';
    if (verbose) console.log(`\n  Branch: ${label}`);

    // One traversal now serves what used to be four: the folder path, the inherited
    // roles table (`protagonist` is `roles.protagonist`, §9.2), the terminal node, and
    // (inside buildCompileContext) the merged variables and components.
    const chain = walkBranchChain(config.branches, branchPath, {
      rootRoles: config.roles || {},
    });
    // Always a string: an absent `roles.protagonist` merges to `undefined`, and
    // `resolveVariables` below requires a string input.
    const inheritedProtagonist = chain.roles.protagonist || '';
    const folderPath = chain.folderPath;
    const outputDir = buildBranchOutputDir(config._resolvedOutput, folderPath);
    const ctx = buildCompileContext(config, branchPath, {
      onWarn: busWarner(compileDiagnostics, { file: configPath }),
    });
    // Expand {%var} in protagonist using branch-merged variables, before the
    // case-insensitive match against item ids.
    const branchProtagonist = resolveVariables(inheritedProtagonist, ctx.variables).toLowerCase() || null;
    const compileContext = { branchPath, branchProtagonist, ...ctx, diagnostics: compileDiagnostics };

    // Phase A: resolve all story cards
    const resolvedItems = resolveBranchItems(allItemDefs, registry, branchPath, ctx.variables, compileDiagnostics);

    // Accumulate unique item IDs and per-leaf stats for summary
    for (const item of resolvedItems) {
      if (item.id) allItemIds.add(item.id.toLowerCase());
    }
    const leafItems    = resolvedItems.length;
    const leafVariants = resolvedItems.filter(c => c._hasVariant).length;

    // The sectioned components are resolved *before* the items that fill them, because two
    // of §7.4's placement ERRORs — undeclared slot, and a section that is not a slot — are
    // questions about the component that only the item's target can ask. Loading here lets
    // them be raised where the placement is made rather than a hundred lines later, at a
    // point that no longer knows which item was responsible. `loadSectioned` caches by
    // resolved path, so a per-leaf hoist costs one Map lookup.
    const sectionedForLeaf = resolveSectionedComponents(compileContext, label, {
      loadSectioned, recordGap,
    });
    const slotIndex = buildSlotIndex(sectionedForLeaf, branchPath);

    // Phase B: cross-item refs + pronouns + render + write. One pass produces the story
    // cards and the component occupants together — see renderBranchItems.
    const renderedById = captureReports ? new Map() : null;
    const { written, occupants, placeholderNoise } = renderBranchItems(
      resolvedItems, registry, templates, partials, outputDir, branchProtagonist, ctx.variables,
      {
        verbose, renderedById,
        projectNotesTemplate: (compileContext.render && compileContext.render.notesTemplate) || null,
        diagnostics: compileDiagnostics, slotIndex, branchLabel: label, placeholders: ctx.placeholders,
        usage: placeholderUsage, usagePath: branchPath.join('/'),
        roles: ctx.roles, onRoleUsed,
      },
    );
    totalFiles += written.length;
    reportCompileDiagnostics();

    if (options.inventory) {
      inventoryData.push(
        require('./inventory').captureLeafInventory(
          label, branchPath, sectionedForLeaf, slotIndex, occupants,
        ),
      );
    }

    // Sectioned components (§7.2) — all four of them now. The shape comes from the
    // component document, the content from the items that named its slots. This runs
    // *after* story cards: the ordering constraint existed only so suppression could
    // follow what Plot Essentials had actually emitted, and there is no suppression left.
    const sectionedWritten = {};
    const sectionedSegments = {};
    for (const { descriptor, spec, component, passthrough } of sectionedForLeaf) {
      const filled = occupants.get(descriptor.key) || new Map();
      let text;
      let segments;
      let excluded = false;
      if (passthrough !== null && passthrough !== undefined) {
        // Prose has no sections to render, warn about, or report separately. It is one
        // segment keyed by the component so the cross-branch reports still name it.
        text = passthrough;
        segments = [{ key: descriptor.label, text: passthrough }];
      } else {
        warnEmptySlots(descriptor, slotIndex, filled, label, compileDiagnostics, spec);
        ({ text, segments, excluded = false } = renderSectionedComponent(
          component, branchPath, filled,
          {
            defaultHeadingLevel: descriptor.defaultHeadingLevel,
            variables: ctx.variables, registry, branchProtagonist,
            roles: ctx.roles, onRoleUsed,
            onWarn: busWarner(compileDiagnostics, { file: String(spec) }),
          },
        ));
      }
      // The assembled component. Occupant bodies were already scanned per placement above,
      // and `checkUndeclaredPlaceholders` reports once per key per site, so a name that
      // appears in both a section's own `text:` and an occupant is named twice — once
      // against the item, once against the component. Both are true and both are editable.
      checkUndeclaredPlaceholders(text, ctx.placeholders, {
        diagnostics: compileDiagnostics,
        file: String(spec),
        where: `component "${descriptor.label}"`,
        branch: label,
        skip: placeholderNoise.get(descriptor.key),
        usage: placeholderUsage,
        usagePath: branchPath.join('/'),
      });

      // §8.5's platform caps, table-driven rather than per-component. Only `opening:`
      // carries a `limitKey` today; the point of the column is that Step 4's `notes:` cap
      // is a row rather than another bespoke call site. Measured post-substitution because
      // Velvet Lattice expands `%key%` to its question text on the way to AID.
      if (descriptor.limitKey && text) {
        checkLimit(
          text,
          questionsForMeasurement(ctx.placeholders, ctx.variables),
          LIMITS[descriptor.limitKey],
          {
            diagnostics: compileDiagnostics,
            loc: { file: String(spec) },
            label: branchPath.length ? `branch "${branchPath[branchPath.length - 1]}"` : 'the project root',
          },
        );
      }

      const outPath = writeSectionedComponent(
        outputDir, descriptor, text, { diagnostics: compileDiagnostics },
        component ? component.metadata : null,
      );
      if (outPath) {
        sectionedWritten[descriptor.key] = true;
        sectionedSegments[descriptor.key] = segments;
        if (descriptor.key === 'adventureDescription') descriptionLeaves.add(label);
        // §7.7's guard used to read this from `writeOpeningsRecursive`'s return value.
        // Openings are written here now, so the set is built here — the two facts CL0616
        // compares are produced by one loop rather than by two passes that had to agree.
        if (descriptor.key === 'opening') openingLeaves.add(label);
        if (verbose) console.log(`    OK: ${descriptor.verboseLabel} → ${outPath}`);
        totalFiles++;
      } else if (!excluded) {
        // §7.4: a component that renders to nothing is an ERROR, not a gap. The gap list
        // is for a component that was asked for and could not be found; this one was
        // found, read, and had every section resolve away, which is a statement about
        // the source that no amount of re-reading the path will explain.
        //
        // A component-level `~` is exempt because it is not that statement. The author
        // wrote "not on this branch", and §7.6.2a gives `~` that meaning at this position
        // exactly as it has it at every other. Writing no file is the whole request.
        compileDiagnostics.error(
          DIAG_CODES.COMPONENT_RENDERS_NOTHING,
          `component "${descriptor.label}" renders to nothing on branch "${label}" — `
          + 'every section is excluded by its own branches: dispatch, empty, or an unfilled slot.',
          { file: String(spec) },
        );
      }
    }
    const hasPE = !!sectionedWritten.plotEssential;
    const hasAIN = !!sectionedWritten.aiInstructions;
    const hasAN = !!sectionedWritten.authorsNote;

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
        // Every sectioned component reports per section, keyed by section name. The
        // cross-branch reports diff component content by segment key, so per-section
        // keys localize a difference to the section that carries it rather than
        // reporting the whole component as changed — which is what §7.2's naming bought
        // Plot Essentials, and there is no reason the prose components report worse.
        //
        // Spread rather than named, and keyed by `descriptor.key` rather than by a name of
        // its own: this site listed three of `SLOTTED_COMPONENTS`' six by hand, so `summary`,
        // `opening` and `adventureDescription` were captured by the loop above and then
        // dropped here, invisible to `--diff` and `--annotate` since Phase 6 added them. A
        // list that has to be extended by hand when a component is added is a list that will
        // not be, so there is no list. `description:` is absent for a real reason rather than
        // this one — the scenario blurb is written once at the root and has no per-leaf value
        // to diff.
        components: { ...sectionedSegments },
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
      // The third `Opening.md` the compiler writes, and the one easiest to miss: root
      // framing is non-inheriting and lands outside both recursive writers. Capped like
      // the other two — VL reads it as this node's Opening and caps the file (§8.5).
      checkLimit(
        content,
        questionsForMeasurement(config.placeholders, config._variables || config.variables || {}),
        LIMITS.opening,
        { diagnostics: compileDiagnostics, loc: { file: configPath }, label: 'the project root (framing)' },
      );
      const outPath = writeComponentFile(config._resolvedOutput, 'Opening.md', content, { diagnostics: compileDiagnostics });
      if (verbose) console.log(`    OK: Root OpeningChoice → ${outPath}`);
    }
  }

  // `opening:` is written by the leaf loop above, as an ordinary inherited component. What
  // is left for the tree visitor is framing, which belongs to a node the leaf loop never
  // visits.
  writeFramingRecursive(
    config.branches, config._resolvedOutput, config._base,
    config._variables || config.variables || {},
    [], verbose, config.placeholders, compileDiagnostics, placeholderUsage,
    loadSectioned, registry,
  );

  writeLabelsRecursive(
    config.branches, config._resolvedOutput, config._variables || config.variables || {}, verbose,
    config.placeholders, compileDiagnostics, configPath, placeholderUsage,
  );

  writePlaceholdersRecursive(
    config.branches, config._resolvedOutput, config.placeholders,
    config._variables || config.variables || {}, configPath, compileDiagnostics, verbose,
    placeholderUsage, placeholderDeclarations, placeholderDuplicates,
  );
  reportCompileDiagnostics();

  // Root Label (project-level, written once to output root alongside Description.md)
  if (config.title != null) {
    const rootLabel = resolveVariables(String(config.title), config.variables || {});
    const labelPath = path.join(config._resolvedOutput, 'Label.md');
    checkUndeclaredPlaceholders(rootLabel, config.placeholders, {
      diagnostics: compileDiagnostics, file: configPath, where: 'the project title',
      usage: placeholderUsage, usagePath: '',
    });
    checkPlaceholderContext(rootLabel, {
      diagnostics: compileDiagnostics,
      file: configPath,
      where: 'the scenario title',
      severity: 'warn',
      reason: 'AID never fills a placeholder in the scenario title. The title names the '
        + 'scenario in listings, before any adventure exists to answer a prompt, so the '
        + 'raw text is what readers see. Legal to write, and occasionally meant as a '
        + 'joke, but never substituted.',
    });
    fs.writeFileSync(labelPath, rootLabel + '\n', 'utf8');
    if (verbose) console.log(`  OK: Label → ${labelPath}`);
  }

  // The scenario blurb (§7.7), written once to the output root alongside Branches/.
  //
  // An ordinary component document since Phase 6, rather than the two-field `description.yaml`
  // v3 gave it a loader of its own for. `body:` is now a section with `file:` and `script:`
  // is one with `from: {script:, extract: scriptBanner}`, which is what made the third file
  // format deletable — and what makes more than one banner expressible, where v3 allowed
  // exactly one.
  //
  // It renders through `renderSectionedComponent` with an empty occupant map, which is not a
  // second render path but the same one called with nothing to place: a scenario has one
  // blurb and items are branch-scoped, so there is no branch whose cast could route into it.
  const descRequested = config.components && config.components.description != null;
  const descSpec = descRequested
    ? resolveComponentSpec(config.components.description, config._base, config._variables || config.variables || null)
    : null;
  if (descRequested && !(descSpec && typeof descSpec === 'string' && fs.existsSync(descSpec))) {
    recordGap('(project)', 'Description', descSpec, 'source not found');
  } else if (descSpec && typeof descSpec === 'string' && fs.existsSync(descSpec)) {
    let combined = null;
    let descMetadata = null;

    if (isPassthrough(descSpec)) {
      combined = readPassthrough(descSpec);
    } else {
      const descComponent = loadSectioned(descSpec, DESCRIPTION_DESCRIPTOR);
      if (descComponent) {
        descMetadata = descComponent.metadata;
        ({ text: combined } = renderSectionedComponent(
          descComponent, [], new Map(),
          {
            defaultHeadingLevel: DESCRIPTION_DESCRIPTOR.defaultHeadingLevel,
            variables: rootVariables || {}, registry, branchProtagonist: null,
            onWarn: busWarner(compileDiagnostics, { file: String(descSpec) }),
          },
        ));
      }
    }

    // Checked against the root table, and that stays correct where the plan warned it might
    // not: the blurb belongs to the project, and it is `adventureDescription:` — a different
    // key, resolved inside the leaf loop against the branch-merged table — that carries the
    // per-node case §7.7 asked for.
    checkUndeclaredPlaceholders(combined, config.placeholders, {
      diagnostics: compileDiagnostics, file: descSpec, where: 'the Description',
      usage: placeholderUsage, usagePath: '',
    });
    checkPlaceholderContext(combined, {
      diagnostics: compileDiagnostics,
      file: descSpec,
      where: 'the Description',
      reason: 'AID does not fill placeholders in the Description. It is shown before any '
        + 'adventure exists to answer them, so the raw text is what a reader sees.',
    });
    const descPath = writeSectionedComponent(
      config._resolvedOutput, DESCRIPTION_DESCRIPTOR, combined,
      { diagnostics: compileDiagnostics }, descMetadata,
    );
    if (descPath) {
      if (verbose) console.log(`  OK: Description → ${descPath}`);
      // Both description keys write `Description.md`, and at an unbranched root they write
      // the same one — the root is its own leaf there, so the leaf loop has already been
      // through. Reported rather than silently resolved, because which of the two an author
      // meant to survive is not recoverable from the file that is left.
      if (descriptionLeaves.has('(root)')) {
        compileDiagnostics.warn(
          DIAG_CODES.DESCRIPTION_KEYS_COLLIDE,
          'this project declares both description: and adventureDescription: and has no '
          + 'branches, so the root is its own leaf and both write the same Description.md. '
          + 'The scenario blurb is what survives. Drop one, or add the branch the '
          + 'adventure description was written for.',
          { file: configPath },
        );
      }
    } else recordGap('(project)', 'Description', descSpec, 'compiled to empty content');
  }

  // §7.7's one guard. Velvet Lattice sets a node's prompt to
  // `components["Opening"] or node.description`, so a leaf carrying a description and no
  // Opening.md does not produce an empty prompt — it produces the blurb as the opening
  // scene. v3 could not reach this, because descriptions were written only at the output
  // root; `adventureDescription:` is what makes the pairing possible, and this is its price.
  for (const leafLabel of descriptionLeaves) {
    if (openingLeaves.has(leafLabel)) continue;
    compileDiagnostics.error(
      DIAG_CODES.LEAF_DESCRIPTION_NO_OPENING,
      `branch "${leafLabel}" has an adventure description and no Opening.md. Velvet Lattice `
      + 'reads a node\'s prompt as its Opening or, failing that, its description — so this '
      + 'leaf would open the adventure with its own blurb rather than a scene. Give the '
      + 'branch an opening:, or drop the adventureDescription: it inherits.',
      { file: configPath },
    );
  }
  reportCompileDiagnostics();

  // Per-leaf summary table (printed after all component writes so Opening status is known)
  for (const s of leafSummaries) {
    s.hasOpening = openingLeaves.has(s.label);
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
  console.log(`\n${allItemIds.size} unique items across project. Wrote ${totalFiles} file(s).`);

  // Library dependency manifest
  const libraryManifest = buildLibraryManifest(config);
  if (Object.keys(libraryManifest).length > 0) {
    const manifestPath = path.join(config._resolvedOutput, 'library-dependencies.json');
    const manifestData = {
      generatedAt: new Date().toISOString(),
      compileYaml: path.resolve(configPath),
      variables: config.variables || {},
      library: libraryManifest,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');
    if (verbose) console.log(`  OK: Library manifest → ${manifestPath}`);
  }

  // Dependency-coverage check (Phase 7 Step 4, floated out of Step 0): `dependencyLedger` is
  // every resolved component path this compile actually read, `imports:` chains included
  // (built above, in `loadSectioned`/`loadComponentDocument`). A component that lives
  // outside the project but under no `structure.input.library` entry compiles and renders
  // correctly today and is invisible to `--snapshot` — the freeze walks declared entries,
  // not resolved dependencies, so nothing else notices the gap. Checked once, here, rather
  // than per leaf: the ledger is already deduplicated by resolved path.
  const libraryDirs = [...config._resolvedLibrarySource.values()];
  for (const specPath of dependencyLedger) {
    if (!isOutOfBase(specPath, config._base)) continue;
    const norm = normalize(specPath);
    const covered = libraryDirs.some((dir) => {
      const normDir = normalize(dir);
      return norm === normDir || norm.startsWith(`${normDir}/`);
    });
    if (!covered) {
      compileDiagnostics.warn(
        LOAD_CODES.LIBRARY_DEPENDENCY_UNCOVERED,
        `This component is read from outside the project (${specPath}), and no `
        + 'structure.input.library entry covers it — --snapshot will not freeze it, and '
        + 'a live edit to this file changes every project that reaches it. Declare its '
        + 'directory as a library entry so the freeze and the {%name} it is reached '
        + 'through are the same thing.',
        { file: specPath },
      );
    }
  }

  // Cross-branch review reports — emitted from the per-leaf data captured above.
  const reportBase = config._resolvedReports || path.join(config._resolvedOutput, 'Overview');
  const reportSummary = [];

  // §17.2 provenance report — always emitted from registry data, independent of leaf loop.
  const { runProvenanceMode } = require('./provenance');
  const provenanceWritten = runProvenanceMode(registry, reportBase, rootDirName);
  reportSummary.push(`${provenanceWritten.length} provenance file(s)`);

  if ((captureReports && leafData.length > 0) || (options.inventory && inventoryData.length > 0)) {
    const { runDiffMode, runAnnotateMode } = require('./diff');
    if (options.inventory) {
      fs.mkdirSync(reportBase, { recursive: true });
      const w = require('./inventory').runInventoryMode(inventoryData, reportBase);
      reportSummary.push(`${w.length} inventory file(s)`);
    }
    if (options.diff) {
      const diffDir = path.join(reportBase, 'diff');
      fs.mkdirSync(diffDir, { recursive: true });
      const w = runDiffMode(leafData, diffDir);
      reportSummary.push(`${w.length} diff file(s) (Shared + deltas)`);
    }
    if (options.annotate) {
      const annotateDir = path.join(reportBase, 'annotate');
      fs.mkdirSync(annotateDir, { recursive: true });
      const w = runAnnotateMode(leafData, allItemDefs, registry, annotateDir);
      reportSummary.push(`${w.length} annotation file(s)`);
    }
  }
  if (reportSummary.length > 0) {
    console.log(`\nWrote ${reportSummary.join(' and ')} to:\n  ${reportBase}`);
  }

  // Last, because "unused" is only knowable once every write point has run — and the
  // Description and the scenario title are written after the branch tree.
  reportUnusedRoles(roleDeclarations, roleUsage, { diagnostics: compileDiagnostics, file: configPath });
  reportUnusedPlaceholders(placeholderDeclarations, placeholderUsage, {
    diagnostics: compileDiagnostics, file: configPath,
  });
  reportDuplicateQuestions(placeholderDuplicates, {
    diagnostics: compileDiagnostics, file: configPath,
  });
  reportCompileDiagnostics();

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

  // Item-resolution and emit ERRORs do not stop the compile: aborting mid-tree would leave
  // a half-written branch behind, and wrong output the author can read beats no output at
  // all. They do fail the run — the tree is written, then this throws and the CLI exits 1.
  reportCompileDiagnostics();
  if (compileDiagnostics.hasErrors()) {
    const count = compileDiagnostics.errors.length;
    throw new Error(
      `${count} error${count === 1 ? '' : 's'} while compiling. The output tree was written, `
      + 'but it does not say what the source says — see the errors above.'
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
  resolveBranchItems,
  renderBranchItems,
  resolveCrossItemRenderFunctions,
  getTemplate,
  getTemplateName,
  resolveNotesTemplateName,
  checkConfigNotesTemplates,
  CODES,
  validateCardType,
  writeOutput,
  resolveIncludes,
  buildCompileContext,
  resolveVariables,
  buildBranchOutputDir,
  resolveBranchFolderPath,
  resolveOpeningContent,
  writeOpening,
  writeFramingRecursive,
  cleanAndArchive,
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
      outputDir:    cfg._resolvedReports || path.join(cfg._resolvedOutput, 'Overview'),
      hasConfig:    true,
      // The report modes get `lint.level` from here rather than loading the config a second
      // time. This function already reads it for the output and reports paths, so the value
      // is in hand; without passing it out, `--lint` would answer differently from the
      // compile that wrote the tree it is reading, on the same project's own setting.
      configLintLevel: (cfg.lint && cfg.lint.level) || null,
    };
  }

  if (!positional) {
    return {
      configPath: null, scenarioRoot: null, outputDir: null, hasConfig: false,
      configLintLevel: null,
    };
  }

  return {
    configPath:   null,
    scenarioRoot: path.resolve(positional),
    outputDir:    path.resolve('overview'),
    hasConfig:    false,
    // No config to read one from. `--lint` on a bare output tree has only the CLI flag,
    // which is the honest answer rather than a gap.
    configLintLevel: null,
  };
}

/**
 * Resolve `--migrate`'s config path by directory search alone (§14.2, §4.6, Decision 4).
 *
 * Deliberately not `resolveArgs`: that function calls `loadCompileConfig`, and the schema
 * requires `version: 4` with no compatibility mode — a v3 project has no such key by
 * definition, so routing `--migrate` through the shared resolver would reject exactly the
 * input it exists to accept. This does only the filename search half, reusing
 * `CONFIG_BASENAMES` (`util.js`) so it recognizes all four entry-point spellings rather
 * than the two `resolveArgs`'s own `/\.ya?ml$/i` test knows.
 */
function resolveMigrateConfigPath(positional) {
  if (positional && /\.ya?ml$/i.test(positional)) {
    const resolved = path.resolve(positional);
    return fs.existsSync(resolved) ? resolved : null;
  }
  const dir = path.resolve(positional || '.');
  for (const base of CONFIG_BASENAMES) {
    const candidate = path.join(dir, base);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Render `--migrate`'s review queue and notes as `migration-report.md` (§9.5, §14.2).
 *
 * Written beside the config rather than into `structure.reports` — Decision 4 — because
 * the migrator creates that key during the same run (renaming `structure.overview`), so a
 * path read from the config would depend on a key the invocation is midway through writing.
 */
function renderMigrationReport(result) {
  const lines = [`# Migration report — ${result.configPath}`, ''];

  lines.push('## What changed', '');
  if (result.notes.length === 0) {
    lines.push('Nothing to report.');
  } else {
    for (const note of result.notes) lines.push(`- ${note}`);
  }
  lines.push('');

  lines.push(
    '## Review queue', '',
    'Every prose fragment that now carries a converted role token beside a hardcoded '
    + 'gendered pronoun (§9.5). The migrator cannot convert the pronoun — only a person can '
    + 'decide whether it should become a role reference too.', '',
  );
  if (!result.reviewQueue || result.reviewQueue.length === 0) {
    lines.push('None found.');
  } else {
    for (const entry of result.reviewQueue) {
      const at = entry.line ? `${entry.file}:${entry.line}` : entry.file;
      lines.push(`- **${at}** — ${entry.text}`);
    }
  }
  lines.push('');

  return lines.join('\n');
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
    ['snapshot',   ['--snapshot']],
    ['migrate',    ['--migrate']],
    ['renameToCl', ['--rename-cl']],
    ['diff',       ['--with-diff',     '--diff',     '-d']],
    ['annotate',   ['--with-annotate', '--annotate', '-a']],
    ['inventory',  ['--with-inventory', '--inventory', '-i']],
    ['clean',      ['--clean',      '-c']],
    ['verbose',    ['--verbose',    '-v']],
    ['live',       ['--live']],
  ];

  const flags = {};
  const flagIdxs = new Set();
  for (const [key, aliases] of knownFlags) {
    const idx = rawArgs.findIndex(a => aliases.includes(a));
    flags[key] = idx !== -1;
    if (idx !== -1) flagIdxs.add(idx);
  }

  // `--lint-level` is a value flag, so it is parsed apart from the boolean table above and
  // in both spellings: `--lint-level=warn` and `--lint-level warn`. It is deliberately not
  // folded into `--verbose` (§12.5) — verbosity is about compile progress, this is about
  // which diagnostics an author wants to hear, and the two answer different questions.
  let lintLevel = null;
  {
    const idx = rawArgs.findIndex(a => a === '--lint-level' || a.startsWith('--lint-level='));
    if (idx !== -1) {
      const arg = rawArgs[idx];
      flagIdxs.add(idx);
      if (arg.includes('=')) {
        lintLevel = arg.slice(arg.indexOf('=') + 1);
      } else {
        lintLevel = rawArgs[idx + 1];
        if (lintLevel !== undefined) flagIdxs.add(idx + 1);
      }
      if (!LINT_LEVELS.includes(lintLevel)) {
        console.error(
          `--lint-level takes one of ${LINT_LEVELS.join(', ')}; got ${JSON.stringify(lintLevel || '')}.`
        );
        process.exit(1);
      }
    }
  }

  const positional = rawArgs.filter((_, i) => !flagIdxs.has(i));

  // --with-diff / --with-annotate need data captured during compilation (the on-disk markdown is
  // lossy), so they are compile *options* — they force a compile rather than reading the
  // output dir like the post-hoc report modes (--leafReview/--overview/--seed-map/--card-sizes).
  const doCompile    = flags.compile || flags.diff || flags.annotate || flags.inventory ||
    (!flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes && !flags.lint &&
      !flags.snapshot && !flags.migrate);
  const doLeafReview = flags.leafReview;
  const doOverview   = flags.overview;
  const doSeedMap    = flags.seedMap;
  const doCardSizes  = flags.cardSizes;
  const doLint       = flags.lint;
  const doSnapshot   = flags.snapshot;

  if (positional.length === 0 && !flags.compile && !flags.diff && !flags.annotate &&
      !flags.inventory &&
      !flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes && !flags.lint &&
      !flags.snapshot && !flags.migrate) {
    console.error(
      'Usage: codex-loom [mode flags] [compile options] [<folder | compile.yaml>]\n' +
      '  Modes (what runs):     --compile|-C  --leafReview|-l  --overview|-o  --seed-map|-s  --card-sizes|-b  --lint|-L  --snapshot  --migrate\n' +
      '  Compile options:       --with-diff|-d  --with-annotate|-a  --with-inventory|-i  --clean|-c  --verbose|-v  --live\n' +
      '  Migrate options:       --rename-cl  (§4.6: also rename compile.yaml to compile.cl.yaml)\n' +
      '  Diagnostics:           --lint-level=off|error|warn  (overrides lint.level; reaches the opinion layer only)\n' +
      '  No mode flag compiles. Report modes read the existing output tree; compile options force a compile.\n' +
      '  --migrate converts a v3 project in place and does not compile — run it again once migrated.'
    );
    process.exit(1);
  }

  // ── Migrate (§14.2, Decision 4) ──
  //
  // Resolves its own config path (by filename search alone, per util.js's CONFIG_BASENAMES)
  // rather than through resolveArgs below: that function loads the config it finds, and the
  // v4 schema requires `version: 4` with no compatibility mode. A v3 project — the only
  // input `--migrate` exists to accept — has no such key, so routing through resolveArgs
  // rejects it before the migrator ever runs. Handled and exited before resolveArgs is
  // called at all, not merely before its result is used.
  if (flags.migrate) {
    const migrateConfigPath = resolveMigrateConfigPath(positional[0]);
    if (!migrateConfigPath) {
      console.error(`No v3 compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
      process.exit(1);
    }
    try {
      const { migrateProjectFully } = require('./migrate');
      const result = migrateProjectFully(migrateConfigPath, { renameToCl: flags.renameToCl });
      const reportPath = path.join(path.dirname(result.configPath), 'migration-report.md');
      fs.writeFileSync(reportPath, renderMigrationReport(result), 'utf8');
      const queueCount = result.reviewQueue.length;
      console.log(`Migrated ${migrateConfigPath}`);
      console.log(
        `Touched ${result.touched.length} file(s). Review queue: ${queueCount} `
        + `entr${queueCount === 1 ? 'y' : 'ies'}.`
      );
      console.log(`Wrote ${reportPath}`);
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  const { configPath, scenarioRoot, outputDir, hasConfig, configLintLevel } = resolveArgs(positional[0]);

  // The flag is what someone typed for this run; the config is what the project says every
  // run. Same precedence the compile applies internally, stated once here so the report
  // modes and the compile cannot disagree about it.
  const effectiveLintLevel = lintLevel || configLintLevel;

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
        compile(configPath, {
          clean: flags.clean, verbose: flags.verbose,
          diff: flags.diff, annotate: flags.annotate, inventory: flags.inventory,
          lintLevel, live: flags.live,
        });
      } catch (err) {
        console.error(`\nFatal: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // ── Snapshot (Phase 7's freeze: sync structure.input.library + out-of-base templates) ──
  if (doSnapshot) {
    if (!hasConfig) {
      console.error(`No compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
      process.exit(1);
    } else {
      try {
        const snapshotDiagnostics = new Diagnostics();
        const config = loadCompileConfig(configPath, { diagnostics: snapshotDiagnostics, live: true });
        if (!config._resolvedSnapshot) {
          console.error('structure.input.snapshot is not set in compile.yaml; nothing to sync.');
          process.exit(1);
        }
        const result = syncLibrary(config, { verbose: flags.verbose, diagnostics: snapshotDiagnostics });
        for (const diag of snapshotDiagnostics.all) {
          if (diag.severity === 'error') console.error(diag.format());
          else console.warn(diag.format());
        }
        console.log(
          `\nSynced ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'} `
          + `(${result.filesWritten} file(s)) to:\n  ${config._resolvedSnapshot}\n`
          + `Manifest: ${result.manifestPath}\n`
        );
        // The manifest and copied files are still written above — sync itself succeeded —
        // but a `requiresRoles` refusal (Decision 2, Phase 8) means the run is not clean.
        if (snapshotDiagnostics.hasErrors()) process.exit(1);
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
        if (result) summaryParts.push('2 card size files');
      }

      if (doLint) {
        const { runLintMode } = require('./lint');
        const dir = path.join(outputDir, 'lint');
        fs.mkdirSync(dir, { recursive: true });
        const result = runLintMode(scenarioRoot, dir, flags.verbose, { lintLevel: effectiveLintLevel });
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
