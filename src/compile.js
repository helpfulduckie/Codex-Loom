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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * The branch protagonist at every node, keyed by `path.join('/')` (`''` for the root):
 * `roles.protagonist` merged down the tree, `{%var}`-expanded against that node's merged
 * variables, and lowercased for the id comparison every consumer makes — or `null` where no
 * protagonist is bound.
 *
 * Resolved once here, ahead of both consumers, rather than by each of them. The leaf loop
 * and the framing walker used to derive this themselves, per leaf and per node, and neither
 * could pass a bus: an undeclared name in the string is one config mistake, and a resolve
 * that reports at every leaf would raise it once per branch. The bus does not dedupe, so the
 * dedupe has to be here, keyed on the identity of the mistake — and that identity is *a node
 * where the answer can change*. Only three things change it: the root (the first resolve),
 * a node whose merged protagonist string differs from its parent's, and a node that declares
 * `variables:`. Every other node inherits its parent's resolved value without a call, so one
 * mistake is one `CL0510`, on the compile bus, naming `compile.cl.yaml`.
 *
 * Variables and roles merge with `mergeUnbindable`, the same key-wise `~`-deleting merge
 * `walkBranchChain` gives the leaf loop, so the two cannot see different tables. The root
 * visit merges the declared `variables:` onto the seeded effective set (`_variables`, library
 * names folded in) exactly as the framing walker does; `_variables` ⊇ `variables`, so the
 * merge leaves it untouched.
 */
function resolveProtagonists(config, configPath, diagnostics) {
  const byPath = new Map();
  walkBranchTree(config, ({ node, path: nodePath, isRoot, state }) => {
    const variables = mergeUnbindable(state.variables, node && node.variables, {
      code: DIAG_CODES.VARIABLE_UNBIND_UNKNOWN, kind: 'variable', onWarn: null,
    });
    const roles = mergeUnbindable(state.roles, node && node.roles, {
      code: DIAG_CODES.ROLE_UNBIND_UNKNOWN, kind: 'role', onWarn: null,
    });
    // Always a string: an absent `roles.protagonist` merges to `undefined`, and
    // `resolveVariables` requires a string input.
    const raw = roles.protagonist || '';
    const canChange = isRoot || raw !== state.raw || !!(node && node.variables);
    const resolved = canChange
      ? (resolveVariables(raw, variables, { diagnostics, file: configPath }).toLowerCase() || null)
      : state.resolved;
    byPath.set(nodePath.join('/'), resolved);
    return { variables, roles, raw, resolved };
  }, {
    variables: config._variables || config.variables || {},
    roles: {},
    raw: '',
    resolved: null,
  });
  return byPath;
}

