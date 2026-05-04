'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCard } = require('./resolver');
const { applyPronounPasses } = require('./pronouns');
const { render, applyFieldInterpolation } = require('./template');

/**
 * Load and parse plot-essentials.yaml from the project base directory.
 * Returns an array of PE block definitions, or [] if the file does not exist.
 */
function loadPEConfig(base) {
  const pePath = path.join(base, 'plot-essentials.yaml');
  if (!fs.existsSync(pePath)) return [];

  const yaml = require('js-yaml');
  try {
    const raw = fs.readFileSync(pePath, 'utf8');
    const data = yaml.load(raw);
    if (!Array.isArray(data)) {
      throw new Error('plot-essentials.yaml must be a YAML sequence (list of blocks)');
    }
    return data;
  } catch (err) {
    throw new Error(`Failed to load plot-essentials.yaml: ${err.message}`);
  }
}

/**
 * Wrap rendered text in the appropriate AID bracket style.
 */
function applyWrapper(text, wrapper) {
  const w = (wrapper || 'none').toLowerCase();
  if (w === 'square') return `[\n${text}\n]`;
  if (w === 'curly')  return `{\n${text}\n}`;
  return text;
}

/**
 * Strip everything up to and including the last ~~~ fence line from rendered text.
 * Used for card-body blocks so the ## Name / ~~~...~~~ header is removed.
 * Returns the trimmed body that follows the last fence.
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
 * Get the template for a card (same logic as compile.js getTemplate).
 * Checks card.template first, then card.type. Case-insensitive.
 */
function getTemplate(card, templates) {
  const keys = [card.template, card.type].filter(Boolean);
  for (const key of keys) {
    const t = templates.get(key.toLowerCase());
    if (t) return t.content;
  }
  return null;
}

/**
 * Check whether a PE block applies to the given branch leaf path.
 * Identical logic to cardAppliesTo in compile.js.
 */
function blockAppliesTo(blockDef, branchPath) {
  const only   = blockDef.only;
  const except = blockDef.except;
  const leafStr = branchPath.map(p => p.toLowerCase()).join('/');

  function matchesAnyPrefix(prefixList) {
    const prefixes = Array.isArray(prefixList) ? prefixList : [prefixList];
    return prefixes.some(prefix => {
      const p = prefix.toLowerCase();
      return leafStr === p || leafStr.startsWith(p + '/');
    });
  }

  if (only  !== undefined && only  !== null) return  matchesAnyPrefix(only);
  if (except !== undefined && except !== null) return !matchesAnyPrefix(except);
  return true;
}

/**
 * Compile all applicable PE blocks for a single branch leaf.
 * Returns the full PlotEssentials.md content string, or null if no blocks apply.
 *
 * @param {object[]} peBlocks   - raw block definitions from plot-essentials.yaml
 * @param {Map}      registry   - full merged card registry
 * @param {Map}      templates  - loaded template map
 * @param {string[]} branchPath - active leaf path e.g. ['subject']
 * @param {string|null} branchProtagonist - lowercase protagonist ID for this branch
 */
function compilePE(peBlocks, registry, templates, branchPath, branchProtagonist) {
  const rendered = [];

  for (const blockDef of peBlocks) {
    if (!blockAppliesTo(blockDef, branchPath)) continue;

    const wrapper   = blockDef.wrapper || 'none';
    const stripFence = !!blockDef.strip_fence;

    // ── Freeform block ──────────────────────────────────────────────────────
    if (!blockDef.import) {
      if (!blockDef.text && blockDef.text !== '') {
        console.warn('  WARN [PE]: freeform block has no text field — skipping');
        continue;
      }

      // Run pronoun/conjugation passes on freeform text.
      // We need a minimal card-like object for the pass.
      // Freeform blocks can declare pronouns/protagonist directly on the block.
      const fakeCard = {
        name: blockDef.id || '(pe block)',
        pronouns:    blockDef.pronouns    || null,
        protagonist: blockDef.protagonist || null,
        fields: { _text: blockDef.text },
      };

      applyPronounPasses(fakeCard, registry, branchProtagonist);
      const processedText = fakeCard.fields._text;

      rendered.push(applyWrapper(processedText.trim(), wrapper));
      continue;
    }

    // ── Card-body block (import: syntax) ────────────────────────────────────
    let card;
    try {
      card = resolveCard(blockDef, registry, branchPath);
    } catch (err) {
      console.error(`  ERR [PE]: resolving import "${blockDef.import}": ${err.message}`);
      continue;
    }

    applyFieldInterpolation(card);
    applyPronounPasses(card, registry, branchProtagonist);

    // Template override on the PE block takes priority over card's own template/type
    const templateKey = blockDef.template || null;
    let templateContent;
    if (templateKey) {
      const t = templates.get(templateKey.toLowerCase());
      if (!t) {
        console.error(`  ERR [PE]: template "${templateKey}" not found for import "${blockDef.import}"`);
        continue;
      }
      templateContent = t.content;
    } else {
      templateContent = getTemplate(card, templates);
      if (!templateContent) {
        console.error(`  ERR [PE]: no template found for card "${card.name}" (type: ${card.type}, template: ${card.template})`);
        continue;
      }
    }

    const context = { ...card, fields: card.fields || {} };

    let renderedCard;
    try {
      renderedCard = render(templateContent, context);
    } catch (err) {
      console.error(`  ERR [PE]: rendering card "${card.name}": ${err.message}`);
      continue;
    }

    const body = stripFence ? stripAboveLastFence(renderedCard) : renderedCard.trim();
    rendered.push(applyWrapper(body, wrapper));
  }

  if (rendered.length === 0) return null;
  return rendered.join('\n\n');
}

/**
 * Write PlotEssentials.md to the Components folder for a branch.
 * Creates the directory if needed. Does nothing if content is null.
 */
function writePE(branchOutputDir, content) {
  if (!content) return null;
  const dir = path.join(branchOutputDir, 'Components');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'PlotEssentials.md');
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

module.exports = { loadPEConfig, compilePE, writePE };