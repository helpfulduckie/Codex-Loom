'use strict';

const fs = require('fs');
const path = require('path');
const { loadYaml, resolveVariables, warnUnexpandedVariables, warnUnresolvedFieldTokens, warnMechanicalArtifacts } = require('./util');
const { applyFieldOp } = require('./resolver');
const { applyTokenPass } = require('./model/pronouns');
const { normalizeWhitespace } = require('./template');

/**
 * Load and parse an AI Instructions YAML file.
 * Returns the parsed AINDoc object, or null if spec is missing.
 *
 * @param {string|null} ainSpec - resolved file path
 */
function loadAINConfig(ainSpec) {
  if (!ainSpec) return null;
  if (!fs.existsSync(ainSpec)) {
    console.warn(`  WARN [AIN]: file not found: ${ainSpec}`);
    return null;
  }
  const data = loadYaml(ainSpec);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`AIN file must be a YAML mapping: ${ainSpec}`);
  }
  return data;
}

/**
 * Resolve branch dispatch for AIN.
 *
 * Branch value forms:
 *   scalar or sequence  → applies to ain output only
 *   mapping with ain:/cards: keys → controls each independently
 *
 * Returns { ainVariants: string[], cardVariantSets: string[][] }
 *   ainVariants:    variant names to apply to the AIN document render
 *   cardVariantSets: array of variant-name lists, each producing a distinct story card
 */
function resolveAINBranches(branchesSpec, branchPath) {
  if (!branchesSpec || typeof branchesSpec !== 'object') {
    return { ainVariants: [], cardVariantSets: [] };
  }

  // Walk branch path to find the matching entry
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

  if (current === null || current === undefined) {
    return { ainVariants: [], cardVariantSets: [] };
  }

  // Mapping form with ain:/cards: keys
  if (typeof current === 'object' && !Array.isArray(current) && ('ain' in current || 'cards' in current)) {
    const ainVal  = current.ain;
    const cardsVal = current.cards;
    return {
      ainVariants:    parseVariantList(ainVal),
      cardVariantSets: parseCardVariantSets(cardsVal),
    };
  }

  // Scalar/sequence → AIN only
  return {
    ainVariants:    parseVariantList(current),
    cardVariantSets: [],
  };
}

function parseVariantList(val) {
  if (!val) return [];
  if (typeof val === 'string') return val ? [val] : [];
  if (Array.isArray(val)) return val.filter(v => typeof v === 'string' && v);
  return [];
}

function parseCardVariantSets(val) {
  if (!val) return [];
  if (typeof val === 'string') return val ? [[val]] : [];
  if (Array.isArray(val)) return val.map(v => typeof v === 'string' ? [v] : (Array.isArray(v) ? v : []));
  return [];
}

/**
 * Apply a list of document-level variants to the AINDoc.
 * Document variants have an apply: key (applied to all sections that define it)
 * and a sections: key (null a section entirely).
 * Returns a new doc object (shallow clone with modified sections).
 */
function applyDocumentVariants(doc, variantNames) {
  if (!variantNames || variantNames.length === 0) return doc;
  if (!doc.variants) return doc;

  let sections = Object.assign({}, doc.sections || {});
  let card = doc.card;

  for (const vName of variantNames) {
    const actualKey = Object.keys(doc.variants).find(k => k.toLowerCase() === vName.toLowerCase());
    if (!actualKey) {
      console.warn(`  WARN [AIN]: document variant "${vName}" not found`);
      continue;
    }
    const variant = doc.variants[actualKey];
    if (!variant || typeof variant !== 'object') continue;

    // apply: list — apply named section variants to all sections that define them
    const applyList = parseVariantList(variant.apply);
    for (const sectionVarName of applyList) {
      for (const [sId, section] of Object.entries(sections)) {
        if (!section || !section.variants) continue;
        const sVarKey = Object.keys(section.variants).find(k => k.toLowerCase() === sectionVarName.toLowerCase());
        if (sVarKey) {
          sections[sId] = applySection(section, section.variants[sVarKey]);
        }
      }
    }

    // sections: null → remove section
    if (variant.sections) {
      for (const [sId, sVal] of Object.entries(variant.sections)) {
        if (sVal === null) {
          const actualSKey = Object.keys(sections).find(k => k.toLowerCase() === sId.toLowerCase());
          if (actualSKey) delete sections[actualSKey];
        }
      }
    }

    // card: overrides
    if (variant.card) {
      card = Object.assign({}, card, variant.card);
    }
  }

  return { ...doc, sections, card };
}

/**
 * Apply a section-level variant delta to a section.
 */
