'use strict';

const fs = require('fs');
const path = require('path');
const { CODES: DIAG_CODES } = require('./diag');
const { CODES: LOAD_CODES, isOutOfBase, normalize } = require('./config/load');
const { reportUnusedPlaceholders, reportDuplicateQuestions } = require('./emit/placeholders');

/**
 * `CL0545`: a role declared and never referenced by a resolved token anywhere in the
 * compile. `resolveRole` in `model/pronouns.js` calls `onRoleUsed` only on a successful
 * bind, so `usage` names every role that actually did something.
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
 * Build a library dependency manifest for the output JSON file.
 */
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

/**
 * The report emitters (provenance, schema-tables, `--diff` / `--annotate` / `--inventory`).
 * Provenance is always emitted from registry data; the rest are opt-in. Called from
 * `finalizeDiagnostics` at the point the inline code emitted them — after the
 * dependency-coverage sweep, before the unused-roles / audit drains — so the console
 * ordering the integration snapshots capture does not move.
 */
function runReports({
  config, configPath, options, log, registry, rootDirName,
  fieldTable, tierTemplates, captureReports, leafData, inventoryData, allItemDefs,
}) {
  // Cross-branch review reports — emitted from the per-leaf data captured above.
  const reportBase = config._resolvedReports || path.join(config._resolvedOutput, 'Overview');
  const reportSummary = [];

  // Provenance report — always emitted from registry data, independent of leaf loop.
  // Source paths are reported relative to the project directory (the one holding the
  // compile config), so a shared report carries no machine-specific path and a committed
  // baseline compares equal to one compiled anywhere else.
  const { runProvenanceMode } = require('./provenance');
  const provenanceWritten = runProvenanceMode(
    registry, reportBase, rootDirName, path.dirname(configPath),
  );
  reportSummary.push(`${provenanceWritten.length} provenance file(s)`);

  // The generated field reference, opt-in. Derived from the merged field table, not the
  // leaf loop, and written in a form meant to be pasted into a hand-maintained schema doc.
  if (options.schemaTables) {
    const { runSchemaTablesMode } = require('./schematables');
    // Every template a branch's `templateFor` slot files produce, so a tier author can
    // diff a terse list against the full type in one place. `tierTemplates` was gathered
    // once beside the field audit (`gatherTierTemplates`), which needs the same set.
    const w = runSchemaTablesMode(fieldTable, path.join(reportBase, 'schema-tables'),
      { title: config.title || rootDirName, tierTemplates });
    reportSummary.push(`${w.length} schema-tables file(s)`);
  }

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
    log.info(`\nWrote ${reportSummary.join(' and ')} to:\n  ${reportBase}`);
  }
}

/**
 * Everything after the tree is on disk and before the two terminal throws: the
 * project-wide leaf-outcome checks (`CL0616`, `CL0630`/`CL0631`), the summary table, the
 * library manifest, the dependency-coverage sweep, the report emitters, and the "unused"
 * drains (roles, fields, card types, placeholders, duplicate questions) that are only
 * knowable once every write point has run. Everything it touches is read-only except the
 * compile bus. The spine keeps the `gaps.length` and `hasErrors()` throws.
 */
function finalizeDiagnostics({
  config, configPath, options, log,
  diagnostics,
  descriptionLeaves, openingLeaves, leafSummaries,
  allItemIds, totalFiles, componentLoader,
  roleState, placeholderState, gaps, fieldAudit, cardTypeAudit,
  registry, rootDirName, fieldTable, tierTemplates,
  captureReports, leafData, inventoryData, allItemDefs,
}) {
  // Velvet Lattice sets a node's prompt to `components["Opening"] or node.description`, so
  // a leaf carrying an adventure description and no Opening.md does not produce an empty
  // prompt — it opens the adventure with its own blurb rather than a scene. That is the
  // price of letting `adventureDescription:` be a per-node inherited component, and this
  // guard is what flags it.
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

  // A leaf that resolves neither an opening nor AI Instructions. Both are ordinary
  // inherited components (`buildCompileContext` merges them down the chain), so a `false`
  // here means nothing in the leaf's ancestry set one — not merely that this node did not.
  // Read from `leafSummaries` because a leaf's opening status is only final once every
  // component write, inherited ones included, has run. A leaf covered by the CL0616 ERROR
  // above (has a description, no opening) is not also flagged CL0630.
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

  // Per-leaf summary table (printed after all component writes so Opening status is known)
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
    log.verbose(`  OK: Library manifest → ${manifestPath}`);
  }

  // Dependency-coverage check: the ledger is every resolved component path this compile
  // actually read, `imports:` chains included (built inside `ComponentLoader`). A component
  // that lives outside the project but under no `structure.input.library` entry compiles
  // and renders correctly today and is invisible to `--snapshot` — the freeze walks
  // declared entries, not resolved dependencies, so nothing else notices the gap. Checked
  // once, here, rather than per leaf: the ledger is already deduplicated by resolved path.
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

  runReports({
    config, configPath, options, log, registry, rootDirName,
    fieldTable, tierTemplates, captureReports, leafData, inventoryData, allItemDefs,
  });

  // Last, because "unused" is only knowable once every write point has run — and the
  // Description and the scenario title are written after the branch tree.
  reportUnusedRoles(roleState.declarations, roleState.usage, { diagnostics, file: configPath });
  // The deduped unread-field findings, then the whole-table dead-declaration sweep.
  fieldAudit.finish(diagnostics);
  // CL0626–CL0628, here for the same reason: the fold warns once per authored value across
  // the whole compile, and a case collision is only visible once every branch's types are in.
  cardTypeAudit.finish(diagnostics);
  reportUnusedPlaceholders(placeholderState.declarations, placeholderState.usage, {
    diagnostics, file: configPath,
  });
  reportDuplicateQuestions(placeholderState.duplicates, {
    diagnostics, file: configPath,
  });

  // Requested-but-unwritten components: surface as an error so the gap is never silent.
  // Raised onto the bus before the spine's `hasErrors()` check in `compile.js`, which is
  // why a gap fails the run — nothing here prints it; the CLI prints the bus.
  for (const g of gaps.entries) {
    diagnostics.error(
      DIAG_CODES.COMPONENT_NO_OUTPUT,
      `[${g.leaf}] ${g.component}: ${g.reason} (spec: ${g.spec})`,
      { file: configPath },
    );
  }
}

module.exports = { finalizeDiagnostics };
