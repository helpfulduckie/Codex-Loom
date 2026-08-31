#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadItemsFromDir, loadTemplates, loadCompileConfig,
  buildRegistry, mergeRegistries, loadYaml,
} = require('./loader');
const {
  resolveItem, enumerateLeaves, walkBranchChain, walkBranchTree, mergePlaceholders, mergeUnbindable,
  resolveBranchSpec, collectVariantDeltas, localRoleKeysOf,
} = require('./resolver');
const { resolvePlacements } = require('./model/item');
const { slotsForBranch, normalizeComponent, applySectionSelector } = require('./model/component');
const { loadComponentDocument } = require('./loader/component');
const { applyPronounPasses, applyCrossItemRefs } = require('./model/pronouns');
const { render, applyFieldInterpolation, applyVariableInterpolation, applyFieldRenderFunctions } = require('./template');
const { renderFieldList } = require('./render/field-list');
const { FUNCTION_NAMES } = require('./render/parse');
const { CODES: FIELD_TABLE_CODES } = require('./loader/field-table');
const { buildFieldAudit } = require('./render/field-audit');
const { resolveVariables, checkUnexpandedVariables, checkUnresolvedFieldTokens, checkMechanicalArtifacts, itemContext, CONFIG_BASENAMES, normalizeVarKey } = require('./util');
const { expandTokens } = require('./tokens');
const { resolveIncludes, buildCanonRegistry, findConfigEntry } = require('./loader/registry');
const { Diagnostics, busWarner, severityOf, CODES: DIAG_CODES, LINT_LEVELS } = require('./diag');
const { renderCard, cardTitle, parseCards } = require('./emit/vl');
const {
  loadPack, evaluatePack, evaluatePackExistence, evaluatePackItemRules, clampFinding,
} = require('./lint/packs');
const {
  FILENAME: PLACEHOLDERS_FILENAME, writeNodePlaceholders, checkUndeclaredPlaceholders,
  checkPlaceholderContext, reportUnusedPlaceholders, reportDuplicateQuestions, localKeysOf,
  expandQuestions,
} = require('./emit/placeholders');
const { LIMITS, checkLimit } = require('./limits');
const {
  SLOTTED_COMPONENTS, DESCRIPTION_DESCRIPTOR, FRAMING_DESCRIPTOR, isPassthrough, readPassthrough,
  renderSectionedComponent, writeSectionedComponent,
} = require('./emit/components');
const { syncLibrary, checkDrift } = require('./snapshot');
const { CODES: LOAD_CODES, isOutOfBase, normalize } = require('./config/load');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Characters illegal in a Windows/Unix path segment (mirrors overview.js sanitizeFilename
// plus control chars). aid.type becomes both a folder and a filename, so it must be safe.
const INVALID_TYPE_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

/**
 * Validate an item's aid.type after variable expansion. aid.type is written to disk
 * as Story Cards/{type}/{type}.md, so it must be a legal path segment. Throws (aborts
 * the compile) on an invalid type. No-op when the item has no aid.type (that case is
 * already warned about during item resolution).
 */
function validateCardType(item) {
  const type = item.aid && item.aid.type;
  if (typeof type !== 'string' || type === '') return;
  const trimmed = type.trim();
  const name = item.id || (typeof item.name === 'string' ? item.name : '(unknown)');
  const src = item._source ? ` (${item._source})` : '';
  let reason = null;
  if (trimmed === '') reason = 'is empty/whitespace';
  else if (INVALID_TYPE_CHARS.test(type)) reason = 'contains an illegal path character (one of < > : " / \\ | ? *)';
  else if (trimmed === '.' || trimmed === '..') reason = 'is "." or ".."';
  else if (/[ .]$/.test(type)) reason = 'ends with a space or period';
  if (reason) {
    throw new Error(`Invalid aid.type "${type}" for item "${name}"${src}: ${reason}. aid.type becomes a folder/file name and must be a legal path segment.`);
  }
}

/**
 * AI Dungeon's five built-in story-card categories, in the casing AID itself stores.
 *
 * Confirmed against the platform rather than inherited from Velvet Lattice's old list: a
 * card pushed as `Race` comes back as `Race` and does not group with `race` in the editor,
 * so AID stores the string verbatim and matches it exactly. Anything not in this set is a
 * custom category and keeps whatever casing the author gave it — `Character - Dalor` and
 * `Spell - Ice` are deliberate groupings, not misspellings of a built-in.
 */
const AID_BUILTIN_TYPES = new Set(['character', 'class', 'race', 'location', 'faction']);

/**
 * Normalize one `aid.type` for emit: trim leading space, fold a built-in to lowercase.
 *
 * Pure, and separate from `validateCardType` because the two answer different questions —
 * that one asks whether the string can be a path at all and throws when it cannot, this one
 * asks what should actually be written. Trailing space and period never reach here; they
 * are fatal above, since Windows strips them and the type would silently become another.
 *
 * @returns {{ type: string, folded: boolean, trimmed: boolean }}
 */
function normalizeCardType(raw) {
  if (typeof raw !== 'string' || raw === '') return { type: raw, folded: false, trimmed: false };
  const trimmedText = raw.replace(/^\s+/, '');
  const lower = trimmedText.toLowerCase();
  const folded = AID_BUILTIN_TYPES.has(lower) && trimmedText !== lower;
  return { type: folded ? lower : trimmedText, folded, trimmed: trimmedText !== raw };
}

/**
 * Compile-wide accumulator for `aid.type` normalization and collisions (CL0626–CL0628).
 *
 * Shaped like `buildFieldAudit`: record as the compile walks branches, report once at the
 * end. Both halves need that shape for the same reason — a type is resolved per item per
 * branch, so per-site reporting would print one line per card per branch for a single
 * authoring decision, and the collision check cannot run until every branch's types are in.
 */
function buildCardTypeAudit() {
  // authored value → { to, file }. Keyed on the authored string so one warning covers
  // every card that spells the type that way.
  const foldedValues = new Map();
  const trimmedValues = new Map();
  // final type → the first source file that produced it, for the collision message.
  const originOf = new Map();

  function resolve(raw, loc = {}) {
    const { type, folded, trimmed } = normalizeCardType(raw);
    if (typeof type !== 'string' || type === '') return type;
    const file = loc.file || null;
    if (folded && !foldedValues.has(raw)) foldedValues.set(raw, { to: type, file });
    if (trimmed && !trimmedValues.has(raw)) trimmedValues.set(raw, { to: type, file });
    if (!originOf.has(type)) originOf.set(type, file);
    return type;
  }

  function finish(diagnostics) {
    if (!diagnostics) return;

    for (const [authored, { to, file }] of trimmedValues) {
      diagnostics.warn(
        DIAG_CODES.CARD_TYPE_LEADING_SPACE,
        `aid.type "${authored}" has leading whitespace; writing it as "${to}".`,
        { file },
        {
          hint: 'A leading space survives in a directory name, so the type would reach AI '
            + 'Dungeon as a category whose name differs from the obvious one by an '
            + 'invisible character.',
        },
      );
    }

    for (const [authored, { to, file }] of foldedValues) {
      // One line per authored value, not two: a leading-space type that is also a built-in
      // has already been reported by CL0628, whose message names the same final value.
      if (trimmedValues.has(authored)) continue;
      diagnostics.warn(
        DIAG_CODES.CARD_TYPE_NORMALIZED,
        `aid.type "${authored}" names a built-in AI Dungeon category; writing it as "${to}".`,
        { file },
        {
          hint: 'AID\'s built-in categories are lowercase and it matches the type string '
            + `exactly, so "${authored}" would arrive as a custom category beside `
            + `"${to}" rather than inside it. Declare it lowercase to silence this.`,
        },
      );
    }

    // Collision is checked on the *normalized* values: a pair that folded to one built-in
    // has already been merged on purpose, and only a pair that still differs still collides.
    const byPath = new Map();
    for (const type of originOf.keys()) {
      const key = type.trim().toLowerCase();
      if (!byPath.has(key)) byPath.set(key, []);
      byPath.get(key).push(type);
    }
    for (const [, variants] of byPath) {
      if (variants.length < 2) continue;
      const sorted = variants.slice().sort();
      diagnostics.error(
        DIAG_CODES.CARD_TYPE_CASE_COLLISION,
        `aid.type values ${sorted.map((v) => `"${v}"`).join(' and ')} differ only by case, `
        + 'and are written to the same file on a case-insensitive filesystem.',
        { file: originOf.get(sorted[0]) },
        {
          hint: 'Story Cards/{type}/{type}.md is one path for all of them on Windows and '
            + 'macOS, so the group written last overwrites the others and their cards never '
            + 'reach AI Dungeon. Pick one spelling.',
        },
      );
    }
  }

  return { resolve, finish };
}

/** Codes this module reports. CL04xx is the render/template band (§4.4). */
const CODES = {
  NOTES_TEMPLATE_NOT_FOUND: 'CL0411',
  ITEM_NOTES_TEMPLATE_NOT_FOUND: 'CL0412',
};

/**
 * Check every `render.notesTemplate` declared in compile.yaml against the loaded set.
 *
 * At load rather than at render, because this one is a closed set — the root node and
 * every branch node, all known before a single card is compiled. Left to render time it
 * would report once per item per leaf, which for a project like The Institute means the
 * same typo printed thousands of times.
 */
function checkConfigNotesTemplates(config, templates, diagnostics, configPath, fieldTable) {
  if (!diagnostics) return;
  const fieldListTemplates = (fieldTable && fieldTable.templates) || {};

  const check = (node, where) => {
    const name = node && node.render && node.render.notesTemplate;
    if (!name || templates.has(String(name).toLowerCase()) || fieldListTemplates[String(name)]) return;
    diagnostics.error(
      CODES.NOTES_TEMPLATE_NOT_FOUND,
      `${where} declares render.notesTemplate "${name}", which is not a loaded template.`,
      { file: configPath },
      { hint: 'Add a matching .template file, or remove the key to fall back to rendering '
        + 'the notes value itself. Use `notesTemplate: ~` to turn notes off for a branch.' },
    );
  };

  // The walker covers the project root too (Phase 11 Step 0); the old
  // `check(config, 'The project')` rung lives in the `isRoot` arm, byte-for-byte.
  walkBranchTree(config, ({ node, path: path_, isRoot }) => {
    check(node, isRoot ? 'The project' : `Branch "${path_.join('/')}"`);
  });
}

/**
 * Render `notes:` through the resolved notes template, or return undefined (§4.5).
 *
 * Undefined rather than an empty string, because the two mean different things to the
 * emitter: undefined leaves §4.5's default rule in force (scalar verbatim, mapping as
 * `key: value` lines), while an empty string is a template that deliberately produced
 * nothing and suppresses the `notes:` line entirely. That is what lets one shared
 * template carry a whole convention: `{if $notes.known}[e]{/if}` writes nothing at all
 * for an item that never set the flag, so opting out needs no syntax.
 *
 * The wrapper is forced off for this render. `render.wrapper` describes the card body;
 * a notes template that did not spell out a {wrapper} block would otherwise be wrapped
 * by the post-render fallback and emit `notes: '{...}'`.
 */
function renderNotesText(item, context, templates, partials, variables, projectNotesTemplate, diagnostics, extra = {}) {
  const { fieldTable = { templates: {} }, templateFor = {} } = extra;
  const resolved = resolveNotesRender(
    item, templates, fieldTable, projectNotesTemplate, templateFor,
  );
  if (!resolved) return undefined;

  if (resolved.kind === 'missing') {
    // Only rung 1 reaches here — the project/branch `render.notesTemplate` name is
    // existence-checked at load (`CL0411`), so a missing name came from the item.
    const label = item.id || (typeof item.name === 'string' ? item.name : String(item.name));
    if (diagnostics) {
      diagnostics.error(
        CODES.ITEM_NOTES_TEMPLATE_NOT_FOUND,
        `item "${label}" declares render.notesTemplate "${resolved.name}", which is not a loaded template.`,
        { file: item._source },
      );
    }
    return undefined;
  }

  const notesContext = { ...context, render: { ...context.render, wrapper: 'none' } };
  if (resolved.kind === 'fieldList') {
    return renderFieldList(resolved.list, fieldTable, notesContext, {
      diagnostics, file: null, name: resolved.name, partials, variables, refRoot: resolved.refRoot || 'notes',
    });
  }
  return render(resolved.entry.content, notesContext, partials, variables, {
    diagnostics, file: resolved.entry._source, name: resolved.name,
  });
}

/**
 * The name of the template that renders this item's body: render.template, then aid.type.
 *
 * Returns the name rather than the content because `resolveBodyRender` and the notes
 * ladder need the name that actually resolved the body — the same answer `getTemplate`
 * reached — rather than a second guess.
 */
function getTemplateName(item, templates) {
  const keys = [
    item.render && item.render.template,
    item.aid && item.aid.type,
  ].filter(Boolean);
  for (const key of keys) {
    if (templates.has(key.toLowerCase())) return key;
  }
  return null;
}

/**
 * Get the template entry for an item. Checks render.template first, then aid.type.
 *
 * Returns the `{content, _source}` entry rather than the content string alone (Phase 9
 * Step 0) — `_source` is what lets a render-time diagnostic name the template file instead
 * of reporting a parse or eval failure with nowhere to point.
 */
function getTemplate(item, templates) {
  const name = getTemplateName(item, templates);
  return name ? templates.get(name.toLowerCase()) : null;
}

// ── templateFor: rendering roles, branch-addressable (§13.4, Phase 12) ─────────

/**
 * Find one `templateFor` slot file on the templates search path.
 *
 * A slot value is a bare basename (`terse.cl.yaml`), a `{%tok}`-expanded relative path, or
 * an absolute path. Bare names are matched against each resolved templates directory in
 * turn; `config._resolvedTemplates` has already been redirected through the snapshot where
 * one exists, so a slot file inside a frozen library directory freezes with it.
 */
function findTemplateForFile(spec, templateDirs, base) {
  const s = String(spec);
  if (path.isAbsolute(s) && fs.existsSync(s)) return s;
  const rel = path.resolve(base, s);
  if (fs.existsSync(rel)) return rel;
  for (const dir of templateDirs) {
    const p = path.join(dir, s);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolve a branch-merged `templateFor` map (`{ role: file | [files] }`) into
 * `{ role: { <aid.type>: <field list> } }`.
 *
 * Each slot's files are read for their `templates:` namespace and merged left to right; the
 * `fields:`/`groups:` of a slot file are not folded in — a role file reselects which fields
 * a type shows, and the field declarations themselves stay single-sourced in
 * `fields.cl.yaml` (§13.5: the table is not branch-addressable).
 */
function resolveTemplateForMaps(slots, templateDirs, base, variables, diagnostics, configPath) {
  const roleMaps = {};
  for (const [role, spec] of Object.entries(slots || {})) {
    if (spec === null || spec === undefined) continue;
    const files = Array.isArray(spec) ? spec : [spec];
    const merged = {};
    for (const file of files) {
      const expanded = resolveVariables(String(file), variables);
      const abs = findTemplateForFile(expanded, templateDirs, base);
      if (!abs) {
        if (diagnostics) {
          diagnostics.error(
            LOAD_CODES.PATH_NOT_FOUND,
            `templateFor.${role} names "${file}", which was not found on the templates search path.`,
            { file: configPath },
          );
        }
        continue;
      }
      let doc;
      try {
        doc = loadYaml(abs);
      } catch (err) {
        if (diagnostics) {
          diagnostics.error(FIELD_TABLE_CODES.FIELD_TABLE_MALFORMED,
            `Could not parse templateFor.${role} file ${path.basename(abs)}: ${err.message}`, { file: abs });
        }
        continue;
      }
      if (doc && doc.templates && typeof doc.templates === 'object') {
        Object.assign(merged, doc.templates);
      }
    }
    roleMaps[role] = merged;
  }
  return roleMaps;
}

/**
 * Every field list a project's `templateFor` slot files produce, across the branch tree —
 * `[{ branch, role, name, list }]`, one row per `<role>.<name>` a node's slot files define.
 *
 * One walk of the tree rather than per leaf: the slot files resolve per node, but both
 * consumers — the `--schema-tables` report (§13.8) and the field audit's dead-declaration
 * sweep (§13.6, CL0428) — want the whole-project set. Empty for a project that declares no
 * `templateFor:`. `diagnostics` is null here: a bad slot path is reported by the leaf
 * loop's own `resolveTemplateForMaps` call.
 */
function gatherTierTemplates(config, configPath) {
  const variables = config._variables || config.variables || {};
  const rows = [];
  walkBranchTree(config, ({ node, path: nodePath, isRoot }) => {
    if (!node || !node.templateFor) return;
    const maps = resolveTemplateForMaps(
      node.templateFor, config._resolvedTemplates || [], config._base || '.',
      variables, null, configPath,
    );
    for (const [role, typeMap] of Object.entries(maps)) {
      for (const [name, list] of Object.entries(typeMap)) {
        rows.push({ branch: isRoot ? '(root)' : nodePath.join('/'), role, name, list });
      }
    }
  });
  return rows;
}

/**
 * Case-insensitive lookup of a name in a `templateFor` role map.
 *
 * A slot file's `templates:` keys are usually `aid.type` names, but nothing stops one from
 * being a free-standing name a single item selects with `render.template` to opt back into
 * a fuller list on a tiered branch (§13.4 Pattern 2). This is the only path that reaches
 * those names — `lookupNamedTemplate` sees the shared field table, never the slot maps.
 */
function lookupSlotList(name, map) {
  if (!name || !map) return null;
  if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
  const lower = String(name).toLowerCase();
  const key = Object.keys(map).find((k) => k.toLowerCase() === lower);
  return key ? map[key] : null;
}

/** A named template, resolved to text entry or field list, ignoring the type→template map. */
function lookupNamedTemplate(name, templates, fieldTable) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  if (templates.has(lower)) return { kind: 'text', entry: templates.get(lower), name: String(name) };
  const ft = fieldTable && fieldTable.templates;
  if (ft) {
    // Field-list names match case-insensitively too. The text branch above already
    // lowercases, so a consumer that lowercases a name before calling (the notes ladder,
    // `renderPlacementBody`) must not miss a field-list template on case alone.
    const key = Object.prototype.hasOwnProperty.call(ft, name)
      ? name
      : Object.keys(ft).find((k) => k.toLowerCase() === lower);
    if (key) return { kind: 'fieldList', list: ft[key], name: String(name) };
  }
  return null;
}

/**
 * Is a `render.template` / component-target `template:` value an authorial choice, or the
 * `model/item.js` normaliser fill?
 *
 * `model/item.js` fills `render.template` (`:280`) and a component target's `template:`
 * (`:384`) with `aid.type` for every card that names neither, and every type has a
 * shared-table field list of its own name — so a resolver rung that honoured that fill
 * would shadow a branch's `templateFor.*` map for the whole corpus. Fix A removed that from
 * the body ladder in Phase 13; Phase 14 Step 0 extends the same guard to the component-target
 * ladder. A value equal to `aid.type` (case-insensitively) is treated as absent; anything
 * else — a cross-type name, `Character.hint`, or a Pattern-2 name a branch slot file defines
 * (§13.4) — is a real choice and wins at rung 1.
 *
 * The notes ladder needs no call here: nothing fills `render.notesTemplate`, so its rung 1
 * already fires only on a real choice.
 */
function isTemplateChoice(name, type) {
  if (!name) return false;
  return String(name).toLowerCase() !== String(type || '').toLowerCase();
}

/**
 * The body ladder (§13.4): a *chosen* item `render.template` → `templateFor.base` keyed on
 * `aid.type` → `aid.type` as a template name → verbatim (null).
 *
 * Returns `{ kind: 'text', entry, name } | { kind: 'fieldList', list, name } | null`. With
 * no field table and no `templateFor`, this is `getTemplate` exactly — the two extra rungs
 * only ever fire once a project declares one or the other.
 *
 * **A `render.template` equal to `aid.type` is not a choice** — see `isTemplateChoice`. It is
 * treated as absent, so rung 3 renders the type's default and a tiered branch's rung 2 takes
 * effect.
 */
function resolveBodyRender(item, templates, fieldTable, templateForMaps) {
  const type = item.aid && item.aid.type;
  const baseMap = (templateForMaps && templateForMaps.base) || {};

  const explicit = item.render && item.render.template;
  if (isTemplateChoice(explicit, type)) {
    const slot = lookupSlotList(explicit, baseMap);
    if (slot) return { kind: 'fieldList', list: slot, name: String(explicit) };
    const hit = lookupNamedTemplate(explicit, templates, fieldTable);
    if (hit) return hit;
  }
  if (type && baseMap[type]) return { kind: 'fieldList', list: baseMap[type], name: type };
  if (type) {
    const hit = lookupNamedTemplate(type, templates, fieldTable);
    if (hit) return hit;
  }
  return null;
}

/**
 * The notes ladder (§4.5.1, §13.4 end state — three rungs): item `render.notesTemplate` →
 * the branch-addressable notes default (`templateFor.notes` keyed on `aid.type`, then the
 * merged `render.notesTemplate` scalar) → §4.5's default rendering (null).
 *
 * The `<body template>.notes` filename-suffix rung was removed in Phase 13 (Decision 5):
 * it activated a renderer by filename with no declaration, `templateFor.notes` is its
 * branch-addressable replacement, and no corpus project ever named a `*.notes` template.
 */
function resolveNotesRender(item, templates, fieldTable, projectNotesTemplate, templateForMaps) {
  const explicit = item.render && item.render.notesTemplate;
  if (explicit) {
    const hit = lookupNamedTemplate(explicit, templates, fieldTable);
    return hit || { kind: 'missing', name: String(explicit) };
  }
  const type = item.aid && item.aid.type;
  const notesMap = (templateForMaps && templateForMaps.notes) || {};
  if (type && notesMap[type]) {
    return { kind: 'fieldList', list: notesMap[type], name: `templateFor.notes[${type}]`, refRoot: 'notes' };
  }
  if (projectNotesTemplate) {
    const hit = lookupNamedTemplate(projectNotesTemplate, templates, fieldTable);
    return hit || { kind: 'missing', name: String(projectNotesTemplate) };
  }
  return null;
}

/**
 * Resolve opening content: file path → read file; otherwise use as inline text.
 */
function resolveOpeningContent(opening, base, variables) {
  const expandedSpec = variables ? resolveVariables(String(opening), variables) : String(opening);
  const resolved = path.resolve(base, expandedSpec);
  let content;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    content = fs.readFileSync(resolved, 'utf8').trimEnd();
  } else {
    content = expandedSpec.trimEnd();
  }
  return variables ? resolveVariables(content, variables) : content;
}

/**
 * Resolve a component spec (a file path, or literal text) against branch-merged variables.
 *
 * Returns null for an absent spec, an absolute path when the spec names a file that
 * exists, and otherwise the literal string — `opening:` and `branchFraming:` are often a
 * sentence rather than a path, and that fallback is what lets one key carry both.
 *
 * **The literal arm returns the *expanded* string, not the raw one.** An inline spec is
 * content, and content has its variables expanded like any other text — returning the raw
 * spec left `opening: 'You wake in {%place}.'` carrying a live token past this point, where
 * the caller's unresolved-reference check reads any surviving `{` as a path that failed to
 * expand and records a component gap. A token that genuinely does not resolve still survives
 * `expandTokens` and still reaches that check, so the reporting is unchanged for the case it
 * was written for.
 */
function resolveComponentSpec(spec, base, variables) {
  if (spec == null) return null;
  let resolved = spec;
  if (typeof resolved === 'string') {
    resolved = expandTokens(resolved, { variables });
  }
  // Try resolving as file or directory path
  const filePath = path.resolve(base, String(resolved));
  if (fs.existsSync(filePath)) return filePath;
  return resolved;
}

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
 * Write compiled items to output directory.
 * One .md file per item type: Story Cards/{type}/{type}.md
 */
function writeOutput(outputDir, type, renderedItems) {
  const typeDir = path.join(outputDir, 'Story Cards', type);
  fs.mkdirSync(typeDir, { recursive: true });
  const outputPath = path.join(typeDir, `${type}.md`);
  fs.writeFileSync(outputPath, renderedItems.join('\n\n') + '\n', 'utf8');
  return outputPath;
}

/**
 * Delete Story Cards, Components, Scripts subdirs and Label.md from a branch output dir.
 */
function cleanBranchOutputDir(dir) {
  for (const sub of ['Story Cards', 'Components', 'Scripts']) {
    const target = path.join(dir, sub);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
  for (const file of ['Label.md', PLACEHOLDERS_FILENAME]) {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) fs.rmSync(target);
  }
}

/**
 * Every branch *node* dir on disk beneath a `Branches/` container, deepest first.
 *
 * Was `findLeafDirsOnDisk`, which stopped at leaves. An interior node is a node: it owns
 * a `Label.md` and, since Phase 4, a `Placeholders.yaml`, and Velvet Lattice reads both
 * and inherits them down the subtree. A sweep that only sees leaves cannot clean an
 * interior node and cannot tell that one has gone stale.
 *
 * Deepest first so a caller removing empty directories meets a child before its parent.
 */
function findNodeDirsOnDisk(dir) {
  if (!fs.existsSync(dir)) return [];
  const nodes = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    nodes.push(...findNodeDirsOnDisk(path.join(child, 'Branches')));
    nodes.push(child);
  }
  return nodes;
}

