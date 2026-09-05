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
const { busWarner, CODES: DIAG_CODES } = require('./diag');
const { renderCard, cardTitle } = require('./emit/vl');
const { checkUndeclaredPlaceholders, checkPlaceholderContext } = require('./emit/placeholders');
const { checkTargetSlot } = require('./slots');
const { resolveComponentSpec, questionsForMeasurement } = require('./treeWrite');

/**
 * Build the CompileContext for a given branch path.
 * Merges variables, components and render defaults from root → branch chain.
 */
function buildCompileContext(config, branchPath, options = {}) {
  const chain = walkBranchChain(config.branches, branchPath, {
    rootPlaceholders: config.placeholders,
    // Seeded here rather than merged afterward: `~` deletes a key from `chain.variables`
    // directly, and re-merging the root table on top afterward would silently put a
    // deleted root key right back.
    rootVariables: config._variables || config.variables || {},
    rootRoles: config.roles || {},
    rootLint: config.lint || null,
    onWarn: options.onWarn || null,
  });
  const variables = chain.variables;
  // `null` when no node in the chain ever declared `roles:`, distinct from an object that
  // merged down to no live bindings — a branch that unbinds its only inherited role is
  // still role-aware territory for CL0540's gating (`model/pronouns.js`), not the same as a
  // project that never mentioned roles at all.
  const roles = chain.rolesDeclared ? chain.roles : null;
  const components = Object.assign({}, config.components || {}, chain.components);
  const render = Object.assign({}, config.render || {}, chain.render);

  // `scripts:` is top-level: it is a file copy, not a rendered document, and it was the
  // one row in the component table that shared none of the row's behavior. It still merges
  // down the branch chain like everything else, so it is folded back in here rather than
  // resolved separately.
  const scripts = chain.scripts !== undefined ? chain.scripts : config.scripts;
  if (scripts !== undefined) components.scripts = scripts;

  // Resolve component specs to file paths
  // `adventureDescription` merges down the chain like the other sectioned components, so a
  // per-node adventure description is an ordinary row rather than a second writer: a value
  // declared at an interior node reaches the leaves beneath it here. `description` is
  // resolved here too — it is read at the root rather than per branch, but the migrator
  // and the root write both want the same expansion the other components get.
  //
  // `branchFraming` is deliberately absent. Framing belongs to interior nodes, not leaves:
  // `writeFramingRecursive`'s own tree walk reads `node.components.branchFraming` at every
  // node and resolves it there, with the bus, once. Nothing reads a leaf-context ref for it
  // (`SLOTTED_COMPONENTS` does not carry the framing descriptor), and resolving it here as
  // well would raise the same undeclared `{%var}` a second time, once per leaf.
  const componentTypes = [
    'aiInstructions', 'opening', 'plotEssential', 'summary', 'authorsNote',
    'description', 'adventureDescription', 'scripts',
  ];
  const componentRefs = {};
  const componentSpecSink = { diagnostics: options.diagnostics, file: options.configPath || null };
  for (const type of componentTypes) {
    const spec = components[type] !== undefined ? components[type] : null;
    componentRefs[type] = resolveComponentSpec(spec, config._base, variables, componentSpecSink);
  }

  // Branch-addressable `templateFor`. What merges down the chain is the type→field-list
  // map each node's slot files *produce*, not the filenames: a node names one file for a
  // role and gets that file's types, inheriting every other type from its ancestors. So
  // each node in the chain — the root config first, then every branch node — is resolved
  // on its own and the resulting per-role maps are folded key-wise, root to leaf. Empty
  // and IO-free for any project that declares no `templateFor:`.
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

  // The branch-merged placeholder table. Sits beside `variables` because it is the same
  // kind of thing — a per-branch mapping every check and the emitter read — and because
  // placeholder question text expands against `variables`, so the two are always wanted
  // together.
  return {
    variables, componentRefs, render, templateFor, placeholders: chain.placeholders, roles,
    // The branch-merged `lint.packs` table and per-branch `level:`. Returned so
    // `runPackChecks` reads it off the one walk that already ran here — with `onWarn`
    // wired, so a `<pack>: ~` unbinding nothing raises `CL0118` exactly once — rather than
    // re-walking `walkBranchChain` with its own, warn-less seed.
    lint: chain.lint,
  };
}

