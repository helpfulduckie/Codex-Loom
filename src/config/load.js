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

const { Diagnostics, CODES: DIAG_CODES } = require('../diag');
const { validate } = require('../schema');
const { loadYamlDocument } = require('../loader/yaml');
const { CONFIG_SCHEMA } = require('./schema');

const CODES = Object.freeze({
  CONFIG_NOT_A_MAPPING: 'CL0110',
  PATH_NOT_FOUND: 'CL0120',
  VARIABLE_UNDECLARED: 'CL0510',
  VARIABLE_CYCLE: 'CL0511',
  /** A branch-scoped variable used where only root variables resolve (§5.1). */
  VARIABLE_PRE_BRANCH: 'CL0520',
  /** A canon name and a declared variable share one namespace as of §6.1. */
  CANON_NAME_COLLIDES: 'CL0521',
});

/**
 * Expand `{%variable}` references, collecting diagnostics instead of warning.
 *
 * §6.2 proposed building a dependency graph and topologically sorting it, on the premise
 * that v3 resolved variables in declaration order. That premise is not correct: v3
 * already resolves recursively by key lookup, so ordering is already irrelevant and the
 * golden fixtures depend on it (`canon: '{%loom}/Canon'` with `loom` declared above).
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
      if (diagnostics) {
        const loop = [...chain.slice(cycleAt), lower].join('" → "');
        diagnostics.error(CODES.VARIABLE_CYCLE, `Variable cycle: "${loop}".`, location);
      }
      return match;
    }

    const actualKey = Object.keys(declared).find((k) => k.toLowerCase() === lower);
    if (actualKey === undefined) {
      if (diagnostics) {
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

  const walk = (branches) => {
    if (!branches || typeof branches !== 'object') return;
    for (const node of Object.values(branches)) {
      if (!node || typeof node !== 'object') continue;
      if (node.variables && typeof node.variables === 'object') {
        for (const k of Object.keys(node.variables)) branch.add(k.toLowerCase());
      }
      walk(node.branches);
    }
  };
  walk(config.branches);

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

/**
 * Expand tokens in a path string.
 *
 * There is one family left: `{%variable}`. Canon names are exposed as variables (§6.1),
 * so a canon reference resolves through exactly the same lookup as anything else.
 */
function expandPathTokens(str, variables, diagnostics, location, branchOnly) {
  return expandVariables(String(str), variables, { diagnostics, location, branchOnly });
}

/** Print collected diagnostics and abort if any of them are errors. */
function flush(diagnostics) {
  for (const diag of diagnostics.all) {
    if (diag.severity === 'error') console.error(diag.format());
    else console.warn(diag.format());
  }
  if (diagnostics.hasErrors()) {
    const count = diagnostics.errors.length;
    throw new Error(`Configuration has ${count} error${count === 1 ? '' : 's'}; nothing was compiled.`);
  }
}

/**
 * Load compile.cl.yaml and resolve every path relative to it.
 *
 * Pass `options.diagnostics` to collect into an existing bus; otherwise a private one is
 * used, printed, and turned into a thrown error if it holds any.
 */
