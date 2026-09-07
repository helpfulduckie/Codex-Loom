'use strict';

const fs = require('fs');
const path = require('path');
const { loadTemplates } = require('./loader');
const {
  branchTreeDeclares, enumerateLeaves, walkBranchTree,
  localRoleKeysOf, mergeUnbindable,
} = require('./model/branches');
const { buildFieldAudit } = require('./render/field-audit');
const { resolveVariables } = require('./util');
const { buildCardTypeAudit } = require('./cardType');
const {
  checkConfigNotesTemplates, gatherTierTemplates,
} = require('./templateResolve');
const { cleanAndArchive } = require('./outputPaths');
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
const { writeTreeFiles, writeScenarioBlurb } = require('./treeWrite');
const { finalizeDiagnostics } = require('./reportDispatch');
const {
  PlaceholderTracker, RoleTracker, GapList, ComponentLoader,
} = require('./compileState');
const { NULL_LOG } = require('./log');


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
    const protagonist = resolved.protagonist
      ? String(resolved.protagonist).toLowerCase()
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

function runPackChecks(config, deferredCardLeaves, configPath, diagnostics) {
  const rootPacks = (config.lint && config.lint.packs) || {};
  const anyBranchPacks = branchTreeDeclares(
    config.branches, (node) => node.lint && node.lint.packs
      && Object.keys(node.lint.packs).length > 0,
  );
  if (Object.keys(rootPacks).length === 0 && !anyBranchPacks) return;

  const baseDir = config._base || '.';
  const loaded = new Map(); // pack name -> normalized pack | null (failed, already reported)
  const loc = { file: configPath };

  for (const leaf of deferredCardLeaves) {
    const lint = leaf.lint || { packs: {}, level: null };
    if (!lint.packs || Object.keys(lint.packs).length === 0) continue;
    const label = leaf.branchPath.length > 0 ? leaf.branchPath.join('/') : '(root)';
    const branchLevel = lint.level || null;

    for (const [name, entry] of Object.entries(lint.packs)) {
      const packLevel = (entry && typeof entry === 'object' && entry.level) || null;
      if (packLevel === 'off') continue;

      if (!loaded.has(name)) {
        loaded.set(name, loadPack(name, entry, {
          baseDir, variables: leaf.variables || {}, diagnostics, loc,
        }));
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
        ...evaluatePack(pack, leafCards, { branchLabel: label }),
        ...evaluatePackExistence(pack, leafCards, { branchLabel: label }),
        ...evaluatePackItemRules(pack, leaf.resolvedItems, { branchLabel: label }),
      ];
      for (const f of routed) {
        const sev = clampFinding(f.severity, packLevel, branchLevel);
        if (sev === null) continue;
        diagnostics.add(sev, f.code, f.message, loc);
      }
    }
  }
}

function abortOnLoadErrors(diagnostics) {
  if (diagnostics.hasErrors()) {
    const count = diagnostics.errors.length;
    throw new Error(`${count} error${count === 1 ? '' : 's'} while loading; nothing was compiled.`);
  }
}


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
  const log = options.log || NULL_LOG;

  const loadDiagnostics = new Diagnostics();
  buses.load = loadDiagnostics;

  const compileDiagnostics = new Diagnostics();
  buses.compile = compileDiagnostics;

  const config = loadCompileConfig(configPath, { diagnostics: loadDiagnostics, live: options.live });

  if (config) checkDrift(config, loadDiagnostics, log);

  abortOnLoadErrors(loadDiagnostics);

  compileDiagnostics.setLintLevel(
    options.lintLevel || (config.lint && config.lint.level) || null,
  );

  fs.mkdirSync(config._resolvedOutput, { recursive: true });

  const { templates, partials, fieldTable } = loadTemplates(config._resolvedTemplates, { diagnostics: loadDiagnostics });
  checkConfigNotesTemplates(config, templates, loadDiagnostics, configPath, fieldTable);
  abortOnLoadErrors(loadDiagnostics);
  log.info(`Loaded ${templates.size} template(s)${partials.size ? `, ${partials.size} partial(s)` : ''}.`);

  const tierTemplates = config ? gatherTierTemplates(config, configPath) : [];
  const fieldAudit = buildFieldAudit({ fieldTable, partials, tierTemplates });
  const cardTypeAudit = buildCardTypeAudit();

  const canonRegistry = buildCanonRegistry(config._resolvedLibrary, { diagnostics: loadDiagnostics });
  if (canonRegistry.itemCount > 0) {
    log.info(`Loaded ${canonRegistry.itemCount} library item(s).`);
  }

  const rawProjectItems = loadItemsFromDir(config._resolvedItems, { diagnostics: loadDiagnostics });

  const includedItems = resolveIncludes(rawProjectItems, canonRegistry, config, { diagnostics: loadDiagnostics });
  if (includedItems.length > 0) {
    log.info(`Loaded ${includedItems.length} included library item(s).`);
  }

  abortOnLoadErrors(loadDiagnostics);

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

  if (options.clean) {
    log.info('\nClean build: clearing output folders...');
    cleanAndArchive(config, leaves, log);
  }

  log.info(`\nCompiling ${leaves.length} branch leaf/leaves...`);

  let totalFiles = 0;
  const allItemIds = new Set();
  const leafSummaries = [];

  const captureReports = !!(options.diff || options.annotate);
  const rootDirName = path.basename(config._resolvedOutput);
  const leafData = [];

  const inventoryData = [];

  const gaps = new GapList();

  const rootVariables = config._variables || config.variables || null;
  const componentLoader = new ComponentLoader({
    diagnostics: compileDiagnostics, variables: rootVariables, base: config._base,
  });

  const descriptionLeaves = new Set();
  const openingLeaves = new Set();

  const deferredComponents = new Map(); // descriptor.key → { descriptor, perLeaf: Map(outputDir → { text, metadata }) }
  const deferredScripts = new Map(); // outputDir → resolved scripts spec (a directory path)

  const deferredCardLeaves = [];

  totalFiles += runLeafLoop({
    leaves, config, configPath, options, log,
    diagnostics: compileDiagnostics,
    allItemDefs, registry, templates, partials,
    fieldTable, fieldAudit, cardTypeAudit,
    rootDirName, captureReports,
    placeholderState, roleState, gaps, componentLoader, roleStateByPath,
    deferredComponents, deferredScripts, deferredCardLeaves,
    descriptionLeaves, openingLeaves,
    leafData, inventoryData, leafSummaries, allItemIds,
  });

  runPackChecks(config, deferredCardLeaves, configPath, compileDiagnostics);

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
  });

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
};
