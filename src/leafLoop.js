'use strict';

const { walkBranchChain } = require('./model/branches');
const { busWarner, CODES: DIAG_CODES } = require('./diag');
const {
  buildCompileContext, resolveBranchItems, renderBranchItems,
} = require('./branchCompile');
const {
  resolveSectionedComponents, buildSlotIndex, warnEmptySlots,
  selectComponentSections, renderComponentStoryCards,
} = require('./slots');
const {
  renderSectionedComponent, writeSectionedComponent, resolveComponentMetadata,
} = require('./emit/components');
const { applyTokenPass } = require('./model/pronouns');
const { resolveVariables } = require('./util');
const { checkUndeclaredPlaceholders } = require('./emit/placeholders');
const { LIMITS, checkLimit } = require('./limits');
const { questionsForMeasurement } = require('./treeWrite');
const { buildBranchOutputDir } = require('./outputPaths');

const LIFT_EXCLUDED_COMPONENTS = new Set(['opening', 'adventureDescription']);

function compileLeaf(branchPath, ctx) {
  const {
    config, configPath, options, log,
    diagnostics,
    allItemDefs, registry, templates, partials,
    fieldTable, fieldAudit, cardTypeAudit,
    rootDirName, captureReports,
    placeholderState, roleState, gaps, componentLoader, roleStateByPath,
    deferredComponents, deferredScripts, deferredCardLeaves,
    descriptionLeaves, openingLeaves,
    leafData, inventoryData, leafSummaries, allItemIds,
  } = ctx;

  let leafFiles = 0;
  const label = branchPath.length > 0 ? branchPath.join('/') : '(root)';
  log.verbose(`\n  Branch: ${label}`);

  const chain = walkBranchChain(config.branches, branchPath);
  const folderPath = chain.folderPath;
  const outputDir = buildBranchOutputDir(config._resolvedOutput, folderPath);
  const cctx = buildCompileContext(config, branchPath, {
    onWarn: busWarner(diagnostics, { file: configPath, branch: label }),
    diagnostics,
    configPath,
    roleStateByPath,
  });
  const branchProtagonist = cctx.branchProtagonist;

  const resolvedItems = resolveBranchItems(allItemDefs, registry, branchPath, cctx.variables, diagnostics);

  for (const item of resolvedItems) {
    if (item.id) allItemIds.add(item.id.toLowerCase());
  }
  const leafItems    = resolvedItems.length;
  const leafVariants = resolvedItems.filter(c => c._hasVariant).length;

  const sectionedForLeaf = resolveSectionedComponents(cctx, label, {
    loadSectioned: componentLoader.load, recordGap: gaps.record,
  });
  const slotIndex = buildSlotIndex(sectionedForLeaf, branchPath);

  const renderedById = captureReports ? new Map() : null;
  const { grouped: leafCardGroups, occupants, placeholderNoise } = renderBranchItems(
    resolvedItems, registry, templates, partials, branchProtagonist, cctx.variables,
    {
      renderedById,
      projectNotesTemplate: (cctx.render && cctx.render.notesTemplate) || null,
      diagnostics, slotIndex, branchLabel: label, placeholders: cctx.placeholders,
      usage: placeholderState.usage, usagePath: branchPath.join('/'),
      roles: cctx.roles, onRoleUsed: roleState.onUsed,
      fieldTable, templateFor: cctx.templateFor, fieldAudit, cardTypeAudit,
    },
  );
  deferredCardLeaves.push({
    branchPath, folderPath, outputDir, grouped: leafCardGroups,
    lint: cctx.lint, variables: cctx.variables, resolvedItems,
  });

  if (options.inventory) {
    inventoryData.push(
      require('./inventory').captureLeafInventory(
        label, branchPath, sectionedForLeaf, slotIndex, occupants,
      ),
    );
  }

  const sectionedWritten = {};
  const sectionedSegments = {};
  for (const { descriptor, spec, component, passthrough } of sectionedForLeaf) {
    const filled = occupants.get(descriptor.key) || new Map();
    let text;
    let segments;
    let excluded = false;
    if (passthrough !== null && passthrough !== undefined) {
      const prose = resolveVariables(passthrough, cctx.variables, {
        diagnostics, file: String(spec),
      });
      text = descriptor.inlineProse
        ? applyTokenPass(prose, {
          item: {}, registry, branchProtagonist,
          roles: cctx.roles, onRoleUsed: roleState.onUsed,
          onWarn: busWarner(diagnostics, { file: String(spec), branch: label }),
        })
        : prose;
      segments = [{ key: descriptor.label, text }];
    } else {
      warnEmptySlots(descriptor, slotIndex, filled, label, diagnostics, spec);
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
          onWarn: busWarner(diagnostics, { file: String(spec), branch: label }),
          diagnostics, file: String(spec),
        },
      ));
    }
    checkUndeclaredPlaceholders(text, cctx.placeholders, {
      diagnostics,
      file: String(spec),
      where: `component "${descriptor.label}"`,
      branch: label,
      skip: placeholderNoise.get(descriptor.key),
      usage: placeholderState.usage,
      usagePath: branchPath.join('/'),
    });

    if (descriptor.limitKey && text) {
      checkLimit(
        text,
        questionsForMeasurement(cctx.placeholders, cctx.variables, {
          registry, roles: cctx.roles, branchProtagonist, onRoleUsed: roleState.onUsed,
        }),
        LIMITS[descriptor.limitKey],
        {
          diagnostics,
          loc: { file: String(spec) },
          label: branchPath.length ? `branch "${branchPath[branchPath.length - 1]}"` : 'the project root',
        },
      );
    }

    const metadata = component ? resolveComponentMetadata(component.metadata, cctx.variables, {
      diagnostics, file: String(spec),
    }) : null;
    let wrote;
    if (text && LIFT_EXCLUDED_COMPONENTS.has(descriptor.key)) {
      const outPath = writeSectionedComponent(
        outputDir, descriptor, text, { diagnostics }, metadata,
      );
      wrote = !!outPath;
      if (outPath) {
        log.verbose(`    OK: ${descriptor.verboseLabel} → ${outPath}`);
        leafFiles += 1;
      }
    } else if (text) {
      let entry = deferredComponents.get(descriptor.key);
      if (!entry) {
        entry = { descriptor, perLeaf: new Map() };
        deferredComponents.set(descriptor.key, entry);
      }
      entry.perLeaf.set(outputDir, { text, metadata });
      wrote = true;
    } else {
      wrote = false;
    }
    if (wrote) {
      sectionedWritten[descriptor.key] = true;
      sectionedSegments[descriptor.key] = segments;
      if (descriptor.key === 'adventureDescription') descriptionLeaves.add(label);
      if (descriptor.key === 'opening') openingLeaves.add(label);
    } else if (!excluded) {
      diagnostics.error(
        DIAG_CODES.COMPONENT_RENDERS_NOTHING,
        `component "${descriptor.label}" renders to nothing on branch "${label}" — `
        + 'every section is excluded by its own branches: dispatch, empty, or an unfilled slot. Add renderable content or exclude the component there.',
        { file: String(spec) },
      );
    }

    if (!excluded && component && component.render) {
      renderComponentStoryCards(component, descriptor, branchPath, filled, leafCardGroups, {
        variables: cctx.variables, registry, branchProtagonist,
        roles: cctx.roles, onRoleUsed: roleState.onUsed,
        diagnostics,
        questions: questionsForMeasurement(cctx.placeholders, cctx.variables, {
          registry, roles: cctx.roles, branchProtagonist, onRoleUsed: roleState.onUsed,
        }),
        storyCardType: config.storyCardType,
        spec, branchLabel: label, cardTypeAudit,
      });
    }
  }
  const hasPE = !!sectionedWritten.plotEssential;
  const hasAIN = !!sectionedWritten.aiInstructions;
  const hasAN = !!sectionedWritten.authorsNote;

  const scriptsSpec = cctx.componentRefs.scripts;
  if (scriptsSpec && typeof scriptsSpec === 'string') {
    deferredScripts.set(outputDir, scriptsSpec);
  }

  if (captureReports) {
    leafData.push({
      label,
      branchPath,
      fileBase: branchPath.length ? branchPath.join(' - ') : rootDirName,
      items: renderedById,
      components: { ...sectionedSegments },
    });
  }

  leafSummaries.push({ label, leafItems, leafVariants, hasPE, hasAIN, hasAN });
  return leafFiles;
}

function runLeafLoop(ctx) {
  let filesWritten = 0;
  for (const branchPath of ctx.leaves) {
    filesWritten += compileLeaf(branchPath, ctx);
  }
  return filesWritten;
}

module.exports = { runLeafLoop };
