'use strict';

/**
 * compile.cl.yaml → Config (v4 spec §6).
 *
 * Moved out of `loader.js`, which was doing config loading, item loading and registry
 * construction in one file. What is new here is that the document is parsed with source
 * positions and validated against a declared key surface before anything is resolved, so
 * a typo in config is an ERROR that names a line rather than a silently ignored key whose
 * only symptom is wrong output.
 *
 * Path resolution itself is carried forward unchanged, including the deliberate scoping
 * from §5.1: `structure.*` expands against root variables only, because it resolves
 * before branches are enumerated. That is a real constraint, not an oversight, and the
 * diagnostic for tripping over it (CL0520) says so specifically rather than reporting the
 * branch-scoped variable as undeclared.
 */

const fs = require('fs');
const path = require('path');

const { Diagnostics, CODES } = require('../diag');
const { validate } = require('../schema');
const { loadYamlDocument } = require('../loader/yaml');
const { CONFIG_SCHEMA } = require('./schema');
const { walkBranchTree } = require('../model/branches');

/**
 * Expand `{%variable}` references, collecting diagnostics instead of warning.
 *
 * §6.2 proposed building a dependency graph and topologically sorting it, on the premise
 * that v3 resolved variables in declaration order. That premise is not correct: v3
 * already resolves recursively by key lookup, so ordering is already irrelevant and the
 * golden fixtures depend on it (`library: '{%loom}/Canon'` with `loom` declared above).
 * What was genuinely missing is the diagnostic quality §6.2 asks for — naming every key
 * in a cycle rather than only the one where it was detected — so that is what changed.
 */
function expandVariables(text, variables, options = {}) {
  const { diagnostics, location, chain = [], branchOnly = null } = options;
  if (typeof text !== 'string') return text;

  // An absent `variables:` block is an empty one, not a reason to skip checking. A
  // config with no variables that nevertheless references `{%role}` has exactly the
  // problem this reports, and returning early here would hide it.
  const declared = (variables && typeof variables === 'object') ? variables : {};

  return text.replace(/\{%([^}]+)\}/g, (match, rawKey) => {
    const key = rawKey.trim();
    const lower = key.toLowerCase();

    const cycleAt = chain.findIndex((k) => k === lower);
    if (cycleAt >= 0) {
      const loop = [...chain.slice(cycleAt), lower].join('" → "');
      diagnostics.error(CODES.VARIABLE_CYCLE, `Variable cycle: "${loop}".`, location);
      return match;
    }

    const actualKey = Object.keys(declared).find((k) => k.toLowerCase() === lower);
    if (actualKey === undefined) {
      // §5.1's distinction, and the reason it needs its own code: a name declared only
      // under a branch is not a typo, it is a scoping mistake. Reporting it as
      // undeclared would send the author hunting for a declaration that exists.
      if (branchOnly && branchOnly.has(lower)) {
        diagnostics.error(
          CODES.VARIABLE_PRE_BRANCH,
          `"{%${key}}" is declared only under a branch, but this value resolves before `
          + 'branches are enumerated.',
          location,
          { hint: 'Only root-level variables are available in include/import paths and under structure:.' }
        );
      } else {
        diagnostics.error(CODES.VARIABLE_UNDECLARED, `Variable "{%${key}}" is not declared.`, location);
      }
      return match;
    }

    return expandVariables(String(declared[actualKey]), declared, {
      ...options,
      chain: [...chain, lower],
    });
  });
}

/**
 * Collect declared variable names: those at root, and those only a branch declares.
 *
 * The second set is what makes CL0520 possible — without it, a branch-scoped variable
 * used in a pre-branch position is indistinguishable from a misspelling.
 */
