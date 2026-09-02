'use strict';

const { walkBranchChain } = require('./model/branches');
const { busWarner, CODES: DIAG_CODES } = require('./diag');
const { resolveVariables } = require('./util');
const {
  resolveSectionedComponents, buildSlotIndex, warnEmptySlots,
  selectComponentSections, renderComponentStoryCards,
} = require('./slots');
const { renderSectionedComponent, writeSectionedComponent } = require('./emit/components');
const { applyTokenPass } = require('./model/pronouns');
const { checkUndeclaredPlaceholders } = require('./emit/placeholders');
const { LIMITS, checkLimit } = require('./limits');
const { questionsForMeasurement } = require('./treeWrite');
const { buildBranchOutputDir } = require('./outputPaths');

//   - `opening` is excluded from the inheritance lift: it shares the `Opening.md` filename
//     with `branchFraming`, which `writeFramingRecursive` writes at every interior node, so
//     an inherited opening lifted above a leaf would be shadowed by the nearest ancestor's
//     framing question. It stays written at the leaf.
//   - `adventureDescription` is excluded: VL reads `Description.md` from the node's own
//     directory and does not inherit it (`scenario.py`), so the file has to land at each
//     leaf regardless of Codex Loom's own key-merge (`emit/components.js`).
const LIFT_EXCLUDED_COMPONENTS = new Set(['opening', 'adventureDescription']);

/**
 * The per-leaf compile. For each branch leaf: walk the chain, build the compile context,
 * resolve and render the story cards and the sectioned components, then either write the
 * two leaf-held components (`opening`, `adventureDescription`) or defer the rest to the
 * post-loop inheritance pass. Every collection this mutates — the deferred maps, the
 * CL0616 sets, the report-capture arrays, the placeholder/role trackers — is passed in and
 * mutated in place; the only value returned is the count of files actually written here.
 */
