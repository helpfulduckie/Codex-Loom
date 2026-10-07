'use strict';

const path = require('path');
const { loadTemplates } = require('./loader');
const {
  branchTreeDeclares, enumerateLeaves, walkBranchTree,
  localRoleKeysOf, mergeUnbindable,
} = require('./model/branches');
const { buildFieldAudit } = require('./render/field-audit');
const { resolveVariables, getCI } = require('./util');
const { buildCardTypeAudit } = require('./cardType');
const {
  checkConfigNotesTemplates, gatherTierTemplates,
} = require('./templateResolve');
const { sweepOutput } = require('./outputPaths');
const {
  startOutputLedger, takeOutputLedger, takeCapturedOutput, ensureOutputDir,
} = require('./outputLedger');
const {
  loadItemsFromDir, buildRegistry, mergeRegistries,
  resolveIncludes, buildCanonRegistry,
} = require('./loader/registry');
const { Diagnostics, CODES: DIAG_CODES } = require('./diag');
const { parseCards } = require('./emit/vl');
const {
  loadPack, evaluatePack, evaluatePackExistence, evaluatePackItemRules, clampFinding,
} = require('./lint/packs');
const { checkDrift } = require('./snapshot');
const { loadCompileConfig } = require('./config/load');
const { placeInheritedFiles } = require('./inherit');
const { runLeafLoop } = require('./leafLoop');
const { writeTreeFiles, writeScenarioBlurb, resolveComponentSpec } = require('./treeWrite');
const { checkComponentKeys } = require('./loader/component');
const { isPassthrough } = require('./emit/components');
const { finalizeDiagnostics } = require('./reportDispatch');
const {
  PlaceholderTracker, RoleTracker, GapList, ComponentLoader,
} = require('./compileState');
const { NULL_LOG } = require('./log');
const { withSourceOverrides } = require('./sources');


function resolveRoles(config, configPath, diagnostics) {
  const byPath = new Map();
  walkBranchTree(config, ({ node, path: nodePath, isRoot, state }) => {
    const variables = mergeUnbindable(state.variables, node && node.variables, {
      code: DIAG_CODES.VARIABLE_UNBIND_UNKNOWN, kind: 'variable', onWarn: null,
    });
    const raw = mergeUnbindable(state.raw, node && node.roles, {
      code: DIAG_CODES.ROLE_UNBIND_UNKNOWN, kind: 'role', onWarn: null,
    });
    const declared = state.declared || !!(node && node.roles);
    const changed = isRoot || !!(node && node.variables && Object.keys(node.variables).length)
      || !!(node && node.roles && Object.keys(node.roles).length);
    const resolved = changed
      ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [
        key, resolveVariables(value, variables, { diagnostics, file: configPath }),
      ]))
      : state.resolved;
    const protagonistId = getCI(resolved, 'protagonist');
    const protagonist = protagonistId
      ? String(protagonistId).toLowerCase()
      : null;
    const roleInfo = { raw, resolved, declared, protagonist };
    byPath.set(nodePath.join('/'), roleInfo);
    return { variables, raw, resolved, declared };
  }, {
    variables: config._variables || config.variables || {},
    raw: {},
    resolved: {},
    declared: false,
  });
  return byPath;
}

// A component path may hold a variable, and a branch that changes the variable changes the
// file an inherited spec names. So every node re-resolves every spec in scope, inherited
// ones included, against its own variables.
function checkComponentKeyIdentity(config, diagnostics) {
  const seen = new Set();
  const rootVariables = config._variables || config.variables || {};
  walkBranchTree(config, ({ node, isRoot, state }) => {
    const variables = isRoot ? state.variables : mergeUnbindable(state.variables, node && node.variables, {
      code: DIAG_CODES.VARIABLE_UNBIND_UNKNOWN, kind: 'variable', onWarn: null,
    });
    const components = { ...state.components, ...((node && node.components) || {}) };
    for (const spec of Object.values(components)) {
      const file = resolveComponentSpec(spec, config._base, variables, { diagnostics: new Diagnostics() });
      if (isPassthrough(file)) continue;
      checkComponentKeys(file, { diagnostics, variables: rootVariables, base: config._base, seen });
    }
    return { variables, components };
  }, { variables: rootVariables, components: {} });
}