/**
 * Every node dir from `leafDir` up to and including `baseOutput`.
 *
 * The `Branches` containers between them are skipped: they hold nodes and are not nodes,
 * so they carry no `Label.md` and nothing to clean.
 */
function nodeDirsUpTo(leafDir, baseOutput) {
  const chain = [];
  let current = path.resolve(leafDir);
  const stop = path.resolve(baseOutput);
  while (current.length >= stop.length) {
    if (path.basename(current) !== 'Branches') chain.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

function isDirEmpty(dir) {
  if (!fs.existsSync(dir)) return true;
  return fs.readdirSync(dir).length === 0;
}

/**
 * Pre-build clean: wipe output-type folders from every active branch node, then detect
 * and archive (or delete) any stale node on disk.
 *
 * **Nodes, not leaves.** This swept only leaf directories until Phase 4 raised it: a
 * declaration deleted from an interior node — its `Placeholders.yaml`, or the `Label.md`
 * that has the same shape and predates placeholders — survived in the output tree, and
 * Velvet Lattice went on reading it and inheriting it down the subtree. The compiler
 * rewrites what it emits, so only a key that stopped being emitted was affected, which is
 * exactly the edit an author makes when they mean to remove one.
 *
 * The root is a node too, and had the same hole: it was added to the expected set only
 * for a project with no branches at all, so a branched project's root `Label.md` and
 * `Placeholders.yaml` were never swept either.
 *
 * Ancestors of an expected leaf are expected, which gives the stale pass an invariant it
 * needs: a stale node can never contain a live descendant, so archiving one whole is safe.
 */
function cleanAndArchive(config, leaves) {
  const baseOutput = config._resolvedOutput;

  const expectedDirs = new Set();
  for (const branchPath of leaves) {
    const folderPath = resolveBranchFolderPath(config.branches, branchPath);
    const leafDir = buildBranchOutputDir(baseOutput, folderPath);
    for (const dir of nodeDirsUpTo(leafDir, baseOutput)) expectedDirs.add(dir);
  }
  expectedDirs.add(path.resolve(baseOutput));

  for (const dir of expectedDirs) {
    cleanBranchOutputDir(dir);
    console.log(`  Cleaned: ${path.relative(baseOutput, dir) || '(root)'}`);
  }

  const branchesRoot = path.join(baseOutput, 'Branches');
  const diskNodes = findNodeDirsOnDisk(branchesRoot);
  const stale = diskNodes.filter(d => !expectedDirs.has(path.resolve(d)));
  if (stale.length === 0) return;

  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  const archiveBase = path.join(baseOutput, 'Archive', ts);

  for (const staleDir of stale) {
    cleanBranchOutputDir(staleDir);
    // `stale` is deepest first, so a stale node's own stale children have already been
    // dealt with by the time it is reached — leaving behind an empty `Branches` container
    // that would otherwise read as content and get the node archived as a hollow shell.
    const container = path.join(staleDir, 'Branches');
    if (fs.existsSync(container) && isDirEmpty(container)) fs.rmSync(container, { recursive: true });
    if (isDirEmpty(staleDir)) {
      fs.rmSync(staleDir, { recursive: true, force: true });
      console.log(`  Removed empty stale branch: ${path.relative(baseOutput, staleDir)}`);
    } else {
      const rel = path.relative(baseOutput, staleDir);
      const dest = path.join(archiveBase, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(staleDir, dest);
      console.log(`  Archived stale branch → Archive/${ts}/${rel}`);
    }
  }
}

/**
 * Build the output directory path for a branch leaf.
 */
function buildBranchOutputDir(baseOutput, branchPath) {
  if (branchPath.length === 0) return baseOutput;
  return path.join(baseOutput, ...branchPath.flatMap(b => ['Branches', b]));
}

/**
 * Resolve the output folder path for a branch identifier path.
 * Uses the internal key name (case-preserved from the YAML) for each folder segment.
 *
 * @param {object|null} branches - root branches mapping from config
 * @param {string[]}    idPath   - branch identifier path (e.g. ['tier2', 'alpha'])
 * @returns {string[]}           - folder name path (e.g. ['tier2', 'alpha'])
 */
function resolveBranchFolderPath(branches, idPath) {
  return walkBranchChain(branches, idPath).folderPath;
}

/**
 * True when any branch node anywhere below the root satisfies `predicate` — used by the
 * Phase 11 Step 4 inheritance pass to check whether a component key or `scripts:` is
 * redeclared below the project root. A key declared only at the root can be written once
 * there and left for Velvet Lattice to inherit; a key some branch overrides has to be
 * resolved per leaf.
 */
function branchTreeDeclares(branches, predicate) {
  if (!branches || typeof branches !== 'object') return false;
  for (const node of Object.values(branches)) {
    if (!node || typeof node !== 'object') continue;
    if (predicate(node)) return true;
    if (branchTreeDeclares(node.branches, predicate)) return true;
  }
  return false;
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
  const { findFiles } = require('./loader');
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
 * The sections one `render.storyCards` entry (or `render.component`) renders (§7.8).
 *
 * Selection is a `sections:` subset (a plain key-filter over `rawSections`) then a `variant:`
 * fan-out (`applySectionSelector`, the same one `imports:` uses). The result is re-normalized
 * into a component the section renderer can take. The re-normalization runs `normalizeSection`
 * again, so its `onWarn` is a no-op here: load-time normalization already reported the base
 * sections' structure, and a selector only edits `text:`/`heading:`/`render:` — it cannot
 * introduce the slot/text conflict or the render-nothing case those checks catch. A `variant:`
 * that empties a section shows up instead as CL0625 on the entry, raised by the caller.
 *
 * `entrySections` is the entry's `sections:` list, or null for `render.component`.
 */
function selectComponentSections(component, variant, entrySections, onUnknownSection) {
  let raw = (component && component.rawSections) || {};

  if (Array.isArray(entrySections) && entrySections.length > 0) {
    const want = new Set(entrySections.map((s) => String(s).toLowerCase()));
    const picked = {};
    const got = new Set();
    for (const [name, def] of Object.entries(raw)) {
      if (want.has(name.toLowerCase())) { picked[name] = def; got.add(name.toLowerCase()); }
    }
    for (const s of entrySections) {
      if (!got.has(String(s).toLowerCase()) && onUnknownSection) onUnknownSection(s);
    }
    raw = picked;
  }

  if (typeof variant === 'string' && variant.trim() !== '') {
    raw = applySectionSelector(raw, variant.trim()).sections;
  }

  return normalizeComponent({ sections: raw, branches: component && component.branches }, {});
}

/**
 * §7.8 — a component's `render.storyCards` entries, rendered for one leaf.
 *
 * Each entry renders the component again — a `variant:` selector, a `sections:` subset, or
 * both, with the leaf's slot occupants in place — and is emitted as a trigger-less
 * `kind: reference` story card: the rendered component text as the `notes:` payload, a
 * one-line orienting string as the body. The cards are appended to `grouped` (the leaf's
 * `renderBranchItems` card map) so Phase 11 frontier placement writes them like any other
 * card, keyed on `(type, name)`.
 *
 * The card's AID `type` resolves on §7.8's three-rung ladder: the entry's own `type:`, then
 * `storyCardType[<component key>]` from compile.yaml, then the component's display label.
 *
 * `CL0622` is checked here rather than inherited from `renderBranchItems`: these cards are
 * built after that function returns, so its `seenNames` set never sees them. The check reads
 * the names already in `grouped` (the real cards) plus the entries emitted so far.
 */
function renderComponentStoryCards(component, descriptor, branchPath, filled, grouped, options) {
  const {
    variables = {}, registry, branchProtagonist, roles = null, onRoleUsed = null,
    diagnostics, questions = null, storyCardType = null, spec, branchLabel = '(root)',
    cardTypeAudit = null,
  } = options;

  const entries = component && component.render && Array.isArray(component.render.storyCards)
    ? component.render.storyCards : [];
  if (entries.length === 0) return;

  const loc = { file: String(spec) };
  const projectType = (storyCardType && typeof storyCardType === 'object')
    ? storyCardType[descriptor.key] : null;

  // Names already taken on this leaf, per type — the real cards, then each entry as it lands.
  const takenByType = new Map();
  for (const [type, cards] of grouped) {
    takenByType.set(type, new Set(cards.map((c) => c.name)));
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (title === '') {
      diagnostics.error(
        DIAG_CODES.STORY_CARD_ENTRY_NO_TITLE,
        `a render.storyCards entry on component "${descriptor.label}" declares no title: — `
        + 'the title is the card\'s AID name and its place in the frontier index.',
        loc,
      );
      continue;
    }

    const rawCardType = (typeof entry.type === 'string' && entry.type.trim() !== '' && entry.type.trim())
      || (typeof projectType === 'string' && projectType.trim() !== '' && projectType.trim())
      || descriptor.label;
    // §7.8's cards land in the same `Story Cards/{type}/` tree as every other card, so they
    // take the same normalization — otherwise a component declaring `type: Character` would
    // reopen the collision this closes everywhere else.
    const cardType = cardTypeAudit ? cardTypeAudit.resolve(rawCardType, loc) : rawCardType;

    const sub = selectComponentSections(
      component,
      typeof entry.variant === 'string' ? entry.variant : null,
      entry.sections,
      (name) => diagnostics.warn(
        DIAG_CODES.STORY_CARD_ENTRY_UNKNOWN_SECTION,
        `render.storyCards entry "${title}" names section "${name}", which component `
        + `"${descriptor.label}" does not declare — it is dropped from this entry.`,
        loc,
      ),
    );

    const { text: notesText } = renderSectionedComponent(sub, branchPath, filled, {
      defaultHeadingLevel: descriptor.defaultHeadingLevel,
      variables, registry, branchProtagonist, roles, onRoleUsed,
      onWarn: busWarner(diagnostics, loc),
    });

    if (!notesText || notesText.trim() === '') {
      diagnostics.warn(
        DIAG_CODES.STORY_CARD_ENTRY_RENDERS_NOTHING,
        `render.storyCards entry "${title}" renders no text on branch "${branchLabel}" — `
        + 'its variant:/sections: selectors left nothing. No card is written.',
        loc,
      );
      continue;
    }

    if (!takenByType.has(cardType)) takenByType.set(cardType, new Set());
    if (takenByType.get(cardType).has(title)) {
      diagnostics.error(
        DIAG_CODES.CARD_NAME_COLLISION,
        `story cards named "${title}" collide on branch "${branchLabel}" (both as ${cardType}). `
        + 'Velvet Lattice merges story cards by name, so only one survives to AID. '
        + 'Give them distinct names.',
        loc,
      );
      continue;
    }
    takenByType.get(cardType).add(title);

    const body = `${title} — copy the description field below into your scenario's ${descriptor.label}.`;
    const synthetic = { kind: 'reference', name: title, aid: { type: cardType, title } };
    const rendered = renderCard({
      item: synthetic, bodyText: body, notesText, diagnostics, loc, questions,
    }).text;

    if (!grouped.has(cardType)) grouped.set(cardType, []);
    grouped.get(cardType).push({
      sortKey: title.toLowerCase(), rendered, id: null, name: title,
    });
  }
}

/**
 * Resolve every sectioned component declared for this leaf, ahead of the items.
 *
 * Returns one entry per component that loaded, in `SLOTTED_COMPONENTS` order. A component
 * that cannot be found is recorded as a gap and omitted — the gap report already says a
 * requested component produced no file, and adding a placement ERROR for every item that
 * named one of its slots would bury that one fact under a per-item pile.
 */
function resolveSectionedComponents(compileContext, label, { loadSectioned, recordGap }) {
  const resolved = [];
  for (const descriptor of SLOTTED_COMPONENTS) {
    const spec = compileContext.componentRefs[descriptor.key];
    if (!spec) continue;
    if (typeof spec === 'string' && spec.includes('{')) {
      recordGap(label, descriptor.label, spec, 'unresolved reference — token did not expand to a path');
      continue;
    }

    // An opening is routinely a sentence rather than a path — `opening: "Who are you?"` —
    // and `resolveComponentSpec` hands back the raw string when nothing on disk matches.
    // Only the rows that declare `inlineProse` take that reading: for every other component
    // a spec naming no file is a broken path, and treating it as content would write the
    // path into the output instead of reporting it.
    if (descriptor.inlineProse && !(typeof spec === 'string' && fs.existsSync(spec))) {
      // Already variable-expanded by `resolveComponentSpec`; only trimmed here.
      const text = String(spec).trimEnd();
      if (!text) {
        recordGap(label, descriptor.label, spec, 'inline text is empty');
        continue;
      }
      resolved.push({ descriptor, spec, component: null, passthrough: text });
      continue;
    }

    // Prose copied verbatim, not a document to compile. It declares no sections and so no
    // slots, which is a fact the slot index needs — an item targeting a slot in a `.md`
    // component would otherwise be dropped in silence.
    if (isPassthrough(spec)) {
      if (!fs.existsSync(spec)) {
        recordGap(label, descriptor.label, spec, 'source not found');
        continue;
      }
      const text = readPassthrough(spec);
      if (text === null) {
        recordGap(label, descriptor.label, spec, 'source is empty');
        continue;
      }
      resolved.push({ descriptor, spec, component: null, passthrough: text });
      continue;
    }

    const component = loadSectioned(spec, descriptor);
    if (!component) {
      recordGap(label, descriptor.label, spec, 'source declared no sections (missing or empty file)');
      continue;
    }
    resolved.push({ descriptor, spec, component, passthrough: null });
  }
  return resolved;
}

/**
 * What a render target on this branch is allowed to name.
 *
 * Three sets, because §7.4 asks three different questions of a target's `slot:` and gives
 * three different answers. `slots` is what this branch will actually place into.
 * `documentSlots` is every slot the document declares, branch gating ignored — a slot
 * gated off on this branch is correctly spelled and must not be reported as a typo, which
 * is the whole content of §7.4's third and fifth rows. `sections` is every name in the
 * document, so naming a text section can be told apart from naming nothing at all. All
 * three are keyed lowercased, matching how `renderSectionedComponent` looks occupants up.
 *
 * A component key absent from this index is one that failed to load. Targets naming it are
 * left alone: the gap report owns that failure.
 */
function buildSlotIndex(sectionedForLeaf, branchPath) {
  const index = new Map();
  for (const { descriptor, component, passthrough } of sectionedForLeaf) {
    if (passthrough !== null && passthrough !== undefined) {
      index.set(descriptor.key, {
        slots: new Map(), documentSlots: new Set(), sections: new Set(),
        label: descriptor.label, passthrough: true,
      });
      continue;
    }
    const slots = new Map();
    for (const [name, section] of slotsForBranch(component, branchPath)) {
      slots.set(name.toLowerCase(), section);
    }
    const documentSlots = new Set(
      component.sections.filter((s) => s.isSlot).map((s) => s.name.toLowerCase()),
    );
    const sections = new Set(component.sections.map((s) => s.name.toLowerCase()));
    index.set(descriptor.key, {
      slots, documentSlots, sections, label: descriptor.label, passthrough: false,
    });
  }
  return index;
}

/**
 * Check one render target against the branch's slot set (§7.4).
 *
 * Returns true when the target may be placed. The three refusals are all ERRORs and all
 * name the item, because each is a typo class that otherwise ends as silence: v3 filed an
 * occupant under a slot key no section matched and dropped it, which made a misspelled
 * `slot:` and a deliberately excluded item indistinguishable in the output.
 *
 * A slot the component declares but this branch gates off is *not* one of them — §7.4's
 * third and fifth rows keep component-level gating legitimate, and the consequence of
 * gating it away is caught by the no-output invariant instead.
 */
function checkTargetSlot(target, itemId, slotIndex, label, diagnostics, file) {
  const known = slotIndex.get(target.component);
  if (!known) return true;

  if (known.passthrough) {
    diagnostics.error(
      DIAG_CODES.TARGET_UNDECLARED_SLOT,
      `item "${itemId}" targets slot "${target.slot || '(unnamed)'}" in ${known.label}, which is `
      + 'prose copied verbatim and declares no slots. Point the component at a YAML '
      + 'document with "sections:" to route items into it.',
      { file },
    );
    return false;
  }

  if (!target.slot) {
    diagnostics.error(
      DIAG_CODES.TARGET_NAMES_NO_SLOT,
      `item "${itemId}" renders into ${known.label} without naming a slot — `
      + `add "slot:" naming one of: ${[...known.documentSlots].join(', ') || '(the component declares none)'}.`,
      { file },
    );
    return false;
  }

  const key = target.slot.toLowerCase();
  // Active on this branch, or declared and gated off on it. The second places nothing and
  // says nothing — the name is right, and whether losing the placement matters is the
  // no-output invariant's question rather than this one's.
  if (known.documentSlots.has(key)) return true;

  if (known.sections.has(key)) {
    diagnostics.error(
      DIAG_CODES.TARGET_NOT_A_SLOT,
      `item "${itemId}" targets "${target.slot}" in ${known.label}, which is a section but `
      + 'not a slot — only a section declaring "slot: true" can hold items.',
      { file },
    );
    return false;
  }

  diagnostics.error(
    DIAG_CODES.TARGET_UNDECLARED_SLOT,
    `item "${itemId}" targets slot "${target.slot}" in ${known.label} on branch "${label}", `
    + `which declares no such slot. Declared here: ${[...known.documentSlots].join(', ') || '(none)'}.`,
    { file },
  );
  return false;
}

/**
 * A declared slot that no item filled on this branch (§7.4) — a WARN, not an error.
 *
 * An empty cast is a legitimate branch. The warning exists because an empty slot and a
 * slot whose occupants all mis-typed their `slot:` look identical in the output file, and
 * the second is worth a line on the way past.
 */
function warnEmptySlots(descriptor, slotIndex, filled, label, diagnostics, file) {
  const known = slotIndex.get(descriptor.key);
  if (!known) return;
  for (const name of known.slots.keys()) {
    const placed = filled.get(name);
    if (placed && placed.length > 0) continue;
    // Located at the component that declared the slot, not at the item that failed to
    // fill it — there is no such item, which is the whole finding. §4.4's "every
    // diagnostic names a file" otherwise has one exception, and an author reading
    // "slot X has no items" with no path has to guess which component declared X.
    diagnostics.warn(
      DIAG_CODES.SLOT_EMPTY,
      `slot "${name}" in ${known.label} has no items on branch "${label}".`,
      { file: file == null ? undefined : String(file) },
    );
  }
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
 * The placeholder table as Velvet Lattice will hold it at this node, for §8.5's caps.
 *
 * VL substitutes `%key%` with the *question*, so measuring the stored length needs the
 * questions and needs them already nested — which is what `expandQuestions` produces and
 * what `Placeholders.yaml` therefore contains (§12.2). Expanding the merged table here
 * gives the same values a leaf's inherited chain of those files would.
 *
 * Deliberately given no `onWarn`: `writePlaceholdersRecursive` runs the same expansion
 * with the bus attached, so passing one here would report every cycle and every undeclared
 * nested reference a second time. This call wants the strings, not the findings.
 */
function questionsForMeasurement(table, variables) {
  if (!table || Object.keys(table).length === 0) return null;
  return expandQuestions(table, variables);
}

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

/**
 * The fixed keys `itemContext` (`util.js`) attaches to every item's render context. A render
 * function's first path segment matching one of these resolves against the *current* item —
 * `resolveField`'s (`render/eval.js`) itemMap pivot only fires when the segment matches
 * neither this set nor the current item, so the dependency graph below must exclude them the
 * same way or it would draw an edge for every plain `$body.x` reference.
 */
const ITEM_CONTEXT_KEYS = new Set(['id', 'name', 'pronouns', 'aid', 'render', 'body', 'v', 'notes']);

/**
 * The render-function call syntax `processFieldRenderFunctions` (`template.js`) dispatches on.
 * Derived from the canonical `FUNCTION_NAMES` (`render/parse.js`) so a new render function
 * is registered in exactly one place.
 */
const RENDER_FN_PREFIXES = FUNCTION_NAMES.map((n) => n + '(');

/**
 * Scan one item's body for cross-item render-function references (Phase 9 Step 2).
 *
 * An edge exists only when a render function's *first* path segment names another item —
 * exactly the case `resolveField`'s itemMap pivot resolves — so this scan has to mirror that
 * pivot's rule precisely rather than approximate it, or the graph would draw edges the
 * evaluator never actually chases (or miss ones it does). Plain `{$Other.body.X}` field
 * substitutions are `applyCrossItemRefs`'s pass, a different token family already resolved
 * before this runs, and are not scanned here.
 *
 * Returns `[{ target, field }]` — `target` the referenced item's lowercase id, `field` the
 * dotted body path the reference was found in, for `CL0418`'s message.
 */
function scanCrossItemRefs(body, resolvedById, selfId) {
  const refs = [];
  const scanString = (str, fieldPath) => {
    str.replace(/\{([^{}]+)\}/g, (match, inner) => {
      inner = inner.trim();
      if (!RENDER_FN_PREFIXES.some((prefix) => inner.startsWith(prefix))) return match;
      const tokens = inner.match(/\$[A-Za-z0-9_-]+/g) || [];
      for (const token of tokens) {
        const first = normalizeVarKey(token.slice(1)).toLowerCase();
        if (ITEM_CONTEXT_KEYS.has(first)) continue;
        if (first === selfId) continue;
        if (!resolvedById.has(first)) continue;
        refs.push({ target: first, field: fieldPath });
      }
      return match;
    });
  };
  const walk = (obj, fieldPath) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const nextPath = fieldPath ? `${fieldPath}.${key}` : key;
      if (typeof val === 'string') {
        scanString(val, nextPath);
      } else if (Array.isArray(val)) {
        for (const entry of val) {
          if (typeof entry === 'string') scanString(entry, nextPath);
        }
      } else if (typeof val === 'object' && val !== null) {
        walk(val, nextPath);
      }
    }
  };
  walk(body, '');
  return refs;
}

/**
 * Tarjan's SCC over the cross-item dependency graph. Returns only the multi-node groups —
 * every genuine cycle — because a single-node SCC is acyclic by construction once self-loops
 * are excluded from the graph (Decision 3's Unknowns: self-reference is tolerated, not a
 * cycle, and `scanCrossItemRefs` never records one).
 */
function findCycles(graph) {
  let counter = 0;
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const groups = [];

  const strongconnect = (v) => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) || []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const group = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) groups.push(group);
    }
  };

  for (const v of graph.keys()) {
    if (!index.has(v)) strongconnect(v);
  }
  return groups;
}

