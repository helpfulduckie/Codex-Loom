'use strict';

const path = require('path');
const {
  resolveItem, resolvePlacements, collectVariantDeltas,
} = require('./model/item');
const { walkBranchChain, resolveBranchSpec } = require('./model/branches');
const { applyRolePass, applyPronounPasses, applyCrossItemRefs } = require('./model/pronouns');
const { render, applyFieldInterpolation, applyVariableInterpolation } = require('./template');
const { renderFieldList } = require('./render/field-list');
const {
  resolveVariables, checkUnexpandedVariables, checkUnresolvedFieldTokens,
  checkMechanicalArtifacts, itemContext,
} = require('./util');
const { validateCardType } = require('./cardType');
const {
  renderNotesText, resolveTemplateForMaps, resolveRenderLadder, resolveBodyRender,
} = require('./templateResolve');
const { resolveCrossItemRenderFunctions } = require('./crossItem');
const { busWarner, severityOf, CODES: DIAG_CODES } = require('./diag');
const { nearestOrigin, originLocation } = require('./origin');
const { renderCard, cardTitle } = require('./emit/vl');
const { checkUndeclaredPlaceholders, checkPlaceholderContext } = require('./emit/placeholders');
const { checkTargetSlot } = require('./slots');
const { resolveComponentSpec, questionsForMeasurement } = require('./treeWrite');

function buildCompileContext(config, branchPath, options = {}) {
  const chain = walkBranchChain(config.branches, branchPath, {
    rootPlaceholders: config.placeholders,
    rootVariables: config._variables || config.variables || {},
    rootRoles: config.roles || {},
    rootLint: config.lint || null,
    onWarn: options.onWarn || null,
    source: config,
  });
  const variables = chain.variables;
  const roleInfo = options.roleStateByPath
    ? options.roleStateByPath.get(branchPath.join('/'))
    : null;
  const roles = roleInfo ? (roleInfo.declared ? roleInfo.resolved : null) : (chain.rolesDeclared ? chain.roles : null);
  const components = Object.assign({}, config.components || {}, chain.components);
  const render = Object.assign({}, config.render || {}, chain.render);

  const scripts = chain.scripts !== undefined ? chain.scripts : config.scripts;
  if (scripts !== undefined) components.scripts = scripts;

  const componentTypes = [
    'aiInstructions', 'opening', 'plotEssential', 'summary', 'authorsNote',
    'description', 'adventureDescription', 'scripts',
  ];
  const componentRefs = {};
  const componentOrigins = {};
  const configFile = { file: options.configPath || undefined };
  for (const type of componentTypes) {
    const spec = components[type] !== undefined ? components[type] : null;
    const authored = type === 'scripts'
      ? (chain.scripts !== undefined ? chain.paths.scripts : ['scripts'])
      : (chain.paths.components[type] || ['components', type]);
    componentOrigins[type] = originLocation(config, authored, configFile);
    componentRefs[type] = resolveComponentSpec(spec, config._base, variables, {
      diagnostics: options.diagnostics, location: componentOrigins[type],
    });
  }

  const templateFor = {};
  for (const node of [config, ...chain.nodes]) {
    if (!node || !node.templateFor) continue;
    const resolved = resolveTemplateForMaps(
      node.templateFor,
      config._resolvedTemplates || [],
      config._base || '.',
      variables,
      options.diagnostics,
      options.configPath || null,
    );
    for (const [role, typeMap] of Object.entries(resolved)) {
      templateFor[role] = Object.assign(templateFor[role] || {}, typeMap);
    }
  }

  return {
    variables, componentRefs, componentOrigins, render, templateFor, placeholders: chain.placeholders, roles,
    branchProtagonist: roleInfo ? roleInfo.protagonist : null,
    lint: chain.lint,
  };
}

