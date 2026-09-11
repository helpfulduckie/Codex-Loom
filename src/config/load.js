'use strict';


const fs = require('fs');
const path = require('path');

const { Diagnostics, CODES } = require('../diag');
const { validate } = require('../schema');
const { loadYamlDocument, YamlLoadError } = require('../loader/yaml');
const { attachOrigins } = require('../origin');
const { CONFIG_SCHEMA } = require('./schema');
const { walkBranchTree } = require('../model/branches');
const { resolveVariables } = require('../util');

function collectVariableNames(config) {
  const root = new Set(
    Object.keys((config.variables && typeof config.variables === 'object') ? config.variables : {})
      .map((k) => k.toLowerCase())
  );
  const branch = new Set();

  walkBranchTree(config, ({ node, isRoot }) => {
    if (isRoot) return;
    if (node.variables && typeof node.variables === 'object') {
      for (const k of Object.keys(node.variables)) branch.add(k.toLowerCase());
    }
  });

  const branchOnly = new Set([...branch].filter((k) => !root.has(k)));
  return { root, branch, branchOnly };
}

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
          `Variable "{%${ref}}", referenced by variable "${name}", is not declared, so expansion fails; declare or correct the key.`,
          location
        );
      }
    }
  }

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
          `Variable cycle: "${loop.map((k) => lowerToName.get(k) || k).join('" → "')}"; expansion cannot finish until the cycle is broken.`,
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