/**
 * Post-order DFS topological order: a dependency is pushed onto `order` before the item that
 * depends on it, because it is fully visited (recursed into) first. Safe to run on a graph
 * that contains cycles — a node already on the current stack (`state === 1`) is skipped
 * rather than re-entered, so every node still resolves to exactly one position in `order`.
 * The caller excludes cyclic nodes from evaluation; their position in this order is otherwise
 * unused.
 */
function topoOrder(graph) {
  const state = new Map();
  const order = [];
  const visit = (node) => {
    if (state.has(node)) return;
    state.set(node, 1);
    for (const dep of graph.get(node) || []) {
      visit(dep);
    }
    state.set(node, 2);
    order.push(node);
  };
  for (const node of graph.keys()) visit(node);
  return order;
}

/** `CL0418`, naming every item and field on the cycle's edges rather than the uncoded warning it replaces. */
function reportCycle(group, edgeFields, resolvedById, diagnostics) {
  if (!diagnostics) return;
  const groupSet = new Set(group);
  const parts = [];
  for (const from of group) {
    for (const to of groupSet) {
      const key = `${from}->${to}`;
      const fields = edgeFields.get(key);
      if (!fields) continue;
      const fromItem = resolvedById.get(from);
      const toItem = resolvedById.get(to);
      for (const field of fields) {
        parts.push(`"${fromItem.id}".${field} → "${toItem.id}"`);
      }
    }
  }
  diagnostics.error(
    DIAG_CODES.CROSS_ITEM_CYCLE,
    `Circular cross-item render dependency: ${parts.join(', ')}`,
  );
}