function reportUnmatchedIncludeDispatch(allItemDefs, branchPath, diagnostics) {
  const groups = new Map(); // included file → the items it contributed
  for (const def of allItemDefs) {
    if (!def._include_branch_spec) continue;
    const key = def._source || '(unknown)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(def);
  }

  const branch = branchPath.join('/') || '(root)';
  for (const [source, items] of groups) {
    const selections = [];
    const names = resolveBranchSpec(
      items[0]._include_branch_spec, branchPath,
      (code, message, loc) => diagnostics.add(severityOf(code), code, message, { file: source, ...loc, branch }),
      { source: items[0], path: ['_include_branch_spec'], selections },
    );
    if (names === null) continue; // the whole include is excluded from this branch
    for (const { name, loc } of selections) {
      const matched = items.filter((def) => {
        const deltas = collectVariantDeltas(def, name, null);
        return deltas === null || deltas.length > 0;
      }).length;
      if (matched > 0) continue;
      diagnostics.warn(
        DIAG_CODES.SELECTOR_MATCHED_NOTHING,
        `branch dispatch to variant "${name}" on branch "${branchPath.join('/') || '(root)'}" `
        + `matched none of the ${items.length} items included from ${path.basename(source)}. `
        + 'No included item defines that variant, so the dispatch changes nothing; check '
        + 'the spelling or add the variant to an included item.',
        { ...loc, branch },
      );
    }
  }
}

function resolveBranchItems(allItemDefs, registry, branchPath, variables, diagnostics) {
  const resolvedItems = [];
  const claimedBy = new Map();

  reportUnmatchedIncludeDispatch(allItemDefs, branchPath, diagnostics);

  const branch = branchPath.join('/') || '(root)';
  for (const itemDef of allItemDefs) {
    let item;
    try {
      item = resolveItem(itemDef, registry, branchPath, (code, message, loc) => {
        diagnostics.add(severityOf(code), code, message, { ...originLocation(itemDef), ...loc, branch });
      });
    } catch (err) {
      const label = itemDef.id || itemDef.import || itemDef.name || '?';
      diagnostics.error(
        DIAG_CODES.ITEM_RESOLUTION_FAILED,
        `item "${label}" could not be resolved: ${err.importFailure ? err.importFailure.message : err.message}`,
        { ...(nearestOrigin(itemDef, 'import') || { file: itemDef._source }), branch },
        { hint: err.hint },
      );
      continue;
    }

    if (!item) continue; // excluded by branch spec

    const claimKey = String(item.id || '').toLowerCase();
    if (claimKey) {
      if (claimedBy.has(claimKey)) {
        const rival = claimedBy.get(claimKey);
        const here = itemDef._source ? path.basename(itemDef._source) : null;
        const elsewhere = rival.file && rival.file !== here ? ` (the first is in ${rival.file})` : '';
        diagnostics.error(
          DIAG_CODES.DUPLICATE_RESOLVED_ID,
          `two item definitions resolve to id "${claimKey}" on this branch${elsewhere}.`,
          { ...originLocation(itemDef, [itemDef.id ? 'id' : itemDef.import ? 'import' : 'name']), branch },
          {
            related: [{ label: 'first definition', ...rival.loc }],
            hint: 'A def carrying `import:` with no `id:` of its own claims the id of the item '
              + 'it imports, so two of them — or one alongside an explicit def of that id — emit '
              + 'the same item twice. Give one of them its own `id:` to make it a copy (§17.4), '
              + 'or dispatch them to different branches.',
          },
        );
      } else {
        claimedBy.set(claimKey, {
          file: itemDef._source ? path.basename(itemDef._source) : null,
          loc: originLocation(itemDef, [itemDef.id ? 'id' : itemDef.import ? 'import' : 'name']),
        });
      }
    }

    applyFieldInterpolation(item);
    applyVariableInterpolation(item, variables, { diagnostics, file: item._source });
    resolvedItems.push(item);
  }

  return resolvedItems;
}