function runPackChecks(config, deferredCardLeaves, configPath, diagnostics) {
  const packLoadFindings = new Set();
  const rootPacks = (config.lint && config.lint.packs) || {};
  const anyBranchPacks = branchTreeDeclares(
    config.branches, (node) => node.lint && node.lint.packs
      && Object.keys(node.lint.packs).length > 0,
  );
  if (Object.keys(rootPacks).length === 0 && !anyBranchPacks) return packLoadFindings;

  const baseDir = config._base || '.';
  const loaded = new Map(); // pack name -> normalized pack | null (failed, already reported)
  const loc = { file: configPath };
  const isScenario = !(config.lint && config.lint.scenario === false);

  // A card that renders the same on several leaves raises the same finding on each, so
  // findings are grouped across leaves and reported once, carrying the branches.
  const grouped = new Map(); // finding key -> { finding, sev, file, labels }

  for (const leaf of deferredCardLeaves) {
    const lint = leaf.lint || { packs: {}, level: null };
    if (!lint.packs || Object.keys(lint.packs).length === 0) continue;
    const label = leaf.branchPath.length > 0 ? leaf.branchPath.join('/') : '(root)';
    const branchLevel = lint.level || null;

    for (const [name, entry] of Object.entries(lint.packs)) {
      const packLevel = (entry && typeof entry === 'object' && entry.level) || null;
      if (packLevel === 'off') continue;

      if (!loaded.has(name)) {
        const before = diagnostics.length;
        loaded.set(name, loadPack(name, entry, {
          baseDir, variables: leaf.variables || {}, diagnostics, loc,
        }));
        for (const finding of diagnostics.all.slice(before)) packLoadFindings.add(finding);
      }
      const pack = loaded.get(name);
      if (!pack) continue;

      const leafCards = [];
      for (const [type, entries] of leaf.grouped) {
        for (const rendered of entries) {
          leafCards.push(...parseCards(rendered.rendered, { type }));
        }
      }

      const routed = [
        ...evaluatePack(pack, leafCards),
        // A card a playable leaf must carry is meaningless in a project that is not one.
        ...(isScenario ? evaluatePackExistence(pack, leafCards, { branchLabel: label }) : []),
        ...evaluatePackItemRules(pack, leaf.resolvedItems, { branchLabel: label }),
      ];
      for (const f of routed) {
        const sev = clampFinding(f.severity, packLevel, branchLevel);
        if (sev === null) continue;
        const file = f.file || configPath;
        const key = [name, sev, f.code, file, f.message].join('\u0000');
        if (!grouped.has(key)) grouped.set(key, { finding: f, sev, file, labels: [] });
        grouped.get(key).labels.push(label);
      }
    }
  }

  // `allBranches` counts against every leaf compiled, not the leaves a pack was bound on, so
  // a pack bound on part of the tree is never reported as covering all of it.
  for (const { finding, sev, file, labels } of grouped.values()) {
    const branches = [...new Set(labels)];
    diagnostics.add(sev, finding.code, finding.message, {
      file, branches, allBranches: branches.length === deferredCardLeaves.length,
    });
  }
  return packLoadFindings;
}

// A tolerant compile drops unknown keys and keeps going, so those two errors are reported
// without stopping the load.
const TOLERATED_CODES = new Set([DIAG_CODES.UNKNOWN_KEY, DIAG_CODES.MISPLACED_KEY]);

function abortOnLoadErrors(diagnostics, { tolerant } = {}) {
  const errors = tolerant
    ? diagnostics.errors.filter((d) => !TOLERATED_CODES.has(d.code))
    : diagnostics.errors;
  if (errors.length > 0) {
    const count = errors.length;
    const err = new Error(`${count} error${count === 1 ? '' : 's'} while loading; nothing was compiled.`);
    // Lets a caller that reads the diagnostics tell this from a crash.
    err.loadAborted = true;
    throw err;
  }
}


function compile(configPath, options = {}) {
  const buses = {};
  try {
    return withSourceOverrides(options.sources, () => compileRun(configPath, options, buses));
  } finally {
    takeOutputLedger(); // a run that threw before its sweep leaves no ledger behind
    if (options.diagnostics) {
      if (buses.load) options.diagnostics.merge(buses.load);
      if (buses.compile) options.diagnostics.merge(buses.compile);
    }
  }
}