/**
 * CL0326 for an include's `branches:` — the other half of the arity-N dispatch guard.
 *
 * **Per branch, because a branch dispatch has no answer without a branch path.** The
 * `importVariants:` half of this check runs once per compile inside `resolveIncludes`,
 * which is where a selector that does not depend on the branch belongs. These two
 * placements are not an inconsistency: `importVariants:` selects from the imported source
 * unconditionally, `branches:` dispatches, and each is asked wherever its answer exists.
 *
 * A stamped spec is identical across every item from one include, so it resolves once per
 * group rather than once per item. Matching follows the same rule the other half uses: a
 * non-empty delta list or a `null` exclusion both count, and a partial path counts on the
 * segment that resolved.
 */
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
    const names = resolveBranchSpec(
      items[0]._include_branch_spec, branchPath, busWarner(diagnostics, { file: source, branch }),
    );
    if (names === null) continue; // the whole include is excluded from this branch
    for (const name of names) {
      const matched = items.filter((def) => {
        const deltas = collectVariantDeltas(def, name, null);
        return deltas === null || deltas.length > 0;
      }).length;
      if (matched > 0) continue;
      diagnostics.warn(
        DIAG_CODES.SELECTOR_MATCHED_NOTHING,
        `branch dispatch to variant "${name}" on branch "${branchPath.join('/') || '(root)'}" `
        + `matched none of the ${items.length} items included from ${path.basename(source)}. `
        + 'A dispatch stamped onto every item in a file is silent where an item does not '
        + 'define the name (§7.6.2a), so a misspelling applies to nothing and changes '
        + 'nothing — this is the only report it produces.',
        { file: source },
      );
    }
  }
}

/**
 * Compile story cards for a single branch leaf.
 * Returns array of resolved items (after Phase A), in place for Phase B caller.
 *
 * Phase A: resolve + field interpolation
 * Phase B (caller): cross-item refs + pronouns + render
 *
 * ── Why the duplicate-id check is here and not in the registry ──────────────
 *
 * `buildRegistry` throws on two defs claiming one id, but it never sees the whole
 * question: a bare `import:` def claims no id of its own — it *is* the item it names — so
 * it is filtered out before the registry's check runs. Two of them naming one library item,
 * or a bare import alongside an explicit def of the same id, therefore pass load and meet
 * for the first time here, as two resolved items with one id. What
 * reaches AID is two entries in one Plot Essentials slot and two story cards sharing a
 * name and a trigger list, from a compile that reported nothing.
 *
 * **Per branch, because the answer is per branch.** `resolveItem` returns null for a def
 * the branch spec excludes, so two defs sharing an id collide only on the branches where
 * both survive dispatch — dispatching one of a pair away is the documented way to write
 * mutually exclusive versions of an item. Asking once over the def list would report
 * that legitimate pattern as an error.
 */
