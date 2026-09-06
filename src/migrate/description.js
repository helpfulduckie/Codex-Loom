'use strict';


const fs = require('fs');

const { migrateComponentDoc } = require('./component-doc');
const { buildCompileContext } = require('../branchCompile');

function convertDescription(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (doc.sections) return null;
  if (!doc.body && !doc.script) return null;

  const sections = {};
  const notes = [];

  if (doc.body) sections.body = { file: String(doc.body) };
  if (doc.script) {
    sections.modBanner = {
      from: { script: String(doc.script), extract: 'scriptBanner' },
    };
  }

  if (doc.stripTrailingInstructions === false && doc.script) {
    notes.push(
      'stripTrailingInstructions: false is gone — the scriptBanner extractor always drops a '
      + 'trailing comment group with no list items when an earlier group has them. Check the '
      + 'compiled Description.md: if the final line of the banner mattered, move it into a '
      + 'text: section of its own.',
    );
  }

  return { sections, notes };
}

function migrateDescriptionFiles(configPath, options = {}) {
  const { loadCompileConfig } = require('../config/load');
  const { diagnostics } = options;

  const config = loadCompileConfig(configPath, { diagnostics });
  if (!config) {
    return { notes: ['could not load the migrated config to find the description — nothing migrated.'], touched: [] };
  }
  const specPath = buildCompileContext(config, [], { diagnostics }).componentRefs.description;
  if (!specPath || !fs.existsSync(String(specPath))) {
    return { notes: ['no description file to migrate.'], touched: [] };
  }
  if (!/\.ya?ml$/i.test(String(specPath))) {
    return { notes: ['the description is prose, not a document — nothing to migrate.'], touched: [] };
  }

  const converted = migrateComponentDoc(specPath, (doc) => convertDescription(doc), {
    dryRun: options.dryRun,
    bannerFilter: (line) => line.trim().startsWith('#'),
  });
  if (!converted) {
    return { notes: ['the description is already a sections: document — nothing to migrate.'], touched: [] };
  }

  return {
    notes: [
      'description.yaml became a component document: body: is a section with file:, and '
      + 'script: is one with from: {script:, extract: scriptBanner}.',
      ...converted.notes,
    ],
    touched: [String(specPath)],
  };
}

module.exports = { convertDescription, migrateDescriptionFiles };
