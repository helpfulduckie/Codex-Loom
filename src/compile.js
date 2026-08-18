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
} = require('./resolver');
const { resolvePlacements } = require('./model/item');
const { slotsForBranch } = require('./model/component');
const { loadComponentDocument } = require('./loader/component');
const { applyPronounPasses, applyCrossItemRefs } = require('./model/pronouns');
const { render, applyFieldInterpolation, applyVariableInterpolation, applyFieldRenderFunctions } = require('./template');
const { resolveVariables, warnUnexpandedVariables, warnUnresolvedFieldTokens, warnMechanicalArtifacts, itemContext } = require('./util');
const { expandTokens } = require('./tokens');
const { resolveIncludes, buildCanonRegistry } = require('./loader/registry');
const { Diagnostics, busWarner, severityOf, CODES: DIAG_CODES } = require('./diag');
const { renderCard } = require('./emit/vl');
const {
  FILENAME: PLACEHOLDERS_FILENAME, writeNodePlaceholders, checkUndeclaredPlaceholders,
} = require('./emit/placeholders');
const { loadDescConfig, extractScriptBanner, writeDescription } = require('./description');
const { loadOpeningConfig, compileOpening } = require('./opening');
const {
  SLOTTED_COMPONENTS, isPassthrough, readPassthrough,
  renderSectionedComponent, writeSectionedComponent,
} = require('./emit/components');

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
  return render(template.content, notesContext, partials, variables);
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
 * Get the template for an item. Checks render.template first, then aid.type.
 */