function resolveBranchItems(allItemDefs, registry, branchPath, variables, diagnostics) {
  const resolvedItems = [];
  const claimedBy = new Map(); // lowercased resolved id → the source file that claimed it

  reportUnmatchedIncludeDispatch(allItemDefs, branchPath, diagnostics);

  const branch = branchPath.join('/') || '(root)';
  for (const itemDef of allItemDefs) {
    let item;
    try {
      item = resolveItem(itemDef, registry, branchPath, busWarner(diagnostics, { file: itemDef._source, branch }));
    } catch (err) {
      const label = itemDef.id || itemDef.import || itemDef.name || '?';
      diagnostics.error(
        DIAG_CODES.ITEM_RESOLUTION_FAILED,
        `item "${label}" could not be resolved: ${err.message}`,
        { file: itemDef._source, branch },
      );
      continue;
    }

    if (!item) continue; // excluded by branch spec

    const claimKey = String(item.id || '').toLowerCase();
    if (claimKey) {
      if (claimedBy.has(claimKey)) {
        // The other def's *basename* only, and only when it differs. `loc.file` already
        // carries this def's position, and an absolute path in a message body escapes
        // every normalization a report or a snapshot applies to `file`.
        const rival = claimedBy.get(claimKey);
        const here = itemDef._source ? path.basename(itemDef._source) : null;
        const elsewhere = rival && rival !== here ? ` (the first is in ${rival})` : '';
        diagnostics.error(
          DIAG_CODES.DUPLICATE_RESOLVED_ID,
          `two item definitions resolve to id "${claimKey}" on this branch${elsewhere}.`,
          { file: itemDef._source },
          {
            hint: 'A def carrying `import:` with no `id:` of its own claims the id of the item '
              + 'it imports, so two of them — or one alongside an explicit def of that id — emit '
              + 'the same item twice. Give one of them its own `id:` to make it a copy (§17.4), '
              + 'or dispatch them to different branches.',
          },
        );
      } else {
        claimedBy.set(claimKey, itemDef._source ? path.basename(itemDef._source) : null);
      }
    }

    applyFieldInterpolation(item);
    applyVariableInterpolation(item, variables, { diagnostics, file: item._source });
    resolvedItems.push(item);
  }

  return resolvedItems;
}

/**
 * Render one item body for one component target.
 *
 * The wrapper is forced off: the slot owns the wrapping of everything placed in it, and
 * `emit/components.js` applies it once the occupants are in hand. Leaving the item's own
 * `render.wrapper` in the context is what would ship an item double-braced inside a slot
 * of the same wrapper, which is why `render.wrapper` governs story-card output alone.
 *
 * Returns null and reports when the target's template ladder runs out with nothing to
 * render, which is the one case the ladder's verbatim rung cannot cover: no template and
 * no text is not a pass-through, it is an item that has nothing to say.
 */
function renderPlacementBody(item, target, templates, partials, variables, diagnostics, extra = {}) {
  const { fieldTable = { templates: {} }, templateFor = {} } = extra;
  const context = itemContext(item, { render: { ...(item.render || {}), wrapper: 'none' } });
  const label = item.id || (typeof item.name === 'string' ? item.name : String(item.name));

  // The component-target ladder, walked by `resolveRenderLadder` — the same rungs the
  // story-card body ladder walks, with a component slot map searched ahead of the base one.
  // A per-item `render.<component>.template` reaches here as `target.template`, so a real
  // choice keeps winning over the branch's slot — but the fill of `target.template` from
  // `aid.type` in `model/item.js` is not a choice, and honoring it at rung 1 would shadow
  // `templateFor.<component>` / `templateFor.base` for the whole corpus, which is what
  // `isTemplateChoice` guards against inside the ladder.
  const type = item.aid && item.aid.type;
  const hit = resolveRenderLadder(item, templates, fieldTable, {
    choice: target.template,
    maps: [templateFor[target.component] || {}, templateFor.base || {}],
    typeSlotName: `${target.component}:${type}`,
  });

  if (hit) {
    try {
      if (hit.kind === 'fieldList') {
        // The unread-field audit reads every field list an item renders through, not just
        // its story-card body — a key a slot's list omits but the card's reads is not
        // misrouted (§13.6). Gated on `extra.fieldAudit`, which the caller passes only for
        // an item that also emits a card (the audit's item set is unchanged this way).
        if (extra.fieldAudit) {
          // This is a story-card/component body render, so a bare `from:`/implied-source
          // path in `hit.list` qualifies against `body` (§ Decision 8).
          extra.fieldAudit.collectForItem(item, hit.list, { templateFor, refRoot: 'body' });
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
        `item "${label}" failed to render into ${target.component}: ${err.message}`,
        { file: item._source },
      );
      return null;
    }
  }

  // Verbatim pass-through — the last rung of the ladder.
  const raw = item.body && (item.body.text !== undefined ? item.body.text : item.body.content);
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    return resolveVariables(String(raw).trim(), variables, { diagnostics, file: item._source });
  }

  diagnostics.error(
    DIAG_CODES.TEMPLATE_NOT_FOUND,
    `no template found for item "${label}" rendering into ${target.component}`
    + `${target.slot ? ` slot "${target.slot}"` : ''} (template: ${target.template || 'none'})`,
    { file: item._source },
  );
  return null;
}

