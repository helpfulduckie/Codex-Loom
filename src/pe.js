'use strict';

const fs = require('fs');
const path = require('path');
const { loadYaml } = require('./util');
const { resolveCard, resolveBranchSpec, applyFieldsDelta } = require('./resolver');
const { applyPronounPasses } = require('./pronouns');
const { render, applyFieldInterpolation, applyFieldRenderFunctions, applyWrapper, resolveTemplateName } = require('./template');

/**
 * Load and parse a Plot Essentials YAML file.
 * Returns an array of PE block definitions, or [] if spec is null/missing.
 *
 * @param {string|null} peSpec - resolved file path (already resolved by compile.js)
 */
function loadPEConfig(peSpec) {
  if (!peSpec) return [];
  if (!fs.existsSync(peSpec)) {
    console.warn(`  WARN [PE]: file not found: ${peSpec}`);
    return [];
  }
  const data = loadYaml(peSpec);
  if (!Array.isArray(data)) {
    throw new Error(`PE file must be a YAML sequence: ${peSpec}`);
  }
  return data;
}

/**
 * Strip everything above the last ~~~ fence line from rendered text.
 */
function stripAboveLastFence(rendered) {
  const lines = rendered.split('\n');
  let lastFence = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '~~~') lastFence = i;
  }
  if (lastFence === -1) return rendered.trim();
  return lines.slice(lastFence + 1).join('\n').trim();
}

/**
 * Get template content for a card, with optional hint fallback.
 */
function getCardTemplate(card, templates, style) {
  const templateName = card.render && card.render.template
    ? card.render.template
    : (card.aid && card.aid.type ? card.aid.type : null);

  if (!templateName) return null;

  if (style === 'hint') {
    const hintKey = (templateName + '.hint').toLowerCase();
    const hintTemplate = templates.get(hintKey);
    if (hintTemplate) return hintTemplate.content;
    // Fallback to regular template with warning
    console.warn(`  WARN [PE]: no .hint template found for "${templateName}", falling back to full template`);
  }

  const t = templates.get(templateName.toLowerCase());
  return t ? t.content : null;
}

/**
 * Sort rendered segments by position (default 5). Stable sort.
 */
function sortByPosition(segments) {
  return segments.slice().sort((a, b) => (a.position || 5) - (b.position || 5));
}

/**
 * Compile all applicable PE blocks for a single branch leaf.
 * Returns the full Plot Essentials content string, or null if no blocks produce output.
 *
 * @param {object[]} peBlocks          - raw block definitions
 * @param {Map}      registry          - full merged card registry
 * @param {Map}      templates         - loaded template map
 * @param {Map}      partials          - loaded partials map
 * @param {object}   compileContext    - { branchPath, branchProtagonist }
 */