function applySection(section, variantDef) {
  if (!variantDef || typeof variantDef !== 'object') return section;
  const result = Object.assign({}, section);

  if (variantDef.text !== undefined) {
    if (variantDef.text === null) {
      delete result.text;
    } else if (typeof variantDef.text === 'string') {
      // Replace text entirely
      result.text = variantDef.text;
    } else if (typeof variantDef.text === 'object') {
      // Operate on mapping text
      if (typeof result.text !== 'object' || result.text === null) {
        result.text = {};
      }
      const newText = Object.assign({}, result.text);
      for (const [rId, rOp] of Object.entries(variantDef.text)) {
        if (rOp === null) {
          delete newText[rId];
        } else {
          const newVal = applyFieldOp(newText[rId], rOp);
          if (newVal === '__DELETE__') delete newText[rId]; else newText[rId] = newVal;
        }
      }
      result.text = newText;
    }
  }

  if (variantDef.heading !== undefined) result.heading = variantDef.heading;
  if (variantDef.headingLevel !== undefined) result.headingLevel = variantDef.headingLevel;
  if (variantDef.render !== undefined) result.render = Object.assign({}, result.render, variantDef.render);

  return result;
}

/**
 * Render a single AIN section to a string.
 */
function renderSection(section, opts) {
  const { branchProtagonist, registry, variables } = opts;
  const lines = [];

  // Heading
  if (section.heading) {
    const level = section.headingLevel ?? 2;
    lines.push(level > 0 ? '#'.repeat(level) + ' ' + section.heading : section.heading);
    if (!section.render?.compact) lines.push('');
  }

  // Text
  const text = section.text;
  const prefix = section.render?.bullet ? '- ' : '';
  if (typeof text === 'string') {
    const withVars = resolveVariables(text, variables);
    const processed = applyTokenPass(withVars, { item: {}, registry, branchProtagonist });
    lines.push(prefix + processed.trim());
  } else if (text && typeof text === 'object') {
    for (const [, ruleText] of Object.entries(text)) {
      const withVars = resolveVariables(String(ruleText), variables);
      const processed = applyTokenPass(withVars, { item: {}, registry, branchProtagonist });
      lines.push(prefix + processed.trim());
    }
  }

  return lines.join('\n');
}

/**
 * Sort sections by position (from section.render.position, default 5). Stable.
 */
function sortSections(sections) {
  return Object.entries(sections).sort(([, a], [, b]) => {
    const posA = (a && a.render && a.render.position !== undefined) ? a.render.position : 5;
    const posB = (b && b.render && b.render.position !== undefined) ? b.render.position : 5;
    return posA - posB;
  });
}

/**
 * Compile an AIN document for a branch.
 *
 * @param {object|null} ainDoc
 * @param {Map}         registry
 * @param {object}      compileContext - { branchPath, branchProtagonist }
 * @returns {{ ain: string|null, storyCard: object|null }}
 */
function compileAIN(ainDoc, registry, compileContext) {
  if (!ainDoc) return { ain: null, storyCard: null };

  const { branchPath, branchProtagonist, variables } = compileContext;
  const { ainVariants, cardVariantSets } = resolveAINBranches(ainDoc.branches, branchPath);

  // Apply document-level variants for AIN output
  const resolvedDoc = applyDocumentVariants(ainDoc, ainVariants);
  const sections = resolvedDoc.sections || {};

  const opts = { branchProtagonist, registry, variables: variables || {} };
  const sectionStrings = sortSections(sections)
    .map(([, section]) => renderSection(section, opts))
    .filter(s => s.trim());

  const ain = sectionStrings.length > 0 ? normalizeWhitespace(sectionStrings.join('\n\n')) : null;

  // Story card output (if cards: variants are specified)
  // Each variant set in cardVariantSets produces a distinct card
  // For now, return the card metadata from the doc's card: block (if any)
  const storyCard = (cardVariantSets.length > 0 && resolvedDoc.card) ? resolvedDoc.card : null;

  return { ain, storyCard };
}

/**
 * Write AI Instructions.md to the Components folder for a branch.
 */
function writeAIN(branchOutputDir, content) {
  if (!content) return null;
  const dir = path.join(branchOutputDir, 'Components');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'AI Instructions.md');
  warnUnexpandedVariables(content, 'component AI Instructions.md');
  warnUnresolvedFieldTokens(content, 'component AI Instructions.md');
  warnMechanicalArtifacts(content, 'component AI Instructions.md');
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

module.exports = {
  loadAINConfig,
  compileAIN,
  writeAIN,
  resolveAINBranches,
  applyDocumentVariants,
};
