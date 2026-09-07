'use strict';

const fs = require('fs');
const path = require('path');
const { CODES: DIAG_CODES } = require('./diag');
const { isOutOfBase, normalize } = require('./config/load');
const { reportUnusedPlaceholders, reportDuplicateQuestions } = require('./emit/placeholders');

function reportUnusedRoles(declarations, usage, { diagnostics, file }) {
  const unused = [];
  for (const { label, keys } of declarations) {
    for (const key of keys) {
      if (usage.has(key.toLowerCase())) continue;
      unused.push(key);
      diagnostics.warn(
        DIAG_CODES.ROLE_UNUSED,
        `role "${key}" is declared ${label} but no resolved token references it, so its binding has no effect; use or remove the role.`,
        { file: file == null ? undefined : String(file) },
      );
    }
  }
  return unused;
}

function buildLibraryManifest(config) {
  const { findFiles } = require('./util');
  const manifest = {};
  for (const [name, resolvedPath] of config._resolvedLibrary) {
    const expression = config._libraryRaw ? String(config._libraryRaw[name] ?? resolvedPath) : resolvedPath;
    const missing = !fs.existsSync(resolvedPath);
    const files = missing ? [] : findFiles(resolvedPath, '.yaml');
    manifest[name] = { expression, resolvedPath, files, ...(missing ? { missing: true } : {}) };
  }
  return manifest;
}

function runReports({
  config, configPath, options, log, registry, rootDirName,
  fieldTable, tierTemplates, captureReports, leafData, inventoryData, allItemDefs,
}) {
  const reportBase = config._resolvedReports || path.join(config._resolvedOutput, 'Overview');
  const reportSummary = [];

  const { runProvenanceMode } = require('./provenance');
  const provenanceResult = runProvenanceMode(
    registry, reportBase, rootDirName, path.dirname(configPath),
  );
  reportSummary.push(`${provenanceResult.written.length} provenance file(s)`);

  if (options.schemaTables) {
    const { runSchemaTablesMode } = require('./schematables');
    const w = runSchemaTablesMode(fieldTable, path.join(reportBase, 'schema-tables'),
      { title: config.title || rootDirName, tierTemplates });
    reportSummary.push(`${w.written.length} schema-tables file(s)`);
  }

  if ((captureReports && leafData.length > 0) || (options.inventory && inventoryData.length > 0)) {
    const { runDiffMode, runAnnotateMode } = require('./diff');
    if (options.inventory) {
      fs.mkdirSync(reportBase, { recursive: true });
      const w = require('./inventory').runInventoryMode(inventoryData, reportBase);
      reportSummary.push(`${w.written.length} inventory file(s)`);
    }
    if (options.diff) {
      const diffDir = path.join(reportBase, 'diff');
      fs.mkdirSync(diffDir, { recursive: true });
      const w = runDiffMode(leafData, diffDir);
      reportSummary.push(`${w.written.length} diff file(s) (Shared + deltas)`);
    }
    if (options.annotate) {
      const annotateDir = path.join(reportBase, 'annotate');
      fs.mkdirSync(annotateDir, { recursive: true });
      const w = runAnnotateMode(leafData, allItemDefs, registry, annotateDir);
      reportSummary.push(`${w.written.length} annotation file(s)`);
    }
  }
  if (reportSummary.length > 0) {
    log.info(`\nWrote ${reportSummary.join(' and ')} to:\n  ${reportBase}`);
  }
}