/**
 * Phase B: apply cross-item refs, pronouns, render, and write output.
 *
 * Returns `{ written, occupants }` — the story-card files, and the component slots those
 * same items routed into. One traversal produces both: an item declares where it goes, so
 * one pass over one resolved item decides its card output and its component placement
 * together, with nothing to reconcile afterward.
 */

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
    // The merged role table for this branch, and CL0545's usage callback — grouped with
    // the rest of the trailing options rather than appended as a 17th positional parameter.
    roles = null,
    onRoleUsed = null,
    // The field-declaration table (compile-wide) and the branch's resolved `templateFor`
    // role maps. Both default to empty, and every ladder below falls back to a plain
    // template lookup when they are.
    fieldTable = { fields: {}, groups: {}, templates: {} },
    templateFor = {},
    // The unread-field audit, built once per compile so its `(item id, field path)` dedupe
    // spans every leaf. Null on the report-mode paths that reuse this function without a
    // field table.
    fieldAudit = null,
    // CL0626–CL0628 — the `aid.type` normalizer, built once per compile for the same
    // reason: it dedupes per authored value across every branch, and its collision check
    // cannot run until every branch has contributed its types.
    cardTypeAudit = null,
  } = options;
  // Build early so render functions can resolve cross-item refs during field expansion.
  const resolvedById = new Map();
  for (const item of resolvedItems) {
    const id = (item.id || '').toLowerCase();
    if (id) resolvedById.set(id, item);
  }

  // Undeclared names already reported against a specific item-and-slot, per component.
  // The assembled-component scan reads this so one mistake is not described twice for
  // one file, once well and once vaguely.
  const placeholderNoise = new Map();

  // The length check measures what AID stores, which is the *substituted* string, so it
  // needs the questions rather than the keys. Expanded once per branch and handed down.
  const questions = questionsForMeasurement(placeholders, variables, {
    registry, roles, branchProtagonist, onRoleUsed,
  });

  // §9.3: normalize `{$Role…}` to `{$id…}` across every item before `applyCrossItemRefs`
  // runs, so a cross-item ref reached through a role (`{$LI.body.Tagline}`) arrives as
  // `{$<id>.body.Tagline}` and resolves like any other. Silent — `applyPronounPasses`
  // below is still the one site that raises role diagnostics — but it threads `onRoleUsed`
  // so a role used only in an item `.body.` ref keeps counting against CL0545. A no-op
  // when the branch declares no roles.
  applyRolePass(resolvedItems, { registry, roles, resolvedById, onRoleUsed });

  applyCrossItemRefs(resolvedItems, {
    registry, onWarn: busWarner(diagnostics, { branch: branchLabel }), resolvedById,
  });

  // Expand render functions in body field values now that cross-item refs are resolved.
  // Dependency-ordered: a scan-build-sort-evaluate sequence over the same graph a chain
  // like A.field = join($B.body.x) implies. Evaluating in topological order rather than
  // iterating a fixpoint loop to convergence is a correctness choice, not a performance
  // one — convergence order is not deterministic across such a graph.
  resolveCrossItemRenderFunctions(resolvedItems, resolvedById, diagnostics);

  // The envelope is the emitter's, not the template's. Templates render the body;
  // `emit/vl.js` writes the heading and the fence around it, and reports what it cannot
  // carry — a comma inside a trigger — onto the caller's bus. Nothing is printed or thrown
  // here: wrong output is still output, so the branch tree is finished either way and the
  // caller decides when to print and whether the run fails.
  const grouped = new Map();

  // component key → slot name (lowercased) → occupants, unsorted. `emit/components.js`
  // owns the sort, so `order:` then item id is stated in exactly one place.
  const occupants = new Map();

  // Card-name collision detector (CL0622). Keyed on the displayed card name rather than
  // the item id, because that is what VL's `_merge_story_cards` keys on.
  const seenNames = new Map(); // name → { type, file }
  const reportedCollisions = new Set(); // name

  for (const item of resolvedItems) {
    applyPronounPasses(item, {
      registry, branchProtagonist, resolvedById,
      roles, onWarn: busWarner(diagnostics, { branch: branchLabel }), onRoleUsed,
    });

    // The item says where it goes. Read once, here, and used for both outputs.
    const placement = resolvePlacements(item);
    const itemId = item.id || (typeof item.name === 'string' ? item.name : String(item.name));

    renderTargets(item, placement, itemId, {
      templates, partials, variables, diagnostics, slotIndex, branchLabel,
      fieldTable, templateFor, fieldAudit, placeholders, usage, usagePath,
      occupants, placeholderNoise,
    });

    // `storyCard: false` is the only thing that suppresses a card. An item that renders
    // only into a component never produces one, so there is nothing to suppress.
    if (!placement.storyCard) continue;

    renderStoryCard(item, itemId, questions, {
      templates, partials, variables, diagnostics, branchLabel, projectNotesTemplate,
      fieldTable, templateFor, fieldAudit, cardTypeAudit, placeholders, usage, usagePath,
      grouped, renderedById, seenNames, reportedCollisions,
    });
  }

  // The per-(node, type) file write is deferred to `compileRun`'s post-loop inheritance
  // pass, which has every leaf's cards in hand and can write a card once at the deepest
  // node whose whole subtree renders it identically, letting Velvet Lattice inherit it
  // down. `grouped` is returned raw — types unsorted, cards unsorted within a type —
  // because that pass re-groups by node before sorting.
  return { grouped, occupants, placeholderNoise };
}

