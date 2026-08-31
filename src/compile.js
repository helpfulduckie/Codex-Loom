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
const { loadComponentDocument } = require('./loader/component');
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
const {
  writeOutput, cleanAndArchive, buildBranchOutputDir, resolveBranchFolderPath,
} = require('./outputPaths');
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
const {
  checkUndeclaredPlaceholders, checkPlaceholderContext,
  reportUnusedPlaceholders, reportDuplicateQuestions,
} = require('./emit/placeholders');
const { LIMITS, checkLimit } = require('./limits');
const {
  DESCRIPTION_DESCRIPTOR, isPassthrough, readPassthrough,
  renderSectionedComponent, writeSectionedComponent,
} = require('./emit/components');
const { checkDrift } = require('./snapshot');
const { loadCompileConfig, CODES: LOAD_CODES, isOutOfBase, normalize } = require('./config/load');
const {
  selectComponentSections, renderComponentStoryCards, resolveSectionedComponents,
  buildSlotIndex, checkTargetSlot, warnEmptySlots,
} = require('./slots');
const {
  resolveComponentSpec, questionsForMeasurement, copyScripts,
  writeFramingRecursive, writeLabelsRecursive, writePlaceholdersRecursive,
} = require('./treeWrite');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the CompileContext for a given branch path.
 * Merges variables, components and render defaults from root → branch chain.
 */