function renderPlacementBody(item, target, templates, partials, variables, diagnostics, extra = {}) {
  const { fieldTable = { templates: {} }, templateFor = {} } = extra;
  const context = itemContext(item, { render: { ...(item.render || {}), wrapper: 'none' } });
  const label = item.id || (typeof item.name === 'string' ? item.name : String(item.name));
  const ownTemplate = item.render && item.render[target.component] && item.render[target.component].template;
  const loc = originLocation(item, ownTemplate ? ['render', target.component, 'template'] : ['render', 'template'],
    { branch: extra.branchLabel });

  const type = item.aid && item.aid.type;
  const hit = resolveRenderLadder(item, templates, fieldTable, {
    choice: target.template,
    maps: [templateFor[target.component] || {}, templateFor.base || {}],
    typeSlotName: `${target.component}:${type}`,
  });

  if (hit) {
    try {
      if (hit.kind === 'fieldList') {
        if (extra.fieldAudit) {
          extra.fieldAudit.collectForItem(item, hit.list, { templateFor, refRoot: 'body', branch: extra.branchLabel });
        }
        return renderFieldList(hit.list, fieldTable, context, {
          diagnostics, file: null, name: hit.name, partials, variables,
        });
      }
      return render(hit.entry.content, context, partials, variables,
        { diagnostics, file: hit.entry._source, name: hit.name });
    } catch (err) {
      diagnostics.error(
        DIAG_CODES.RENDER_FAILED,
      `item "${label}" failed to render into ${target.component}: ${err.message}; fix the reported template or data error, and the item remains unrendered.`,
        loc,
      );
      return null;
    }
  }

  const raw = item.body && (item.body.text !== undefined ? item.body.text : item.body.content);
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    return resolveVariables(String(raw).trim(), variables, { diagnostics, file: item._source });
  }

  diagnostics.error(
    DIAG_CODES.TEMPLATE_NOT_FOUND,
    `no template found for item "${label}" rendering into ${target.component}`
    + `${target.slot ? ` slot "${target.slot}"` : ''} (template: ${target.template || 'none'}); add or select the matching template, and the item remains unrendered.`,
    loc,
  );
  return null;
}


function renderBranchItems(resolvedItems, registry, templates, partials, branchProtagonist, variables = {}, options = {}) {
  const {
    renderedById = null,
    projectNotesTemplate = null,
    diagnostics,
    slotIndex = new Map(),
    branchLabel = '(root)',
    placeholders = {},
    usage = null,
    usagePath = '',
    roles = null,
    onRoleUsed = null,
    fieldTable = { fields: {}, groups: {}, templates: {} },
    templateFor = {},
    fieldAudit = null,
    cardTypeAudit = null,
  } = options;
  const resolvedById = new Map();
  for (const item of resolvedItems) {
    const id = (item.id || '').toLowerCase();
    if (id) resolvedById.set(id, item);
  }

  const placeholderNoise = new Map();

  const questions = questionsForMeasurement(placeholders, variables, {
    registry, roles, branchProtagonist, onRoleUsed,
  });

  applyRolePass(resolvedItems, { registry, roles, resolvedById, onRoleUsed });

  applyCrossItemRefs(resolvedItems, {
    registry, onWarn: busWarner(diagnostics, { branch: branchLabel }), resolvedById,
  });

  resolveCrossItemRenderFunctions(resolvedItems, resolvedById, diagnostics, { branch: branchLabel });

  const grouped = new Map();

  const occupants = new Map();

  const seenNames = new Map();
  const reportedCollisions = new Set(); // name

  for (const item of resolvedItems) {
    applyPronounPasses(item, {
      registry, branchProtagonist, resolvedById,
      roles, onWarn: busWarner(diagnostics, { branch: branchLabel }), onRoleUsed,
    });

    const placement = resolvePlacements(item);
    const itemId = item.id || (typeof item.name === 'string' ? item.name : String(item.name));

    renderTargets(item, placement, itemId, {
      templates, partials, variables, diagnostics, slotIndex, branchLabel,
      fieldTable, templateFor, fieldAudit, placeholders, usage, usagePath,
      occupants, placeholderNoise,
    });

    if (!placement.storyCard) continue;

    renderStoryCard(item, itemId, questions, {
      templates, partials, variables, diagnostics, branchLabel, projectNotesTemplate,
      fieldTable, templateFor, fieldAudit, cardTypeAudit, placeholders, usage, usagePath,
      grouped, renderedById, seenNames, reportedCollisions,
    });
  }

  return { grouped, occupants, placeholderNoise };
}