/**
 * Dependency-ordered cross-item render-function resolution (v4 spec §13, Phase 9 Step 2).
 *
 * Replaces the fixpoint loop that iterated to convergence: build the dependency graph the
 * corpus's cross-item render functions imply, evaluate it in one topological pass, and report
 * a genuine cycle by name instead of an uncoded warning after N passes.
 *
 * A render function that migrates from item `B` into item `A` is evaluated in `B`'s context —
 * where the author wrote it — because `B` is resolved (and its body mutated in place) before
 * `A` ever reads it. This is Decision 3's divergence, and the one place in the phase whose
 * compiled output may legitimately move.
 */
function resolveCrossItemRenderFunctions(resolvedItems, resolvedById, diagnostics) {
  const graph = new Map();
  const edgeFields = new Map();

  for (const item of resolvedItems) {
    const idLower = (item.id || '').toLowerCase();
    if (!idLower) continue;
    const deps = graph.get(idLower) || new Set();
    graph.set(idLower, deps);
    if (!item.body) continue;
    for (const { target, field } of scanCrossItemRefs(item.body, resolvedById, idLower)) {
      deps.add(target);
      const key = `${idLower}->${target}`;
      if (!edgeFields.has(key)) edgeFields.set(key, new Set());
      edgeFields.get(key).add(field);
    }
  }

  const cyclic = new Set();
  for (const group of findCycles(graph)) {
    for (const id of group) cyclic.add(id);
    reportCycle(group, edgeFields, resolvedById, diagnostics);
  }

  for (const id of topoOrder(graph)) {
    // Left unexpanded: the item's leaked render-function text is caught downstream by the
    // output sweep's CL0432 LEAKED_RENDER_FUNCTION, per Decision 3's Unknowns — two reports,
    // both correct, rather than a guess at which side of the cycle to break.
    if (cyclic.has(id)) continue;
    const item = resolvedById.get(id);
    applyFieldRenderFunctions(item, resolvedById, { diagnostics, file: item._source });
  }
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
    // after all {%}/{$} passes, so it sees the final on-disk type. Aborts on invalid.
    validateCardType(item);


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
 * Copy scripts directory to target branch Scripts/ folder.
 */
function copyScripts(srcDir, targetDir) {
  if (!srcDir || !fs.existsSync(srcDir)) return;
  const dest = path.join(targetDir, 'Scripts');
  fs.cpSync(srcDir, dest, { recursive: true });
}

/**
 * Write Opening.md or Opening Choice.md to a branch node's Components folder.
 */
function writeComponentFile(outputDir, filename, content, sink) {
  const dir = path.join(outputDir, 'Components');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, filename);
  checkUnexpandedVariables(content, `component ${filename}`, sink);
  checkUnresolvedFieldTokens(content, `component ${filename}`, sink);
  checkMechanicalArtifacts(content, `component ${filename}`, sink);
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

/**
 * Write branch framing across the branch tree (§7.3).
 *
 * Framing is the only component that belongs to a *non-leaf* node — AID reads it as what
 * is shown while the player chooses among the children below it — which is why this uses
 * the tree visitor while every other component is written by the leaf loop. It lands in
 * `Opening.md`, the name a leaf's `opening:` uses, because Velvet Lattice reads a node's
 * prompt from that filename at every level.
 *
 * **The opening half of this walker moved into the leaf loop in Phase 6 Step 6.** An
 * `opening:` is an ordinary inherited component now, so the chain-merge this function used
 * to do by hand — `declaredOpening !== undefined ? … : state.inheritedOpening` — is what
 * `buildCompileContext` already does for every component. What is left here is the node
 * write the leaf loop genuinely cannot reach.
 *
 * **Phase 10 Step 4 threads roles and a resolved protagonist through the same state channel
 * `variables` and `table` already ride.** `walkBranchTree`'s visitor returns the state its
 * children inherit, so per-node `roles`/`branchProtagonist` need no change to that mechanism
 * — they merge into `state` exactly the way `branchVars`/`table` already do, via
 * `mergeUnbindable`, the same key-wise `~`-deleting merge `walkBranchChain` uses for roles
 * (`model/branches.js`), reused rather than reimplemented so the two cannot disagree.
 * `onRoleUsed`, the sink the leaf loop's `resolveRole` already calls on every successful
 * resolution, arrives as an input because this is a top-level function with no closure over
 * `compile()`'s scope. Neither is `roles` or `branchProtagonist` itself: those still ride
 * via state, computed fresh per node.
 *
 * **Phase 11 Step 0 walks the project root like every other node.** The walker takes the
 * root now, so the old hand-rolled root rung is gone: the root's own `branchFraming`
 * arrives through the visitor's `isRoot` arm, and `config.roles` / `config.placeholders`
 * are seeded by the root visit through the same merges the branch nodes use.
 */
function writeFramingRecursive(rootNode, outputBase, configBase, configPath, variables, verbose = false, diagnostics = null, usage = null, loadSectioned = null, registry = null, onRoleUsed = null) {
  // The walker visits the project root as a node (Phase 11 Step 0), so an unbranched
  // project still receives its root visit — that is where the "no branches" warn lands.
  if (!rootNode || typeof rootNode !== 'object') return;

  const renderFraming = (spec, nodePath, vars, table, name, roles, branchProtagonist) => {
    const resolvedSpec = resolveComponentSpec(spec, configBase, vars);
    const isFile = typeof resolvedSpec === 'string' && fs.existsSync(resolvedSpec)
      && fs.statSync(resolvedSpec).isFile();

    // Three shapes, the same three an opening has: a component document, a prose file, and
    // a literal sentence. Framing is a question far more often than it is a path, which is
    // why the literal arm is the common one here.
    if (isFile && !isPassthrough(resolvedSpec)) {
      const component = loadSectioned
        ? loadSectioned(resolvedSpec, FRAMING_DESCRIPTOR)
        : null;
      if (!component) return null;
      // An empty occupant map: framing sits at an interior node, and items are resolved per
      // leaf, so there is no cast here to route into it. Same call the scenario blurb makes.
      const { text } = renderSectionedComponent(component, nodePath, new Map(), {
        defaultHeadingLevel: FRAMING_DESCRIPTOR.defaultHeadingLevel,
        variables: vars, registry, branchProtagonist,
        roles, onRoleUsed,
        onWarn: busWarner(diagnostics, { file: String(resolvedSpec) }),
      });
      return text;
    }
    return resolveOpeningContent(spec, configBase, vars);
  };

  walkBranchTree(rootNode, ({ name, node, path: nodePath, isLeaf, isRoot, state }) => {
    const nodeOutput = isRoot ? state.outputBase : path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    const framing = node && node.components && node.components.branchFraming !== undefined
      ? node.components.branchFraming
      : null;

    const table = mergePlaceholders(state.table, node);

    // Roles merge the same way `walkBranchChain` merges them for the leaf loop — key-wise,
    // `~` deleting, `rolesDeclared` sticky once any ancestor (including the project root)
    // declares a `roles:` key at all, even if every binding it declared unbinds to nothing
    // (§9.3's CL0540 gating cares about that distinction, not just whether the merged table
    // is non-empty). No `onWarn` here, matching `mergePlaceholders` two lines above: this
    // walker has never surfaced per-node unbind warnings and Step 4 does not start now.
    const rolesDeclared = state.rolesDeclared || !!(node && node.roles);
    const roles = mergeUnbindable(state.roles, node && node.roles, {
      code: DIAG_CODES.ROLE_UNBIND_UNKNOWN, kind: 'role', onWarn: null,
    });
    // Same derivation the leaf loop uses (`chain.roles.protagonist`, resolved and
    // lowercased against the branch's own variables) — reading the merged table directly
    // rather than gating on `rolesDeclared` first, because an inherited protagonist is a
    // real binding whether or not *this* node is the one that declared `roles:`.
    const inheritedProtagonist = roles.protagonist || '';
    const branchProtagonist = resolveVariables(inheritedProtagonist, branchVars).toLowerCase() || null;

    if (framing != null) {
      if (isLeaf) {
        // The same rule at both levels: nothing below this node means nothing to frame.
        // The walker's root visit reaches the project rung here (Phase 11 Step 0), and
        // the message is the one the old root rung wrote.
        if (isRoot) console.warn(`  WARN: root branchFraming with no branches — ignoring`);
        else console.warn(`  WARN: branchFraming on leaf branch "${name}" — ignoring`);
      } else {
        // Phase 11 Step 1: the root renders through the same sectioned path an interior
        // node uses, rather than the literal/`{%variable}`-only `resolveOpeningContent`
        // the old hand-rolled rung called. That gains `sections:`, roles, `_variables`
        // (library names folded in, since `branchVars` descends from the seed the root
        // visit merged) and the undeclared-placeholder check, none of which the root ever
        // had before.
        const framingText = renderFraming(
          framing, nodePath, branchVars, table, name,
          rolesDeclared ? roles : null, branchProtagonist,
        );
        if (framingText) {
          checkUndeclaredPlaceholders(framingText, table, {
            diagnostics, where: isRoot ? 'the project root (framing)' : `the branch framing on "${name}"`,
            usage, usagePath: nodePath.join('/'),
          });
          // Framing lands in the same `Opening.md` filename at an interior node, and VL caps
          // the file rather than the chain — components merge per filename, so a leaf's
          // opening replaces this rather than adding to it (§8.5).
          checkLimit(framingText, questionsForMeasurement(table, branchVars), LIMITS.opening, {
            diagnostics, label: isRoot ? 'the project root (framing)' : `branch "${name}" (framing)`,
          });
          const outPath = writeComponentFile(nodeOutput, 'Opening.md', framingText, { diagnostics });
          if (verbose) console.log(isRoot ? `    OK: Root OpeningChoice → ${outPath}` : `    OK: BranchFraming → ${outPath}`);
        }
      }
    }

    return {
      outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
    };
  }, {
    // Seeded empty: the walker visits the project root first, and the root's own
    // `placeholders:` and `roles:` establish these through the same merges any branch
    // node uses. `variables` is the exception — the root visit merges the declared set,
    // so the effective set (`_variables`, library names folded in) has to arrive already
    // seeded (Step 1's root framing resolves against it); `_variables` ⊇ `variables`,
    // so the root's merge leaves it untouched.
    outputBase, variables, table: {}, roles: {}, rolesDeclared: false,
  });
}

/**
 * Write Label.md at every node in the branch tree, the project root included
 * (Phase 11 Step 0).
 *
 * Node-level, not leaf-level, which is why it uses the tree visitor rather than the
 * leaf loop: a branch label belongs to the node the player is choosing.
 */
function writeLabelsRecursive(rootNode, outputBase, variables, rootVariables, verbose = false, diagnostics = null, configPath = null, usage = null) {
  walkBranchTree(rootNode, ({ name, node, path: path_, isRoot, state }) => {
    const nodeOutput = isRoot ? state.outputBase : path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    const table = mergePlaceholders(state.table, node);

    if (isRoot) {
      // The scenario title, written once at the project root. Two things stay different
      // from a branch label here, both deliberately: it expands against `rootVariables`
      // — the variables the author declared, not `_variables` with library names folded
      // in, exactly as the old rung did — and it gets the "AID never substitutes a
      // scenario title" warn where a branch title only half-works.
      if (node.title == null) {
        return { outputBase: nodeOutput, variables: branchVars, table };
      }
      const rootLabel = resolveVariables(String(node.title), rootVariables);
      const labelPath = path.join(nodeOutput, 'Label.md');
      checkUndeclaredPlaceholders(rootLabel, table, {
        diagnostics, file: configPath, where: 'the project title',
        usage, usagePath: '',
      });
      checkPlaceholderContext(rootLabel, {
        diagnostics,
        file: configPath,
        where: 'the scenario title',
        severity: 'warn',
        reason: 'AID never fills a placeholder in the scenario title. The title names the '
          + 'scenario in listings, before any adventure exists to answer a prompt, so the '
          + 'raw text is what readers see. Legal to write, and occasionally meant as a '
          + 'joke, but never substituted.',
      });
      fs.writeFileSync(labelPath, rootLabel + '\n', 'utf8');
      if (verbose) console.log(`  OK: Label → ${labelPath}`);
      return { outputBase: nodeOutput, variables: branchVars, table };
    }

    const rawTitle = (node && node.title) || name;
    fs.mkdirSync(nodeOutput, { recursive: true });
    const outPath = path.join(nodeOutput, 'Label.md');
    const labelText = resolveVariables(rawTitle, branchVars);
    // A branch title is the one destination where a placeholder half-works: AID fills
    // the prompt correctly, then keeps the raw text in the saved adventure's title.
    // Undeclared is still simply broken, so it errors here like anywhere else; the
    // half-working case is Step 4's WARN.
    checkUndeclaredPlaceholders(labelText, table, {
      diagnostics, file: configPath, where: `the title of branch "${name}"`,
      usage, usagePath: path_.join('/'),
    });
    checkPlaceholderContext(labelText, {
      diagnostics,
      file: configPath,
      where: `the title of branch "${name}"`,
      severity: 'warn',
      reason: 'a branch title half-works. AID fills the prompt and shows the answer while '
        + 'the player is choosing, then keeps the raw placeholder text in the saved '
        + 'adventure’s title. Deliberate is possible; usually it is not.',
    });
    // Velvet Lattice reads `Label.md` from the node's own directory and falls back to the
    // directory name when the file is absent (`scenario.py:37`, `self._load_file("Label.md")
    // or self.name`). A label that renders to its own branch key is therefore written for
    // nothing — 60 of The Institute's 61 label files are exactly that. Write only where the
    // rendered label differs from the segment VL would default to (Phase 11 Step 3,
    // Decision 2). The diagnostics above still run either way: a broken placeholder in a
    // title the author wrote is reportable whether or not the file lands.
    if (labelText !== name) {
      fs.writeFileSync(outPath, labelText + '\n', 'utf8');
      if (verbose) console.log(`    OK: Label → ${outPath}`);
    } else if (fs.existsSync(outPath)) {
      // A prior compile of a since-shortened title left one behind. Harmless to VL, which
      // would read it and get the same string it now defaults to, but noise in the tree
      // and in any diff — the pre-build clean only archives whole stale nodes, not a live
      // node whose label collapsed into its key.
      fs.rmSync(outPath);
    }

    return { outputBase: nodeOutput, variables: branchVars, table };
  }, { outputBase, variables, table: {} });
}

/**
 * Write `Placeholders.yaml` across the branch tree (§12.2).
 *
 * Node-level, like `Label.md` and for the same reason: Velvet Lattice reads one file per
 * scenario node and merges them down itself, so the leaf loop is the wrong shape — it
 * would emit a leaf's accumulated table and never write the interior nodes at all.
 *
 * Each node emits only the keys it declares. What it emits are those keys' *expanded*
 * questions, resolved against the merged table so a local question nesting an inherited
 * key carries that key's question inline — see `emit/placeholders.js` for why the nesting
 * cannot be left to VL.
 */
function writePlaceholdersRecursive(rootNode, outputBase, variables, configPath, diagnostics, verbose = false, usage = null, declarations = null, duplicates = null) {
  const onWarn = (code, message, file) => diagnostics.add(
    severityOf(code), code, message, { file: file || configPath },
  );

  // The walker's root visit replaces the old hand-rolled root rung (Phase 11 Step 0):
  // the root's own `placeholders:` live on the root node itself, the merged table starts
  // empty and gains them at the root exactly the way a branch node gains its own, and
  // the declarations entry keeps the root's `at the project root` label and its
  // unconditional-on-`placeholders` push.
  walkBranchTree(rootNode, ({ name, node, path: path_, isRoot, state }) => {
    const nodeOutput = isRoot ? state.outputBase : path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    // The merged table at this node, by the same rules `walkBranchChain` applies along a
    // path: local keys override inherited ones, `~` deletes. Accumulated here rather than
    // looked up because the tree walk already has the chain in hand as `state`.
    const table = mergePlaceholders(state.table, node);

    if (declarations) {
      const keys = localKeysOf(node);
      if (keys.length) {
        declarations.push(isRoot
          ? { path: '', label: 'at the project root', keys }
          : { path: path_.join('/'), label: `on branch "${path_.join('/')}"`, keys });
      }
    }

    const outPath = writeNodePlaceholders(nodeOutput, node, table, branchVars, {
      onWarn, file: configPath, diagnostics, usage, usagePath: path_.join('/'), duplicates,
    });
    if (outPath && verbose) console.log(`    OK: Placeholders → ${outPath}`);

    return { outputBase: nodeOutput, variables: branchVars, table };
  }, { outputBase, variables, table: {} });
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

  const projectRegistry = buildRegistry(projectItems, 'project');
  console.log(`Loaded ${projectRegistry.size} project item definition(s).`);

  const registry = mergeRegistries(canonRegistry, projectRegistry);

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
        // Every sectioned component reports per section, keyed by section name. The
        // cross-branch reports diff component content by segment key, so per-section
        // keys localize a difference to the section that carries it rather than
        // reporting the whole component as changed — which is what §7.2's naming bought
        // Plot Essentials, and there is no reason the prose components report worse.
        //
        // Spread rather than named, and keyed by `descriptor.key` rather than by a name of
        // its own: this site listed three of `SLOTTED_COMPONENTS`' six by hand, so `summary`,
        // `opening` and `adventureDescription` were captured by the loop above and then
        // dropped here, invisible to `--diff` and `--annotate` since Phase 6 added them. A
        // list that has to be extended by hand when a component is added is a list that will
        // not be, so there is no list. `description:` is absent for a real reason rather than
        // this one — the scenario blurb is written once at the root and has no per-leaf value
        // to diff.
        components: { ...sectionedSegments },
      });
    }

    leafSummaries.push({ label, leafItems, leafVariants, hasPE, hasAIN, hasAN });
  }

  // §8.2.2 — convention packs, run over the cards each leaf just rendered while they are
  // still keyed per leaf. Dormant unless a project declares `lint.packs`.
  runPackChecks(config, deferredCardLeaves, configPath, compileDiagnostics);
  reportCompileDiagnostics();

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
  reportCompileDiagnostics();

  // Requested-but-unwritten components: surface as an error so the gap is never silent.
  if (componentGaps.length > 0) {
    console.error(`\nERROR: ${componentGaps.length} requested component(s) produced no output:`);
    for (const g of componentGaps) {
      console.error(`  - [${g.leaf}] ${g.component}: ${g.reason}`);
      console.error(`      spec: ${g.spec}`);
    }
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

/**
 * Write content to Components/Opening.md inside outputDir.
 * Exposed for unit testing.
 */
function writeOpening(outputDir, content) {
  return writeComponentFile(outputDir, 'Opening.md', content);
}

module.exports = {
  compile,
  resolveBranchItems,
  renderBranchItems,
  resolveCrossItemRenderFunctions,
  getTemplate,
  getTemplateName,
  resolveBodyRender,
  resolveNotesRender,
  resolveTemplateForMaps,
  renderPlacementBody,
  isTemplateChoice,
  checkConfigNotesTemplates,
  CODES,
  validateCardType,
  normalizeCardType,
  buildCardTypeAudit,
  AID_BUILTIN_TYPES,
  writeOutput,
  resolveIncludes,
  buildCompileContext,
  resolveVariables,
  buildBranchOutputDir,
  resolveBranchFolderPath,
  resolveOpeningContent,
  writeOpening,
  writeFramingRecursive,
  cleanAndArchive,
  RENDER_FN_PREFIXES,
};

/**
 * Resolve configPath, scenarioRoot, and outputDir from a CLI positional argument.
 * Accepts a folder (searched for a config entry point, §4.6), a config-file path, or
 * undefined (searches cwd).
 *
 * The directory search goes through `findConfigEntry`, so all four `CONFIG_BASENAMES`
 * spellings are found — including the `compile.cl.yaml` that `--migrate --rename-cl`
 * leaves behind — and a directory holding two configs throws rather than silently
 * compiling one and ignoring the other.
 *
 * @param {string|undefined} positional
 * @returns {{ configPath: string|null, scenarioRoot: string|null, outputDir: string|null, hasConfig: boolean }}
 */
function resolveArgs(positional) {
  let cfgPath = null;

  if (positional && /\.ya?ml$/i.test(positional)) {
    cfgPath = path.resolve(positional);
  } else {
    const dir = positional ? path.resolve(positional) : process.cwd();
    cfgPath = findConfigEntry(dir, CONFIG_BASENAMES);
  }

  if (cfgPath) {
    const cfg = loadCompileConfig(cfgPath);
    return {
      configPath:   cfgPath,
      scenarioRoot: cfg._resolvedOutput,
      outputDir:    cfg._resolvedReports || path.join(cfg._resolvedOutput, 'Overview'),
      hasConfig:    true,
      // The report modes get `lint.level` from here rather than loading the config a second
      // time. This function already reads it for the output and reports paths, so the value
      // is in hand; without passing it out, `--lint` would answer differently from the
      // compile that wrote the tree it is reading, on the same project's own setting.
      configLintLevel: (cfg.lint && cfg.lint.level) || null,
    };
  }

  if (!positional) {
    return {
      configPath: null, scenarioRoot: null, outputDir: null, hasConfig: false,
      configLintLevel: null,
    };
  }

  return {
    configPath:   null,
    scenarioRoot: path.resolve(positional),
    outputDir:    path.resolve('overview'),
    hasConfig:    false,
    // No config to read one from. `--lint` on a bare output tree has only the CLI flag,
    // which is the honest answer rather than a gap.
    configLintLevel: null,
  };
}

/**
 * Resolve `--migrate`'s config path by directory search alone (§14.2, §4.6, Decision 4).
 *
 * Deliberately not `resolveArgs`: that function calls `loadCompileConfig`, and the schema
 * requires `version: 4` with no compatibility mode — a v3 project has no such key by
 * definition, so routing `--migrate` through the shared resolver would reject exactly the
 * input it exists to accept. This does only the filename search half — the same
 * `CONFIG_BASENAMES` search `resolveArgs` runs via `findConfigEntry`, minus the config
 * load — and it tolerates a directory with two configs (a half-finished migration) rather
 * than throwing on it.
 */
function resolveMigrateConfigPath(positional) {
  if (positional && /\.ya?ml$/i.test(positional)) {
    const resolved = path.resolve(positional);
    return fs.existsSync(resolved) ? resolved : null;
  }
  const dir = path.resolve(positional || '.');
  for (const base of CONFIG_BASENAMES) {
    const candidate = path.join(dir, base);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Render `--migrate`'s review queue and notes as `migration-report.md` (§9.5, §14.2).
 *
 * Written beside the config rather than into `structure.reports` — Decision 4 — because
 * the migrator creates that key during the same run (renaming `structure.overview`), so a
 * path read from the config would depend on a key the invocation is midway through writing.
 */
function renderMigrationReport(result) {
  const lines = [`# Migration report — ${result.configPath}`, ''];

  lines.push('## What changed', '');
  if (result.notes.length === 0) {
    lines.push('Nothing to report.');
  } else {
    for (const note of result.notes) lines.push(`- ${note}`);
  }
  lines.push('');

  lines.push(
    '## Review queue', '',
    'Every prose fragment that now carries a converted role token beside a hardcoded '
    + 'gendered pronoun (§9.5). The migrator cannot convert the pronoun — only a person can '
    + 'decide whether it should become a role reference too.', '',
  );
  if (!result.reviewQueue || result.reviewQueue.length === 0) {
    lines.push('None found.');
  } else {
    for (const entry of result.reviewQueue) {
      const at = entry.line ? `${entry.file}:${entry.line}` : entry.file;
      lines.push(`- **${at}** — ${entry.text}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const rawArgs = process.argv.slice(2);

  const knownFlags = [
    ['compile',    ['--compile',    '-C']],
    ['leafReview', ['--leafReview', '-l']],
    ['overview',   ['--overview',   '-o']],
    ['seedMap',    ['--seed-map',   '-s']],
    ['cardSizes',  ['--card-sizes', '-b']],
    ['lint',       ['--lint',       '-L']],
    ['snapshot',   ['--snapshot']],
    ['migrate',    ['--migrate']],
    ['renameToCl', ['--rename-cl']],
    ['diff',       ['--with-diff',     '--diff',     '-d']],
    ['annotate',   ['--with-annotate', '--annotate', '-a']],
    ['inventory',  ['--with-inventory', '--inventory', '-i']],
    ['schemaTables', ['--schema-tables']],
    ['clean',      ['--clean',      '-c']],
    ['verbose',    ['--verbose',    '-v']],
    ['live',       ['--live']],
  ];

  const flags = {};
  const flagIdxs = new Set();
  for (const [key, aliases] of knownFlags) {
    const idx = rawArgs.findIndex(a => aliases.includes(a));
    flags[key] = idx !== -1;
    if (idx !== -1) flagIdxs.add(idx);
  }

  // `--lint-level` is a value flag, so it is parsed apart from the boolean table above and
  // in both spellings: `--lint-level=warn` and `--lint-level warn`. It is deliberately not
  // folded into `--verbose` (§12.5) — verbosity is about compile progress, this is about
  // which diagnostics an author wants to hear, and the two answer different questions.
  let lintLevel = null;
  {
    const idx = rawArgs.findIndex(a => a === '--lint-level' || a.startsWith('--lint-level='));
    if (idx !== -1) {
      const arg = rawArgs[idx];
      flagIdxs.add(idx);
      if (arg.includes('=')) {
        lintLevel = arg.slice(arg.indexOf('=') + 1);
      } else {
        lintLevel = rawArgs[idx + 1];
        if (lintLevel !== undefined) flagIdxs.add(idx + 1);
      }
      if (!LINT_LEVELS.includes(lintLevel)) {
        console.error(
          `--lint-level takes one of ${LINT_LEVELS.join(', ')}; got ${JSON.stringify(lintLevel || '')}.`
        );
        process.exit(1);
      }
    }
  }

  const positional = rawArgs.filter((_, i) => !flagIdxs.has(i));

  // --with-diff / --with-annotate need data captured during compilation (the on-disk markdown is
  // lossy), so they are compile *options* — they force a compile rather than reading the
  // output dir like the post-hoc report modes (--leafReview/--overview/--seed-map/--card-sizes).
  const doCompile    = flags.compile || flags.diff || flags.annotate || flags.inventory ||
    flags.schemaTables ||
    (!flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes && !flags.lint &&
      !flags.snapshot && !flags.migrate);
  const doLeafReview = flags.leafReview;
  const doOverview   = flags.overview;
  const doSeedMap    = flags.seedMap;
  const doCardSizes  = flags.cardSizes;
  const doLint       = flags.lint;
  const doSnapshot   = flags.snapshot;

  if (positional.length === 0 && !flags.compile && !flags.diff && !flags.annotate &&
      !flags.inventory && !flags.schemaTables &&
      !flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes && !flags.lint &&
      !flags.snapshot && !flags.migrate) {
    console.error(
      'Usage: codex-loom [mode flags] [compile options] [<folder | compile.yaml>]\n' +
      '  Modes (what runs):     --compile|-C  --leafReview|-l  --overview|-o  --seed-map|-s  --card-sizes|-b  --lint|-L  --snapshot  --migrate\n' +
      '  Compile options:       --with-diff|-d  --with-annotate|-a  --with-inventory|-i  --schema-tables  --clean|-c  --verbose|-v  --live\n' +
      '  Migrate options:       --rename-cl  (§4.6: also rename compile.yaml to compile.cl.yaml)\n' +
      '  Diagnostics:           --lint-level=off|error|warn  (overrides lint.level; reaches the opinion layer only)\n' +
      '  No mode flag compiles. Report modes read the existing output tree; compile options force a compile.\n' +
      '  --migrate converts a v3 project in place and does not compile — run it again once migrated.'
    );
    process.exit(1);
  }

  // ── Migrate (§14.2, Decision 4) ──
  //
  // Resolves its own config path (by filename search alone, per util.js's CONFIG_BASENAMES)
  // rather than through resolveArgs below: that function loads the config it finds, and the
  // v4 schema requires `version: 4` with no compatibility mode. A v3 project — the only
  // input `--migrate` exists to accept — has no such key, so routing through resolveArgs
  // rejects it before the migrator ever runs. Handled and exited before resolveArgs is
  // called at all, not merely before its result is used.
  if (flags.migrate) {
    const migrateConfigPath = resolveMigrateConfigPath(positional[0]);
    if (!migrateConfigPath) {
      console.error(`No v3 compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
      process.exit(1);
    }
    try {
      const { migrateProjectFully } = require('./migrate');
      const result = migrateProjectFully(migrateConfigPath, { renameToCl: flags.renameToCl });
      const reportPath = path.join(path.dirname(result.configPath), 'migration-report.md');
      fs.writeFileSync(reportPath, renderMigrationReport(result), 'utf8');
      const queueCount = result.reviewQueue.length;
      console.log(`Migrated ${migrateConfigPath}`);
      console.log(
        `Touched ${result.touched.length} file(s). Review queue: ${queueCount} `
        + `entr${queueCount === 1 ? 'y' : 'ies'}.`
      );
      console.log(`Wrote ${reportPath}`);
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  let resolved;
  try {
    resolved = resolveArgs(positional[0]);
  } catch (err) {
    // findConfigEntry throws when a directory holds more than one config entry point.
    console.error(`\nFatal: ${err.message}`);
    process.exit(1);
  }
  const { configPath, scenarioRoot, outputDir, hasConfig, configLintLevel } = resolved;

  // The flag is what someone typed for this run; the config is what the project says every
  // run. Same precedence the compile applies internally, stated once here so the report
  // modes and the compile cannot disagree about it.
  const effectiveLintLevel = lintLevel || configLintLevel;

  // ── Compile ──
  if (doCompile) {
    if (!hasConfig) {
      if (!scenarioRoot) {
        console.error('No compile.yaml in current directory and no path given.');
        process.exit(1);
      }
      if (doLeafReview || doOverview) {
        console.warn('Warning: compile.yaml not found; skipping compile.');
      } else {
        console.error(`No compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
        process.exit(1);
      }
    } else {
      try {
        compile(configPath, {
          clean: flags.clean, verbose: flags.verbose,
          diff: flags.diff, annotate: flags.annotate, inventory: flags.inventory,
          schemaTables: flags.schemaTables,
          lintLevel, live: flags.live,
        });
      } catch (err) {
        console.error(`\nFatal: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // ── Snapshot (Phase 7's freeze: sync structure.input.library + out-of-base templates) ──
  if (doSnapshot) {
    if (!hasConfig) {
      console.error(`No compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
      process.exit(1);
    } else {
      try {
        const snapshotDiagnostics = new Diagnostics();
        const config = loadCompileConfig(configPath, { diagnostics: snapshotDiagnostics, live: true });
        if (!config._resolvedSnapshot) {
          console.error('structure.input.snapshot is not set in compile.yaml; nothing to sync.');
          process.exit(1);
        }
        const result = syncLibrary(config, { verbose: flags.verbose, diagnostics: snapshotDiagnostics });
        for (const diag of snapshotDiagnostics.all) {
          if (diag.severity === 'error') console.error(diag.format());
          else console.warn(diag.format());
        }
        console.log(
          `\nSynced ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'} `
          + `(${result.filesWritten} file(s)) to:\n  ${config._resolvedSnapshot}\n`
          + `Manifest: ${result.manifestPath}\n`
        );
        // The manifest and copied files are still written above — sync itself succeeded —
        // but a `requiresRoles` refusal (Decision 2, Phase 8) means the run is not clean.
        if (snapshotDiagnostics.hasErrors()) process.exit(1);
      } catch (err) {
        console.error(`\nFatal: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // ── Reports (leaf-review, overview, seed-map, card-sizes, lint) ──
  if (doLeafReview || doOverview || doSeedMap || doCardSizes || doLint) {
    if (!scenarioRoot) {
      console.error('No compile.yaml in current directory and no path given.');
      process.exit(1);
    }
    if (!fs.existsSync(scenarioRoot)) {
      console.error(`Scenario root not found: ${scenarioRoot}`);
      process.exit(1);
    }

    if (flags.verbose) {
      const modeLabel = [
        doLeafReview && 'leaf-review',
        doOverview   && 'overview',
        doSeedMap    && 'seed-map',
        doCardSizes  && 'card-sizes',
        doLint       && 'lint',
      ].filter(Boolean).join(' + ');
      console.log(`\n${modeLabel} mode\nScenario root : ${scenarioRoot}\nOutput dir    : ${outputDir}\n`);
    }

    try {
      const summaryParts = [];

      if (doLeafReview) {
        const { runLeafReviewMode } = require('./overview');
        const dir = path.join(outputDir, 'leaf-review');
        fs.mkdirSync(dir, { recursive: true });
        const written = runLeafReviewMode(scenarioRoot, dir, flags.verbose);
        summaryParts.push(`${written.length} leaf review file(s)`);
      }

      if (doSeedMap) {
        const { runSeedMapMode } = require('./seedmap');
        const dir = path.join(outputDir, 'seed-map');
        fs.mkdirSync(dir, { recursive: true });
        const result = runSeedMapMode(scenarioRoot, dir, flags.verbose);
        if (result) summaryParts.push('2 seed map files');
      }

      if (doOverview) {
        const { runOverviewMode } = require('./overview');
        const dir = path.join(outputDir, 'overview');
        fs.mkdirSync(dir, { recursive: true });
        runOverviewMode(scenarioRoot, dir, flags.verbose);
        summaryParts.push('an overview file');
      }

      if (doCardSizes) {
        const { runBodySizeMode } = require('./bodysize');
        const dir = path.join(outputDir, 'card-sizes');
        fs.mkdirSync(dir, { recursive: true });
        const result = runBodySizeMode(scenarioRoot, dir, flags.verbose);
        if (result) summaryParts.push('2 card size files');
      }

      if (doLint) {
        const { runLintMode } = require('./lint');
        const dir = path.join(outputDir, 'lint');
        fs.mkdirSync(dir, { recursive: true });
        // A compiled tree carries no branch context, so `--lint` runs the project-root
        // `lint.packs` against every file (§8.2.2). With no `compile.yaml` to find, it has
        // no packs to run — the same honest gap `--lint` already has for `lint.level`.
        let lintConfig = null;
        if (configPath) {
          try { lintConfig = loadCompileConfig(configPath); } catch (err) { lintConfig = null; }
        }
        const result = runLintMode(scenarioRoot, dir, flags.verbose, {
          lintLevel: effectiveLintLevel, config: lintConfig, configPath,
        });
        if (result) summaryParts.push(`a lint report (${result.errorCount} error(s), ${result.warnCount} warning(s))`);
      }

      if (summaryParts.length > 0) {
        const joined = summaryParts.length === 1
          ? summaryParts[0]
          : summaryParts.slice(0, -1).join(', ') + ', and ' + summaryParts.at(-1);
        console.log(`\nWrote ${joined} to:\n  ${outputDir}\n`);
      }
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      process.exit(1);
    }
  }
}