/**
 * Placement half of the per-item loop: routes an item's declared targets into component
 * slots and raises CL0609 (empty render at a live target) and CL0610 (no output at all).
 * `placement` is a parameter — CL0610 also tests `!placement.storyCard`, since a target
 * miss only matters when nothing else is going to speak for this item either.
 */
function renderTargets(item, placement, itemId, ctx) {
  const {
    templates, partials, variables, diagnostics, slotIndex, branchLabel,
    fieldTable, templateFor, fieldAudit, placeholders, usage, usagePath,
    occupants, placeholderNoise,
  } = ctx;

  // `liveTargets` is targets that reached a real slot on this branch — a gated-off slot
  // is not one. CL0610 fires when nothing reached a slot; CL0609 when something did and
  // rendered blank.
  let liveTargets = 0;

  for (const target of placement.targets) {
    if (!checkTargetSlot(target, itemId, slotIndex, branchLabel, diagnostics, item._source)) continue;
    const known = slotIndex.get(target.component);
    // A slot the component declares but this branch excludes: nothing is placed, and
    // nothing is said here. Whether that silence matters is the no-output invariant's
    // question, below, and it is the only one with enough context to answer it.
    if (known && !known.slots.has(String(target.slot).toLowerCase())) continue;
    liveTargets++;
    const text = renderPlacementBody(item, target, templates, partials, variables, diagnostics, {
      fieldTable, templateFor,
      // Only for a card-emitting item: the audit collects the union of an item's render
      // lists but its item set stays "items that produce a story card" this session.
      fieldAudit: placement.storyCard ? fieldAudit : null,
    });
    if (text === null) continue;
    // A live target that rendered to nothing (CL0609). `renderPlacementBody` already
    // reported and returned null for a missing template or a render failure; this is the
    // other way a placement goes silent — a field-list or `.template` that is all
    // non-firing conditionals against an item that carries none of the keys. The slot
    // filters the empty occupant back out at emit, so without this the item vanishes
    // from the branch with nothing said. `~` on the branch dispatch or `branches:` is
    // the intended way to drop an item from a branch.
    if (String(text).trim() === '') {
      diagnostics.error(
        DIAG_CODES.ITEM_RENDERS_EMPTY,
        `item "${itemId}" reaches ${target.component} slot "${target.slot}" on branch `
        + `"${branchLabel}" but its body renders to nothing there. Exclude it from the `
        + 'branch with "branches:" if that is what was meant.',
        { file: item._source },
      );
      continue;
    }
    // Scanned per placement rather than once on the assembled component, because the
    // same item body can land in two components on one branch and the author needs to
    // be told which routing carried the mistake.
    const reported = checkUndeclaredPlaceholders(text, placeholders, {
      diagnostics,
      file: item._source,
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

  // The no-output invariant: an item that resolved into this branch must leave a mark on
  // it. Scoped by consequence rather than by mechanism — gating a slot off at the
  // component level stays a legitimate way to drop a whole slot's contents from one
  // branch, and only becomes an error when it would make an item vanish from every
  // output it declared. Keyed on `liveTargets`: a target that reached a slot and
  // rendered blank is CL0609's to report, and raising CL0610 too would describe one
  // mistake twice.
  if (!placement.storyCard && liveTargets === 0) {
    diagnostics.error(
      DIAG_CODES.ITEM_NO_OUTPUT,
      `item "${itemId}" resolves on branch "${branchLabel}" but produces no output there: `
      + 'storyCard is false and no declared target placed it. Exclude it from the branch '
      + 'with "branches:" if that is what was meant.',
      { file: item._source },
    );
  }
}

/**
 * Card half of the per-item loop: runs the template ladder, renders the card, and
 * accumulates it into `grouped` for the post-loop inheritance pass. Only called once
 * `placement.storyCard` is known true.
 */
function renderStoryCard(item, itemId, questions, ctx) {
  const {
    templates, partials, variables, diagnostics, branchLabel, projectNotesTemplate,
    fieldTable, templateFor, fieldAudit, cardTypeAudit, placeholders, usage, usagePath,
    grouped, renderedById, seenNames, reportedCollisions,
  } = ctx;

  // Before the template ladder, deliberately. `aid.type` selects the template when no
  // explicit one is named, so a placeholder in it also fails to match a template — and
  // that failure returns past every later check. Reported here, the author is told
  // the cause; reported after, they get CL0420 about a template they never wrote.
  //
  // Per branch rather than once per item, because a variant can change `aid.type` and
  // only some branches may apply it.
  checkPlaceholderContext(item.aid && item.aid.type, {
    diagnostics,
    file: item._source,
    where: `the type of story card "${itemId}"`,
    branch: branchLabel,
    reason: 'AID does not fill placeholders in a card’s type. It is a category, and '
      + 'Codex Loom also makes it a folder and file name in the compiled tree, so the '
      + 'raw text would become part of a path.',
  });

  // Validate the fully-resolved aid.type (it becomes a folder/file name). Runs here,
  // after all {%}/{$} passes, so it sees the final on-disk type. Raises CL0632 and
  // returns on invalid — the leaf loop moves to the next item rather than aborting,
  // so a run reports every bad type instead of only the first.
  validateCardType(item, { diagnostics });

  const bodyRender = resolveBodyRender(item, templates, fieldTable, templateFor);
  if (!bodyRender) {
    const type = (item.aid && item.aid.type) || (item.render && item.render.template) || '?';
    diagnostics.error(
      DIAG_CODES.TEMPLATE_NOT_FOUND,
      `no template found for item "${itemId}" (type: ${type})`,
      { file: item._source },
    );
    return;
  }

  // The unread-field audit: does the resolved template read every key this item's body
  // carries? Runs on the field-list body only — a `.template` text body names nothing to
  // check against. Findings are deduped compile-wide and emitted once, after every leaf.
  if (fieldAudit && bodyRender.kind === 'fieldList') {
    fieldAudit.collectForItem(item, bodyRender.list, { templateFor, refRoot: 'body' });
  }

  // Build render context: top-level item fields + body for {$body.X} access
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
    // A resolved template that rendered the card body to nothing (CL0609). `reference`
    // cards are exempt — §4.8 puts their payload in `notes:` and an empty body there is
    // the normal shape. For a `story` card it means the template reads keys this item
    // does not carry, and the card would ship to AID as a name with a blank value.
    // Suppressed when the render itself just reported an error (a malformed `join()`,
    // an unclosed `{if}`): that is CL0413/CL0415's finding, and the empty body is its
    // symptom, not a second mistake.
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
        { file: item._source },
      );
      return;
    }
    // The body arrives already wrapped — `render` applies render.wrapper — which is
    // what the length check needs when it measures the final string.
    rendered = renderCard({
      item,
      bodyText,
      notesText: renderNotesText(item, context, templates, partials, variables, projectNotesTemplate, diagnostics, {
        fieldTable, templateFor,
      }),
      diagnostics,
      loc: { file: item._source },
      questions,
    }).text;
  } catch (err) {
    diagnostics.error(
      DIAG_CODES.RENDER_FAILED,
      `item "${itemId}" failed to render: ${err.message}`,
      { file: item._source },
    );
    return;
  }

  // The written type, normalized (CL0626–CL0628). Applied here rather than to
  // `item.aid.type` itself, because that value is also the *selector* the template ladder
  // and `templateFor` key on, and those maps carry the author's casing from the config —
  // folding the item would silently deselect a type's tier. Everything downstream of this
  // line is on the writing side: the grouping key, the file path, the collision message,
  // and the reports, which read the compiled tree from disk and so see this value anyway.
  const type = cardTypeAudit
    ? cardTypeAudit.resolve((item.aid && item.aid.type) || 'Uncategorized', { file: item._source })
    : (item.aid && item.aid.type) || 'Uncategorized';

  checkCardNameCollision(item, type, branchLabel, diagnostics, seenNames, reportedCollisions);

  const leakSink = { diagnostics, file: item._source };
  checkUnexpandedVariables(rendered, `item "${itemId}" (${type})`, leakSink);
  checkUnresolvedFieldTokens(rendered, `item "${itemId}" (${type})`, leakSink);
  checkMechanicalArtifacts(rendered, `item "${itemId}" (${type})`, leakSink);
  // The whole rendered card, so one call covers name, triggers, notes and body — every
  // story-card field AID accepts a placeholder in.
  checkUndeclaredPlaceholders(rendered, placeholders, {
    diagnostics, file: item._source, where: `story card "${itemId}"`, branch: branchLabel,
    usage, usagePath,
  });
  if (!grouped.has(type)) grouped.set(type, []);
  // Carry a sort key (the item's real id, lowercased) so output order is
  // deterministic regardless of authoring order in the source YAML. `id`/`name` ride
  // along so the caller's inheritance pass can match this card to the same card on
  // other leaves — `name` is what Velvet Lattice's card merge keys on.
  grouped.get(type).push({
    sortKey: String(itemId).toLowerCase(),
    rendered,
    id: item.id ? String(item.id) : null,
    name: cardTitle(item),
  });
  // Capture the rendered block per item id for cross-branch diff/annotate reports.
  if (renderedById && item.id) renderedById.set(item.id.toLowerCase(), { type, rendered });
}