function compileRun(configPath, options, buses) {
  const log = options.log || NULL_LOG;

  const loadDiagnostics = new Diagnostics();
  buses.load = loadDiagnostics;

  const compileDiagnostics = new Diagnostics();
  buses.compile = compileDiagnostics;

  const config = loadCompileConfig(configPath, {
    diagnostics: loadDiagnostics, live: options.live, tolerant: options.tolerant,
  });

  if (config) checkDrift(config, loadDiagnostics, log);

  abortOnLoadErrors(loadDiagnostics, { tolerant: options.tolerant });

  compileDiagnostics.setLintLevel(
    options.lintLevel || (config.lint && config.lint.level) || null,
  );

  // Started before the first output call, so capture mode covers the output directory too.
  startOutputLedger({ capture: !!options.capture });
  ensureOutputDir(config._resolvedOutput);

  const { templates, partials, fieldTable } = loadTemplates(config._resolvedTemplates, {
    diagnostics: loadDiagnostics, tolerant: options.tolerant,
  });
  checkConfigNotesTemplates(config, templates, loadDiagnostics, configPath, fieldTable);
  abortOnLoadErrors(loadDiagnostics, { tolerant: options.tolerant });
  log.info(`Loaded ${templates.size} template(s)${partials.size ? `, ${partials.size} partial(s)` : ''}.`);

  const tierTemplates = config ? gatherTierTemplates(config, configPath, loadDiagnostics) : [];
  abortOnLoadErrors(loadDiagnostics, { tolerant: options.tolerant });
  const fieldAudit = buildFieldAudit({ fieldTable, partials, tierTemplates });
  const cardTypeAudit = buildCardTypeAudit();

  const canonRegistry = buildCanonRegistry(config._resolvedLibrary, {
    diagnostics: loadDiagnostics, tolerant: options.tolerant,
  });
  if (canonRegistry.itemCount > 0) {
    log.info(`Loaded ${canonRegistry.itemCount} library item(s).`);
  }

  const rawProjectItems = loadItemsFromDir(config._resolvedItems, {
    diagnostics: loadDiagnostics, tolerant: options.tolerant,
  });

  const includedItems = resolveIncludes(rawProjectItems, canonRegistry, config, {
    diagnostics: loadDiagnostics, tolerant: options.tolerant,
  });
  if (includedItems.length > 0) {
    log.info(`Loaded ${includedItems.length} included library item(s).`);
  }

  checkComponentKeyIdentity(config, loadDiagnostics);

  abortOnLoadErrors(loadDiagnostics, { tolerant: options.tolerant });

  const projectItems = rawProjectItems.filter((d) => !d.include);

  const allItemDefs = [...projectItems, ...includedItems];

  const projectRegistry = buildRegistry(projectItems, 'project', { diagnostics: loadDiagnostics });
  log.info(`Loaded ${projectRegistry.size} project item definition(s).`);

  const registry = mergeRegistries(canonRegistry, projectRegistry, { diagnostics: loadDiagnostics });

  const placeholderState = new PlaceholderTracker();

  const roleState = new RoleTracker();
  walkBranchTree(config, ({ node, path: path_, isRoot }) => {
    const keys = localRoleKeysOf(node).filter((k) => k.toLowerCase() !== 'protagonist');
    if (keys.length) {
      roleState.declarations.push(isRoot
        ? { path: '', label: 'at the project root', keys }
        : { path: path_.join('/'), label: `on branch "${path_.join('/')}"`, keys });
    }
  });

  const roleStateByPath = resolveRoles(config, configPath, compileDiagnostics);

  const leaves = enumerateLeaves(config.branches);

  log.info(`\nCompiling ${leaves.length} branch leaf/leaves...`);

  let totalFiles = 0;
  const allItemIds = new Set();
  const leafSummaries = [];

  // Capture mode returns report data to its caller, so it collects what a report run would.
  const captureReports = !!(options.capture || options.diff || options.annotate || options.variance);
  const rootDirName = path.basename(config._resolvedOutput);
  const leafData = [];

  const inventoryData = [];
  const componentDetails = [];

  const gaps = new GapList();

  const rootVariables = config._variables || config.variables || null;
  const componentLoader = new ComponentLoader({
    diagnostics: compileDiagnostics, variables: rootVariables, base: config._base,
    tolerant: options.tolerant,
  });

  const descriptionLeaves = new Set();
  const openingLeaves = new Set();

  const deferredComponents = new Map(); // descriptor.key → { descriptor, perLeaf: Map(outputDir → { text, metadata }) }
  const deferredScripts = new Map(); // outputDir → selected script files (relative path → source path)

  const deferredCardLeaves = [];

  // A copy, so collecting inventory for a capture does not change the caller's options.
  const leafOptions = options.capture ? { ...options, inventory: true } : options;

  totalFiles += runLeafLoop({
    leaves, config, configPath, options: leafOptions, log,
    diagnostics: compileDiagnostics,
    allItemDefs, registry, templates, partials,
    fieldTable, fieldAudit, cardTypeAudit,
    rootDirName, captureReports,
    placeholderState, roleState, gaps, componentLoader, roleStateByPath,
    deferredComponents, deferredScripts, deferredCardLeaves,
    descriptionLeaves, openingLeaves,
    leafData, inventoryData, componentDetails, leafSummaries, allItemIds,
  });

  const packLoadFindings = runPackChecks(config, deferredCardLeaves, configPath, compileDiagnostics);

  totalFiles += placeInheritedFiles({
    deferredComponents, deferredScripts, deferredCardLeaves,
    leaves, config, diagnostics: compileDiagnostics, log,
  });

  writeTreeFiles({
    config, configPath, log, diagnostics: compileDiagnostics,
    placeholderState, componentLoader, registry, roleState, roleStateByPath,
  });

  writeScenarioBlurb({
    config, configPath, log, diagnostics: compileDiagnostics,
    rootVariables, registry, placeholderState, roleState, roleStateByPath, componentLoader, gaps, descriptionLeaves,
  });

  finalizeDiagnostics({
    config, configPath, options, log,
    diagnostics: compileDiagnostics,
    descriptionLeaves, openingLeaves, leafSummaries,
    allItemIds, totalFiles, componentLoader,
    roleState, placeholderState, gaps, fieldAudit, cardTypeAudit,
    registry, rootDirName, fieldTable, tierTemplates,
    captureReports, leafData, inventoryData, allItemDefs,
    writeReports: !options.capture,
  });

  // Every output file is written by now, so what the compiler owns and did not write is
  // stale. The errors below describe a complete tree, so they do not stop the sweep; an
  // exception before this point skips it and leaves the previous output in place.
  // The captured content goes first: taking the ledger ends capture mode and drops it.
  const captured = options.capture ? takeCapturedOutput() : null;
  const writtenFiles = takeOutputLedger();
  if (!options.capture) sweepOutput(config, leaves, writtenFiles, log);

  if (options.capture) {
    // Components and field tables are read on both buses, so a drop is counted on either.
    const droppedKeys = options.tolerant
      ? [...loadDiagnostics.all, ...compileDiagnostics.all]
        // Invalid pack rules are skipped whole; none of their keys are dropped individually.
        .filter((d) => TOLERATED_CODES.has(d.code) && !packLoadFindings.has(d)).length
      : 0;
    return {
      config, leaves, leafData, inventoryData, deferredCardLeaves, captured, droppedKeys,
      componentDetails,
    };
  }

  if (gaps.length > 0) {
    throw new Error(
      `${gaps.length} requested component(s) were not written — see errors above. ` +
      `Fix the source path/reference, or remove the component from compile.yaml if it is not wanted.`
    );
  }

  if (compileDiagnostics.hasErrors()) {
    const count = compileDiagnostics.errors.length;
    throw new Error(
      `${count} error${count === 1 ? '' : 's'} while compiling. The output tree was written, `
      + 'but it does not say what the source says — see the errors above.'
    );
  }
}

module.exports = {
  compile,
  // Required on first use: preview.js requires this module, so a top-level require here
  // would make the two load each other.
  get preview() { return require('./preview').preview; },
};
