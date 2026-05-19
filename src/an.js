'use strict';

const fs = require('fs');
const path = require('path');
const { loadYaml } = require('./util');
const { compileAIN, loadAINConfig, applyDocumentVariants } = require('./ain');
const { applyTokenPass } = require('./pronouns');
const { normalizeWhitespace } = require('./template');

/**
 * Load and parse an Author's Note YAML file.
 * Same structure as AIN except no card: block.
 *
 * @param {string|null} anSpec - resolved file path
 */
function loadANConfig(anSpec) {
  if (!anSpec) return null;
  if (!fs.existsSync(anSpec)) {
    console.warn(`  WARN [AN]: file not found: ${anSpec}`);
    return null;
  }
  const data = loadYaml(anSpec);
  if (!data || typeof data !== 'object') {
    throw new Error(`AN file must be a YAML mapping: ${anSpec}`);
  }
  if (data.card) {
    console.warn(`  WARN [AN]: Author's Note does not support "card:" block — ignoring`);
    delete data.card;
  }
  return data;
}

/**
 * Resolve branch dispatch for AN.
 * AN only uses scalar/sequence form (no ain:/cards: split).
 * Returns variant name list.
 */
function resolveANBranches(branchesSpec, branchPath) {
  if (!branchesSpec || typeof branchesSpec !== 'object') return [];

  let current = branchesSpec;
  for (const branch of branchPath) {
    if (!current || typeof current !== 'object') break;
    const branchLower = branch.toLowerCase();
    const exactKey = Object.keys(current).find(k => k !== '*' && k.toLowerCase() === branchLower);
    const wildcardVal = current['*'];
    if (exactKey !== undefined) {
      current = current[exactKey];
    } else if (wildcardVal !== undefined) {
      current = wildcardVal;
    } else {
      current = null;
      break;
    }
  }

  if (current === null || current === undefined) return [];

  // If it accidentally has ain:/cards: keys, use ain: only
  if (typeof current === 'object' && !Array.isArray(current) && 'ain' in current) {
    current = current.ain;
  }

  if (typeof current === 'string') return current ? [current] : [];
  if (Array.isArray(current)) return current.filter(v => typeof v === 'string' && v);
  return [];
}

/**
 * Compile an Author's Note document for a branch.
 * Identical to AIN compilation but no story card output.
 *
 * @param {object|null} anDoc
 * @param {Map}         registry
 * @param {object}      compileContext - { branchPath, branchProtagonist }
 * @returns {string|null}
 */
function compileAN(anDoc, registry, compileContext) {
  if (!anDoc) return null;

  const { branchPath, branchProtagonist, variables } = compileContext;
  const variantNames = resolveANBranches(anDoc.branches, branchPath);
  const resolvedDoc = applyDocumentVariants(anDoc, variantNames);
  const sections = resolvedDoc.sections || {};

  // Reuse the section sorting and rendering from ain.js via compileAIN
  // but strip the story card output
  const { ain } = compileAIN(resolvedDoc, registry, { branchPath, branchProtagonist, variables });
  return ain;
}

/**
 * Write Author's Note.md to the Components folder for a branch.
 */
function writeAN(branchOutputDir, content) {
  if (!content) return null;
  const dir = path.join(branchOutputDir, 'Components');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "Author's Note.md");
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

module.exports = { loadANConfig, compileAN, writeAN };
