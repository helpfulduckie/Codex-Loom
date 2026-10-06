'use strict';

const fs = require('fs');
const path = require('path');
const { resolveVariables, listFilesRelative } = require('./util');
const { originLocation } = require('./origin');
const { CODES } = require('./diag');

const HOOKS = Object.freeze(['input', 'output', 'context', 'library']);
const HOOK_FILES = new Set(HOOKS.map((hook) => `${hook}.js`));

function resolveScriptFiles(config, chain, variables, options = {}) {
  const hooks = new Map();
  let auxiliaries = new Map();
  const cache = options.directoryCache || new Map();
  // Every leaf re-applies its ancestors' declarations, so a bad path is reported once per run.
  const reported = options.reported || new Set();
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

  const errorCount = () => (options.diagnostics ? options.diagnostics.errors.length : 0);
  const isDirectory = (target) => fs.existsSync(target) && fs.statSync(target).isDirectory();
  const isFile = (target) => fs.existsSync(target) && fs.statSync(target).isFile();
  const reportMissing = (declPath, target, message, at) => {
    const key = JSON.stringify([declPath, target]);
    if (!options.diagnostics || reported.has(key)) return;
    reported.add(key);
    options.diagnostics.error(CODES.SCRIPT_SOURCE_NOT_FOUND, message, at);
  };

  const applyDirectory = (spec, declPath) => {
    const at = location(declPath);
    const errorsBefore = errorCount();
    const dir = absolute(spec, at);
    const found = isDirectory(dir);
    // An unexpanded variable is already an error; the literal path it leaves is not a second one.
    if (!found && errorCount() === errorsBefore) {
      reportMissing(declPath, dir,
        `scripts: names "${spec}", which is not a directory (resolved to ${dir}), so no script files are selected from it; correct the path or create the directory.`,
        at);
    }
    const relatives = found ? filesIn(dir) : [];
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
      const errorsBefore = errorCount();
      const source = absolute(value, at);
      if (isFile(source)) {
        hooks.set(filename, source);
        continue;
      }
      // The inherited hook is dropped rather than kept, so a bad path never ships the parent's script.
      hooks.delete(filename);
      if (errorCount() === errorsBefore) {
        reportMissing([...declPath, hook], source,
          `scripts.${hook} names "${value}", which is not a file (resolved to ${source}), so this branch has no ${hook} hook; correct the path, or write null to remove the hook.`,
          at);
      }
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