function compilePE(peBlocks, registry, templates, partials, compileContext) {
  const { branchPath, branchProtagonist } = compileContext;
  const segments = [];

  for (const blockDef of peBlocks) {
    // Branch filtering via resolveBranchSpec
    const branchResult = resolveBranchSpec(blockDef.branches, branchPath);
    if (branchResult === null) continue; // excluded

    const style = (blockDef.style || 'full').toLowerCase();
    if (style === 'skip') continue;

    const renderOpts = blockDef.render || {};
    const position  = renderOpts.position !== undefined ? renderOpts.position : 5;
    const stripFence = !!renderOpts.stripFence;
    const wrapperOverride = renderOpts.wrapper || null;

    // ── Inline PE card (no import) ────────────────────────────────────────────
    if (!blockDef.import) {
      const syntheticCard = {
        id:      blockDef.id || '(pe-inline)',
        name:    blockDef.id || '(pe-inline)',
        pronouns: blockDef.pronouns || null,
        aid:     blockDef.aid || {},
        render:  blockDef.render || {},
        body:    blockDef.body || {},
      };

      // Apply block-level variants if any
      if (blockDef.variants) {
        applyFieldsDelta(syntheticCard, blockDef.variants);
      }

      applyFieldInterpolation(syntheticCard);
      applyFieldRenderFunctions(syntheticCard);
      applyPronounPasses(syntheticCard, registry, branchProtagonist);

      // Inline PE cards may have a template or just body text
      const templateOverride = renderOpts.template;
      const wrapper = wrapperOverride || (syntheticCard.render && syntheticCard.render.wrapper) || 'none';
      let rendered;
      if (templateOverride) {
        const t = templates.get(templateOverride.toLowerCase());
        if (!t) {
          console.warn(`  WARN [PE]: template "${templateOverride}" not found for inline block`);
          continue;
        }
        // Strip wrapper from context so template.js doesn't also wrap — pe.js applies it below
        const cardForRender = { ...syntheticCard, render: { ...syntheticCard.render, wrapper: 'none' } };
        rendered = render(t.content, cardForRender, partials);
      } else if (syntheticCard.body && Object.keys(syntheticCard.body).length > 0) {
        // No template: render body as plain text if it has a text/content field
        const bodyText = syntheticCard.body.text || syntheticCard.body.content || '';
        if (!bodyText) continue;
        rendered = String(bodyText).trim();
      } else {
        continue;
      }

      const body = stripFence ? stripAboveLastFence(rendered) : rendered;
      segments.push({ text: applyWrapper(body, wrapper), position });
      continue;
    }

    // ── Card import ───────────────────────────────────────────────────────────
    const canonId = String(blockDef.import).toLowerCase();
    const canonCard = registry.get(canonId);
    if (!canonCard) {
      console.error(`  ERR [PE]: no card with id "${blockDef.import}" found in registry`);
      continue;
    }

    // Build a synthetic import def for resolveCard
    // Apply block's variants and branch-selected variants
    const importDef = {
      import:         blockDef.import,
      importVariants: blockDef.importVariants,
      branches:       blockDef.branches,
      body:           blockDef.body,
    };

    let card;
    try {
      card = resolveCard(importDef, registry, branchPath);
    } catch (err) {
      console.error(`  ERR [PE]: resolving import "${blockDef.import}": ${err.message}`);
      continue;
    }

    if (!card) continue; // excluded by branch spec

    // Apply additional block-level variants (render-only overrides)
    if (blockDef.variants) {
      applyFieldsDelta(card, blockDef.variants);
    }

    // Apply render overrides from block
    if (renderOpts.template) {
      if (!card.render) card.render = {};
      card.render.template = renderOpts.template;
    }
    if (renderOpts.wrapper) {
      if (!card.render) card.render = {};
      card.render.wrapper = renderOpts.wrapper;
    }

    applyFieldInterpolation(card);
    applyFieldRenderFunctions(card);
    applyPronounPasses(card, registry, branchProtagonist);

    const templateContent = getCardTemplate(card, templates, style);
    if (!templateContent) {
      const name = card.id || blockDef.import;
      console.error(`  ERR [PE]: no template found for card "${name}" (type: ${card.aid && card.aid.type}, style: ${style})`);
      continue;
    }

    const wrapper = wrapperOverride || (card.render && card.render.wrapper) || 'none';
    // Strip wrapper from context so template.js doesn't also wrap — pe.js applies it below
    const context = { ...card, body: card.body || {}, render: { ...card.render, wrapper: 'none' } };
    let renderedCard;
    try {
      renderedCard = render(templateContent, context, partials);
    } catch (err) {
      console.error(`  ERR [PE]: rendering card "${card.id || blockDef.import}": ${err.message}`);
      continue;
    }

    const body = stripFence ? stripAboveLastFence(renderedCard) : renderedCard;
    segments.push({ text: applyWrapper(body, wrapper), position });
  }

  if (segments.length === 0) return null;
  return sortByPosition(segments).map(s => s.text).join('\n\n');
}

/**
 * Write Plot Essentials.md to the Components folder for a branch.
 * Returns the output path, or null if content is null.
 */
function writePE(branchOutputDir, content) {
  if (!content) return null;
  const dir = path.join(branchOutputDir, 'Components');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'Plot Essentials.md');
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

module.exports = { loadPEConfig, compilePE, writePE };
