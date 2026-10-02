'use strict';

const fs = require('fs');
const path = require('path');
const { resolveVariables, listFilesRelative } = require('./util');
const { originLocation } = require('./origin');

const HOOKS = Object.freeze(['input', 'output', 'context', 'library']);
const HOOK_FILES = new Set(HOOKS.map((hook) => `${hook}.js`));

function resolveScriptFiles(config, chain, variables, options = {}) {
  const hooks = new Map();
  let auxiliaries = new Map();
  const cache = options.directoryCache || new Map();
  const configFile = { file: options.configPath || undefined };

  const location = (declPath) => originLocation(config, declPath, configFile);
  const expand = (value, at) => resolveVariables(value, variables, {
    diagnostics: options.diagnostics,
    location: at,
  });
  const absolute = (value, at) => path.resolve(config._base || '.', expand(value, at));
  const filesIn = (dir) => {
    const key = path.resolve(dir);
    if (!cache.has(key)) cache.set(key, listFilesRelative(key));
    return cache.get(key);
  };

  const applyDirectory = (spec, declPath) => {
    const dir = absolute(spec, location(declPath));
    const relatives = filesIn(dir);
    const nextHooks = new Map();
    const nextAuxiliaries = new Map();
    for (const relative of relatives) {
      const source = path.join(dir, relative);
      if (HOOK_FILES.has(relative)) nextHooks.set(relative, source);
      else nextAuxiliaries.set(relative, source);
    }
    for (const hook of HOOKS) {
      const filename = `${hook}.js`;
      if (nextHooks.has(filename)) hooks.set(filename, nextHooks.get(filename));
      else hooks.delete(filename);
    }
    auxiliaries = nextAuxiliaries;
  };

  const applyMapping = (mapping, declPath) => {
    for (const [hook, value] of Object.entries(mapping)) {
      const filename = `${hook}.js`;
      if (value === null || value === undefined) {
        hooks.delete(filename);
        continue;
      }
      const at = location([...declPath, hook]);
      const source = absolute(value, at);
      if (fs.existsSync(source) && fs.statSync(source).isFile()) hooks.set(filename, source);
      else hooks.delete(filename);
    }
  };

  const apply = (spec, declPath) => {
    if (spec === null) {
      for (const hook of HOOKS) hooks.delete(`${hook}.js`);
    } else if (typeof spec === 'string') {
      applyDirectory(spec, declPath);
    } else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      applyMapping(spec, declPath);
    }
  };

  if (config.scripts !== undefined) apply(config.scripts, ['scripts']);
  (chain.nodes || []).forEach((node, index) => {
    if (node && node.scripts !== undefined) {
      const branchPath = (chain.folderPath || []).slice(0, index + 1);
      const authoredPath = branchPath.flatMap((name) => ['branches', name]);
      apply(node.scripts, [...authoredPath, 'scripts']);
    }
  });

  const files = new Map(auxiliaries);
  for (const [filename, source] of hooks) files.set(filename, source);
  return files;
}

module.exports = { resolveScriptFiles };
