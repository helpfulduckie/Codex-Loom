'use strict';

const fs = require('fs');
const path = require('path');
const { loadTemplates } = require('./loader');
const {
  resolveItem, resolvePlacements, collectVariantDeltas,
} = require('./model/item');
const {
  branchTreeDeclares, enumerateLeaves, walkBranchChain, walkBranchTree,
  resolveBranchSpec, localRoleKeysOf,
} = require('./model/branches');
const { applyPronounPasses, applyCrossItemRefs } = require('./model/pronouns');
const { render, applyFieldInterpolation, applyVariableInterpolation } = require('./template');
const { renderFieldList } = require('./render/field-list');
const { CODES: FIELD_TABLE_CODES } = require('./loader/field-table');
const { buildFieldAudit } = require('./render/field-audit');
const { resolveVariables, checkUnexpandedVariables, checkUnresolvedFieldTokens, checkMechanicalArtifacts, itemContext } = require('./util');
const { validateCardType, buildCardTypeAudit } = require('./cardType');
const {
  checkConfigNotesTemplates, renderNotesText, resolveTemplateForMaps, gatherTierTemplates,
  lookupSlotList, lookupNamedTemplate, isTemplateChoice, resolveBodyRender,
} = require('./templateResolve');
const { cleanAndArchive } = require('./outputPaths');
const { resolveCrossItemRenderFunctions } = require('./crossItem');
const {
  loadItemsFromDir, buildRegistry, mergeRegistries,
  resolveIncludes, buildCanonRegistry,
} = require('./loader/registry');
const { Diagnostics, busWarner, CODES: DIAG_CODES } = require('./diag');
const { renderCard, cardTitle, parseCards } = require('./emit/vl');
const {
  loadPack, evaluatePack, evaluatePackExistence, evaluatePackItemRules, clampFinding,
} = require('./lint/packs');
const { checkUndeclaredPlaceholders, checkPlaceholderContext } = require('./emit/placeholders');
const { checkDrift } = require('./snapshot');
const { loadCompileConfig } = require('./config/load');
const { checkTargetSlot } = require('./slots');
const { resolveComponentSpec, questionsForMeasurement } = require('./treeWrite');
const { placeInheritedFiles } = require('./inherit');
const { runLeafLoop } = require('./leafLoop');
const { writeTreeFiles, writeScenarioBlurb } = require('./treeFiles');
const { finalizeDiagnostics } = require('./reportDispatch');
const {
  PlaceholderTracker, RoleTracker, GapList, ComponentLoader,
} = require('./compileState');

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const componentTypes = [
    'aiInstructions', 'opening', 'branchFraming', 'plotEssential', 'summary', 'authorsNote',
    'description', 'adventureDescription', 'scripts',
  ];
  const componentRefs = {};
  for (const type of componentTypes) {
    const spec = components[type] !== undefined ? components[type] : null;
    componentRefs[type] = resolveComponentSpec(spec, config._base, variables);
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
      options.diagnostics || null,
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
 * The inline convention-pack pass.
 *
 * Runs after the leaf loop, over the story cards each leaf rendered — `deferredCardLeaves`
 * still holds them per leaf, before the frontier collapse, which is what lets a finding
 * name the branch it fired on. For each leaf it resolves that branch's merged `lint.packs`
 * (root packs, key-wise-overridden and `~`-unbound down the chain), loads each pack once,
 * and evaluates it against `parseCards` of every rendered card.
 *
 * Findings route onto the compile bus, so a pack ERROR fails the build — which is what the
 * per-pack `level:` dial exists to make safe. The severity is clamped through the per-pack
 * ceiling, then the per-branch one; the bus applies the global `lint.level` on top at
 * `add` time, because a `CL-<pack>/…` code is opinion-layer (`diag.js`).
 *
 * A complete no-op — no IO — for any project that declares no `lint.packs` anywhere,
 * which is every golden. The branch-merge is *not* recomputed here: each leaf carries its
 * merged `lint` table from `buildCompileContext`, the one walk that already ran with
 * `onWarn` wired.
 */
function runPackChecks(config, deferredCardLeaves, configPath, diagnostics) {
  const rootPacks = (config.lint && config.lint.packs) || {};
  const anyBranchPacks = branchTreeDeclares(
    config.branches, (node) => node.lint && node.lint.packs
      && Object.keys(node.lint.packs).length > 0,
  );
  if (Object.keys(rootPacks).length === 0 && !anyBranchPacks) return;

  const baseDir = config._base || '.';
  const loaded = new Map(); // pack name -> normalized pack | null (failed, already reported)
  const loc = { file: configPath };

  for (const leaf of deferredCardLeaves) {
    const lint = leaf.lint || { packs: {}, level: null };
    if (!lint.packs || Object.keys(lint.packs).length === 0) continue;
    const label = leaf.branchPath.length > 0 ? leaf.branchPath.join('/') : '(root)';
    const branchLevel = lint.level || null;

    for (const [name, entry] of Object.entries(lint.packs)) {
      const packLevel = (entry && typeof entry === 'object' && entry.level) || null;
      if (packLevel === 'off') continue;

      if (!loaded.has(name)) {
        loaded.set(name, loadPack(name, entry, {
          baseDir, variables: leaf.variables || {}, diagnostics, loc,
        }));
      }
      const pack = loaded.get(name);
      if (!pack) continue;

      // Gather the leaf's whole resolved card set once, so the per-card rules
      // (`evaluatePack`) and the per-leaf existence check (`evaluatePackExistence`, for a
      // `requireCard` rule) both see every card the leaf rendered. `evaluatePack` still
      // evaluates each card exactly once — moving it out of the group loop is only a
      // regrouping.
      const leafCards = [];
      for (const [type, entries] of leaf.grouped) {
        for (const rendered of entries) {
          leafCards.push(...parseCards(rendered.rendered, { type }));
        }
      }

      const routed = [
        ...evaluatePack(pack, leafCards, { branchLabel: label }),
        ...evaluatePackExistence(pack, leafCards, { branchLabel: label }),
        // The per-resolved-item rules (`count` / `mutexHint`). Inline only — the offline
        // `--lint` arm has no structured item to hand them.
        ...evaluatePackItemRules(pack, leaf.resolvedItems, { branchLabel: label }),
      ];
      for (const f of routed) {
        const sev = clampFinding(f.severity, packLevel, branchLevel);
        if (sev === null) continue;
        diagnostics.add(sev, f.code, f.message, loc);
      }
    }
  }
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

  for (const [source, items] of groups) {
    const names = resolveBranchSpec(items[0]._include_branch_spec, branchPath);
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
 * it is filtered out before the registry's check runs. Two of them naming one canon item,
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
function resolveBranchItems(allItemDefs, registry, branchPath, variables, diagnostics = new Diagnostics()) {
  const resolvedItems = [];
  const claimedBy = new Map(); // lowercased resolved id → the source file that claimed it

  reportUnmatchedIncludeDispatch(allItemDefs, branchPath, diagnostics);

  for (const itemDef of allItemDefs) {
    let item;
    try {
      item = resolveItem(itemDef, registry, branchPath, busWarner(diagnostics, { file: itemDef._source }));
    } catch (err) {
      const label = itemDef.id || itemDef.import || itemDef.name || '?';
      diagnostics.error(
        DIAG_CODES.ITEM_RESOLUTION_FAILED,
        `item "${label}" could not be resolved: ${err.message}`,
        { file: itemDef._source },
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

  // The component-target ladder: a *chosen* target `template:` (a named text or field-list
  // template, or a Pattern-2 name in a slot file) → `templateFor.<component>` keyed on
  // `aid.type` → `templateFor.base` keyed on `aid.type` → `aid.type` as a template name →
  // verbatim. A per-item `render.<component>.template` reaches here as `target.template`,
  // so a real choice keeps winning over the branch's slot — but the fill of
  // `target.template` from `aid.type` in `model/item.js` is not a choice, and honoring it
  // at rung 1 would shadow `templateFor.<component>` / `templateFor.base` for the whole
  // corpus, which is what `isTemplateChoice` guards against.
  const type = item.aid && item.aid.type;
  const compMap = templateFor[target.component] || {};
  const baseMap = templateFor.base || {};

  let hit = null;
  if (isTemplateChoice(target.template, type)) {
    const slot = lookupSlotList(target.template, compMap) || lookupSlotList(target.template, baseMap);
    hit = slot
      ? { kind: 'fieldList', list: slot, name: String(target.template) }
      : lookupNamedTemplate(target.template, templates, fieldTable);
  }
  if (!hit && type) {
    // Case-insensitive, matching rung 1 above and the body/notes ladders.
    const list = lookupSlotList(type, compMap) || lookupSlotList(type, baseMap);
    if (list) hit = { kind: 'fieldList', list, name: `${target.component}:${type}` };
  }
  if (!hit && type) hit = lookupNamedTemplate(type, templates, fieldTable);

  if (hit) {
    try {
      if (hit.kind === 'fieldList') {
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

function renderBranchItems(resolvedItems, registry, templates, partials, outputDir, branchProtagonist, variables = {}, options = {}) {
  const {
    verbose = false,
    renderedById = null,
    projectNotesTemplate = null,
    diagnostics = new Diagnostics(),
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
  const questions = questionsForMeasurement(placeholders, variables);

  applyCrossItemRefs(resolvedItems, registry, busWarner(diagnostics), resolvedById);

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
    applyPronounPasses(
      item, registry, branchProtagonist, resolvedById, roles, busWarner(diagnostics), onRoleUsed,
    );

    // The item says where it goes. Read once, here, and used for both outputs.
    const placement = resolvePlacements(item);
    const itemId = item.id || (typeof item.name === 'string' ? item.name : String(item.name));

    // Counts outputs, not targets: a target whose slot is gated off on this branch is
    // legitimate and simply does not produce one.
    let outputs = 0;

    for (const target of placement.targets) {
      if (!checkTargetSlot(target, itemId, slotIndex, branchLabel, diagnostics, item._source)) continue;
      const known = slotIndex.get(target.component);
      // A slot the component declares but this branch excludes: nothing is placed, and
      // nothing is said here. Whether that silence matters is the no-output invariant's
      // question, below, and it is the only one with enough context to answer it.
      if (known && !known.slots.has(String(target.slot).toLowerCase())) continue;
      const text = renderPlacementBody(item, target, templates, partials, variables, diagnostics, {
        fieldTable, templateFor,
      });
      if (text === null) continue;
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
      outputs++;
    }

    // The no-output invariant: an item that resolved into this branch must leave a mark on
    // it. Scoped by consequence rather than by mechanism — gating a slot off at the
    // component level stays a legitimate way to drop a whole slot's contents from one
    // branch, and only becomes an error when it would make an item vanish from every
    // output it declared.
    if (!placement.storyCard && outputs === 0) {
      diagnostics.error(
        DIAG_CODES.ITEM_NO_OUTPUT,
        `item "${itemId}" resolves on branch "${branchLabel}" but produces no output there: `
        + 'storyCard is false and no declared target placed it. Exclude it from the branch '
        + 'with "branches:" if that is what was meant.',
        { file: item._source },
      );
    }

    // `storyCard: false` is the only thing that suppresses a card. An item that renders
    // only into a component never produces one, so there is nothing to suppress.
    if (!placement.storyCard) continue;

    // Before the template ladder, deliberately. `aid.type` selects the template when no
    // explicit one is named, so a placeholder in it also fails to match a template — and
    // that failure `continue`s past every later check. Reported here, the author is told
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
    // continues on invalid — the leaf loop moves to the next item rather than aborting,
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
      continue;
    }

    // The unread-field audit: does the resolved template read every key this item's body
    // carries? Runs on the field-list body only — a `.template` text body names nothing to
    // check against. Findings are deduped compile-wide and emitted once, after every leaf.
    if (fieldAudit && bodyRender.kind === 'fieldList') {
      fieldAudit.auditBody(item, bodyRender.list, bodyRender.name, { templateFor });
    }

    // Build render context: top-level item fields + body for {$body.X} access
    const context = itemContext(item);

    let rendered;
    try {
      const bodyText = bodyRender.kind === 'fieldList'
        ? renderFieldList(bodyRender.list, fieldTable, context, {
          diagnostics, file: null, name: bodyRender.name, partials, variables,
        })
        : render(bodyRender.entry.content, context, partials, variables, {
          diagnostics, file: bodyRender.entry._source, name: bodyRender.name,
        });
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
      continue;
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

    // Two cards on one leaf that share a display name are an error. Velvet Lattice's
    // `_merge_story_cards` keys on name alone, so only one of them ever reaches AID — the
    // later declaration wins, and once cards are inherited rather than copied to every
    // leaf that winner is position-dependent. Two cards meant to coexist must have
    // distinct names; one card declared twice is a duplicate id (CL0325), not this.
    // Cross-type or same-type makes no difference to VL, so neither does it here.
    // Reported once per name per leaf.
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

  // The per-(node, type) file write is deferred to `compileRun`'s post-loop inheritance
  // pass, which has every leaf's cards in hand and can write a card once at the deepest
  // node whose whole subtree renders it identically, letting Velvet Lattice inherit it
  // down. `grouped` is returned raw — types unsorted, cards unsorted within a type —
  // because that pass re-groups by node before sorting.
  return { grouped, occupants, placeholderNoise };
}

/**
 * Print what the loading phase has collected since `since`, and abort if any of it —
 * checked across the whole bus, not just what's new — is an error.
 *
 * Errors stop the compile before anything is written. A schema violation means some part
 * of what the author wrote is not being read, so continuing would emit a tree that looks
 * complete and is quietly missing something.
 *
 * Takes a cursor and returns the new one so a caller can check more than once — config
 * loading and item/canon loading each add to the same bus, and a config-level error must
 * stop the compile before item loading ever touches disk, not only once both have run.
 * Without the cursor, calling this twice would reprint whatever the first call already
 * printed.
 */
function reportLoadDiagnostics(diagnostics, since = 0) {
  const items = diagnostics.all;
  for (const diag of items.slice(since)) {
    if (diag.severity === 'error') console.error(diag.format());
    else console.warn(diag.format());
  }
  if (diagnostics.hasErrors()) {
    const count = diagnostics.errors.length;
    throw new Error(`${count} error${count === 1 ? '' : 's'} while loading; nothing was compiled.`);
  }
  return items.length;
}

// ── Main compile function ─────────────────────────────────────────────────────

/**
 * Compile a project, optionally handing the caller the diagnostics as data.
 *
 * `compileRun` reports through the console and signals failure by throwing a *count* —
 * which is right for an author at a terminal and useless to a test that wants to assert
 * on codes. Passing `options.diagnostics` (a `Diagnostics`) collects everything both
 * internal buses saw, on every exit path: the early load throw, the component-gap throw,
 * the final error throw, and success alike. That is what the `finally` is for — a compile
 * that failed is precisely the one whose diagnostics are worth reading, so merging only
 * on the success path would collect nothing in the interesting case.
 *
 * The buses stay separate internally because their abort semantics differ: a load error
 * stops the compile before anything is written, a compile error lets the tree land and
 * fails the run afterward. The sink flattens them because a caller reading diagnostics
 * wants the whole stream in one place.
 */
function compile(configPath, options = {}) {
  const buses = {};
  try {
    return compileRun(configPath, options, buses);
  } finally {
    if (options.diagnostics) {
      if (buses.load) options.diagnostics.merge(buses.load);
      if (buses.compile) options.diagnostics.merge(buses.compile);
    }
  }
}

function compileRun(configPath, options, buses) {
  // ── 1. Buses & report closures ─────────────────────────────────────────────
  const verbose = !!options.verbose;

  // One bus for everything the loading phase reports, so item schema violations are
  // collected with their source positions and reported together rather than as a stream
  // of console warnings interleaved with progress output.
  const loadDiagnostics = new Diagnostics();
  buses.load = loadDiagnostics;

  // A second bus for everything the compile phases report — item resolution, cross-item
  // refs, emit. Unlike the load bus this one never aborts mid-run: its errors mean the tree
  // that gets written is wrong, not that it cannot be written, so it is checked once at the
  // end and the author gets both the artifact and a failed build.
  const compileDiagnostics = new Diagnostics();
  buses.compile = compileDiagnostics;
  let compileCursor = 0;
  const reportCompileDiagnostics = () => {
    for (const diag of compileDiagnostics.all.slice(compileCursor)) {
      if (diag.severity === 'error') console.error(diag.format());
      else console.warn(diag.format());
    }
    compileCursor = compileDiagnostics.length;
  };

  // ── 2. Config, drift, templates ────────────────────────────────────────────
  const config = loadCompileConfig(configPath, { diagnostics: loadDiagnostics, live: options.live });

  // The snapshot drift notice: a complete no-op unless the project has opted into a
  // snapshot. Drift is informational — never a warning, never a non-zero exit; the one
  // exception is CL0115, corruption of the frozen copy itself, which is an ERROR.
  if (config) checkDrift(config, loadDiagnostics);

  // Checked immediately, before any filesystem work — an unknown key, a missing required
  // field, or a bad path token in compile.yaml itself must stop the compile before
  // mkdirSync ever runs, not merely before the compiled tree is written. Folding this into
  // the single check below meant a config error still created the output directory and
  // read canon/item files from disk before the throw was reached.
  let loadCursor = reportLoadDiagnostics(loadDiagnostics);

  // The lint-severity ceiling, set here because this is the first moment both halves of it
  // exist: `lint.level` has just been read off the config, and `--lint-level` came in with
  // the options. The CLI flag wins, on the general rule that a flag is what someone typed
  // for this run and the config is what the project says every run.
  //
  // The load bus is deliberately left alone. Nothing it raises is an opinion — it is
  // schema violations and unreadable files — and it has already been reported by the line
  // above, so a ceiling applied here could only ever arrive too late to mean anything.
  compileDiagnostics.setLintLevel(
    options.lintLevel || (config.lint && config.lint.level) || null,
  );

  fs.mkdirSync(config._resolvedOutput, { recursive: true });

  const { templates, partials, fieldTable } = loadTemplates(config._resolvedTemplates, { diagnostics: loadDiagnostics });
  // Checked before anything renders: a template that still carries a fence would emit a
  // double envelope on every card it owns, and the report names the files. The
  // notes-template check needs both halves in hand, so it runs against the same bus.
  checkConfigNotesTemplates(config, templates, loadDiagnostics, configPath, fieldTable);
  loadCursor = reportLoadDiagnostics(loadDiagnostics, loadCursor);
  console.log(`Loaded ${templates.size} template(s)${partials.size ? `, ${partials.size} partial(s)` : ''}.`);

  // ── 3. Registries & audits ────────────────────────────────────────────────────
  // The unread-field and card-type audits, built once so their per-compile dedupes span
  // every leaf. Both `finish()` after the leaf loop, in `finalizeDiagnostics`.
  // `tierTemplates` also feeds `--schema-tables`; gathered once here.
  const tierTemplates = config ? gatherTierTemplates(config, configPath) : [];
  const fieldAudit = buildFieldAudit({ fieldTable, partials, tierTemplates });
  const cardTypeAudit = buildCardTypeAudit();

  // Build canon registry
  const canonRegistry = buildCanonRegistry(config._resolvedLibrary, { diagnostics: loadDiagnostics });
  // itemCount, not size: an id two canon sets both define holds no plain key, and
  // "loaded 40 items" would otherwise quietly drop the very items worth mentioning.
  if (canonRegistry.itemCount > 0) {
    console.log(`Loaded ${canonRegistry.itemCount} canonical item(s).`);
  }

  // Load project items
  const rawProjectItems = loadItemsFromDir(config._resolvedItems, { diagnostics: loadDiagnostics });

  // Resolve includes
  const includedItems = resolveIncludes(rawProjectItems, canonRegistry, config, { diagnostics: loadDiagnostics });
  if (includedItems.length > 0) {
    console.log(`Loaded ${includedItems.length} included canonical item(s).`);
  }

  loadCursor = reportLoadDiagnostics(loadDiagnostics, loadCursor);

  // include: directives are spent once resolveIncludes has read them — drop them here so
  // nothing downstream has to know they ever existed. `import:` defs are NOT dropped:
  // they are real items awaiting resolution against the id they name.
  const projectItems = rawProjectItems.filter((d) => !d.include);

  const allItemDefs = [...projectItems, ...includedItems];

  const projectRegistry = buildRegistry(projectItems, 'project', { diagnostics: loadDiagnostics });
  console.log(`Loaded ${projectRegistry.size} project item definition(s).`);

  const registry = mergeRegistries(canonRegistry, projectRegistry, { diagnostics: loadDiagnostics });

  // ── 4. Pre-loop accumulators ──────────────────────────────────────────────────
  // Every declared key referenced by any text this compile writes, keyed by the branch path
  // the text belongs to, and every node that declared one. The unused-placeholder check
  // needs both: the declarations say what was promised and where, the usage says what was
  // spent.
  const placeholderState = new PlaceholderTracker();

  // `CL0545`: every role name a resolved token actually bound to, project-wide. This is a
  // whole-compile check, deliberately coarser than `CL0535`'s subtree-scoped one — no
  // golden declares a role yet, so there is no branch with a differently-scoped sibling
  // for the coarse check to get wrong, and it is the cheaper one to build correctly.
  // `protagonist` is exempt: it is read structurally, by comparing an item id against
  // `branchProtagonist`, wherever any `{$Id}` token resolves — not only where
  // `{$protagonist}` is literally written — so "unused" is never a fact about it.
  const roleState = new RoleTracker();
  walkBranchTree(config, ({ node, path: path_, isRoot }) => {
    const keys = localRoleKeysOf(node).filter((k) => k.toLowerCase() !== 'protagonist');
    if (keys.length) {
      roleState.declarations.push(isRoot
        ? { path: '', label: 'at the project root', keys }
        : { path: path_.join('/'), label: `on branch "${path_.join('/')}"`, keys });
    }
  });

  const leaves = enumerateLeaves(config.branches);

  if (options.clean) {
    console.log('\nClean build: clearing output folders...');
    cleanAndArchive(config, leaves);
  }

  console.log(`\nCompiling ${leaves.length} branch leaf/leaves...`);

  let totalFiles = 0;
  const allItemIds = new Set();
  const leafSummaries = [];

  // Cross-branch review reports (--diff / --annotate) are built from data captured
  // during compilation — the resolver materializes identity-keyed items in memory that
  // the on-disk markdown has already discarded. Gated so a normal compile is unchanged.
  const captureReports = !!(options.diff || options.annotate);
  const rootDirName = path.basename(config._resolvedOutput);
  const leafData = [];

  // `--inventory` reads the slot index and the occupant map, which exist only inside the
  // leaf loop and are gone by the time an output tree is on disk — the file records what a
  // slot rendered to, never who filled it. Captured separately from `leafData` because it
  // needs neither the rendered item bodies nor the component segments that make that
  // structure expensive.
  const inventoryData = [];

  // Track components that were requested (a spec/path was provided) but produced
  // no output file. A requested-but-unwritten component is almost always a silent
  // failure (bad path, unexpanded {%var}/{@key}, empty source) rather than intent —
  // collected here and reported as an error at the end of the compile.
  const gaps = new GapList();

  // The sectioned-component loader (see compileState.js). A component document is read,
  // validated and normalized once per resolved path rather than once per leaf, so a schema
  // violation or an import cycle reaches the author once instead of once for every leaf
  // that names the component. `imports:` chains resolve inside that one load, which is why
  // cycle detection lives there. `from:` expands against the *root* variable table for the
  // same reason the cache is keyed by path — a branch-varying `from:` would make one cache
  // key stand for two documents. The `CL0619`–`CL0621` metadata guards and the
  // `imports:`-inclusive `dependencyLedger` live inside the loader; `componentLoader.load`
  // is the stable `(spec, descriptor)` reference the leaf loop and the framing writer take.
  const rootVariables = config._variables || config.variables || null;
  const componentLoader = new ComponentLoader({
    diagnostics: compileDiagnostics, variables: rootVariables, base: config._base,
  });

  // The two sets CL0616 compares — a leaf with an adventure description and no opening.
  // Both are filled by the leaf loop below, which makes the check a comparison of two
  // facts rather than of two passes.
  const descriptionLeaves = new Set();
  const openingLeaves = new Set();

  // Component and script inheritance. `runLeafLoop` renders and checks every component per
  // leaf and fills these two maps; `placeInheritedFiles` drains them, writing each value
  // once at the node Velvet Lattice inherits it from, or per leaf where it cannot.
  // `LIFT_EXCLUDED_COMPONENTS` (opening, adventureDescription — see leafLoop.js) are the
  // two the leaf must hold itself and are written inside the loop instead.
  const deferredComponents = new Map(); // descriptor.key → { descriptor, metadata, perLeaf: Map(outputDir → text) }
  const deferredScripts = new Map(); // outputDir → resolved scripts spec (a directory path)

  // Story-card inheritance. One entry per leaf, filled by the loop:
  // `{ branchPath, folderPath, outputDir, grouped: Map(type → [{sortKey, rendered, id, name}]) }`.
  // The post-loop pass writes each card at the deepest node whose whole leaf-subtree
  // renders it byte-identically, and per leaf otherwise.
  const deferredCardLeaves = [];

  // ── 5. The leaf loop ──────────────────────────────────────────────────────────
  totalFiles += runLeafLoop({
    leaves, config, configPath, options, verbose,
    diagnostics: compileDiagnostics, flushDiagnostics: reportCompileDiagnostics,
    allItemDefs, registry, templates, partials,
    fieldTable, fieldAudit, cardTypeAudit,
    rootDirName, captureReports,
    buildCompileContext, resolveBranchItems, renderBranchItems,
    placeholderState, roleState, gaps, componentLoader,
    deferredComponents, deferredScripts, deferredCardLeaves,
    descriptionLeaves, openingLeaves,
    leafData, inventoryData, leafSummaries, allItemIds,
  });

  // ── 6. Pack checks ────────────────────────────────────────────────────────────
  // Convention packs, run over the cards each leaf just rendered while they are still
  // keyed per leaf. Dormant unless a project declares `lint.packs`.
  runPackChecks(config, deferredCardLeaves, configPath, compileDiagnostics);
  reportCompileDiagnostics();

  // ── 7. Inheritance passes ─────────────────────────────────────────────────────
  totalFiles += placeInheritedFiles({
    deferredComponents, deferredScripts, deferredCardLeaves,
    leaves, config, diagnostics: compileDiagnostics, verbose,
  });

  // ── 8. Tree-level writes ──────────────────────────────────────────────────────
  // Framing, labels and placeholder questions, each at a node the leaf loop never visits.
  // Root-level branchFraming and the root Label land in these walkers' own root visits.
  writeTreeFiles({
    config, configPath, verbose, diagnostics: compileDiagnostics,
    placeholderState, componentLoader, registry, roleState,
  });
  reportCompileDiagnostics();

  // The scenario blurb, written once to the output root alongside Branches/.
  writeScenarioBlurb({
    config, configPath, verbose, diagnostics: compileDiagnostics,
    rootVariables, registry, placeholderState, roleState, componentLoader, gaps, descriptionLeaves,
  });

  // ── 9. Project diagnostics, summary, reports, finalize ────────────────────────
  finalizeDiagnostics({
    config, configPath, options, verbose,
    diagnostics: compileDiagnostics, flushDiagnostics: reportCompileDiagnostics,
    descriptionLeaves, openingLeaves, leafSummaries,
    allItemIds, totalFiles, componentLoader,
    roleState, placeholderState, gaps, fieldAudit, cardTypeAudit,
    registry, rootDirName, fieldTable, tierTemplates,
    captureReports, leafData, inventoryData, allItemDefs,
  });

  if (gaps.length > 0) {
    throw new Error(
      `${gaps.length} requested component(s) were not written — see errors above. ` +
      `Fix the source path/reference, or remove the component from compile.yaml if it is not wanted.`
    );
  }

  // Item-resolution and emit ERRORs do not stop the compile: aborting mid-tree would leave
  // a half-written branch behind, and wrong output the author can read beats no output at
  // all. They do fail the run — the tree is written, then this throws and the CLI exits 1.
  reportCompileDiagnostics();
  if (compileDiagnostics.hasErrors()) {
    const count = compileDiagnostics.errors.length;
    throw new Error(
      `${count} error${count === 1 ? '' : 's'} while compiling. The output tree was written, `
      + 'but it does not say what the source says — see the errors above.'
    );
  }
}

module.exports = {
  compile,
  resolveBranchItems,
  renderBranchItems,
  renderPlacementBody,
  resolveIncludes,
  buildCompileContext,
  resolveVariables,
};
