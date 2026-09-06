'use strict';


const fs = require('fs');
const path = require('path');

const { walkBranchTree } = require('../model/branches');
const { migrateComponentDoc } = require('./component-doc');
const { buildCompileContext } = require('../branchCompile');

const SPLIT_LINES = /\r?\n/;

function nameFromComment(line) {
  const stripped = String(line).replace(/^#+\s*/, '').replace(/[─―—=-]+/g, ' ').trim();
  if (!stripped || stripped.length > 40) return null;
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return null;
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('')
    .replace(/[^A-Za-z0-9]/g, '');
}

function namesFromSource(source, blockCount) {
  const names = [];
  let pending = null;

  for (const line of source.split(SPLIT_LINES)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      const candidate = nameFromComment(trimmed);
      if (candidate) pending = candidate;
      continue;
    }
    if (/^-\s/.test(trimmed)) {
      names.push(pending);
      pending = null;
    }
  }

  const used = new Set();
  const out = [];
  for (let i = 0; i < blockCount; i += 1) {
    let name = names[i] || `block${i + 1}`;
    while (used.has(name.toLowerCase())) name = `${name}_`;
    used.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

function looksLikeFile(textSpec, base) {
  if (typeof textSpec !== 'string') return false;
  if (/\r?\n/.test(textSpec)) return false;
  if (/\{%/.test(textSpec)) return /\.(md|txt)$/i.test(textSpec.trim());
  const resolved = path.resolve(base, textSpec.trim());
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
}

function convertOpening(blocks, source, base) {
  if (!Array.isArray(blocks)) return null;

  const names = namesFromSource(source, blocks.length);
  const sections = {};
  const notes = [];

  blocks.forEach((block, index) => {
    if (!block || typeof block !== 'object') return;
    const name = names[index];
    const section = {};

    if (looksLikeFile(block.text, base)) section.file = String(block.text).trim();
    else if (block.text != null) section.text = block.text;

    if (block.branches != null) section.branches = block.branches;

    if (block.variants && typeof block.variants === 'object') {
      section.variants = block.variants;
      if (Object.keys(block.variants).length > 1) {
        notes.push(
          `opening section "${name}" has ${Object.keys(block.variants).length} variants. v3 `
          + 'applied only the first name a branch dispatched to and silently discarded the '
          + 'rest; sections apply all of them in order. Check any branch that dispatches to '
          + 'more than one.',
        );
      }
    }

    sections[name] = section;
  });

  const generated = names.filter((n) => /^block\d+_*$/.test(n)).length;
  if (generated > 0) {
    notes.push(
      `${generated} opening block(s) had no comment to take a name from and became `
      + '"blockN". Sections are named so an importing project can override, reposition or '
      + 'delete one (§7.2), so rename them to something meaningful before sharing the file.',
    );
  }

  return { sections, notes };
}

function migrateOpeningFiles(configPath, options = {}) {
  const { loadCompileConfig } = require('../config/load');
  const { diagnostics } = options;

  const config = loadCompileConfig(configPath, { diagnostics });
  if (!config) {
    return { notes: ['could not load the migrated config to find openings — nothing migrated.'], touched: [] };
  }

  const specs = new Set();
  const collect = (components) => {
    if (!components || typeof components !== 'object') return;
    if (typeof components.opening === 'string') specs.add(components.opening);
  };
  walkBranchTree(config, ({ node }) => collect(node.components));

  const ctx = buildCompileContext(config, [], { diagnostics });
  const notes = [];
  const touched = [];

  for (const rawSpec of specs) {
    const resolved = ctx.componentRefs.opening && String(rawSpec) === String(config.components?.opening)
      ? ctx.componentRefs.opening
      : path.resolve(config._base, String(rawSpec));
    if (!fs.existsSync(String(resolved)) || !/\.ya?ml$/i.test(String(resolved))) continue;

    const converted = migrateComponentDoc(
      resolved,
      (blocks, source) => convertOpening(blocks, source, config._base),
      {
        dryRun: options.dryRun,
        bannerFilter: (line) => line.trim().startsWith('#') && !nameFromComment(line),
      },
    );
    if (!converted) continue;

    touched.push(String(resolved));
    notes.push(
      `${path.basename(String(resolved))}: ${Object.keys(converted.sections).length} opening `
      + 'block(s) became named sections.',
      ...converted.notes,
    );
  }

  if (touched.length === 0) return { notes: ['no block-list opening to migrate.'], touched: [] };
  return { notes, touched };
}

module.exports = { convertOpening, migrateOpeningFiles, namesFromSource };