function collectVariableNames(config) {
  const root = new Set(
    Object.keys((config.variables && typeof config.variables === 'object') ? config.variables : {})
      .map((k) => k.toLowerCase())
  );
  const branch = new Set();

  // The shared walker covers the tree (Phase 11 Step 0). Its root visit is skipped:
  // root variables are the `root` set, and counting them as branch-scoped would defeat
  // the very check this function exists to serve.
  walkBranchTree(config, ({ node, isRoot }) => {
    if (isRoot) return;
    if (node.variables && typeof node.variables === 'object') {
      for (const k of Object.keys(node.variables)) branch.add(k.toLowerCase());
    }
  });

  const branchOnly = new Set([...branch].filter((k) => !root.has(k)));
  return { root, branch, branchOnly };
}

/**
 * Check every declared variable's references, whether or not anything uses them.
 *
 * Variables are expanded lazily, at the point a path or body actually references one, so
 * a typo inside a variable that nothing consumes would otherwise never be reported. This
 * walks the declarations directly and reports undeclared references and cycles up front.
 *
 * It deliberately does *not* substitute anything. Root variables are re-resolved per
 * branch against the merged set — The Institute declares `openingFile` at root in terms
 * of `scenario`, `protag` and `liname`, each of which every branch overrides — so baking
 * root values into the declarations would silently collapse four branches into one.
 *
 * For the same reason the known-name set is the union of root and every branch's
 * variables. A root variable referencing a name that only some branches declare resolves
 * correctly at branch time, and reporting it as undeclared would be a false positive.
 */
function checkVariableGraph(config, diagnostics, sourceMap, names) {
  const rootVars = (config.variables && typeof config.variables === 'object') ? config.variables : {};
  const known = new Set([...names.root, ...names.branch]);

  const refsOf = (value) => {
    const out = [];
    String(value).replace(/\{%([^}]+)\}/g, (_, key) => { out.push(key.trim()); return ''; });
    return out;
  };

  for (const [name, value] of Object.entries(rootVars)) {
    const location = sourceMap ? sourceMap.nearest(['variables', name]) : {};
    for (const ref of refsOf(value)) {
      if (!known.has(ref.toLowerCase())) {
        diagnostics.error(
          CODES.VARIABLE_UNDECLARED,
          `Variable "{%${ref}}", referenced by variable "${name}", is not declared.`,
          location
        );
      }
    }
  }

  // Cycle detection over the declaration graph, reporting the whole loop (§6.2).
  const lowerToName = new Map(Object.keys(rootVars).map((k) => [k.toLowerCase(), k]));
  const state = new Map();
  const reported = new Set();

  const visit = (lower, stack) => {
    if (state.get(lower) === 'done') return;
    const at = stack.indexOf(lower);
    if (at >= 0) {
      const loop = [...stack.slice(at), lower];
      const signature = [...loop].sort().join('|');
      if (!reported.has(signature)) {
        reported.add(signature);
        const name = lowerToName.get(lower);
        diagnostics.error(
          CODES.VARIABLE_CYCLE,
          `Variable cycle: "${loop.map((k) => lowerToName.get(k) || k).join('" → "')}".`,
          sourceMap ? sourceMap.nearest(['variables', name]) : {}
        );
      }
      return;
    }
    const name = lowerToName.get(lower);
    if (name === undefined) return;
    stack.push(lower);
    for (const ref of refsOf(rootVars[name])) visit(ref.toLowerCase(), stack);
    stack.pop();
    state.set(lower, 'done');
  };

  for (const lower of lowerToName.keys()) visit(lower, []);
}