function getTemplate(item, templates) {
  const name = getTemplateName(item, templates);
  return name ? templates.get(name.toLowerCase()).content : null;
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
 * Merges variables, components and render defaults from root → branch chain.
 */
function buildCompileContext(config, branchPath, options = {}) {
  const chain = walkBranchChain(config.branches, branchPath, {
    rootPlaceholders: config.placeholders,
    onWarn: options.onWarn || null,
  });
  const variables = Object.assign({}, config._variables || config.variables || {}, chain.variables);
  const components = Object.assign({}, config.components || {}, chain.components);
  const render = Object.assign({}, config.render || {}, chain.render);

  // `scripts:` is top-level as of §6.3: it is a file copy, not a rendered document, and
  // it was the one row in the component table that shared none of the row's behavior. It
  // still merges down the branch chain like everything else, so it is folded back in
  // here rather than resolved separately.
  const scripts = chain.scripts !== undefined ? chain.scripts : config.scripts;
  if (scripts !== undefined) components.scripts = scripts;

  // Resolve component specs to file paths
  const componentTypes = ['aiInstructions', 'opening', 'branchFraming', 'plotEssential', 'summary', 'authorsNote', 'scripts'];
  const componentRefs = {};
  for (const type of componentTypes) {
    const spec = components[type] !== undefined ? components[type] : null;
    componentRefs[type] = resolveComponentSpec(spec, config._base, variables);
  }

  // The branch-merged placeholder table (§12.2). Sits beside `variables` because it is the
  // same kind of thing — a per-branch mapping every check and the emitter read — and
  // because §12.3's question text expands against `variables`, so the two are always
  // wanted together.
  return { variables, componentRefs, render, placeholders: chain.placeholders };
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
function resolveBranchItems(allItemDefs, registry, branchPath, variables, diagnostics = new Diagnostics()) {
  const resolvedItems = [];

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
      return render(template.content, context, partials, variables);
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
function renderBranchItems(resolvedItems, registry, templates, partials, outputDir, branchProtagonist, variables = {}, verbose = false, renderedById = null, projectNotesTemplate = null, diagnostics = new Diagnostics(), slotIndex = new Map(), branchLabel = '(root)', placeholders = {}) {
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

  applyCrossItemRefs(resolvedItems, registry, busWarner(diagnostics), resolvedById);

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

  // §8.2: the envelope is the emitter's, not the template's. Templates render the body;
  // `emit/vl.js` writes the heading and the fence around it, and reports what it cannot
  // carry — a comma inside a trigger — onto the caller's bus. Nothing is printed or thrown
  // here: wrong output is still output, so the branch tree is finished either way and the
  // caller decides when to print and whether the run fails.
  const grouped = new Map();

  // component key → slot name (lowercased) → occupants, unsorted. `emit/components.js`
  // owns the sort, so `order:` then item id is stated in exactly one place (§7.4).
  const occupants = new Map();

  for (const item of resolvedItems) {
    applyPronounPasses(item, registry, branchProtagonist, resolvedById);

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

    // Validate the fully-resolved aid.type (it becomes a folder/file name). Runs here,
    // after all {%}/{$} passes, so it sees the final on-disk type. Aborts on invalid.
    validateCardType(item);

    const template = getTemplate(item, templates);
    if (!template) {
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
      const bodyText = render(template, context, partials, variables);
      // The body arrives already wrapped — `render` applies render.wrapper — which is
      // what §8.5 needs when Phase 5 measures the final string.
      rendered = renderCard({
        item,
        bodyText,
        notesText: renderNotesText(item, context, templates, partials, variables, projectNotesTemplate, diagnostics),
        diagnostics,
        loc: { file: item._source },
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
    warnUnexpandedVariables(rendered, `item "${itemId}" (${type})`);
    warnUnresolvedFieldTokens(rendered, `item "${itemId}" (${type})`);
    warnMechanicalArtifacts(rendered, `item "${itemId}" (${type})`);
    // The whole rendered card, so one call covers name, triggers, notes and body — every
    // story-card field AID accepts a placeholder in.
    checkUndeclaredPlaceholders(rendered, placeholders, {
      diagnostics, file: item._source, where: `story card "${itemId}"`, branch: branchLabel,
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
function writeOpeningsRecursive(branches, outputBase, configBase, inheritedOpening, variables, currentPath = [], verbose = false, rootPlaceholders = null, diagnostics = null) {
  const writtenLeaves = new Set();

  const emitOpening = (spec, outputDir, leafPath, vars, table, where) => {
    // {@Key} expands in path mode here — the result is a path, not file contents.
    const expanded = spec;
    const yamlPath = resolveYamlOpeningPath(expanded, configBase, vars);
    const content = yamlPath
      ? compileOpening(loadOpeningConfig(yamlPath), leafPath, vars, configBase)
      : resolveOpeningContent(expanded, configBase, vars);
    if (!content) return;
    checkUndeclaredPlaceholders(content, table, {
      diagnostics, file: typeof spec === 'string' ? spec : undefined, where,
    });
    const outPath = writeComponentFile(outputDir, 'Opening.md', content);
    if (verbose) console.log(`    OK: Opening → ${outPath}`);
    writtenLeaves.add(leafPath.join('/') || '(root)');
  };

  // An unbranched project: the root is itself the only leaf.
  const rootTable = Object.assign({}, rootPlaceholders || {});
  if (!branches || typeof branches !== 'object') {
    if (inheritedOpening != null) {
      emitOpening(inheritedOpening, outputBase, currentPath, variables, rootTable, 'the Opening');
    }
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

    const table = mergePlaceholders(state.table, node);

    if (framing != null) {
      if (isLeaf) {
        console.warn(`  WARN: branchFraming on leaf branch "${name}" — ignoring`);
      } else {
        const framingText = resolveOpeningContent(framing, configBase, branchVars);
        checkUndeclaredPlaceholders(framingText, table, {
          diagnostics, where: `the branch framing on "${name}"`,
        });
        const outPath = writeComponentFile(nodeOutput, 'Opening.md', framingText);
        if (verbose) console.log(`    OK: OpeningChoice → ${outPath}`);
      }
    }

    if (isLeaf && effectiveOpening != null) {
      emitOpening(
        effectiveOpening, nodeOutput, [...currentPath, ...nodePath], branchVars, table,
        `the Opening on branch "${name}"`,
      );
    }

    return {
      outputBase: nodeOutput, inheritedOpening: effectiveOpening, variables: branchVars, table,
    };
  }, { outputBase, inheritedOpening, variables, table: rootTable });

  return writtenLeaves;
}

/**
 * Write Label.md at every node in the branch tree.
 *
 * Node-level, not leaf-level, which is why it uses the tree visitor rather than the
 * leaf loop: a branch label belongs to the node the player is choosing.
 */
function writeLabelsRecursive(branches, outputBase, variables, verbose = false, rootPlaceholders = null, diagnostics = null, configPath = null) {
  walkBranchTree(branches, ({ name, node, state }) => {
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
function writePlaceholdersRecursive(branches, outputBase, rootPlaceholders, variables, configPath, diagnostics, verbose = false) {
  const onWarn = (code, message, file) => diagnostics.add(
    severityOf(code), code, message, { file: file || configPath },
  );

  const rootNode = { placeholders: rootPlaceholders };
  const rootTable = Object.assign({}, rootPlaceholders || {});
  const written = writeNodePlaceholders(outputBase, rootNode, rootTable, variables, {
    onWarn, file: configPath, diagnostics,
  });
  if (written && verbose) console.log(`    OK: Placeholders → ${written}`);

  walkBranchTree(branches, ({ name, node, state }) => {
    const nodeOutput = path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    // The merged table at this node, by the same rules `walkBranchChain` applies along a
    // path: local keys override inherited ones, `~` deletes. Accumulated here rather than
    // looked up because the tree walk already has the chain in hand as `state`.
    const table = mergePlaceholders(state.table, node);

    const outPath = writeNodePlaceholders(nodeOutput, node, table, branchVars, {
      onWarn, file: configPath, diagnostics,
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

  const config = loadCompileConfig(configPath, { diagnostics: loadDiagnostics });

  // Checked immediately, before any filesystem work — an unknown key, a missing required
  // field, or a bad path token in compile.yaml itself must stop the compile before
  // mkdirSync ever runs, not merely before the compiled tree is written. Folding this into
  // the single check below meant a config error still created the output directory and
  // read canon/item files from disk before the throw was reached.
  let loadCursor = reportLoadDiagnostics(loadDiagnostics);

  fs.mkdirSync(config._resolvedOutput, { recursive: true });

  const { templates, partials } = loadTemplates(config._resolvedTemplates, { diagnostics: loadDiagnostics });
  // Checked before anything renders: a template that still carries a fence would emit a
  // double envelope on every card it owns (§8.3), and the report names the files. The
  // notes-template check needs both halves in hand, so it runs against the same bus.
  checkConfigNotesTemplates(config, templates, loadDiagnostics, configPath);
  loadCursor = reportLoadDiagnostics(loadDiagnostics, loadCursor);
  console.log(`Loaded ${templates.size} template(s)${partials.size ? `, ${partials.size} partial(s)` : ''}.`);

  // Build canon registry
  const canonRegistry = buildCanonRegistry(config._resolvedCanon, { diagnostics: loadDiagnostics });
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
  const sectionedDocs = new Map();
  const loadSectioned = (spec, descriptor) => {
    if (!sectionedDocs.has(spec)) {
      sectionedDocs.set(spec, loadComponentDocument(spec, {
        diagnostics: compileDiagnostics, label: descriptor.label,
      }));
    }
    return sectionedDocs.get(spec);
  };

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
      resolvedItems, registry, templates, partials, outputDir, branchProtagonist, ctx.variables, verbose, renderedById,
      (compileContext.render && compileContext.render.notesTemplate) || null,
      compileDiagnostics, slotIndex, label, ctx.placeholders
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
      if (passthrough !== null && passthrough !== undefined) {
        // Prose has no sections to render, warn about, or report separately. It is one
        // segment keyed by the component so the cross-branch reports still name it.
        text = passthrough;
        segments = [{ key: descriptor.label, text: passthrough }];
      } else {
        warnEmptySlots(descriptor, slotIndex, filled, label, compileDiagnostics, spec);
        ({ text, segments } = renderSectionedComponent(
          component, branchPath, filled,
          {
            defaultHeadingLevel: descriptor.defaultHeadingLevel,
            variables: ctx.variables, registry, branchProtagonist,
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
      });

      const outPath = writeSectionedComponent(outputDir, descriptor, text);
      if (outPath) {
        sectionedWritten[descriptor.key] = true;
        sectionedSegments[descriptor.key] = segments;
        if (verbose) console.log(`    OK: ${descriptor.verboseLabel} → ${outPath}`);
        totalFiles++;
      } else {
        // §7.4: a component that renders to nothing is an ERROR, not a gap. The gap list
        // is for a component that was asked for and could not be found; this one was
        // found, read, and had every section resolve away, which is a statement about
        // the source that no amount of re-reading the path will explain.
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
        components: {
          // Every sectioned component reports per section, keyed by section name. The
          // cross-branch reports diff component content by segment key, so per-section
          // keys localize a difference to the section that carries it rather than
          // reporting the whole component as changed — which is what §7.2's naming bought
          // Plot Essentials, and there is no reason the prose components report worse.
          plotEssentials: sectionedSegments.plotEssential || [],
          aiInstructions: sectionedSegments.aiInstructions || [],
          authorsNote:    sectionedSegments.authorsNote || [],
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
    [], verbose, config.placeholders, compileDiagnostics
  );

  writeLabelsRecursive(
    config.branches, config._resolvedOutput, config._variables || config.variables || {}, verbose,
    config.placeholders, compileDiagnostics, configPath,
  );

  writePlaceholdersRecursive(
    config.branches, config._resolvedOutput, config.placeholders,
    config._variables || config.variables || {}, configPath, compileDiagnostics, verbose,
  );
  reportCompileDiagnostics();

  // Root Label (project-level, written once to output root alongside Description.md)
  if (config.title != null) {
    const rootLabel = resolveVariables(String(config.title), config.variables || {});
    const labelPath = path.join(config._resolvedOutput, 'Label.md');
    checkUndeclaredPlaceholders(rootLabel, config.placeholders, {
      diagnostics: compileDiagnostics, file: configPath, where: 'the project title',
    });
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
    // Description is project-level, so it is checked against the root table — there is
    // no branch whose declarations could apply to it.
    checkUndeclaredPlaceholders(combined, config.placeholders, {
      diagnostics: compileDiagnostics, file: descSpec, where: 'the Description',
    });
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
  console.log(`\n${allItemIds.size} unique items across project. Wrote ${totalFiles} file(s).`);

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
  if ((captureReports && leafData.length > 0) || (options.inventory && inventoryData.length > 0)) {
    const reportBase = config._resolvedReports || path.join(config._resolvedOutput, 'Overview');
    const { runDiffMode, runAnnotateMode } = require('./diff');
    const reportSummary = [];
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
      outputDir:    cfg._resolvedReports || path.join(cfg._resolvedOutput, 'Overview'),
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
    ['diff',       ['--with-diff',     '--diff',     '-d']],
    ['annotate',   ['--with-annotate', '--annotate', '-a']],
    ['inventory',  ['--with-inventory', '--inventory', '-i']],
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

  // --with-diff / --with-annotate need data captured during compilation (the on-disk markdown is
  // lossy), so they are compile *options* — they force a compile rather than reading the
  // output dir like the post-hoc report modes (--leafReview/--overview/--seed-map/--card-sizes).
  const doCompile    = flags.compile || flags.diff || flags.annotate || flags.inventory ||
    (!flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes && !flags.lint);
  const doLeafReview = flags.leafReview;
  const doOverview   = flags.overview;
  const doSeedMap    = flags.seedMap;
  const doCardSizes  = flags.cardSizes;
  const doLint       = flags.lint;

  if (positional.length === 0 && !flags.compile && !flags.diff && !flags.annotate &&
      !flags.inventory &&
      !flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes && !flags.lint) {
    console.error(
      'Usage: codex-loom [mode flags] [compile options] [<folder | compile.yaml>]\n' +
      '  Modes (what runs):     --compile|-C  --leafReview|-l  --overview|-o  --seed-map|-s  --card-sizes|-b  --lint|-L\n' +
      '  Compile options:       --with-diff|-d  --with-annotate|-a  --with-inventory|-i  --clean|-c  --verbose|-v\n' +
      '  No mode flag compiles. Report modes read the existing output tree; compile options force a compile.'
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
        compile(configPath, {
          clean: flags.clean, verbose: flags.verbose,
          diff: flags.diff, annotate: flags.annotate, inventory: flags.inventory,
        });
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
        if (result) summaryParts.push('a card sizes file');
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