function renderTargets(item, placement, itemId, ctx) {
  const {
    templates, partials, variables, diagnostics, slotIndex, branchLabel,
    fieldTable, templateFor, fieldAudit, placeholders, usage, usagePath,
    occupants, placeholderNoise,
  } = ctx;

  let liveTargets = 0;

  for (const target of placement.targets) {
    const targetAt = originLocation(item, ['render', target.component, 'slot'], { branch: branchLabel });
    if (!checkTargetSlot(target, itemId, slotIndex, branchLabel, diagnostics, targetAt)) continue;
    const known = slotIndex.get(target.component);
    if (known && !known.slots.has(String(target.slot).toLowerCase())) continue;
    liveTargets++;
    const text = renderPlacementBody(item, target, templates, partials, variables, diagnostics, {
      fieldTable, templateFor, branchLabel,
      fieldAudit: placement.storyCard ? fieldAudit : null,
    });
    if (text === null) continue;
    if (String(text).trim() === '') {
      diagnostics.error(
        DIAG_CODES.ITEM_RENDERS_EMPTY,
        `item "${itemId}" reaches ${target.component} slot "${target.slot}" on branch `
        + `"${branchLabel}" but its body renders to nothing there. Exclude it from the `
        + 'branch with "branches:" if that is what was meant.',
        originLocation(item, ['body'], { branch: branchLabel }),
      );
      continue;
    }
    const reported = checkUndeclaredPlaceholders(text, placeholders, {
      diagnostics,
      file: item._source,
      item,
      roots: ['body'],
      where: `item "${itemId}" rendering into ${target.component} slot "${target.slot}"`,
      branch: branchLabel,
      usage,
      usagePath,
    });
    if (reported.length) {
      if (!placeholderNoise.has(target.component)) placeholderNoise.set(target.component, new Set());
      for (const name of reported) placeholderNoise.get(target.component).add(name);
    }
    if (!occupants.has(target.component)) occupants.set(target.component, new Map());
    const slots = occupants.get(target.component);
    const slotKey = String(target.slot || '').toLowerCase();
    if (!slots.has(slotKey)) slots.set(slotKey, []);
    slots.get(slotKey).push({ id: itemId, order: target.order, text, slot: target.slot });
  }

  if (!placement.storyCard && liveTargets === 0) {
    diagnostics.error(
      DIAG_CODES.ITEM_NO_OUTPUT,
      `item "${itemId}" resolves on branch "${branchLabel}" but produces no output there: `
      + 'storyCard is false and no declared target placed it. Exclude it from the branch '
      + 'with "branches:" if that is what was meant.',
      originLocation(item, ['render', 'storyCard'], { branch: branchLabel }),
    );
  }
}