/**
 * Two cards on one leaf that share a display name are an error (CL0622). Velvet Lattice's
 * `_merge_story_cards` keys on name alone, so only one of them ever reaches AID — the
 * later declaration wins, and once cards are inherited rather than copied to every leaf
 * that winner is position-dependent. Two cards meant to coexist must have distinct names;
 * one card declared twice is a duplicate id (CL0325), not this. Cross-type or same-type
 * makes no difference to VL, so neither does it here. Reported once per name per leaf.
 */
function checkCardNameCollision(item, type, branchLabel, diagnostics, seenNames, reportedCollisions) {
  const cardName = cardTitle(item);
  const existing = seenNames.get(cardName);
  if (existing && !reportedCollisions.has(cardName)) {
    reportedCollisions.add(cardName);
    const where = existing.type === type
      ? `both as ${type}`
      : `${existing.type} in ${path.basename(existing.file)} and ${type} in ${path.basename(item._source)}`;
    diagnostics.error(
      DIAG_CODES.CARD_NAME_COLLISION,
      `story cards named "${cardName}" collide on branch "${branchLabel}" (${where}). Velvet Lattice merges story cards by name, so only one survives to AID and which one is position-dependent under inheritance. Give them distinct names.`,
      { file: item._source },
    );
  }
  if (!existing) {
    seenNames.set(cardName, { type, file: item._source });
  }
}

module.exports = {
  buildCompileContext,
  reportUnmatchedIncludeDispatch,
  resolveBranchItems,
  renderPlacementBody,
  renderBranchItems,
};