function normalize(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

function isOutOfBase(resolvedPath, base) {
  return !normalize(resolvedPath).startsWith(normalize(base));
}

function loadManifest(manifestPath, diagnostics) {
  if (!fs.existsSync(manifestPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    diagnostics.warn(
      CODES.SNAPSHOT_MANIFEST_UNPARSEABLE,
      `Snapshot manifest ${path.basename(manifestPath)} is not valid JSON, so snapshot tracking is skipped; repair or regenerate manifest.json.`,
      { file: manifestPath }
    );
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.manifestVersion !== 'number') {
    diagnostics.warn(
      CODES.SNAPSHOT_MANIFEST_UNPARSEABLE,
      `Snapshot manifest ${path.basename(manifestPath)} has the wrong shape, so snapshot tracking is skipped; repair or regenerate manifest.json.`,
      { file: manifestPath }
    );
    return null;
  }
  return parsed;
}

function loadCompileConfig(configPath, options = {}) {
  const { diagnostics } = options;

  let parsed; let sourceMap;
  try {
    ({ value: parsed, sourceMap } = loadYamlDocument(configPath));
  } catch (err) {
    if (!(err instanceof YamlLoadError)) throw err;
    diagnostics.error(
      err.code,
      `${err.message} Configuration loading stops because compile.yaml cannot be loaded.`,
      { file: configPath },
    );
    return null;
  }
  const base = path.dirname(path.resolve(configPath));

  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    diagnostics.error(
      CODES.CONFIG_NOT_A_MAPPING,
      'compile.yaml must be a mapping of configuration keys, so configuration cannot be loaded; replace its top-level value with configuration keys.',
      { file: configPath }
    );
    return null;
  }

  const config = parsed;

  const at = (...parts) => (sourceMap ? sourceMap.nearest(parts) : {});

  const { version } = config;
  if (version !== 4) {
    if (version === undefined || version === null || version === 3) {
      diagnostics.error(
        CODES.UNSUPPORTED_VERSION,
        'This looks like a v3 project, so configuration loading stops. Run `codex-loom --migrate <project>` to convert it to v4, or set version: 4 in a v4 project.',
        at('version'),
      );
    } else {
      diagnostics.error(
        CODES.UNSUPPORTED_VERSION,
        `Unsupported compile.yaml version ${JSON.stringify(version)}, so configuration loading stops; set version: 4.`,
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

  const resolvedOutput = path.resolve(base, resolveVariables(
    String(structure.output || 'output'), variables,
    { diagnostics, location: at('structure', 'output'), branchOnly: variableNames.branchOnly }
  ));

  const resolvedReports = structure.reports
    ? path.resolve(base, resolveVariables(
        String(structure.reports), variables,
        { diagnostics, location: at('structure', 'reports'), branchOnly: variableNames.branchOnly }
      ))
    : null;

  const resolvedSnapshot = input.snapshot
    ? path.resolve(base, resolveVariables(
        String(input.snapshot), variables,
        { diagnostics, location: at('structure', 'input', 'snapshot'), branchOnly: variableNames.branchOnly }
      ))
    : null;

  const resolvedLibrarySource = new Map();
  for (const [name, spec] of Object.entries(libraryRaw)) {
    const expanded = resolveVariables(
      String(spec), variables,
      { diagnostics, location: at('structure', 'input', 'library', name), branchOnly: variableNames.branchOnly }
    );
    resolvedLibrarySource.set(name, path.resolve(base, expanded));
  }

  const resolveList = (raw, key) => {
    const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    return list.map((spec, i) => {
      const location = at('structure', 'input', key, String(i));
      return path.resolve(base, resolveVariables(String(spec), variables, { diagnostics, location, branchOnly: variableNames.branchOnly }));
    });
  };

  const resolvedTemplatesSource = resolveList(input.templates, 'templates');
  const resolvedItems = resolveList(input.items, 'items');

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

  for (const [name, activePath] of resolvedLibrary) {
    variables[name] = activePath;
  }

  for (const [i, p] of resolvedItems.entries()) {
    if (!fs.existsSync(p)) {
      diagnostics.warn(CODES.PATH_NOT_FOUND, `Items path not found: ${p}; items at this path are skipped. Create the path or correct structure.input.items.`, at('structure', 'input', 'items', String(i)));
    }
  }
  for (const [name, p] of resolvedLibrarySource) {
    if (!fs.existsSync(p)) {
      diagnostics.warn(CODES.PATH_NOT_FOUND, `Library "${name}" path not found: ${p}; this library contributes no items. Create the path or correct structure.input.library.`, at('structure', 'input', 'library', name));
    }
  }
  for (const [i, p] of resolvedTemplatesSource.entries()) {
    if (!fs.existsSync(p)) {
      diagnostics.warn(CODES.PATH_NOT_FOUND, `Templates path not found: ${p}; templates at this path are unavailable. Create the path or correct structure.input.templates.`, at('structure', 'input', 'templates', String(i)));
    }
  }

  const storyCardType = config.storyCardType && typeof config.storyCardType === 'object'
    && !Array.isArray(config.storyCardType)
    ? Object.fromEntries(Object.entries(config.storyCardType).map(([key, value]) => [
        key,
        typeof value === 'string'
          ? resolveVariables(value, variables, {
              diagnostics, location: at('storyCardType', key), branchOnly: variableNames.branchOnly,
            })
          : value,
      ]))
    : config.storyCardType || null;

  return attachOrigins({
    _base: base,
    _resolvedOutput: resolvedOutput,
    _resolvedReports: resolvedReports,
    _resolvedSnapshot: resolvedSnapshot,
    _resolvedItems: resolvedItems,
    _resolvedLibrary: resolvedLibrary,
    _resolvedTemplates: resolvedTemplates,
    _resolvedLibrarySource: resolvedLibrarySource,
    _resolvedTemplatesSource: resolvedTemplatesSource,
    _libraryRaw: libraryRaw,
    title: config.title || null,
    components: config.components || null,
    roles: config.roles || null,
    scripts: config.scripts !== undefined ? config.scripts : null,
    lint: config.lint || null,
    variables: config.variables || null,
    _variables: variables,
    render: config.render || null,
    templateFor: config.templateFor || null,
    storyCardType,
    placeholders: config.placeholders || null,
    branches: config.branches || null,
  }, sourceMap.exportOrigins());
}

module.exports = {
  loadCompileConfig, collectVariableNames,
  loadManifest, isOutOfBase, normalize,
};