function renderStoryCard(item, itemId, questions, ctx) {
  const {
    templates, partials, variables, diagnostics, branchLabel, projectNotesTemplate,
    fieldTable, templateFor, fieldAudit, cardTypeAudit, placeholders, usage, usagePath,
    grouped, renderedById, seenNames, reportedCollisions,
  } = ctx;

  checkPlaceholderContext(item.aid && item.aid.type, {
    diagnostics,
    file: item._source,
    loc: originLocation(item, ['aid', 'type']),
    where: `the type of story card "${itemId}"`,
    branch: branchLabel,
    reason: 'AID does not fill placeholders in a card’s type. It is a category, and '
      + 'Codex Loom also makes it a folder and file name in the compiled tree, so the '
      + 'raw text would become part of a path.',
  });

  validateCardType(item, { diagnostics, branch: branchLabel });

  const bodyRender = resolveBodyRender(item, templates, fieldTable, templateFor);
  if (!bodyRender) {
    const type = (item.aid && item.aid.type) || (item.render && item.render.template) || '?';
    diagnostics.error(
      DIAG_CODES.TEMPLATE_NOT_FOUND,
      `no template found for item "${itemId}" (type: ${type}); add or select the matching template, and the item remains unrendered.`,
      originLocation(item, ['render', 'template'], { branch: branchLabel }),
    );
    return;
  }

  if (fieldAudit && bodyRender.kind === 'fieldList') {
    fieldAudit.collectForItem(item, bodyRender.list, { templateFor, refRoot: 'body', branch: branchLabel });
  }

  const context = itemContext(item);

  let rendered;
  try {
    const errorsBeforeBody = diagnostics.errors.length;
    const bodyText = bodyRender.kind === 'fieldList'
      ? renderFieldList(bodyRender.list, fieldTable, context, {
        diagnostics, file: null, name: bodyRender.name, partials, variables,
      })
      : render(bodyRender.entry.content, context, partials, variables, {
        diagnostics, file: bodyRender.entry._source, name: bodyRender.name,
      });
    if (
      item.kind !== 'reference'
      && String(bodyText).trim() === ''
      && diagnostics.errors.length === errorsBeforeBody
    ) {
      diagnostics.error(
        DIAG_CODES.ITEM_RENDERS_EMPTY,
        `story card "${itemId}" on branch "${branchLabel}" renders an empty body: `
        + `template "${bodyRender.name}" reads no key this item carries. Use `
        + '"kind: reference" if the card is triggers and notes only.',
        originLocation(item, ['body'], { branch: branchLabel }),
      );
      return;
    }
    rendered = renderCard({
      item,
      bodyText,
      notesText: renderNotesText(item, context, templates, partials, variables, projectNotesTemplate, diagnostics, {
        fieldTable, templateFor,
      }),
      diagnostics,
      loc: originLocation(item, [], { branch: branchLabel }),
      questions,
    }).text;
  } catch (err) {
    diagnostics.error(
      DIAG_CODES.RENDER_FAILED,
      `item "${itemId}" failed to render: ${err.message}; fix the reported template or data error, and the item remains unrendered.`,
      originLocation(item, ['body'], { branch: branchLabel }),
    );
    return;
  }

  const type = cardTypeAudit
    ? cardTypeAudit.resolve((item.aid && item.aid.type) || 'Uncategorized', originLocation(item, ['aid', 'type'], { branch: branchLabel }))
    : (item.aid && item.aid.type) || 'Uncategorized';

  checkCardNameCollision(item, type, branchLabel, diagnostics, seenNames, reportedCollisions);

  const leakSink = { diagnostics, file: item._source };
  checkUnexpandedVariables(rendered, `item "${itemId}" (${type})`, leakSink);
  checkUnresolvedFieldTokens(rendered, `item "${itemId}" (${type})`, leakSink);
  checkMechanicalArtifacts(rendered, `item "${itemId}" (${type})`, leakSink);
  checkUndeclaredPlaceholders(rendered, placeholders, {
    diagnostics, file: item._source, where: `story card "${itemId}"`, branch: branchLabel,
    usage, usagePath, item,
  });
  if (!grouped.has(type)) grouped.set(type, []);
  grouped.get(type).push({
    sortKey: String(itemId).toLowerCase(),
    rendered,
    id: item.id ? String(item.id) : null,
    name: cardTitle(item),
  });
  if (renderedById && item.id) renderedById.set(item.id.toLowerCase(), { type, rendered });
}

function checkCardNameCollision(item, type, branchLabel, diagnostics, seenNames, reportedCollisions) {
  const cardName = cardTitle(item);
  const existing = seenNames.get(cardName);
  if (existing && !reportedCollisions.has(cardName)) {
    reportedCollisions.add(cardName);
    const where = existing.type === type
      ? `both as ${type}`
      : `${existing.type} in ${path.basename(existing.file || '')} and ${type} in ${path.basename(item._source || '')}`;
    diagnostics.error(
      DIAG_CODES.CARD_NAME_COLLISION,
      `story cards named "${cardName}" collide on branch "${branchLabel}" (${where}). Velvet Lattice merges story cards by name, so only one survives to AID and which one is position-dependent under inheritance. Give them distinct names.`,
      originLocation(item, cardNamePath(item), { branch: branchLabel }),
      { related: [{ label: 'first card', ...existing.loc }] },
    );
  }
  if (!existing) {
    seenNames.set(cardName, { type, file: item._source, loc: originLocation(item, cardNamePath(item)) });
  }
}

function cardNamePath(item) {
  const candidates = [['aid', 'title'], ...(typeof item.name === 'string' ? [['name']] : [['name', 'full']]),
    ['name', 'display'], ['id']];
  return candidates.find(path => {
    const value = path.reduce((obj, key) => obj == null ? undefined : obj[key], item);
    return value != null && String(value).trim() !== '';
  }) || [];
}

module.exports = {
  buildCompileContext,
  reportUnmatchedIncludeDispatch,
  resolveBranchItems,
  renderPlacementBody,
  renderBranchItems,
};