function finalizeDiagnostics({
  config, configPath, options, log,
  diagnostics,
  descriptionLeaves, openingLeaves, leafSummaries,
  allItemIds, totalFiles, componentLoader,
  roleState, placeholderState, gaps, fieldAudit, cardTypeAudit,
  registry, rootDirName, fieldTable, tierTemplates,
  captureReports, leafData, inventoryData, allItemDefs,
}) {
  for (const leafLabel of descriptionLeaves) {
    if (openingLeaves.has(leafLabel)) continue;
    diagnostics.error(
      DIAG_CODES.LEAF_DESCRIPTION_NO_OPENING,
      `branch "${leafLabel}" has an adventure description and no Opening.md. Velvet Lattice `
      + 'reads a node\'s prompt as its Opening or, failing that, its description — so this '
      + 'leaf would open the adventure with its own blurb rather than a scene. Give the '
      + 'branch an opening:, or drop the adventureDescription: it inherits.',
      { file: configPath },
    );
  }

  for (const s of leafSummaries) {
    if (!openingLeaves.has(s.label) && !descriptionLeaves.has(s.label)) {
      diagnostics.warn(
        DIAG_CODES.LEAF_NO_OPENING,
        `branch "${s.label}" resolves no opening: and no adventureDescription:, so Velvet `
        + 'Lattice would start this leaf with an empty prompt. Give the branch an opening:, '
        + 'or one an ancestor passes down.',
        { file: configPath },
      );
    }
    if (!s.hasAIN) {
      diagnostics.warn(
        DIAG_CODES.LEAF_NO_AIN,
        `branch "${s.label}" resolves no aiInstructions:. Velvet Lattice writes an `
        + 'empty-string AI Instructions on AID\'s side for it, and an empty string suppresses '
        + 'AID\'s model-default instructions rather than falling back to them — the leaf plays '
        + 'with none at all. Give the branch an aiInstructions:, or one an ancestor passes down.',
        { file: configPath },
      );
    }
  }

  for (const s of leafSummaries) {
    s.hasOpening = openingLeaves.has(s.label);
  }
  const maxLabelLen = Math.max(...leafSummaries.map(s => s.label.length), 'Branch'.length);
  const lp = maxLabelLen + 2;
  const c = b => b ? ' ✓ ' : ' - ';
  log.info(`\n  ${'Branch'.padEnd(lp)} ${'Items'.padStart(5)}  ${'Var'.padStart(3)}   Open   PE  AIN   AN`);
  for (const s of leafSummaries) {
    log.info(
      `  ${s.label.padEnd(lp)} ${String(s.leafItems).padStart(5)}  ${String(s.leafVariants).padStart(3)}  ` +
      ` ${c(s.hasOpening)}  ${c(s.hasPE)} ${c(s.hasAIN)} ${c(s.hasAN)}`
    );
  }
  log.info(`\n${allItemIds.size} unique items across project. Wrote ${totalFiles} file(s).`);

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
    log.verbose(`  OK: Library manifest → ${manifestPath}`);
  }

  const libraryDirs = [...config._resolvedLibrarySource.values()];
  for (const specPath of componentLoader.dependencyLedger) {
    if (!isOutOfBase(specPath, config._base)) continue;
    const norm = normalize(specPath);
    const covered = libraryDirs.some((dir) => {
      const normDir = normalize(dir);
      return norm === normDir || norm.startsWith(`${normDir}/`);
    });
    if (!covered) {
      diagnostics.warn(
        DIAG_CODES.LIBRARY_DEPENDENCY_UNCOVERED,
        `This component is read from outside the project (${specPath}), and no `
        + 'structure.input.library entry covers it — --snapshot will not freeze it, so '
        + 'live edits change every project that reaches it. Declare its directory as a '
        + 'library entry to freeze it.',
        { file: specPath },
      );
    }
  }

  runReports({
    config, configPath, options, log, registry, rootDirName,
    fieldTable, tierTemplates, captureReports, leafData, inventoryData, allItemDefs,
  });

  reportUnusedRoles(roleState.declarations, roleState.usage, { diagnostics, file: configPath });
  fieldAudit.finish(diagnostics);
  cardTypeAudit.finish(diagnostics);
  reportUnusedPlaceholders(placeholderState.declarations, placeholderState.usage, {
    diagnostics, file: configPath,
  });
  reportDuplicateQuestions(placeholderState.duplicates, {
    diagnostics, file: configPath,
  });

  for (const g of gaps.entries) {
    diagnostics.error(
      DIAG_CODES.COMPONENT_NO_OUTPUT,
      `[${g.leaf}] ${g.component}: ${g.reason} (spec: ${g.spec})`,
      { file: configPath },
    );
  }
}

module.exports = { finalizeDiagnostics };