/** Same normalization `golden.test.js`'s `normalizeManifest` uses, for consistency. */
function normalize(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

function isOutOfBase(resolvedPath, base) {
  return !normalize(resolvedPath).startsWith(normalize(base));
}

/**
 * Read `manifest.json`. Returns `null` for "no previous manifest" (the normal first-sync
 * state) and also `null` (after raising CL0112, if a bus was given) for "present but
 * unparseable" — both cases mean "nothing to compare against" to the caller.
 */
function loadManifest(manifestPath, diagnostics) {
  if (!fs.existsSync(manifestPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    diagnostics.warn(
      CODES.SNAPSHOT_MANIFEST_UNPARSEABLE,
      `Snapshot manifest ${path.basename(manifestPath)} is not valid JSON.`,
      {}
    );
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.manifestVersion !== 'number') {
    diagnostics.warn(
      CODES.SNAPSHOT_MANIFEST_UNPARSEABLE,
      `Snapshot manifest ${path.basename(manifestPath)} does not match the expected shape.`,
      {}
    );
    return null;
  }
  return parsed;
}

/**
 * Load compile.cl.yaml and resolve every path relative to it.
 *
 * `options.diagnostics` is required; the caller's bus collects everything this raises.
 * A config this function cannot load returns `null` rather than throwing — the bus is
 * the only contract.
 */
function loadCompileConfig(configPath, options = {}) {
  const { diagnostics } = options;

  const { value: parsed, sourceMap } = loadYamlDocument(configPath);
  const base = path.dirname(path.resolve(configPath));

  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    diagnostics.error(
      CODES.CONFIG_NOT_A_MAPPING,
      'compile.yaml must be a mapping of configuration keys.',
      { file: configPath }
    );
    return null;
  }

  const config = parsed;

  const at = (...parts) => (sourceMap ? sourceMap.nearest(parts) : {});

  // §14.1 / §6: `version: 4` is required with no compatibility mode, so the key exists to
  // detect a v3 project rather than to negotiate. A missing key or an explicit `version: 3`
  // routes to the migrate hint; any other value is a version this compiler cannot load.
  // Reported before `validate` so a v3 config gets this one ERROR instead of a cascade of
  // unknown-key errors for every key v4 renamed or removed.
  const { version } = config;
  if (version !== 4) {
    if (version === undefined || version === null || version === 3) {
      diagnostics.error(
        CODES.UNSUPPORTED_VERSION,
        'This looks like a v3 project. Run `codex-loom --migrate <project>` to convert it to v4.',
        at('version'),
      );
    } else {
      diagnostics.error(
        CODES.UNSUPPORTED_VERSION,
        `Unsupported compile.yaml version ${JSON.stringify(version)}; v4 is the only supported version.`,
        at('version'),
      );
    }
    return null;
  }

  validate(config, CONFIG_SCHEMA, { diagnostics, sourceMap });

  const variableNames = collectVariableNames(config);
  checkVariableGraph(config, diagnostics, sourceMap, variableNames);

  const structure = config.structure || {};
  const input = structure.input || {};

  const libraryRaw = (input.library && typeof input.library === 'object' && !Array.isArray(input.library))
    ? input.library
    : {};

  /**
   * Library names are auto-exposed as variables (§6.1), which is what replaces `{@}`.
   * `{%characters}/Aness.yaml` now works in an include path exactly as
   * `{@characters}/Aness.yaml` used to, leaving one naming system instead of two.
   *
   * A library name colliding with a declared variable is an ERROR rather than a silent
   * precedence rule, because there is no answer to "which one wins" that an author could
   * predict.
   */
  const variables = Object.assign({}, config.variables || {});
  for (const name of Object.keys(libraryRaw)) {
    const clash = Object.keys(variables).find((k) => k.toLowerCase() === name.toLowerCase());
    if (clash !== undefined) {
      diagnostics.error(
        CODES.LIBRARY_NAME_COLLIDES,
        `Library name "${name}" collides with the variable "${clash}".`,
        at('structure', 'input', 'library', name),
        { hint: 'Library names are exposed as variables, so the two share one namespace. Rename one.' }
      );
      continue;
    }
    variables[name] = String(libraryRaw[name]);
  }

  // §5.1 / §6: every string value in compile.cl.yaml passes through the same expander.
  // v3 sent `structure.output` and `structure.reports` straight to `path.resolve` with no
  // expansion, which was an inconsistency rather than a scoping rule — nothing about the
  // author's intent differs between a structure.* path that happens to contain a token
  // and one that does not (§6.1 audit). Both resolve against root variables, like the
  // rest of `structure:`, since they are read before branches are enumerated.
  const resolvedOutput = path.resolve(base, expandVariables(
    String(structure.output || 'output'), variables,
    { diagnostics, location: at('structure', 'output'), branchOnly: variableNames.branchOnly }
  ));

  const resolvedReports = structure.reports
    ? path.resolve(base, expandVariables(
        String(structure.reports), variables,
        { diagnostics, location: at('structure', 'reports'), branchOnly: variableNames.branchOnly }
      ))
    : null;

  // `structure.input.snapshot` names where a Phase 7 freeze lives. No existence check at
  // load time — the directory won't exist before the first `--snapshot` run, which is
  // normal, not an error. (Missing-when-required is CL0111, raised by whatever actually
  // needs the directory populated, not here.)
  const resolvedSnapshot = input.snapshot
    ? path.resolve(base, expandVariables(
        String(input.snapshot), variables,
        { diagnostics, location: at('structure', 'input', 'snapshot'), branchOnly: variableNames.branchOnly }
      ))
    : null;

  // Library entries may reference variables, including other library names, so they
  // resolve through the same expander as everything else rather than a bespoke two-pass.
  //
  // This is the always-live map. `resolvedLibrary` (the "active" map, below) is what every
  // consumer actually reads; the two differ only once a snapshot exists and this run isn't
  // `--live` (Phase 7 Session B).
  const resolvedLibrarySource = new Map();
  for (const [name, spec] of Object.entries(libraryRaw)) {
    const expanded = expandVariables(
      String(spec), variables,
      { diagnostics, location: at('structure', 'input', 'library', name), branchOnly: variableNames.branchOnly }
    );
    resolvedLibrarySource.set(name, path.resolve(base, expanded));
  }

  const resolveList = (raw, key) => {
    const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    return list.map((spec, i) => {
      const location = at('structure', 'input', key, String(i));
      return path.resolve(base, expandVariables(String(spec), variables, { diagnostics, location, branchOnly: variableNames.branchOnly }));
    });
  };

  const resolvedTemplatesSource = resolveList(input.templates, 'templates');
  const resolvedItems = resolveList(input.items, 'items');

  // Snapshot redirection (Phase 7 Session B): "the live library" and "what this compile
  // reads" are different questions once a snapshot exists. `options.live` is the escape
  // hatch back to the source; otherwise, an entry whose name is recorded in
  // `snapshot/manifest.json` reads from the snapshot copy instead. The manifest read here
  // is silent — `checkDrift` (called unconditionally elsewhere) stays the sole source of
  // CL0111–CL0115, and anything this can't confirm just falls back to live. So the bus
  // handed to `loadManifest` below is a throwaway, on purpose: `checkDrift` calls the same
  // function with the real bus and reports CL0112 there, and a live bus here would raise
  // it a second time. This read wants the value, not the finding — the same shape as
  // `questionsForMeasurement` in treeWrite.js.
  let manifest = null;
  if (!options.live && resolvedSnapshot) {
    manifest = loadManifest(path.join(resolvedSnapshot, 'manifest.json'), new Diagnostics());
  }

  const resolvedLibrary = new Map();
  for (const [name, sourcePath] of resolvedLibrarySource) {
    if (manifest && manifest.library && Object.prototype.hasOwnProperty.call(manifest.library, name)) {
      resolvedLibrary.set(name, path.join(resolvedSnapshot, name));
    } else {
      resolvedLibrary.set(name, sourcePath);
    }
  }

  const resolvedTemplates = resolvedTemplatesSource.map((sourcePath, i) => {
    if (
      manifest && manifest.templates && isOutOfBase(sourcePath, base)
      && Object.prototype.hasOwnProperty.call(manifest.templates, String(i))
    ) {
      return path.join(resolvedSnapshot, String(i));
    }
    return sourcePath;
  });

  // §6.1's library-names-as-variables now redirect too: `{%name}` in every
  // include/from/imports resolves through whichever path is active for this run.
  // `path.resolve(base, ...)` on an already-absolute path is a no-op, so nothing
  // downstream needs to change to accept it.
  for (const [name, activePath] of resolvedLibrary) {
    variables[name] = activePath;
  }

  for (const [i, p] of resolvedItems.entries()) {
    if (!fs.existsSync(p)) {
      diagnostics.warn(CODES.PATH_NOT_FOUND, `Items path not found: ${p}`, at('structure', 'input', 'items', String(i)));
    }
  }
  for (const [name, p] of resolvedLibrarySource) {
    if (!fs.existsSync(p)) {
      diagnostics.warn(CODES.PATH_NOT_FOUND, `Library "${name}" path not found: ${p}`, at('structure', 'input', 'library', name));
    }
  }
  for (const [i, p] of resolvedTemplatesSource.entries()) {
    if (!fs.existsSync(p)) {
      diagnostics.warn(CODES.PATH_NOT_FOUND, `Templates path not found: ${p}`, at('structure', 'input', 'templates', String(i)));
    }
  }

  return {
    _base: base,
    _resolvedOutput: resolvedOutput,
    _resolvedReports: resolvedReports,
    _resolvedSnapshot: resolvedSnapshot,
    _resolvedItems: resolvedItems,
    _resolvedLibrary: resolvedLibrary,
    _resolvedTemplates: resolvedTemplates,
    _resolvedLibrarySource: resolvedLibrarySource,
    _resolvedTemplatesSource: resolvedTemplatesSource,
    // The author's own `library:` value for each entry — a `{%token}` expression, not a
    // resolved path — so `buildLibraryManifest` (compile.js) can show what was written
    // alongside what it resolved to. Read off `libraryRaw` rather than off `config` (the
    // raw parsed document): the previous write (`config._libraryRaw = libraryRaw`) landed
    // on that discarded object rather than on what this function actually returns, so
    // `config._libraryRaw` was always undefined downstream — found in Phase 7 Session C.
    _libraryRaw: libraryRaw,
    title: config.title || null,
    components: config.components || null,
    // The built-in `protagonist` role lives here as an ordinary `roles:` entry (§9.2) —
    // Phase 8 retires the separate `protagonist:` key `walkBranchChain` used to read.
    roles: config.roles || null,
    // Top-level as of §6.3, and branch-addressable, so it travels with the config rather
    // than through `structure.input`.
    scripts: config.scripts !== undefined ? config.scripts : null,
    // §12.5's opinion-layer ceiling. This projection is the whole of what the compiler can
    // see — a key validated by the schema and left out here is accepted, documented, and
    // inert, which is what `lint:` was until this line existed.
    lint: config.lint || null,
    // Two variable sets, deliberately.
    //
    // `variables` is what the author declared. The library dependency manifest reports it,
    // and it should stay the author's own list — auto-exposed library names are derived,
    // and recording them as declarations would make the manifest describe the compiler
    // rather than the project.
    //
    // `_variables` is the effective set that token expansion resolves against, with the
    // library names folded in (§6.1). Everything that expands a token uses this one.
    variables: config.variables || null,
    _variables: variables,
    // Rendering defaults (§4.5). Branch-addressable like `components:` and `scripts:`,
    // because which mods a branch loads is what decides whether a notes marker means
    // anything there — so it travels with the config rather than under `structure.input`.
    render: config.render || null,
    // §13.4's template-selection map. The root rung, lifted out for the same reason
    // `render:` is — branch nodes keep theirs on the branch tree (`config.branches`), so
    // this projection is the only place the root's would otherwise be dropped.
    templateFor: config.templateFor || null,
    // §7.8's per-component story-card category. Project-level only — nothing about which
    // AID `type` a reference card sorts under varies per branch — so unlike `render:` and
    // `templateFor:` there is no branch rung to keep on the tree, and this projection is
    // the whole of it.
    storyCardType: config.storyCardType || null,
    // The root rung of the placeholder table (§12.2). Branch nodes keep theirs on the
    // branch tree, so this is the only rung that needs lifting out — and it is easy to
    // miss precisely because the branch case works without it: a project declaring
    // placeholders only on branches would emit correctly while the root's went nowhere.
    placeholders: config.placeholders || null,
    branches: config.branches || null,
  };
}

module.exports = {
  loadCompileConfig, expandVariables, collectVariableNames, CODES,
  loadManifest, isOutOfBase, normalize,
};