/**
 * The inline convention-pack pass.
 *
 * Runs after the leaf loop, over the story cards each leaf rendered — `deferredCardLeaves`
 * still holds them per leaf, before the frontier collapse, which is what lets a finding
 * name the branch it fired on. For each leaf it resolves that branch's merged `lint.packs`
 * (root packs, key-wise-overridden and `~`-unbound down the chain), loads each pack once,
 * and evaluates it against `parseCards` of every rendered card.
 *
 * Findings route onto the compile bus, so a pack ERROR fails the build — which is what the
 * per-pack `level:` dial exists to make safe. The severity is clamped through the per-pack
 * ceiling, then the per-branch one; the bus applies the global `lint.level` on top at
 * `add` time, because a `CL-<pack>/…` code is opinion-layer (`diag.js`).
 *
 * A complete no-op — no IO — for any project that declares no `lint.packs` anywhere,
 * which is every golden. The branch-merge is *not* recomputed here: each leaf carries its
 * merged `lint` table from `buildCompileContext`, the one walk that already ran with
 * `onWarn` wired.
 */
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

      // Gather the leaf's whole resolved card set once, so the per-card rules
      // (`evaluatePack`) and the per-leaf existence check (`evaluatePackExistence`, for a
      // `requireCard` rule) both see every card the leaf rendered. `evaluatePack` still
      // evaluates each card exactly once — moving it out of the group loop is only a
      // regrouping.
      const leafCards = [];
      for (const [type, entries] of leaf.grouped) {
        for (const rendered of entries) {
          leafCards.push(...parseCards(rendered.rendered, { type }));
        }
      }

      const routed = [
        ...evaluatePack(pack, leafCards, { branchLabel: label }),
        ...evaluatePackExistence(pack, leafCards, { branchLabel: label }),
        // The per-resolved-item rules (`count` / `mutexHint`). Inline only — the offline
        // `--lint` arm has no structured item to hand them.
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

/**
 * Abort if the loading phase has raised an error anywhere on the bus.
 *
 * Errors stop the compile before anything is written. A schema violation means some part
 * of what the author wrote is not being read, so continuing would emit a tree that looks
 * complete and is quietly missing something. Nothing here prints: the caller reaches every
 * diagnostic through `options.diagnostics`, which `compile()` merges in its `finally` on
 * every exit path, including this throw.
 */
function abortOnLoadErrors(diagnostics) {
  if (diagnostics.hasErrors()) {
    const count = diagnostics.errors.length;
    throw new Error(`${count} error${count === 1 ? '' : 's'} while loading; nothing was compiled.`);
  }
}

// ── Main compile function ─────────────────────────────────────────────────────

/**
 * Compile a project, optionally handing the caller the diagnostics as data.
 *
 * Nothing below this function prints. Diagnostics reach the caller through
 * `options.diagnostics`, progress through `options.log` — a `{ info(line), verbose(line) }`
 * pair (`src/log.js`; `NULL_LOG` when the caller passes none). Passing `options.diagnostics`
 * (a `Diagnostics`) collects everything both internal buses saw, on every exit path: the
 * early load throw, the component-gap throw, the final error throw, and success alike.
 * That is what the `finally` is for — a compile that failed is precisely the one whose
 * diagnostics are worth reading, so merging only on the success path would collect nothing
 * in the interesting case. A throw still signals failure, and its message still says "see
 * the errors above" — true because the CLI prints the whole bus before it prints the fatal
 * line, not because anything here printed them.
 *
 * The buses stay separate internally because their abort semantics differ: a load error
 * stops the compile before anything is written, a compile error lets the tree land and
 * fails the run afterward. The sink flattens them because a caller reading diagnostics
 * wants the whole stream in one place.
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
  // ── 1. Buses & log ────────────────────────────────────────────────────────
  const log = options.log || NULL_LOG;

  // One bus for everything the loading phase reports, so item schema violations are
  // collected with their source positions and reported together rather than as a stream
  // of console warnings interleaved with progress output.
  const loadDiagnostics = new Diagnostics();
  buses.load = loadDiagnostics;

  // A second bus for everything the compile phases report — item resolution, cross-item
  // refs, emit. Unlike the load bus this one never aborts mid-run: its errors mean the tree
  // that gets written is wrong, not that it cannot be written, so it is checked once at the
  // end and the author gets both the artifact and a failed build.
  const compileDiagnostics = new Diagnostics();
  buses.compile = compileDiagnostics;

  // ── 2. Config, drift, templates ────────────────────────────────────────────
  const config = loadCompileConfig(configPath, { diagnostics: loadDiagnostics, live: options.live });

  // The snapshot drift notice: a complete no-op unless the project has opted into a
  // snapshot. Drift is informational — never a warning, never a non-zero exit; the one
  // exception is CL0115, corruption of the frozen copy itself, which is an ERROR.
  if (config) checkDrift(config, loadDiagnostics, log);

  // Checked immediately, before any filesystem work — an unknown key, a missing required
  // field, or a bad path token in compile.yaml itself must stop the compile before
  // mkdirSync ever runs, not merely before the compiled tree is written. Folding this into
  // the single check below meant a config error still created the output directory and
  // read library/item files from disk before the throw was reached.
  abortOnLoadErrors(loadDiagnostics);

  // The lint-severity ceiling, set here because this is the first moment both halves of it
  // exist: `lint.level` has just been read off the config, and `--lint-level` came in with
  // the options. The CLI flag wins, on the general rule that a flag is what someone typed
  // for this run and the config is what the project says every run.
  //
  // The load bus is deliberately left alone. Nothing it raises is an opinion — it is
  // schema violations and unreadable files — and it has already been reported by the line
  // above, so a ceiling applied here could only ever arrive too late to mean anything.
  compileDiagnostics.setLintLevel(
    options.lintLevel || (config.lint && config.lint.level) || null,
  );

  fs.mkdirSync(config._resolvedOutput, { recursive: true });

  const { templates, partials, fieldTable } = loadTemplates(config._resolvedTemplates, { diagnostics: loadDiagnostics });
  // Checked before anything renders: a template that still carries a fence would emit a
  // double envelope on every card it owns, and the report names the files. The
  // notes-template check needs both halves in hand, so it runs against the same bus.
  checkConfigNotesTemplates(config, templates, loadDiagnostics, configPath, fieldTable);
  abortOnLoadErrors(loadDiagnostics);
  log.info(`Loaded ${templates.size} template(s)${partials.size ? `, ${partials.size} partial(s)` : ''}.`);

  // ── 3. Registries & audits ────────────────────────────────────────────────────
  // The unread-field and card-type audits, built once so their per-compile dedupes span
  // every leaf. Both `finish()` after the leaf loop, in `finalizeDiagnostics`.
  // `tierTemplates` also feeds `--schema-tables`; gathered once here.
  const tierTemplates = config ? gatherTierTemplates(config, configPath) : [];
  const fieldAudit = buildFieldAudit({ fieldTable, partials, tierTemplates });
  const cardTypeAudit = buildCardTypeAudit();

  // Build library registry
  const canonRegistry = buildCanonRegistry(config._resolvedLibrary, { diagnostics: loadDiagnostics });
  // itemCount, not size: an id two library sets both define holds no plain key, and
  // "loaded 40 items" would otherwise quietly drop the very items worth mentioning.
  if (canonRegistry.itemCount > 0) {
    log.info(`Loaded ${canonRegistry.itemCount} library item(s).`);
  }

  // Load project items
  const rawProjectItems = loadItemsFromDir(config._resolvedItems, { diagnostics: loadDiagnostics });

  // Resolve includes
  const includedItems = resolveIncludes(rawProjectItems, canonRegistry, config, { diagnostics: loadDiagnostics });
  if (includedItems.length > 0) {
    log.info(`Loaded ${includedItems.length} included library item(s).`);
  }

  abortOnLoadErrors(loadDiagnostics);

  // include: directives are spent once resolveIncludes has read them — drop them here so
  // nothing downstream has to know they ever existed. `import:` defs are NOT dropped:
  // they are real items awaiting resolution against the id they name.
  const projectItems = rawProjectItems.filter((d) => !d.include);

  const allItemDefs = [...projectItems, ...includedItems];

  const projectRegistry = buildRegistry(projectItems, 'project', { diagnostics: loadDiagnostics });
  log.info(`Loaded ${projectRegistry.size} project item definition(s).`);

  const registry = mergeRegistries(canonRegistry, projectRegistry, { diagnostics: loadDiagnostics });

  // ── 4. Pre-loop accumulators ──────────────────────────────────────────────────
  // Every declared key referenced by any text this compile writes, keyed by the branch path
  // the text belongs to, and every node that declared one. The unused-placeholder check
  // needs both: the declarations say what was promised and where, the usage says what was
  // spent.
  const placeholderState = new PlaceholderTracker();

  // `CL0545`: every role name a resolved token actually bound to, project-wide. This is a
  // whole-compile check, deliberately coarser than `CL0535`'s subtree-scoped one — no
  // golden declares a role yet, so there is no branch with a differently-scoped sibling
  // for the coarse check to get wrong, and it is the cheaper one to build correctly.
  // `protagonist` is exempt: it is read structurally, by comparing an item id against
  // `branchProtagonist`, wherever any `{$Id}` token resolves — not only where
  // `{$protagonist}` is literally written — so "unused" is never a fact about it.
  const roleState = new RoleTracker();
  walkBranchTree(config, ({ node, path: path_, isRoot }) => {
    const keys = localRoleKeysOf(node).filter((k) => k.toLowerCase() !== 'protagonist');
    if (keys.length) {
      roleState.declarations.push(isRoot
        ? { path: '', label: 'at the project root', keys }
        : { path: path_.join('/'), label: `on branch "${path_.join('/')}"`, keys });
    }
  });

  // The protagonist per node, resolved once where a `{%var}` in it can change its answer —
  // see `resolveProtagonists`. Read by the leaf loop and the framing walker, which used to
  // resolve it themselves with no bus to avoid repeating one config mistake per leaf.
  const protagonistByPath = resolveProtagonists(config, configPath, compileDiagnostics);

  const leaves = enumerateLeaves(config.branches);

  if (options.clean) {
    log.info('\nClean build: clearing output folders...');
    cleanAndArchive(config, leaves, log);
  }

  log.info(`\nCompiling ${leaves.length} branch leaf/leaves...`);

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
  const gaps = new GapList();

  // The sectioned-component loader (see compileState.js). A component document is read,
  // validated and normalized once per resolved path rather than once per leaf, so a schema
  // violation or an import cycle reaches the author once instead of once for every leaf
  // that names the component. `imports:` chains resolve inside that one load, which is why
  // cycle detection lives there. `from:` expands against the *root* variable table for the
  // same reason the cache is keyed by path — a branch-varying `from:` would make one cache
  // key stand for two documents. The `CL0619`–`CL0621` metadata guards and the
  // `imports:`-inclusive `dependencyLedger` live inside the loader; `componentLoader.load`
  // is the stable `(spec, descriptor)` reference the leaf loop and the framing writer take.
  const rootVariables = config._variables || config.variables || null;
  const componentLoader = new ComponentLoader({
    diagnostics: compileDiagnostics, variables: rootVariables, base: config._base,
  });

  // The two sets CL0616 compares — a leaf with an adventure description and no opening.
  // Both are filled by the leaf loop below, which makes the check a comparison of two
  // facts rather than of two passes.
  const descriptionLeaves = new Set();
  const openingLeaves = new Set();

  // Component and script inheritance. `runLeafLoop` renders and checks every component per
  // leaf and fills these two maps; `placeInheritedFiles` drains them, writing each value
  // once at the node Velvet Lattice inherits it from, or per leaf where it cannot.
  // `LIFT_EXCLUDED_COMPONENTS` (opening, adventureDescription — see leafLoop.js) are the
  // two the leaf must hold itself and are written inside the loop instead.
  const deferredComponents = new Map(); // descriptor.key → { descriptor, metadata, perLeaf: Map(outputDir → text) }
  const deferredScripts = new Map(); // outputDir → resolved scripts spec (a directory path)

  // Story-card inheritance. One entry per leaf, filled by the loop:
  // `{ branchPath, folderPath, outputDir, grouped: Map(type → [{sortKey, rendered, id, name}]) }`.
  // The post-loop pass writes each card at the deepest node whose whole leaf-subtree
  // renders it byte-identically, and per leaf otherwise.
  const deferredCardLeaves = [];

  // ── 5. The leaf loop ──────────────────────────────────────────────────────────
  totalFiles += runLeafLoop({
    leaves, config, configPath, options, log,
    diagnostics: compileDiagnostics,
    allItemDefs, registry, templates, partials,
    fieldTable, fieldAudit, cardTypeAudit,
    rootDirName, captureReports,
    placeholderState, roleState, gaps, componentLoader, protagonistByPath,
    deferredComponents, deferredScripts, deferredCardLeaves,
    descriptionLeaves, openingLeaves,
    leafData, inventoryData, leafSummaries, allItemIds,
  });

  // ── 6. Pack checks ────────────────────────────────────────────────────────────
  // Convention packs, run over the cards each leaf just rendered while they are still
  // keyed per leaf. Dormant unless a project declares `lint.packs`.
  runPackChecks(config, deferredCardLeaves, configPath, compileDiagnostics);

  // ── 7. Inheritance passes ─────────────────────────────────────────────────────
  totalFiles += placeInheritedFiles({
    deferredComponents, deferredScripts, deferredCardLeaves,
    leaves, config, diagnostics: compileDiagnostics, log,
  });

  // ── 8. Tree-level writes ──────────────────────────────────────────────────────
  // Framing, labels and placeholder questions, each at a node the leaf loop never visits.
  // Root-level branchFraming and the root Label land in these walkers' own root visits.
  writeTreeFiles({
    config, configPath, log, diagnostics: compileDiagnostics,
    placeholderState, componentLoader, registry, roleState, protagonistByPath,
  });

  // The scenario blurb, written once to the output root alongside Branches/.
  writeScenarioBlurb({
    config, configPath, log, diagnostics: compileDiagnostics,
    rootVariables, registry, placeholderState, roleState, componentLoader, gaps, descriptionLeaves,
  });

  // ── 9. Project diagnostics, summary, reports, finalize ────────────────────────
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

  // Item-resolution and emit ERRORs do not stop the compile: aborting mid-tree would leave
  // a half-written branch behind, and wrong output the author can read beats no output at
  // all. They do fail the run — the tree is written, then this throws and the CLI exits 1.
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