function loadCompileConfig(configPath, options = {}) {
  const diagnostics = options.diagnostics || new Diagnostics();
  const ownsBus = !options.diagnostics;

  const { value: parsed, sourceMap } = loadYamlDocument(configPath);
  const base = path.dirname(path.resolve(configPath));

  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    diagnostics.error(
      CODES.CONFIG_NOT_A_MAPPING,
      'compile.yaml must be a mapping of configuration keys.',
      { file: configPath }
    );
    if (ownsBus) flush(diagnostics);
    return null;
  }

  const config = parsed;
  validate(config, CONFIG_SCHEMA, { diagnostics, sourceMap });

  const variableNames = collectVariableNames(config);
  checkVariableGraph(config, diagnostics, sourceMap, variableNames);

  const structure = config.structure || {};
  const input = structure.input || {};

  const at = (...parts) => (sourceMap ? sourceMap.nearest(parts) : {});

  const canonRaw = (input.canon && typeof input.canon === 'object' && !Array.isArray(input.canon))
    ? input.canon
    : {};

  /**
   * Canon names are auto-exposed as variables (§6.1), which is what replaces `{@}`.
   * `{%characters}/Aness.yaml` now works in an include path exactly as
   * `{@characters}/Aness.yaml` used to, leaving one naming system instead of two.
   *
   * A canon name colliding with a declared variable is an ERROR rather than a silent
   * precedence rule, because there is no answer to "which one wins" that an author could
   * predict.
   */
  const variables = Object.assign({}, config.variables || {});
  for (const name of Object.keys(canonRaw)) {
    const clash = Object.keys(variables).find((k) => k.toLowerCase() === name.toLowerCase());
    if (clash !== undefined) {
      diagnostics.error(
        CODES.CANON_NAME_COLLIDES,
        `Canon name "${name}" collides with the variable "${clash}".`,
        at('structure', 'input', 'canon', name),
        { hint: 'Canon names are exposed as variables, so the two share one namespace. Rename one.' }
      );
      continue;
    }
    variables[name] = String(canonRaw[name]);
  }

  // §5.1 / §6: every string value in compile.cl.yaml passes through the same expander.
  // v3 sent `structure.output` and `structure.reports` straight to `path.resolve` with no
  // expansion, which was an inconsistency rather than a scoping rule — nothing about the
  // author's intent differs between a structure.* path that happens to contain a token
  // and one that does not (§6.1 audit). Both resolve against root variables, like the
  // rest of `structure:`, since they are read before branches are enumerated.
  const resolvedOutput = path.resolve(base, expandPathTokens(
    String(structure.output || 'output'), variables, diagnostics,
    at('structure', 'output'), variableNames.branchOnly
  ));

  const resolvedReports = structure.reports
    ? path.resolve(base, expandPathTokens(
        String(structure.reports), variables, diagnostics,
        at('structure', 'reports'), variableNames.branchOnly
      ))
    : null;

  // Canon entries may reference variables, including other canon names, so they resolve
  // through the same expander as everything else rather than a bespoke two-pass.
  const resolvedCanon = new Map();
  for (const [name, spec] of Object.entries(canonRaw)) {
    const expanded = expandPathTokens(
      String(spec), variables, diagnostics,
      at('structure', 'input', 'canon', name), variableNames.branchOnly
    );
    resolvedCanon.set(name, path.resolve(base, expanded));
  }

  config._canonRaw = canonRaw;

  const resolveList = (raw, key) => {
    const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    return list.map((spec, i) => {
      const location = at('structure', 'input', key, String(i));
      return path.resolve(base, expandPathTokens(String(spec), variables, diagnostics, location, variableNames.branchOnly));
    });
  };

  const resolvedTemplates = resolveList(input.templates, 'templates');
  const resolvedItems = resolveList(input.items, 'items');

  for (const [i, p] of resolvedItems.entries()) {
    if (!fs.existsSync(p)) {
      diagnostics.warn(CODES.PATH_NOT_FOUND, `Items path not found: ${p}`, at('structure', 'input', 'items', String(i)));
    }
  }
  for (const [name, p] of resolvedCanon) {
    if (!fs.existsSync(p)) {
      diagnostics.warn(CODES.PATH_NOT_FOUND, `Canon "${name}" path not found: ${p}`, at('structure', 'input', 'canon', name));
    }
  }
  for (const [i, p] of resolvedTemplates.entries()) {
    if (!fs.existsSync(p)) {
      diagnostics.warn(CODES.PATH_NOT_FOUND, `Templates path not found: ${p}`, at('structure', 'input', 'templates', String(i)));
    }
  }

  if (ownsBus) flush(diagnostics);

  return {
    _base: base,
    _resolvedOutput: resolvedOutput,
    _resolvedReports: resolvedReports,
    _resolvedItems: resolvedItems,
    _resolvedCanon: resolvedCanon,
    _resolvedTemplates: resolvedTemplates,
    _sourceMap: sourceMap,
    protagonist: config.protagonist || null,
    title: config.title || null,
    components: config.components || null,
    // Top-level as of §6.3, and branch-addressable, so it travels with the config rather
    // than through `structure.input`.
    scripts: config.scripts !== undefined ? config.scripts : null,
    // Two variable sets, deliberately.
    //
    // `variables` is what the author declared. The canon dependency manifest reports it,
    // and it should stay the author's own list — auto-exposed canon names are derived,
    // and recording them as declarations would make the manifest describe the compiler
    // rather than the project.
    //
    // `_variables` is the effective set that token expansion resolves against, with the
    // canon names folded in (§6.1). Everything that expands a token uses this one.
    variables: config.variables || null,
    _variables: variables,
    branches: config.branches || null,
    _structure: structure,
  };
}

module.exports = { loadCompileConfig, expandVariables, expandPathTokens, collectVariableNames, CODES };