function compileLeaf(branchPath, ctx) {
  const {
    config, configPath, options, verbose,
    diagnostics, flushDiagnostics,
    allItemDefs, registry, templates, partials,
    fieldTable, fieldAudit, cardTypeAudit,
    rootDirName, captureReports,
    buildCompileContext, resolveBranchItems, renderBranchItems,
    placeholderState, roleState, gaps, componentLoader,
    deferredComponents, deferredScripts, deferredCardLeaves,
    descriptionLeaves, openingLeaves,
    leafData, inventoryData, leafSummaries, allItemIds,
  } = ctx;

  let leafFiles = 0;
  const label = branchPath.length > 0 ? branchPath.join('/') : '(root)';
  if (verbose) console.log(`\n  Branch: ${label}`);

  // One traversal serves four things at once: the folder path, the inherited roles table
  // (`protagonist` is `roles.protagonist`), the terminal node, and (inside
  // buildCompileContext) the merged variables and components.
  const chain = walkBranchChain(config.branches, branchPath, {
    rootRoles: config.roles || {},
  });
  // Always a string: an absent `roles.protagonist` merges to `undefined`, and
  // `resolveVariables` below requires a string input.
  const inheritedProtagonist = chain.roles.protagonist || '';
  const folderPath = chain.folderPath;
  const outputDir = buildBranchOutputDir(config._resolvedOutput, folderPath);
  const cctx = buildCompileContext(config, branchPath, {
    onWarn: busWarner(diagnostics, { file: configPath }),
    diagnostics,
    configPath,
  });
  // Expand {%var} in protagonist using branch-merged variables, before the
  // case-insensitive match against item ids. No bus: this runs per leaf, and an undeclared
  // name in the protagonist string is one config mistake, not one per branch — the config
  // load and the role resolver own that diagnostic.
  const branchProtagonist = resolveVariables(inheritedProtagonist, cctx.variables).toLowerCase() || null;
  const compileContext = { branchPath, branchProtagonist, ...cctx, diagnostics };

  // Phase A: resolve all story cards
  const resolvedItems = resolveBranchItems(allItemDefs, registry, branchPath, cctx.variables, diagnostics);

  // Accumulate unique item IDs and per-leaf stats for summary
  for (const item of resolvedItems) {
    if (item.id) allItemIds.add(item.id.toLowerCase());
  }
  const leafItems    = resolvedItems.length;
  const leafVariants = resolvedItems.filter(c => c._hasVariant).length;

  // The sectioned components are resolved *before* the items that fill them, because two
  // of the placement ERRORs — undeclared slot, and a section that is not a slot — are
  // questions about the component that only the item's target can ask. Loading here lets
  // them be raised where the placement is made rather than a hundred lines later, at a
  // point that no longer knows which item was responsible. `componentLoader.load` caches by
  // resolved path, so a per-leaf hoist costs one Map lookup.
  const sectionedForLeaf = resolveSectionedComponents(compileContext, label, {
    loadSectioned: componentLoader.load, recordGap: gaps.record,
  });
  const slotIndex = buildSlotIndex(sectionedForLeaf, branchPath);

  // Phase B: cross-item refs + pronouns + render + write. One pass produces the story
  // cards and the component occupants together — see renderBranchItems.
  const renderedById = captureReports ? new Map() : null;
  const { grouped: leafCardGroups, occupants, placeholderNoise } = renderBranchItems(
    resolvedItems, registry, templates, partials, outputDir, branchProtagonist, cctx.variables,
    {
      verbose, renderedById,
      projectNotesTemplate: (compileContext.render && compileContext.render.notesTemplate) || null,
      diagnostics, slotIndex, branchLabel: label, placeholders: cctx.placeholders,
      usage: placeholderState.usage, usagePath: branchPath.join('/'),
      roles: cctx.roles, onRoleUsed: roleState.onUsed,
      fieldTable, templateFor: cctx.templateFor, fieldAudit, cardTypeAudit,
    },
  );
  // Story cards are written after the loop, at the node that owns each one, so a card
  // constant across a subtree is written once and inherited rather than copied to every
  // leaf. `totalFiles` is credited there.
  deferredCardLeaves.push({
    branchPath, folderPath, outputDir, grouped: leafCardGroups,
    // For the post-loop `runPackChecks`: this leaf's branch-merged `lint` table and the
    // variables a pack `source:` path expands against. Captured here so the pack pass does
    // not re-walk the branch chain. `resolvedItems` is the structured, branch-merged item
    // set — `item.body.<field>` in its authored shape — which the `count` / `mutexHint`
    // rules read (`evaluatePackItemRules`).
    lint: cctx.lint, variables: cctx.variables, resolvedItems,
  });
  flushDiagnostics();

  if (options.inventory) {
    inventoryData.push(
      require('./inventory').captureLeafInventory(
        label, branchPath, sectionedForLeaf, slotIndex, occupants,
      ),
    );
  }

  // Sectioned components — all four of them. The shape comes from the component document,
  // the content from the items that named its slots. Order relative to story cards does
  // not matter here: nothing suppresses a component based on what a card emitted.
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
      //
      // An `inlineProse` component — `opening:` written as a sentence or as a prose `.md`
      // — still runs the role/pronoun token pass, so `{$LI}` in an inline opening resolves
      // exactly as it does in a `sections:` opening. Every other passthrough component (an
      // `aiInstructions:` `.md`, say) is copied verbatim; a stray `{$x}` there is caught by
      // the CL0430 output sweep in `writeSectionedComponent` like any other leaked token.
      text = descriptor.inlineProse
        ? applyTokenPass(passthrough, {
          item: {}, registry, branchProtagonist,
          roles: cctx.roles, onRoleUsed: roleState.onUsed,
          onWarn: busWarner(diagnostics, { file: String(spec) }),
        })
        : passthrough;
      segments = [{ key: descriptor.label, text }];
    } else {
      warnEmptySlots(descriptor, slotIndex, filled, label, diagnostics, spec);
      // `render.component.variant` selects which section-variant ships in the component
      // field. Absent (every golden today) it is a no-op and `component` renders as-is;
      // the slot set is unchanged either way because a variant cannot toggle `slot:`.
      const fieldVariant = component && component.render && component.render.component
        && typeof component.render.component.variant === 'string'
        ? component.render.component.variant.trim() : '';
      const fieldComponent = fieldVariant
        ? selectComponentSections(component, fieldVariant, null, null)
        : component;
      ({ text, segments, excluded = false } = renderSectionedComponent(
        fieldComponent, branchPath, filled,
        {
          defaultHeadingLevel: descriptor.defaultHeadingLevel,
          variables: cctx.variables, registry, branchProtagonist,
          roles: cctx.roles, onRoleUsed: roleState.onUsed,
          onWarn: busWarner(diagnostics, { file: String(spec) }),
          diagnostics, file: String(spec),
        },
      ));
    }
    // The assembled component. Occupant bodies were already scanned per placement above,
    // and `checkUndeclaredPlaceholders` reports once per key per site, so a name that
    // appears in both a section's own `text:` and an occupant is named twice — once
    // against the item, once against the component. Both are true and both are editable.
    checkUndeclaredPlaceholders(text, cctx.placeholders, {
      diagnostics,
      file: String(spec),
      where: `component "${descriptor.label}"`,
      branch: label,
      skip: placeholderNoise.get(descriptor.key),
      usage: placeholderState.usage,
      usagePath: branchPath.join('/'),
    });

    // Platform length caps, table-driven rather than per-component. Only `opening:` carries
    // a `limitKey` today; the point of the `LIMITS` table is that a new cap is a row rather
    // than another bespoke call site. Measured post-substitution because Velvet Lattice
    // expands `%key%` to its question text on the way to AID.
    if (descriptor.limitKey && text) {
      checkLimit(
        text,
        questionsForMeasurement(cctx.placeholders, cctx.variables),
        LIMITS[descriptor.limitKey],
        {
          diagnostics,
          loc: { file: String(spec) },
          label: branchPath.length ? `branch "${branchPath[branchPath.length - 1]}"` : 'the project root',
        },
      );
    }

    const metadata = component ? component.metadata : null;
    // A component that renders to something is written here only if it is one of the two
    // the leaf must hold itself; every other component's write is deferred to the post-loop
    // inheritance pass, which decides between one file at the declaring node and one per
    // leaf. `sectionedWritten`/`sectionedSegments` and the CL0616 sets are still filled
    // per leaf either way — the leaf *has* the component, whether it holds the bytes or
    // inherits them, and `--diff`/`--annotate` read those in-memory segments, not the tree.
    let wrote;
    if (text && LIFT_EXCLUDED_COMPONENTS.has(descriptor.key)) {
      const outPath = writeSectionedComponent(
        outputDir, descriptor, text, { diagnostics }, metadata,
      );
      wrote = !!outPath;
      if (outPath) {
        if (verbose) console.log(`    OK: ${descriptor.verboseLabel} → ${outPath}`);
        leafFiles += 1;
      }
    } else if (text) {
      let entry = deferredComponents.get(descriptor.key);
      if (!entry) {
        entry = { descriptor, metadata, perLeaf: new Map() };
        deferredComponents.set(descriptor.key, entry);
      }
      entry.perLeaf.set(outputDir, text);
      wrote = true;
    } else {
      wrote = false;
    }
    if (wrote) {
      sectionedWritten[descriptor.key] = true;
      sectionedSegments[descriptor.key] = segments;
      if (descriptor.key === 'adventureDescription') descriptionLeaves.add(label);
      // Openings are written here, so `openingLeaves` is built here — the two facts CL0616
      // compares are produced by one loop rather than by two passes that had to agree.
      if (descriptor.key === 'opening') openingLeaves.add(label);
    } else if (!excluded) {
      // A component that renders to nothing is an ERROR, not a gap. The gap list is for a
      // component that was asked for and could not be found; this one was found, read, and
      // had every section resolve away, which is a statement about the source that no
      // amount of re-reading the path will explain.
      //
      // A component-level `~` is exempt because it is not that statement. The author wrote
      // "not on this branch", and `~` means exactly that at this position as everywhere
      // else. Writing no file is the whole request.
      diagnostics.error(
        DIAG_CODES.COMPONENT_RENDERS_NOTHING,
        `component "${descriptor.label}" renders to nothing on branch "${label}" — `
        + 'every section is excluded by its own branches: dispatch, empty, or an unfilled slot.',
        { file: String(spec) },
      );
    }

    // After the component field, its `render.storyCards` alternates. They join
    // `leafCardGroups` here — after `renderBranchItems` has returned — so frontier
    // placement writes them with the real cards. Skipped when the component is excluded
    // from this branch (`~`): the author said "not on this branch", and an alternate copy
    // is still this branch getting the component.
    if (!excluded && component && component.render) {
      renderComponentStoryCards(component, descriptor, branchPath, filled, leafCardGroups, {
        variables: cctx.variables, registry, branchProtagonist,
        roles: cctx.roles, onRoleUsed: roleState.onUsed,
        diagnostics,
        questions: questionsForMeasurement(cctx.placeholders, cctx.variables),
        storyCardType: config.storyCardType,
        spec, branchLabel: label, cardTypeAudit,
      });
    }
  }
  const hasPE = !!sectionedWritten.plotEssential;
  const hasAIN = !!sectionedWritten.aiInstructions;
  const hasAN = !!sectionedWritten.authorsNote;

  // Scripts.
  //
  // Collected here, written by the inheritance pass. Velvet Lattice inherits a node's
  // `Scripts/` dir down its subtree (`scenario.py`: `self.scripts = {**parent, **local}`),
  // so a `scripts:` spec that resolves identically at every leaf and is redeclared by no
  // branch is written once at the output root, exactly as the deferred components are.
  // Anything else is written per leaf, at this leaf's `outputDir`.
  const scriptsSpec = compileContext.componentRefs.scripts;
  if (scriptsSpec && typeof scriptsSpec === 'string') {
    deferredScripts.set(outputDir, scriptsSpec);
  }

  if (captureReports) {
    leafData.push({
      label,
      branchPath,
      fileBase: branchPath.length ? branchPath.join(' - ') : rootDirName,
      items: renderedById,
      // Every sectioned component reports per section, keyed by section name, so a
      // cross-branch diff localizes a change to the section that carries it. Spread
      // rather than named, so every one of `SLOTTED_COMPONENTS` reaches `--diff`/
      // `--annotate` without this site needing to list them by hand; `description:` is
      // absent on purpose, since the scenario blurb is written once at the root and has
      // no per-leaf value to diff.
      components: { ...sectionedSegments },
    });
  }

  leafSummaries.push({ label, leafItems, leafVariants, hasPE, hasAIN, hasAN });
  return leafFiles;
}

/**
 * The leaf loop — `compileLeaf` per branch leaf, summing the files written. Returns that
 * count for the spine to fold into `totalFiles`.
 */
function runLeafLoop(ctx) {
  let filesWritten = 0;
  for (const branchPath of ctx.leaves) {
    filesWritten += compileLeaf(branchPath, ctx);
  }
  return filesWritten;
}

module.exports = { runLeafLoop, compileLeaf, LIFT_EXCLUDED_COMPONENTS };