function buildCompileContext(config, branchPath, options = {}) {
  const chain = walkBranchChain(config.branches, branchPath, {
    rootPlaceholders: config.placeholders,
    // Seeded here rather than merged afterward: `~` deletes a key from `chain.variables`
    // directly (Decision 1), and re-merging the root table on top after the fact — the old
    // shape — would silently put a deleted root key right back.
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

  // `scripts:` is top-level as of §6.3: it is a file copy, not a rendered document, and
  // it was the one row in the component table that shared none of the row's behavior. It
  // still merges down the branch chain like everything else, so it is folded back in
  // here rather than resolved separately.
  const scripts = chain.scripts !== undefined ? chain.scripts : config.scripts;
  if (scripts !== undefined) components.scripts = scripts;

  // Resolve component specs to file paths
  // `adventureDescription` merges down the chain like the other sectioned components, which
  // is what makes §7.7's per-node description an ordinary row rather than a second writer:
  // a value declared at an interior node reaches the leaves beneath it here. `description`
  // is resolved here too — it is read at the root rather than per branch, but the migrator
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

  // §13.4's branch-addressable `templateFor`. What merges down the chain is the
  // type→field-list map each node's slot files *produce*, not the filenames: a node names
  // one file for a role and gets that file's types, inheriting every other type from its
  // ancestors (Decision 6). So each node in the chain — the root config first, then every
  // branch node — is resolved on its own and the resulting per-role maps are folded
  // key-wise, root to leaf. Empty and IO-free for any project that declares no `templateFor:`.
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

  // The branch-merged placeholder table (§12.2). Sits beside `variables` because it is the
  // same kind of thing — a per-branch mapping every check and the emitter read — and
  // because §12.3's question text expands against `variables`, so the two are always
  // wanted together.
  return {
    variables, componentRefs, render, templateFor, placeholders: chain.placeholders, roles,
    // The branch-merged `lint.packs` table and per-branch `level:` (§8.2.2). Returned so
    // `runPackChecks` reads it off the one walk that already ran here — with `onWarn`
    // wired, so a `<pack>: ~` unbinding nothing raises `CL0118` exactly once — rather than
    // re-walking `walkBranchChain` with its own, warn-less seed.
    lint: chain.lint,
  };
}

/**
 * The inline convention-pack pass (§8.2.2).
 *
 * Runs after the leaf loop, over the story cards each leaf rendered — `deferredCardLeaves`
 * still holds them per leaf, before Phase 11's frontier collapse, which is what lets a
 * finding name the branch it fired on. For each leaf it resolves that branch's merged
 * `lint.packs` (root packs, key-wise-overridden and `~`-unbound down the chain), loads
 * each pack once, and evaluates it against `parseCards` of every rendered card.
 *
 * Findings route onto the compile bus, so a pack ERROR fails the build — the behavior
 * §12.5 built the per-pack `level:` dial to make safe. The severity is clamped through
 * the per-pack ceiling, then the per-branch one; the bus applies the global `lint.level`
 * on top at `add` time, because a `CL-<pack>/…` code is opinion-layer (`diag.js`).
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

      // Phase 15: gather the leaf's whole resolved card set once, so the per-card rules
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
        // Phase 16: the per-resolved-item rules (`count` / `mutexHint`). Inline only —
        // the offline `--lint` arm has no structured item to hand them (Decision 5).
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
 * Build a library dependency manifest for the output JSON file.
 */
function buildLibraryManifest(config) {
  const { findFiles } = require('./util');
  const manifest = {};
  for (const [name, resolvedPath] of config._resolvedLibrary) {
    const expression = config._libraryRaw ? String(config._libraryRaw[name] ?? resolvedPath) : resolvedPath;
    const missing = !fs.existsSync(resolvedPath);
    const files = missing ? [] : findFiles(resolvedPath, '.yaml');
    manifest[name] = { expression, resolvedPath, files, ...(missing ? { missing: true } : {}) };
  }
  return manifest;
}

/**
 * CL0326 for an include's `branches:` — the other half of the arity-N guard (§7.6.2a).
 *
 * **Per branch, because a branch dispatch has no answer without a branch path.** The
 * `importVariants:` half of this check runs once per compile inside `resolveIncludes`,
 * which is where a selector that does not depend on the branch belongs. These two
 * placements are not an inconsistency: they are the two axes §7.6.2a separates the keys
 * on — `importVariants:` selects from the imported source unconditionally, `branches:`
 * dispatches, and each is asked wherever its answer exists.
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
 * question: a bare `import:` def claims no id of its own — it *is* the item it names
 * (§17.4) — so it is filtered out before the registry's check runs. Two of them naming
 * one canon item, or a bare import alongside an explicit def of the same id, therefore
 * pass load and meet for the first time here, as two resolved items with one id. What
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
    applyVariableInterpolation(item, variables);
    resolvedItems.push(item);
  }

  return resolvedItems;
}

/**
 * Render one item body for one component target (§7.4).
 *
 * The wrapper is forced off: the slot owns the wrapping of everything placed in it, and
 * `emit/components.js` applies it once the occupants are in hand. Leaving the item's own
 * `render.wrapper` in the context is what would ship an item double-braced inside a slot
 * of the same wrapper — the bug §8.4 exists to eliminate, and the reason `render.wrapper`
 * governs story-card output alone.
 *
 * Returns null and reports when the target's template ladder runs out with nothing to
 * render, which is the one case the ladder's verbatim rung cannot cover: no template and
 * no text is not a pass-through, it is an item that has nothing to say.
 */
function renderPlacementBody(item, target, templates, partials, variables, diagnostics, extra = {}) {
  const { fieldTable = { templates: {} }, templateFor = {} } = extra;
  const context = itemContext(item, { render: { ...(item.render || {}), wrapper: 'none' } });
  const label = item.id || (typeof item.name === 'string' ? item.name : String(item.name));

  // The component-target ladder (§13.4): a *chosen* target `template:` (a named text or
  // field-list template, or a Pattern-2 name in a slot file) → `templateFor.<component>`
  // keyed on `aid.type` → `templateFor.base` keyed on `aid.type` → `aid.type` as a template
  // name → verbatim. A per-item `render.<component>.template` reaches here as
  // `target.template`, so a real choice keeps winning over the branch's slot — but the
  // `model/item.js:384` fill of `target.template` from `aid.type` is not a choice, and
  // honouring it at rung 1 would shadow `templateFor.<component>` / `templateFor.base` for
  // the whole corpus, the same bug fix A removed from the body ladder in Phase 13
  // (`isTemplateChoice`).
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
    const list = compMap[type] || baseMap[type];
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

  // Verbatim pass-through — the last rung of §7.4's ladder.
  const raw = item.body && (item.body.text !== undefined ? item.body.text : item.body.content);
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    return resolveVariables(String(raw).trim(), variables);
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
 * same items routed into. One traversal produces both, which is the §7.2 inversion in its
 * smallest form: v3 ran this loop for story cards and a second resolver in `pe.js` for
 * component content, then reconciled them through a suppression side channel. There is
 * nothing to reconcile when one pass over one resolved item decides both.
 */

/**
 * `CL0545`: a role declared and never referenced by a resolved token anywhere in the
 * compile (§9.2's WARN half — `resolveRole` in `model/pronouns.js` calls `onRoleUsed` only
 * on success, so `roleUsage` names every role that actually did something).
 *
 * Whole-compile rather than `CL0535`'s subtree-scoped check, deliberately simpler: no
 * golden declares a role yet, so there is no corpus case where a role is legitimately used
 * on one branch and unused on a sibling that this coarser check would miss.
 */
function reportUnusedRoles(declarations, usage, { diagnostics, file } = {}) {
  if (!diagnostics) return [];
  const unused = [];
  for (const { label, keys } of declarations) {
    for (const key of keys) {
      if (usage.has(key.toLowerCase())) continue;
      unused.push(key);
      diagnostics.warn(
        DIAG_CODES.ROLE_UNUSED,
        `role "${key}" is declared ${label} but no resolved token anywhere references it.`,
        { file: file == null ? undefined : String(file) },
      );
    }
  }
  return unused;
}

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
    // §9.2's merged role table for this branch, and CL0545's usage callback — grouped with
    // the rest of the trailing options rather than appended as a 17th positional parameter.
    roles = null,
    onRoleUsed = null,
    // §13 — the field-declaration table (compile-wide) and the branch's resolved
    // `templateFor` role maps. Both default to empty, and every ladder below falls back to
    // exactly its pre-Phase-12 behavior when they are.
    fieldTable = { fields: {}, groups: {}, templates: {} },
    templateFor = {},
    // §13.6 — the unread-field audit, built once per compile so its `(item id, field
    // path)` dedupe spans every leaf. Null on the report-mode paths that reuse this
    // function without a field table.
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

  // §8.5 measures what AID stores, which is the *substituted* string, so the length check
  // needs the questions rather than the keys. Expanded once per branch and handed down.
  const questions = questionsForMeasurement(placeholders, variables);

  applyCrossItemRefs(resolvedItems, registry, busWarner(diagnostics), resolvedById);

  // Expand render functions in body field values now that cross-item refs are resolved.
  // Dependency-ordered: a scan-build-sort-evaluate sequence over the same graph a chain
  // like A.field = join($B.body.x) implies, replacing the fixpoint loop this used to be
  // (v4 spec §13, Phase 9 Step 2 — see Decision 3 of the Phase 9 plan for why evaluating
  // in topological order, rather than iterating to convergence, is the correction and not
  // just a performance change).
  resolveCrossItemRenderFunctions(resolvedItems, resolvedById, diagnostics);

  // §8.2: the envelope is the emitter's, not the template's. Templates render the body;
  // `emit/vl.js` writes the heading and the fence around it, and reports what it cannot
  // carry — a comma inside a trigger — onto the caller's bus. Nothing is printed or thrown
  // here: wrong output is still output, so the branch tree is finished either way and the
  // caller decides when to print and whether the run fails.
  const grouped = new Map();

  // component key → slot name (lowercased) → occupants, unsorted. `emit/components.js`
  // owns the sort, so `order:` then item id is stated in exactly one place (§7.4).
  const occupants = new Map();

  // Card-name collision detector (Phase 10 Step 3, CL0622). Keyed on the displayed card
  // name rather than the item id, because that is what VL's `_merge_story_cards` keys on.
  const seenNames = new Map(); // name → { type, file }
  const reportedCollisions = new Set(); // name

  for (const item of resolvedItems) {
    applyPronounPasses(
      item, registry, branchProtagonist, resolvedById, roles, busWarner(diagnostics), onRoleUsed,
    );

    // §7.2: the item says where it goes. Read once, here, and used for both outputs.
    const placement = resolvePlacements(item);
    const itemId = item.id || (typeof item.name === 'string' ? item.name : String(item.name));

    // Counts outputs, not targets: a target whose slot is gated off on this branch is
    // legitimate (§7.4's third and fifth rows) and simply does not produce one.
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

    // The no-output invariant (§7.4) — the replacement for v3's suppression checks. An item
    // that resolved into this branch must leave a mark on it. Scoped by consequence rather
    // than by mechanism: gating a slot off at the component level stays a legitimate way to
    // drop a whole slot's contents from one branch, and only becomes an error when it would
    // make an item vanish from every output it declared.
    if (!placement.storyCard && outputs === 0) {
      diagnostics.error(
        DIAG_CODES.ITEM_NO_OUTPUT,
        `item "${itemId}" resolves on branch "${branchLabel}" but produces no output there: `
        + 'storyCard is false and no declared target placed it. Exclude it from the branch '
        + 'with "branches:" if that is what was meant.',
        { file: item._source },
      );
    }

    // `storyCard: false` is now the only thing that suppresses a card (§7.4). An item that
    // renders only into a component never produces one, so there is nothing to suppress.
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

    // §13.6: does the resolved template read every key this item's body carries? Runs on
    // the field-list body only — a `.template` text body names nothing to check against.
    // Findings are deduped compile-wide and emitted once, after every leaf.
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
      // what §8.5 needs when Phase 5 measures the final string.
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

    // Two cards on one leaf that share a display name are an error (Phase 11 Step 5).
    // Velvet Lattice's `_merge_story_cards` keys on name alone, so only one of them ever
    // reaches AID — the later declaration wins, and once cards are inherited rather than
    // copied to every leaf that winner is position-dependent. Two cards meant to coexist
    // must have distinct names; one card declared twice is a duplicate id (CL0325), not
    // this. Cross-type or same-type makes no difference to VL, so neither does it here.
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
    // along so the caller's Phase 11 Step 5 inheritance pass can match this card to the
    // same card on other leaves — `name` is what Velvet Lattice's card merge keys on.
    grouped.get(type).push({
      sortKey: String(itemId).toLowerCase(),
      rendered,
      id: item.id ? String(item.id) : null,
      name: cardTitle(item),
    });
    // Capture the rendered block per item id for cross-branch diff/annotate reports.
    if (renderedById && item.id) renderedById.set(item.id.toLowerCase(), { type, rendered });
  }

  // Phase 11 Step 5: the per-(node, type) file write is deferred to `compileRun`'s
  // post-loop inheritance pass, which has every leaf's cards in hand and can write a
  // card once at the deepest node whose whole subtree renders it identically, letting
  // Velvet Lattice inherit it down. `grouped` is returned raw — types unsorted, cards
  // unsorted within a type — because that pass re-groups by node before sorting.
  return { grouped, occupants, placeholderNoise };
}

/**
 * Print what the loading phase has collected since `since`, and abort if any of it —
 * checked across the whole bus, not just what's new — is an error.
 *
 * Errors stop the compile before anything is written. A schema violation means some part
 * of what the author wrote is not being read, so continuing would emit a tree that looks
 * complete and is quietly missing something — the exact failure mode §4.3 exists to end.
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
 * The buses stay separate internally because their abort semantics differ (§4.3): a load
 * error stops the compile before anything is written, a compile error lets the tree land
 * and fails the run afterward. The sink flattens them because a caller reading
 * diagnostics wants the whole stream in one place.
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
  // of console warnings interleaved with progress output. The compile phases still warn
  // directly; they move onto the bus as their modules are decomposed.
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

  // Phase 7's drift notice: a complete no-op unless the project has opted into a snapshot
  // (§Decision 4 — drift is informational, never a warning, never a non-zero exit; the one
  // exception is CL0115, corruption of the frozen copy itself, which is an ERROR).
  if (config) checkDrift(config, loadDiagnostics);

  // Checked immediately, before any filesystem work — an unknown key, a missing required
  // field, or a bad path token in compile.yaml itself must stop the compile before
  // mkdirSync ever runs, not merely before the compiled tree is written. Folding this into
  // the single check below meant a config error still created the output directory and
  // read canon/item files from disk before the throw was reached.
  let loadCursor = reportLoadDiagnostics(loadDiagnostics);

  // The §12.5 ceiling, set here because this is the first moment both halves of it exist:
  // `lint.level` has just been read off the config, and `--lint-level` came in with the
  // options. The CLI flag wins, on the general rule that a flag is what someone typed for
  // this run and the config is what the project says every run.
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
  // double envelope on every card it owns (§8.3), and the report names the files. The
  // notes-template check needs both halves in hand, so it runs against the same bus.
  checkConfigNotesTemplates(config, templates, loadDiagnostics, configPath, fieldTable);
  loadCursor = reportLoadDiagnostics(loadDiagnostics, loadCursor);
  console.log(`Loaded ${templates.size} template(s)${partials.size ? `, ${partials.size} partial(s)` : ''}.`);

  // ── 3. Registries & audits ────────────────────────────────────────────────────
  // §13.6 — built once so the unread-field audit's `(item id, field path)` dedupe spans
  // the whole compile. `finish()` runs after the leaf loop, beside reportUnusedRoles.
  // `tierTemplates` also feeds `--schema-tables` below; gathered once here.
  const tierTemplates = config ? gatherTierTemplates(config, configPath) : [];
  const fieldAudit = buildFieldAudit({ fieldTable, partials, tierTemplates });
  const cardTypeAudit = buildCardTypeAudit();

  // Build canon registry
  const canonRegistry = buildCanonRegistry(config._resolvedLibrary, { diagnostics: loadDiagnostics });
  // itemCount, not size: an id two canon sets both define holds no plain key (§17.3), and
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
  // the text belongs to, and every node that declared one. §12.3's unused check needs both:
  // the declarations say what was promised and where, the usage says what was spent.
  const placeholderUsage = new Map();
  const placeholderDeclarations = [];
  const placeholderDuplicates = new Map();

  // `CL0545`: every role name a resolved token actually bound to, project-wide — a
  // whole-compile check rather than `CL0535`'s subtree-scoped one (Decision recorded in
  // the Session A record: no golden declares a role yet, so there is no branch with a
  // differently-scoped sibling to get wrong, and the simpler check is the cheaper one to
  // build correctly today). `protagonist` is exempt: it is read structurally, by comparing
  // an item id against `branchProtagonist`, wherever any `{$Id}` token resolves — not only
  // where `{$protagonist}` is literally written — so "unused" is never a fact about it.
  const roleUsage = new Set();
  const onRoleUsed = (key) => roleUsage.add(String(key).toLowerCase());
  const roleDeclarations = [];
  // The walker's root visit replaces the old hand-rolled root rung (Phase 11 Step 0).
  walkBranchTree(config, ({ node, path: path_, isRoot }) => {
    const keys = localRoleKeysOf(node).filter((k) => k.toLowerCase() !== 'protagonist');
    if (keys.length) {
      roleDeclarations.push(isRoot
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
  const componentGaps = [];
  const recordGap = (leaf, component, spec, reason) =>
    componentGaps.push({ leaf, component, spec: spec == null ? '(none)' : String(spec), reason });

  // A sectioned component document is read, validated and normalized once per file rather
  // than once per leaf. Which sections apply is a per-branch question that
  // `sectionsForBranch` answers from the normalized document, so nothing is lost — and a
  // schema violation in a component reaches the author once instead of once per leaf,
  // which for The Institute's 32 leaves is the difference between a diagnostic and a wall.
  //
  // §7.6's `imports:` resolve inside that one load, which is why cycle detection and the
  // import diagnostics belong there rather than in the leaf loop: a chain resolved once per
  // file reports a cycle once, and a chain resolved once per leaf reports it 32 times for
  // The Institute. `from:` expands against the *root* variable table for the same reason the
  // cache is keyed by path — a branch-varying `from:` would make one cache key stand for two
  // documents.
  const sectionedDocs = new Map();
  // Every resolved path any `loadSectioned` call reads, *including* what its `imports:`
  // chain pulls in — unlike `sectionedDocs`, which is keyed by top-level spec only and
  // says nothing about a file reached solely through `imports:`. This is the ledger the
  // dependency-coverage check (below) actually needs: the gap it exists to catch is a
  // shared component reached through a plain variable rather than a `components:` spec,
  // which by definition never appears as a `sectionedDocs` key.
  const dependencyLedger = new Set();
  const rootVariables = config._variables || config.variables || null;
  const loadSectioned = (spec, descriptor) => {
    if (!sectionedDocs.has(spec)) {
      const loaded = loadComponentDocument(spec, {
        diagnostics: compileDiagnostics,
        label: descriptor.label,
        variables: rootVariables,
        base: config._base,
        dependencyLedger,
      });
      // §7.7's `metadata:` is declared on every component and emitted by the ones whose
      // output has somewhere to put frontmatter — Description today. Reported on the cache
      // miss so the author hears it once, rather than once per leaf.
      if (loaded && loaded.metadata && !descriptor.frontmatter) {
        compileDiagnostics.warn(
          DIAG_CODES.COMPONENT_METADATA_UNSUPPORTED,
          `"${descriptor.label}" declares metadata:, which is written as frontmatter and `
          + `only ${DESCRIPTION_DESCRIPTOR.file} carries any — Velvet Lattice reads scenario `
          + 'tags from there. The metadata is ignored here.',
          { file: String(spec) },
        );
      }
      // §7.7 — the other half of the same flag. `adventureDescription` shares
      // `Description.md` with the scenario blurb and so inherits `frontmatter: true`, but
      // only the blurb should carry `advanced:` and `description:`. Both are Scenario
      // fields VL reads at the root and nowhere else, and the markdown one has no adventure
      // equivalent the player could undo. Checked on the cache miss with CL0620, so an
      // author hears it once rather than once per leaf.
      if (loaded && loaded.metadata && descriptor.key === 'adventureDescription') {
        const offending = ['advanced', 'description']
          .filter((key) => Object.prototype.hasOwnProperty.call(loaded.metadata, key));
        if (offending.length > 0) {
          compileDiagnostics.error(
            DIAG_CODES.ADVENTURE_DESCRIPTION_ADVANCED,
            `"${descriptor.label}" declares ${offending.map((k) => `${k}:`).join(' and ')} in `
            + 'metadata:, which belongs to the scenario blurb only.',
            { file: String(spec) },
            {
              hint: 'Velvet Lattice reads both keys at the root and nowhere else, so they do '
                + 'nothing at a leaf today. AID has no markdown description for an adventure, '
                + 'and if it gains one this frontmatter would set a field the player cannot '
                + `change. Move them to the ${DESCRIPTION_DESCRIPTOR.label} component; other `
                + 'metadata keys are fine here.',
            },
          );
        }
      }
      sectionedDocs.set(spec, loaded);
    }
    return sectionedDocs.get(spec);
  };

  // The two sets §7.7's guard compares. Both are filled by the leaf loop below, which is
  // what makes CL0616 a comparison of two facts rather than of two passes.
  const descriptionLeaves = new Set();
  const openingLeaves = new Set();

  // Phase 11 Step 4 — component and script inheritance. Velvet Lattice inherits a
  // component down the branch tree by filename and a `Scripts/` dir wholesale, so a value
  // that is identical at every leaf need only be written once, at the node that declares
  // it, and VL folds it down. The leaf loop renders and checks every component per leaf
  // exactly as before; only the *file write* is deferred to here, where the full set of
  // per-leaf texts is known and the decision can be "one file at the root" or "one per
  // leaf, as it was".
  //
  //   - `opening` is excluded: it shares the `Opening.md` filename with `branchFraming`,
  //     which `writeFramingRecursive` writes at every interior node, so an inherited
  //     opening lifted above a leaf would be shadowed by the nearest ancestor's framing
  //     question (§7.3). It stays written at the leaf.
  //   - `adventureDescription` is excluded: VL reads `Description.md` from the node's own
  //     directory and does not inherit it (`scenario.py`), so the file has to land at
  //     each leaf regardless of Codex Loom's own key-merge (`emit/components.js:120`).
  const LIFT_EXCLUDED_COMPONENTS = new Set(['opening', 'adventureDescription']);
  const deferredComponents = new Map(); // descriptor.key → { descriptor, metadata, perLeaf: Map(outputDir → text) }
  const deferredScripts = new Map(); // outputDir → resolved scripts spec (a directory path), Phase 12 Step 6

  // Phase 11 Step 5 — story-card inheritance. One entry per leaf, filled by the loop:
  // `{ branchPath, folderPath, outputDir, grouped: Map(type → [{sortKey, rendered, id, name}]) }`.
  // The post-loop pass writes each card at the deepest node whose whole leaf-subtree
  // renders it byte-identically, and per leaf otherwise.
  const deferredCardLeaves = [];

  // ── 5. The leaf loop ──────────────────────────────────────────────────────────
  for (const branchPath of leaves) {
    const label = branchPath.length > 0 ? branchPath.join('/') : '(root)';
    if (verbose) console.log(`\n  Branch: ${label}`);

    // One traversal now serves what used to be four: the folder path, the inherited
    // roles table (`protagonist` is `roles.protagonist`, §9.2), the terminal node, and
    // (inside buildCompileContext) the merged variables and components.
    const chain = walkBranchChain(config.branches, branchPath, {
      rootRoles: config.roles || {},
    });
    // Always a string: an absent `roles.protagonist` merges to `undefined`, and
    // `resolveVariables` below requires a string input.
    const inheritedProtagonist = chain.roles.protagonist || '';
    const folderPath = chain.folderPath;
    const outputDir = buildBranchOutputDir(config._resolvedOutput, folderPath);
    const ctx = buildCompileContext(config, branchPath, {
      onWarn: busWarner(compileDiagnostics, { file: configPath }),
      diagnostics: compileDiagnostics,
      configPath,
    });
    // Expand {%var} in protagonist using branch-merged variables, before the
    // case-insensitive match against item ids.
    const branchProtagonist = resolveVariables(inheritedProtagonist, ctx.variables).toLowerCase() || null;
    const compileContext = { branchPath, branchProtagonist, ...ctx, diagnostics: compileDiagnostics };

    // Phase A: resolve all story cards
    const resolvedItems = resolveBranchItems(allItemDefs, registry, branchPath, ctx.variables, compileDiagnostics);

    // Accumulate unique item IDs and per-leaf stats for summary
    for (const item of resolvedItems) {
      if (item.id) allItemIds.add(item.id.toLowerCase());
    }
    const leafItems    = resolvedItems.length;
    const leafVariants = resolvedItems.filter(c => c._hasVariant).length;

    // The sectioned components are resolved *before* the items that fill them, because two
    // of §7.4's placement ERRORs — undeclared slot, and a section that is not a slot — are
    // questions about the component that only the item's target can ask. Loading here lets
    // them be raised where the placement is made rather than a hundred lines later, at a
    // point that no longer knows which item was responsible. `loadSectioned` caches by
    // resolved path, so a per-leaf hoist costs one Map lookup.
    const sectionedForLeaf = resolveSectionedComponents(compileContext, label, {
      loadSectioned, recordGap,
    });
    const slotIndex = buildSlotIndex(sectionedForLeaf, branchPath);

    // Phase B: cross-item refs + pronouns + render + write. One pass produces the story
    // cards and the component occupants together — see renderBranchItems.
    const renderedById = captureReports ? new Map() : null;
    const { grouped: leafCardGroups, occupants, placeholderNoise } = renderBranchItems(
      resolvedItems, registry, templates, partials, outputDir, branchProtagonist, ctx.variables,
      {
        verbose, renderedById,
        projectNotesTemplate: (compileContext.render && compileContext.render.notesTemplate) || null,
        diagnostics: compileDiagnostics, slotIndex, branchLabel: label, placeholders: ctx.placeholders,
        usage: placeholderUsage, usagePath: branchPath.join('/'),
        roles: ctx.roles, onRoleUsed,
        fieldTable, templateFor: ctx.templateFor, fieldAudit, cardTypeAudit,
      },
    );
    // Phase 11 Step 5: story cards are written after the loop, at the node that owns each
    // one, so a card constant across a subtree is written once and inherited rather than
    // copied to every leaf. `totalFiles` is credited there.
    deferredCardLeaves.push({
      branchPath, folderPath, outputDir, grouped: leafCardGroups,
      // For the post-loop `runPackChecks`: this leaf's branch-merged `lint` table and the
      // variables a pack `source:` path expands against. Captured here so the pack pass
      // does not re-walk the branch chain (§8.2.2). `resolvedItems` is the structured,
      // branch-merged item set — `item.body.<field>` in its authored shape — which the
      // Phase 16 `count` / `mutexHint` rules read (`evaluatePackItemRules`).
      lint: ctx.lint, variables: ctx.variables, resolvedItems,
    });
    reportCompileDiagnostics();

    if (options.inventory) {
      inventoryData.push(
        require('./inventory').captureLeafInventory(
          label, branchPath, sectionedForLeaf, slotIndex, occupants,
        ),
      );
    }

    // Sectioned components (§7.2) — all four of them now. The shape comes from the
    // component document, the content from the items that named its slots. This runs
    // *after* story cards: the ordering constraint existed only so suppression could
    // follow what Plot Essentials had actually emitted, and there is no suppression left.
    const sectionedWritten = {};
    const sectionedSegments = {};
    for (const { descriptor, spec, component, passthrough } of sectionedForLeaf) {
      const filled = occupants.get(descriptor.key) || new Map();
      let text;
      let segments;
      let excluded = false;
      if (passthrough !== null && passthrough !== undefined) {
        // Prose has no sections to render, warn about, or report separately. It is one
        // segment keyed by the component so the cross-branch reports still name it.
        text = passthrough;
        segments = [{ key: descriptor.label, text: passthrough }];
      } else {
        warnEmptySlots(descriptor, slotIndex, filled, label, compileDiagnostics, spec);
        // §7.8: `render.component.variant` selects which section-variant ships in the
        // component field. Absent (every golden today) it is a no-op and `component` renders
        // as-is; the slot set is unchanged either way because a variant cannot toggle `slot:`.
        const fieldVariant = component && component.render && component.render.component
          && typeof component.render.component.variant === 'string'
          ? component.render.component.variant.trim() : '';
        const fieldComponent = fieldVariant
          ? selectComponentSections(component, fieldVariant, null, null)
          : component;
        ({ text, segments, excluded = false } = renderSectionedComponent(
          fieldComponent, branchPath, filled,
          {
            defaultHeadingLevel: descriptor.defaultHeadingLevel,
            variables: ctx.variables, registry, branchProtagonist,
            roles: ctx.roles, onRoleUsed,
            onWarn: busWarner(compileDiagnostics, { file: String(spec) }),
          },
        ));
      }
      // The assembled component. Occupant bodies were already scanned per placement above,
      // and `checkUndeclaredPlaceholders` reports once per key per site, so a name that
      // appears in both a section's own `text:` and an occupant is named twice — once
      // against the item, once against the component. Both are true and both are editable.
      checkUndeclaredPlaceholders(text, ctx.placeholders, {
        diagnostics: compileDiagnostics,
        file: String(spec),
        where: `component "${descriptor.label}"`,
        branch: label,
        skip: placeholderNoise.get(descriptor.key),
        usage: placeholderUsage,
        usagePath: branchPath.join('/'),
      });

      // §8.5's platform caps, table-driven rather than per-component. Only `opening:`
      // carries a `limitKey` today; the point of the column is that Step 4's `notes:` cap
      // is a row rather than another bespoke call site. Measured post-substitution because
      // Velvet Lattice expands `%key%` to its question text on the way to AID.
      if (descriptor.limitKey && text) {
        checkLimit(
          text,
          questionsForMeasurement(ctx.placeholders, ctx.variables),
          LIMITS[descriptor.limitKey],
          {
            diagnostics: compileDiagnostics,
            loc: { file: String(spec) },
            label: branchPath.length ? `branch "${branchPath[branchPath.length - 1]}"` : 'the project root',
          },
        );
      }

      const metadata = component ? component.metadata : null;
      // Phase 11 Step 4: a component that renders to something is written here only if it
      // is one of the two the leaf must hold itself; every other component's write is
      // deferred to the post-loop inheritance pass, which decides between one file at the
      // declaring node and one per leaf. `sectionedWritten`/`sectionedSegments` and the
      // CL0616 sets are still filled per leaf either way — the leaf *has* the component,
      // whether it holds the bytes or inherits them, and `--diff`/`--annotate` read those
      // in-memory segments, not the tree.
      let wrote;
      if (text && LIFT_EXCLUDED_COMPONENTS.has(descriptor.key)) {
        const outPath = writeSectionedComponent(
          outputDir, descriptor, text, { diagnostics: compileDiagnostics }, metadata,
        );
        wrote = !!outPath;
        if (outPath) {
          if (verbose) console.log(`    OK: ${descriptor.verboseLabel} → ${outPath}`);
          totalFiles++;
        }
      } else if (text) {
        let entry = deferredComponents.get(descriptor.key);
        if (!entry) {
          entry = { descriptor, metadata, perLeaf: new Map() };
          deferredComponents.set(descriptor.key, entry);
        }
        entry.perLeaf.set(outputDir, text);
        wrote = true;
      } else {
        wrote = false;
      }
      if (wrote) {
        sectionedWritten[descriptor.key] = true;
        sectionedSegments[descriptor.key] = segments;
        if (descriptor.key === 'adventureDescription') descriptionLeaves.add(label);
        // §7.7's guard used to read this from `writeOpeningsRecursive`'s return value.
        // Openings are written here now, so the set is built here — the two facts CL0616
        // compares are produced by one loop rather than by two passes that had to agree.
        if (descriptor.key === 'opening') openingLeaves.add(label);
      } else if (!excluded) {
        // §7.4: a component that renders to nothing is an ERROR, not a gap. The gap list
        // is for a component that was asked for and could not be found; this one was
        // found, read, and had every section resolve away, which is a statement about
        // the source that no amount of re-reading the path will explain.
        //
        // A component-level `~` is exempt because it is not that statement. The author
        // wrote "not on this branch", and §7.6.2a gives `~` that meaning at this position
        // exactly as it has it at every other. Writing no file is the whole request.
        compileDiagnostics.error(
          DIAG_CODES.COMPONENT_RENDERS_NOTHING,
          `component "${descriptor.label}" renders to nothing on branch "${label}" — `
          + 'every section is excluded by its own branches: dispatch, empty, or an unfilled slot.',
          { file: String(spec) },
        );
      }

      // §7.8: after the component field, its `render.storyCards` alternates. They join
      // `leafCardGroups` here — after `renderBranchItems` has returned — so Phase 11 frontier
      // placement writes them with the real cards. Skipped when the component is excluded
      // from this branch (`~`): the author said "not on this branch", and an alternate copy
      // is still this branch getting the component.
      if (!excluded && component && component.render) {
        renderComponentStoryCards(component, descriptor, branchPath, filled, leafCardGroups, {
          variables: ctx.variables, registry, branchProtagonist,
          roles: ctx.roles, onRoleUsed,
          diagnostics: compileDiagnostics,
          questions: questionsForMeasurement(ctx.placeholders, ctx.variables),
          storyCardType: config.storyCardType,
          spec, branchLabel: label, cardTypeAudit,
        });
      }
    }
    const hasPE = !!sectionedWritten.plotEssential;
    const hasAIN = !!sectionedWritten.aiInstructions;
    const hasAN = !!sectionedWritten.authorsNote;

    // Scripts (Phase 12 Step 6)
    //
    // Collected here, written by the inheritance pass below. Velvet Lattice inherits a
    // node's `Scripts/` dir down its subtree (`scenario.py`: `self.scripts = {**parent,
    // **local}`), so a `scripts:` spec that resolves identically at every leaf and is
    // redeclared by no branch is written once at the output root, exactly as the deferred
    // components are. Anything else is written per leaf, at the same `outputDir` this loop
    // used to copy it to.
    const scriptsSpec = compileContext.componentRefs.scripts;
    if (scriptsSpec && typeof scriptsSpec === 'string') {
      deferredScripts.set(outputDir, scriptsSpec);
    }

    if (captureReports) {
      leafData.push({
        label,
        branchPath,
        fileBase: branchPath.length ? branchPath.join(' - ') : rootDirName,
        items: renderedById,
        // Every sectioned component reports per section, keyed by section name, so a
        // cross-branch diff localizes a change to the section that carries it. Spread
        // rather than named, so every one of `SLOTTED_COMPONENTS` reaches `--diff`/
        // `--annotate` without this site needing to list them by hand; `description:` is
        // absent on purpose, since the scenario blurb is written once at the root and has
        // no per-leaf value to diff.
        components: { ...sectionedSegments },
      });
    }

    leafSummaries.push({ label, leafItems, leafVariants, hasPE, hasAIN, hasAN });
  }

  // ── 6. Pack checks ────────────────────────────────────────────────────────────
  // §8.2.2 — convention packs, run over the cards each leaf just rendered while they are
  // still keyed per leaf. Dormant unless a project declares `lint.packs`.
  runPackChecks(config, deferredCardLeaves, configPath, compileDiagnostics);
  reportCompileDiagnostics();

  // ── 7. Inheritance passes ─────────────────────────────────────────────────────
  // ── Phase 11 Step 4: component and script inheritance ──────────────────────
  //
  // Each deferred component (and the `Scripts/` dir) is written once at the output root
  // when its value is identical at every leaf and no branch node redeclares it — the
  // shape Velvet Lattice inherits down the tree for free. Anything else is written per
  // leaf, byte-for-byte where the leaf loop used to write it, so the fallback is the old
  // behavior rather than a new one.
  //
  // "Identical at every leaf" is required to be a total match, not a majority: a leaf that
  // excludes the component (`~`, or a gap) is not in `perLeaf`, and lifting to the root
  // would make VL inherit it there anyway. `leaves.length > 1` skips the single-leaf
  // projects, where the one "leaf" already *is* the root and lifting would be a no-op that
  // only muddies the diff.
  const canLift = (perLeaf, declaredInBranches) => leaves.length > 1
    && perLeaf.size === leaves.length
    && !declaredInBranches
    && new Set(perLeaf.values()).size === 1;

  for (const { descriptor, metadata, perLeaf } of deferredComponents.values()) {
    const declaredInBranches = branchTreeDeclares(
      config.branches, (node) => node.components && node.components[descriptor.key] !== undefined,
    );
    if (canLift(perLeaf, declaredInBranches)) {
      const [text] = perLeaf.values();
      const outPath = writeSectionedComponent(
        config._resolvedOutput, descriptor, text, { diagnostics: compileDiagnostics }, metadata,
      );
      if (outPath) {
        if (verbose) console.log(`    OK: ${descriptor.verboseLabel} (inherited from root) → ${outPath}`);
        totalFiles++;
      }
    } else {
      for (const [leafDir, text] of perLeaf) {
        const outPath = writeSectionedComponent(
          leafDir, descriptor, text, { diagnostics: compileDiagnostics }, metadata,
        );
        if (outPath) {
          if (verbose) console.log(`    OK: ${descriptor.verboseLabel} → ${outPath}`);
          totalFiles++;
        }
      }
    }
  }

  // The `Scripts/` dir rides the same lift test (Phase 12 Step 6). `canLift` compares the
  // resolved spec strings — one distinct spec across every leaf is one identical
  // `fs.cpSync` by construction — but `scripts/rebaseline.js` still asserts byte-identity
  // of the copied files, because this pass is the only thing between a lifted layout and a
  // silently re-contented script. A single-leaf project (`leaves.length === 1`) writes per
  // leaf, where the one "leaf" already is the output root, so its layout does not move.
  if (deferredScripts.size > 0) {
    const scriptsDeclaredInBranches = branchTreeDeclares(
      config.branches, (node) => node.scripts !== undefined,
    );
    if (canLift(deferredScripts, scriptsDeclaredInBranches)) {
      const [spec] = deferredScripts.values();
      copyScripts(spec, config._resolvedOutput);
      if (verbose) {
        console.log(`    OK: Scripts/ (inherited from root) → ${path.join(config._resolvedOutput, 'Scripts')}`);
      }
    } else {
      for (const [leafDir, spec] of deferredScripts) copyScripts(spec, leafDir);
    }
  }

  // ── Phase 11 Step 5: story-card inheritance ────────────────────────────────
  //
  // A card was rendered once per leaf above. Velvet Lattice inherits a node's cards down
  // its subtree, merging by card name, so a card that renders byte-identically across a
  // whole subtree need only be written once, at that subtree's root. This pass finds, for
  // each card, the minimal set of nodes whose subtrees partition exactly the leaves that
  // rendered it — the frontier — and writes the card there. A card that varies within its
  // scope (a protagonist-dependent body, say) has each of its versions placed the same
  // way, and one that reaches an irregular set of leaves falls all the way back to a copy
  // per leaf. Every leaf still *resolves* to the same card set it did before; only the
  // file layout changes (v4 spec §14.3, §15).
  if (deferredCardLeaves.length <= 1) {
    // One leaf (or none): there is no subtree to inherit down, so the frontier would only
    // relocate the single leaf's cards to the output root for no saving. Write them where
    // they were — same as the pre-Step-5 leaf loop did.
    for (const leaf of deferredCardLeaves) {
      const byType = new Map();
      for (const [type, entries] of leaf.grouped) byType.set(type, entries);
      for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
        const items = byType.get(type)
          .slice()
          .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.rendered.localeCompare(b.rendered))
          .map((c) => c.rendered);
        const outPath = writeOutput(leaf.outputDir, type, items);
        if (verbose) console.log(`    OK: ${type} (${items.length} card(s)) → ${outPath}`);
        totalFiles += 1;
      }
    }
  } else {
    const leafPaths = deferredCardLeaves.map((l) => l.branchPath);
    const leavesUnder = (prefix) => {
      const out = [];
      for (let i = 0; i < leafPaths.length; i += 1) {
        if (prefix.every((seg, k) => leafPaths[i][k] === seg)) out.push(i);
      }
      return out;
    };
    // The minimal nodes (as branch-id paths) whose subtrees cover exactly `carry`.
    const frontier = (prefix, carry) => {
      const under = leavesUnder(prefix);
      if (under.length === 0) return [];
      if (under.every((i) => carry.has(i))) return [prefix];
      const deeper = under.filter((i) => leafPaths[i].length > prefix.length);
      if (deeper.length === 0) {
        return under.filter((i) => carry.has(i)).map((i) => leafPaths[i]);
      }
      const childSegs = [...new Set(deeper.map((i) => leafPaths[i][prefix.length]))];
      const nodes = [];
      for (const seg of childSegs) nodes.push(...frontier([...prefix, seg], carry));
      for (const i of under) {
        if (leafPaths[i].length === prefix.length && carry.has(i)) nodes.push(prefix);
      }
      return nodes;
    };

    // Every rendering of every card, indexed by the (type, name) pair — a card's file is
    // `Story Cards/<type>/<type>.md` and Velvet Lattice merges within it by name, so that
    // pair is the identity inheritance has to preserve. A per-branch variant that changes
    // the name or the type is a different card here and lands on its own leaves; one that
    // only changes the body is one entry with two texts, each placed on its own frontier.
    // Keying on the item id would be wrong — a `variants:` item keeps one id while its
    // name and type differ per branch. (The key separator is a control char so it cannot
    // occur in either half.)
    const cardIndex = new Map();
    deferredCardLeaves.forEach((leaf, li) => {
      for (const [type, entries] of leaf.grouped) {
        for (const e of entries) {
          const key = `${type}${e.name}`;
          let rec = cardIndex.get(key);
          if (!rec) { rec = { type, byText: new Map() }; cardIndex.set(key, rec); }
          let group = rec.byText.get(e.rendered);
          if (!group) { group = { carry: new Set(), sortKey: e.sortKey }; rec.byText.set(e.rendered, group); }
          group.carry.add(li);
        }
      }
    });

    // nodeDir → type → [{ sortKey, rendered }]
    const ownedByNode = new Map();
    const putOwned = (dir, type, sortKey, rendered) => {
      if (!ownedByNode.has(dir)) ownedByNode.set(dir, new Map());
      const byType = ownedByNode.get(dir);
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push({ sortKey, rendered });
    };
    for (const rec of cardIndex.values()) {
      for (const [text, group] of rec.byText) {
        for (const node of frontier([], group.carry)) {
          const dir = buildBranchOutputDir(
            config._resolvedOutput, resolveBranchFolderPath(config.branches, node),
          );
          putOwned(dir, rec.type, group.sortKey, text);
        }
      }
    }

    // Types alphabetical, cards within a type by id then rendered text — the order
    // `renderBranchItems` used to apply itself, now applied once per owning node.
    for (const [dir, byType] of ownedByNode) {
      for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
        const items = byType.get(type)
          .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.rendered.localeCompare(b.rendered))
          .map((c) => c.rendered);
        const outPath = writeOutput(dir, type, items);
        if (verbose) console.log(`    OK: ${type} (${items.length} card(s)) → ${outPath}`);
        totalFiles += 1;
      }
    }
  }

  // ── 8. Tree-level writes ──────────────────────────────────────────────────────
  // Write Opening / OpeningChoice files (post-loop)
  //
  // Root-level branchFraming lives in `writeFramingRecursive`'s root visit now (Phase 11
  // Step 0) — the same component written at the node that declares it, landing in the
  // root output dir where the old hand-rolled rung wrote it.

  // `opening:` is written by the leaf loop above, as an ordinary inherited component. What
  // is left for the tree visitor is framing, which belongs to a node the leaf loop never
  // visits.
  writeFramingRecursive(
    config, config._resolvedOutput, config._base, configPath,
    config._variables || config.variables || {},
    verbose, compileDiagnostics, placeholderUsage,
    loadSectioned, registry, onRoleUsed,
  );

  writeLabelsRecursive(
    config, config._resolvedOutput, config._variables || config.variables || {}, config.variables || {},
    verbose, compileDiagnostics, configPath, placeholderUsage,
  );

  writePlaceholdersRecursive(
    config, config._resolvedOutput,
    config._variables || config.variables || {}, configPath, compileDiagnostics, verbose,
    placeholderUsage, placeholderDeclarations, placeholderDuplicates,
  );
  reportCompileDiagnostics();

  // Root Label is written by `writeLabelsRecursive`'s root visit now (Phase 11 Step 0) —
  // the hand-rolled rung that used to live here duplicated it, writing the file twice and
  // double-firing the placeholder-in-title warn.

  // The scenario blurb (§7.7), written once to the output root alongside Branches/.
  //
  // An ordinary component document since Phase 6, rather than the two-field `description.yaml`
  // v3 gave it a loader of its own for. `body:` is now a section with `file:` and `script:`
  // is one with `from: {script:, extract: scriptBanner}`, which is what made the third file
  // format deletable — and what makes more than one banner expressible, where v3 allowed
  // exactly one.
  //
  // It renders through `renderSectionedComponent` with an empty occupant map, which is not a
  // second render path but the same one called with nothing to place: a scenario has one
  // blurb and items are branch-scoped, so there is no branch whose cast could route into it.
  const descRequested = config.components && config.components.description != null;
  const descSpec = descRequested
    ? resolveComponentSpec(config.components.description, config._base, config._variables || config.variables || null)
    : null;
  if (descRequested && !(descSpec && typeof descSpec === 'string' && fs.existsSync(descSpec))) {
    recordGap('(project)', 'Description', descSpec, 'source not found');
  } else if (descSpec && typeof descSpec === 'string' && fs.existsSync(descSpec)) {
    let combined = null;
    let descMetadata = null;

    if (isPassthrough(descSpec)) {
      combined = readPassthrough(descSpec);
    } else {
      const descComponent = loadSectioned(descSpec, DESCRIPTION_DESCRIPTOR);
      if (descComponent) {
        descMetadata = descComponent.metadata;
        // `branchProtagonist` stays null: the blurb belongs to the project, not to any
        // branch, so there is no chain to take a protagonist from (Phase 10 Step 4).
        // `roles` still reaches the render, gated the same way the leaf loop gates it
        // (Decision — `buildCompileContext`'s `chain.rolesDeclared ? chain.roles : null`),
        // so a `{$role}` token in the root description resolves instead of reading as an
        // undeclared placeholder, and `onRoleUsed` marks it used so `CL0545` agrees.
        const rootRolesDeclared = !!(config.roles && Object.keys(config.roles).length);
        ({ text: combined } = renderSectionedComponent(
          descComponent, [], new Map(),
          {
            defaultHeadingLevel: DESCRIPTION_DESCRIPTOR.defaultHeadingLevel,
            variables: rootVariables || {}, registry, branchProtagonist: null,
            roles: rootRolesDeclared ? config.roles : null, onRoleUsed,
            onWarn: busWarner(compileDiagnostics, { file: String(descSpec) }),
          },
        ));
      }
    }

    // Checked against the root table, and that stays correct where the plan warned it might
    // not: the blurb belongs to the project, and it is `adventureDescription:` — a different
    // key, resolved inside the leaf loop against the branch-merged table — that carries the
    // per-node case §7.7 asked for.
    checkUndeclaredPlaceholders(combined, config.placeholders, {
      diagnostics: compileDiagnostics, file: descSpec, where: 'the Description',
      usage: placeholderUsage, usagePath: '',
    });
    checkPlaceholderContext(combined, {
      diagnostics: compileDiagnostics,
      file: descSpec,
      where: 'the Description',
      reason: 'AID does not fill placeholders in the Description. It is shown before any '
        + 'adventure exists to answer them, so the raw text is what a reader sees.',
    });
    const descPath = writeSectionedComponent(
      config._resolvedOutput, DESCRIPTION_DESCRIPTOR, combined,
      { diagnostics: compileDiagnostics }, descMetadata,
    );
    if (descPath) {
      if (verbose) console.log(`  OK: Description → ${descPath}`);
      // Both description keys write `Description.md`, and at an unbranched root they write
      // the same one — the root is its own leaf there, so the leaf loop has already been
      // through. Reported rather than silently resolved, because which of the two an author
      // meant to survive is not recoverable from the file that is left.
      if (descriptionLeaves.has('(root)')) {
        compileDiagnostics.warn(
          DIAG_CODES.DESCRIPTION_KEYS_COLLIDE,
          'this project declares both description: and adventureDescription: and has no '
          + 'branches, so the root is its own leaf and both write the same Description.md. '
          + 'The scenario blurb is what survives. Drop one, or add the branch the '
          + 'adventure description was written for.',
          { file: configPath },
        );
      }
    } else recordGap('(project)', 'Description', descSpec, 'compiled to empty content');
  }

  // ── 9. Project diagnostics, summary, reports, finalize ────────────────────────
  // §7.7's one guard. Velvet Lattice sets a node's prompt to
  // `components["Opening"] or node.description`, so a leaf carrying a description and no
  // Opening.md does not produce an empty prompt — it produces the blurb as the opening
  // scene. v3 could not reach this, because descriptions were written only at the output
  // root; `adventureDescription:` is what makes the pairing possible, and this is its price.
  for (const leafLabel of descriptionLeaves) {
    if (openingLeaves.has(leafLabel)) continue;
    compileDiagnostics.error(
      DIAG_CODES.LEAF_DESCRIPTION_NO_OPENING,
      `branch "${leafLabel}" has an adventure description and no Opening.md. Velvet Lattice `
      + 'reads a node\'s prompt as its Opening or, failing that, its description — so this '
      + 'leaf would open the adventure with its own blurb rather than a scene. Give the '
      + 'branch an opening:, or drop the adventureDescription: it inherits.',
      { file: configPath },
    );
  }

  // §7.3 / §6.3: a leaf that resolves neither an opening nor AI Instructions. Both are
  // ordinary inherited components (`buildCompileContext` merges them down the chain), so a
  // `false` here means nothing in the leaf's ancestry set one — not merely that this node
  // did not. Read from `leafSummaries` because a leaf's opening status is only final once
  // every component write, inherited ones included, has run. A leaf covered by the CL0616
  // ERROR above (has a description, no opening) is not also flagged CL0630.
  for (const s of leafSummaries) {
    if (!openingLeaves.has(s.label) && !descriptionLeaves.has(s.label)) {
      compileDiagnostics.warn(
        DIAG_CODES.LEAF_NO_OPENING,
        `branch "${s.label}" resolves no opening: and no adventureDescription:, so Velvet `
        + 'Lattice would start this leaf with an empty prompt. Give the branch an opening:, '
        + 'or one an ancestor passes down.',
        { file: configPath },
      );
    }
    if (!s.hasAIN) {
      compileDiagnostics.warn(
        DIAG_CODES.LEAF_NO_AIN,
        `branch "${s.label}" resolves no aiInstructions:. Velvet Lattice writes an `
        + 'empty-string AI Instructions on AID\'s side for it, and an empty string suppresses '
        + 'AID\'s model-default instructions rather than falling back to them — the leaf plays '
        + 'with none at all. Give the branch an aiInstructions:, or one an ancestor passes down.',
        { file: configPath },
      );
    }
  }
  reportCompileDiagnostics();

  // Per-leaf summary table (printed after all component writes so Opening status is known)
  for (const s of leafSummaries) {
    s.hasOpening = openingLeaves.has(s.label);
  }
  const maxLabelLen = Math.max(...leafSummaries.map(s => s.label.length), 'Branch'.length);
  const lp = maxLabelLen + 2;
  const c = b => b ? ' ✓ ' : ' - ';
  console.log(`\n  ${'Branch'.padEnd(lp)} ${'Items'.padStart(5)}  ${'Var'.padStart(3)}   Open   PE  AIN   AN`);
  for (const s of leafSummaries) {
    console.log(
      `  ${s.label.padEnd(lp)} ${String(s.leafItems).padStart(5)}  ${String(s.leafVariants).padStart(3)}  ` +
      ` ${c(s.hasOpening)}  ${c(s.hasPE)} ${c(s.hasAIN)} ${c(s.hasAN)}`
    );
  }
  console.log(`\n${allItemIds.size} unique items across project. Wrote ${totalFiles} file(s).`);

  // Library dependency manifest
  const libraryManifest = buildLibraryManifest(config);
  if (Object.keys(libraryManifest).length > 0) {
    const manifestPath = path.join(config._resolvedOutput, 'library-dependencies.json');
    const manifestData = {
      generatedAt: new Date().toISOString(),
      compileYaml: path.resolve(configPath),
      variables: config.variables || {},
      library: libraryManifest,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');
    if (verbose) console.log(`  OK: Library manifest → ${manifestPath}`);
  }

  // Dependency-coverage check (Phase 7 Step 4, floated out of Step 0): `dependencyLedger` is
  // every resolved component path this compile actually read, `imports:` chains included
  // (built above, in `loadSectioned`/`loadComponentDocument`). A component that lives
  // outside the project but under no `structure.input.library` entry compiles and renders
  // correctly today and is invisible to `--snapshot` — the freeze walks declared entries,
  // not resolved dependencies, so nothing else notices the gap. Checked once, here, rather
  // than per leaf: the ledger is already deduplicated by resolved path.
  const libraryDirs = [...config._resolvedLibrarySource.values()];
  for (const specPath of dependencyLedger) {
    if (!isOutOfBase(specPath, config._base)) continue;
    const norm = normalize(specPath);
    const covered = libraryDirs.some((dir) => {
      const normDir = normalize(dir);
      return norm === normDir || norm.startsWith(`${normDir}/`);
    });
    if (!covered) {
      compileDiagnostics.warn(
        LOAD_CODES.LIBRARY_DEPENDENCY_UNCOVERED,
        `This component is read from outside the project (${specPath}), and no `
        + 'structure.input.library entry covers it — --snapshot will not freeze it, and '
        + 'a live edit to this file changes every project that reaches it. Declare its '
        + 'directory as a library entry so the freeze and the {%name} it is reached '
        + 'through are the same thing.',
        { file: specPath },
      );
    }
  }

  // Cross-branch review reports — emitted from the per-leaf data captured above.
  const reportBase = config._resolvedReports || path.join(config._resolvedOutput, 'Overview');
  const reportSummary = [];

  // §17.2 provenance report — always emitted from registry data, independent of leaf loop.
  const { runProvenanceMode } = require('./provenance');
  const provenanceWritten = runProvenanceMode(registry, reportBase, rootDirName);
  reportSummary.push(`${provenanceWritten.length} provenance file(s)`);

  // §13.8 — the generated field reference, opt-in. Derived from the merged field table,
  // not the leaf loop, and written where SCHEMA.md's §3–§5 tables can be copied from.
  if (options.schemaTables) {
    const { runSchemaTablesMode } = require('./schematables');
    // §13.4 — every template a branch's `templateFor` slot files produce, so a tier author
    // can diff a terse list against the full type in one place. `tierTemplates` was
    // gathered once beside the field audit (`gatherTierTemplates`), which needs the same set.
    const w = runSchemaTablesMode(fieldTable, path.join(reportBase, 'schema-tables'),
      { title: config.title || rootDirName, tierTemplates });
    reportSummary.push(`${w.length} schema-tables file(s)`);
  }

  if ((captureReports && leafData.length > 0) || (options.inventory && inventoryData.length > 0)) {
    const { runDiffMode, runAnnotateMode } = require('./diff');
    if (options.inventory) {
      fs.mkdirSync(reportBase, { recursive: true });
      const w = require('./inventory').runInventoryMode(inventoryData, reportBase);
      reportSummary.push(`${w.length} inventory file(s)`);
    }
    if (options.diff) {
      const diffDir = path.join(reportBase, 'diff');
      fs.mkdirSync(diffDir, { recursive: true });
      const w = runDiffMode(leafData, diffDir);
      reportSummary.push(`${w.length} diff file(s) (Shared + deltas)`);
    }
    if (options.annotate) {
      const annotateDir = path.join(reportBase, 'annotate');
      fs.mkdirSync(annotateDir, { recursive: true });
      const w = runAnnotateMode(leafData, allItemDefs, registry, annotateDir);
      reportSummary.push(`${w.length} annotation file(s)`);
    }
  }
  if (reportSummary.length > 0) {
    console.log(`\nWrote ${reportSummary.join(' and ')} to:\n  ${reportBase}`);
  }

  // Last, because "unused" is only knowable once every write point has run — and the
  // Description and the scenario title are written after the branch tree.
  reportUnusedRoles(roleDeclarations, roleUsage, { diagnostics: compileDiagnostics, file: configPath });
  // §13.6: the deduped unread-field findings, then the whole-table dead-declaration sweep.
  fieldAudit.finish(compileDiagnostics);
  // CL0626–CL0628, here for the same reason: the fold warns once per authored value across
  // the whole compile, and a case collision is only visible once every branch's types are in.
  cardTypeAudit.finish(compileDiagnostics);
  reportUnusedPlaceholders(placeholderDeclarations, placeholderUsage, {
    diagnostics: compileDiagnostics, file: configPath,
  });
  reportDuplicateQuestions(placeholderDuplicates, {
    diagnostics: compileDiagnostics, file: configPath,
  });

  // Requested-but-unwritten components: surface as an error so the gap is never silent.
  // Raised before `reportCompileDiagnostics()` below, so these reach the printed output —
  // a bus error raised after that call would never be rendered.
  for (const g of componentGaps) {
    compileDiagnostics.error(
      DIAG_CODES.COMPONENT_NO_OUTPUT,
      `[${g.leaf}] ${g.component}: ${g.reason} (spec: ${g.spec})`,
      { file: configPath },
    );
  }

  reportCompileDiagnostics();

  if (componentGaps.length > 0) {
    throw new Error(
      `${componentGaps.length} requested component(s) were not written — see errors above. ` +
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
