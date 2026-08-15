'use strict';

const fs = require('fs');
const path = require('path');
const { loadYaml, resolveVariables, warnUnexpandedVariables, warnUnresolvedFieldTokens, warnMechanicalArtifacts, consoleWarner } = require('./util');
const { resolveItem, resolveBranchSpec, mergeBranchSpecs, applyFieldsDelta, applyFieldOp } = require('./resolver');
const { applyPronounPasses } = require('./model/pronouns');
const { resolveItemRef, describeRefFailure, normalizeRef, splitRef } = require('./model/refs');
const { render, applyFieldInterpolation, applyVariableInterpolation, applyFieldRenderFunctions, applyWrapper, resolveTemplateName } = require('./template');

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
 * Get template content for a item, with optional hint fallback.
 */
function getCardTemplate(item, templates, style) {
  const templateName = item.render && item.render.template
    ? item.render.template
    : (item.aid && item.aid.type ? item.aid.type : null);

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
 * Render a single non-section PE block to { body, wrapper }, or null if skipped.
 * Does NOT apply the outer wrapper — caller is responsible.
 * Does NOT do branch-filtering — caller must check branches before calling.
 *
 * @param {object} blockDef
 * @param {object} renderOpts        - blockDef.render (or {} if absent)
 * @param {Map}    registry
 * @param {Map}    templates
 * @param {Map}    partials
 * @param {object} compileContext    - { branchPath, branchProtagonist }
 * @param {Map}    overlays
 * @returns {{ body: string, wrapper: string } | null}
 */
function renderPEBlock(blockDef, renderOpts, registry, templates, partials, compileContext, overlays) {
  const { branchPath, branchProtagonist, variables } = compileContext;

  const style      = (renderOpts.style || 'full').toLowerCase();
  const stripFence = !!renderOpts.stripFence;

  // ── Inline PE item (no import) ──────────────────────────────────────────
  if (!blockDef.import) {
    const syntheticItem = {
      id:       blockDef.id || '(pe-inline)',
      name:     blockDef.id || '(pe-inline)',
      pronouns: blockDef.pronouns || null,
      aid:      blockDef.aid || {},
      render:   blockDef.render || {},
      body:     blockDef.body || {},
    };

    if (blockDef.variants) {
      applyFieldsDelta(syntheticItem, blockDef.variants);
    }

    applyFieldInterpolation(syntheticItem);
    applyVariableInterpolation(syntheticItem, variables);
    applyFieldRenderFunctions(syntheticItem);
    applyPronounPasses(syntheticItem, registry, branchProtagonist);

    const templateOverride = renderOpts.template;
    const wrapper = renderOpts.wrapper || (syntheticItem.render && syntheticItem.render.wrapper) || 'none';
    const bodyText = syntheticItem.body
      ? (syntheticItem.body.text || syntheticItem.body.content || '')
      : '';
    // Template resolution mirrors getCardTemplate: explicit render.template wins,
    // then fall back to the block's aid.type (so PE block types like
    // genreSettingBlock select their matching template without an explicit override).
    const inlineTemplateName = templateOverride
      || (syntheticItem.render && syntheticItem.render.template)
      || (syntheticItem.aid && syntheticItem.aid.type)
      || null;
    const itemForRender = { ...syntheticItem, render: { ...syntheticItem.render, wrapper: 'none' } };
    let rendered;
    if (templateOverride) {
      const t = templates.get(templateOverride.toLowerCase());
      if (!t) {
        console.warn(`  WARN [PE]: template "${templateOverride}" not found for inline block`);
        return null;
      }
      rendered = render(t.content, itemForRender, partials, variables);
    } else if (bodyText) {
      rendered = resolveVariables(String(bodyText).trim(), variables);
    } else if (inlineTemplateName && templates.get(inlineTemplateName.toLowerCase())) {
      const t = templates.get(inlineTemplateName.toLowerCase());
      rendered = render(t.content, itemForRender, partials, variables);
    } else {
      return null;
    }

    const body = stripFence ? stripAboveLastFence(rendered) : rendered;
    return { body, wrapper };
  }

  // ── Item import ───────────────────────────────────────────────────────────
  const found = resolveItemRef(registry, blockDef.import);
  if (!found.item) {
    console.error(`  ERR [PE]: ${describeRefFailure(found)}`);
    return null;
  }
  const canonItem = found.item;

  const overlay = overlays.get(normalizeRef(blockDef.import)) || null;

  // Block-level and overlay-level branches compose with the canon item's own branches
  // tree (canon → overlay → block) rather than replacing it — a PE block's `branches:`
  // is usually just visibility gating and must not discard the item's own route-variant
  // dispatch tree. See mergeBranchSpecs in resolver.js.
  const resolvedBranches = mergeBranchSpecs(
    mergeBranchSpecs(canonItem.branches, overlay?.branches),
    blockDef.branches
  );

  const importDef = {
    import:         blockDef.import,
    importVariants: blockDef.importVariants ?? overlay?.importVariants,
    branches:       resolvedBranches,
    body:           (overlay?.body !== undefined && blockDef.body !== undefined)
                      ? applyFieldOp(overlay.body, blockDef.body)
                      : (blockDef.body ?? overlay?.body),
    // Canon variants are always in scope so variant names dispatched from the merged
    // branches tree above resolve, regardless of whether the block/overlay add their own.
    variants:       Object.assign({}, canonItem.variants, overlay?.variants, blockDef.variants),
    name:           blockDef.name     ?? overlay?.name,
    pronouns:       blockDef.pronouns ?? overlay?.pronouns,
    aid:            (overlay?.aid !== undefined && blockDef.aid !== undefined)
                      ? applyFieldOp(overlay.aid, blockDef.aid)
                      : (blockDef.aid ?? overlay?.aid),
    render:         (overlay?.render !== undefined && blockDef.render !== undefined)
                      ? applyFieldOp(overlay.render, blockDef.render)
                      : (blockDef.render ?? overlay?.render),
    v:              (overlay?.v !== undefined && blockDef.v !== undefined)
                      ? applyFieldOp(overlay.v, blockDef.v)
                      : (blockDef.v ?? overlay?.v),
  };

  let item;
  try {
    item = resolveItem(importDef, registry, branchPath, consoleWarner);
  } catch (err) {
    console.error(`  ERR [PE]: resolving import "${blockDef.import}": ${err.message}`);
    return null;
  }

  if (!item) return null;

  applyFieldInterpolation(item);
  applyVariableInterpolation(item, variables);
  applyFieldRenderFunctions(item);
  applyPronounPasses(item, registry, branchProtagonist);

  const templateContent = getCardTemplate(item, templates, style);
  if (!templateContent) {
    const name = item.id || blockDef.import;
    const src = item._source ? ` (${item._source})` : '';
    console.error(`  ERR [PE]: no template found for item "${name}"${src} (type: ${item.aid && item.aid.type}, style: ${style})`);
    return null;
  }

  const wrapper = renderOpts.wrapper || (item.render && item.render.wrapper) || 'none';
  const context = { ...item, body: item.body || {}, render: { ...item.render, wrapper: 'none' } };
  let renderedItem;
  try {
    renderedItem = render(templateContent, context, partials, variables);
  } catch (err) {
    const src = item._source ? ` (${item._source})` : '';
    console.error(`  ERR [PE]: rendering item "${item.id || blockDef.import}"${src}: ${err.message}`);
    return null;
  }

  const body = stripFence ? stripAboveLastFence(renderedItem) : renderedItem;
  return { body, wrapper };
}

/**
 * Render a section block (identified by having a `blocks:` key).
 * Groups child blocks under a single wrapper with an optional heading.
 * Returns { text: string, position: number } or null if section produces no output.
 *
 * Child render.wrapper is ignored — the section applies the outer wrapper.
 * Child render.position sorts children within the section.
 * Sections are not nestable — a child with a `blocks:` key is warned and skipped.
 *
 * @param {object} sectionDef
 * @param {Map}    registry
 * @param {Map}    templates
 * @param {Map}    partials
 * @param {object} compileContext    - { branchPath, branchProtagonist }
 * @param {Map}    overlays
 * @returns {{ text: string, position: number } | null}
 */
function renderPESection(sectionDef, registry, templates, partials, compileContext, overlays, emittedFullImportIds = null) {
  const { branchPath } = compileContext;
  const renderOpts   = sectionDef.render || {};
  const position     = renderOpts.position !== undefined ? renderOpts.position : 5;
  const wrapper      = renderOpts.wrapper  || 'none';
  const compact      = renderOpts.compact  !== undefined ? renderOpts.compact : false;
  const heading      = sectionDef.heading      || null;
  const headingLevel = sectionDef.headingLevel !== undefined ? sectionDef.headingLevel : 0;

  const childBlocks = sectionDef.blocks;
  if (!Array.isArray(childBlocks) || childBlocks.length === 0) return null;

  const childSegments = [];
  for (const childDef of childBlocks) {
    if (childDef.blocks) {
      console.warn('  WARN [PE]: nested sections are not supported — skipping child section');
      continue;
    }

    const branchResult = resolveBranchSpec(childDef.branches, branchPath);
    if (branchResult === null) continue;

    const childRenderOpts = childDef.render || {};
    if ((childRenderOpts.style || 'full').toLowerCase() === 'skip') continue;

    const childPosition = childRenderOpts.position !== undefined ? childRenderOpts.position : 5;

    // Force wrapper to none — the section owns the outer wrap
    const result = renderPEBlock(
      childDef, { ...childRenderOpts, wrapper: 'none' },
      registry, templates, partials, compileContext, overlays
    );
    if (!result) continue;

    // Record full-style import children that actually rendered, so the caller
    // suppresses exactly the story cards PE emitted (never more).
    if (emittedFullImportIds && childDef.import &&
        (childRenderOpts.style || 'full').toLowerCase() === 'full') {
      emittedFullImportIds.add(splitRef(childDef.import).id);
    }

    childSegments.push({ body: result.body, position: childPosition });
  }

  if (childSegments.length === 0) return null;

  childSegments.sort((a, b) => (a.position || 5) - (b.position || 5));
  const joinedBody = childSegments.map(s => s.body).join('\n');

  const parts = [];
  if (heading) {
    const headingText = headingLevel > 0
      ? '#'.repeat(headingLevel) + ' ' + heading
      : heading;
    parts.push(headingText);
    if (!compact) parts.push('');
  }
  parts.push(joinedBody);

  return { text: applyWrapper(parts.join('\n'), wrapper), position };
}

/**
 * Compile all applicable PE blocks for a single branch leaf.
 * Returns the full Plot Essentials content string, or null if no blocks produce output.
 *
 * @param {object[]} peBlocks          - raw block definitions
 * @param {Map}      registry          - full merged item registry
 * @param {Map}      templates         - loaded template map
 * @param {Map}      partials          - loaded partials map
 * @param {object}   compileContext    - { branchPath, branchProtagonist }
 * @param {Map}      overlays
 * @param {Set|null} emittedFullImportIds - optional out-param; receives the lowercase
 *                   ids of import blocks that actually rendered at full style. The
 *                   caller uses this to suppress exactly those story cards — so a item
 *                   PE excludes (or fails to render) is never dropped from Story Cards.
 */
function compilePE(peBlocks, registry, templates, partials, compileContext, overlays = new Map(), emittedFullImportIds = null) {
  const segments = collectPESegments(peBlocks, registry, templates, partials, compileContext, overlays, emittedFullImportIds);
  if (segments.length === 0) return null;
  return sortByPosition(segments).map(s => s.text).join('\n\n');
}

/**
 * Collect the individual rendered PE segments for a branch leaf, each tagged with a
 * stable `key` so cross-branch diffing can compare block-by-block rather than treating
 * Plot Essentials as one opaque blob. Shared by compilePE (which joins) and
 * compilePEBlocks (which returns the un-joined, position-sorted blocks).
 *
 * Returns [{ key, position, text }].
 */
function collectPESegments(peBlocks, registry, templates, partials, compileContext, overlays = new Map(), emittedFullImportIds = null) {
  const { branchPath } = compileContext;
  const segments = [];

  peBlocks.forEach((blockDef, index) => {
    // ── Section block ──────────────────────────────────────────────────────
    if (blockDef.blocks) {
      const branchResult = resolveBranchSpec(blockDef.branches, branchPath);
      if (branchResult === null) return;

      const segment = renderPESection(blockDef, registry, templates, partials, compileContext, overlays, emittedFullImportIds);
      if (segment) segments.push({ ...segment, key: `section:${blockDef.heading || index}` });
      return;
    }

    // ── Regular block (inline or import) ──────────────────────────────────
    const branchResult = resolveBranchSpec(blockDef.branches, branchPath);
    if (branchResult === null) return;

    const renderOpts = blockDef.render || {};
    const style = (renderOpts.style || 'full').toLowerCase();
    if (style === 'skip') return;

    const position = renderOpts.position !== undefined ? renderOpts.position : 5;

    const result = renderPEBlock(blockDef, renderOpts, registry, templates, partials, compileContext, overlays);
    if (!result) return;

    // Record full-style imports that actually rendered (see emittedFullImportIds).
    if (emittedFullImportIds && blockDef.import && style === 'full') {
      emittedFullImportIds.add(splitRef(blockDef.import).id);
    }

    const key = blockDef.import
      ? `import:${normalizeRef(blockDef.import)}`
      : `inline:${blockDef.id || index}`;
    segments.push({ text: applyWrapper(result.body, result.wrapper), position, key });
  });

  return segments;
}

/**
 * Compile PE for a branch leaf into its individual blocks (position-sorted) instead of
 * a single joined string. Used by the cross-branch diff/annotate reports so component
 * differences are reported at block granularity.
 *
 * Returns [{ key, text }], or [] if nothing rendered.
 */
function compilePEBlocks(peBlocks, registry, templates, partials, compileContext, overlays = new Map()) {
  const segments = collectPESegments(peBlocks, registry, templates, partials, compileContext, overlays, null);
  return sortByPosition(segments).map(s => ({ key: s.key, text: s.text }));
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
  warnUnexpandedVariables(content, 'component Plot Essentials.md');
  warnUnresolvedFieldTokens(content, 'component Plot Essentials.md');
  warnMechanicalArtifacts(content, 'component Plot Essentials.md');
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

module.exports = { loadPEConfig, compilePE, compilePEBlocks, writePE };
