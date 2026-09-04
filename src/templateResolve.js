'use strict';

const fs = require('fs');
const path = require('path');
const { resolveVariables, loadYaml } = require('./util');
const { walkBranchTree } = require('./model/branches');
const { render } = require('./template');
const { renderFieldList } = require('./render/field-list');
const { CODES } = require('./diag');

/**
 * Check every `render.notesTemplate` declared in compile.yaml against the loaded set.
 *
 * At load rather than at render, because this one is a closed set — the root node and
 * every branch node, all known before a single card is compiled. Left to render time it
 * would report once per item per leaf, which for a project like The Institute means the
 * same typo printed thousands of times.
 */
function checkConfigNotesTemplates(config, templates, diagnostics, configPath, fieldTable) {
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

  // The walker's `isRoot` visit covers the project root; there is no separate root check.
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
    diagnostics.error(
      CODES.ITEM_NOTES_TEMPLATE_NOT_FOUND,
      `item "${label}" declares render.notesTemplate "${resolved.name}", which is not a loaded template.`,
      { file: item._source },
    );
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

// ── templateFor: rendering roles, branch-addressable (§13.4) ───────────────────

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
      const expanded = resolveVariables(String(file), variables, { diagnostics, file: configPath });
      const abs = findTemplateForFile(expanded, templateDirs, base);
      if (!abs) {
        diagnostics.error(
          CODES.PATH_NOT_FOUND,
          `templateFor.${role} names "${file}", which was not found on the templates search path.`,
          { file: configPath },
        );
        continue;
      }
      let doc;
      try {
        doc = loadYaml(abs);
      } catch (err) {
        diagnostics.error(CODES.FIELD_TABLE_MALFORMED,
          `Could not parse templateFor.${role} file ${path.basename(abs)}: ${err.message}`, { file: abs });
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
 * `model/item.js` fills `render.template` and a component target's `template:` with
 * `aid.type` for every card that names neither, and every type has a shared-table field
 * list of its own name — so a resolver rung that honoured that fill would shadow a branch's
 * `templateFor.*` map for the whole corpus. A value equal to `aid.type` (case-insensitively)
 * is treated as absent; anything else — a cross-type name, `Character.hint`, or a Pattern-2
 * name a branch slot file defines (§13.4) — is a real choice and wins at rung 1.
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
 * no field table and no `templateFor`, only the first and last rungs can fire — the two
 * extra rungs only ever fire once a project declares one or the other.
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
  // Case-insensitively, like every other name lookup here. `aid.type` is matched against a
  // slot file's `templates:` keys, while `cardType.js` folds a built-in type to lowercase —
  // so a raw index here made a project that wrote `character` silently miss its tier.
  const byType = type ? lookupSlotList(type, baseMap) : null;
  if (byType) return { kind: 'fieldList', list: byType, name: type };
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
  const notesByType = type ? lookupSlotList(type, notesMap) : null;
  if (notesByType) {
    return { kind: 'fieldList', list: notesByType, name: `templateFor.notes[${type}]`, refRoot: 'notes' };
  }
  if (projectNotesTemplate) {
    const hit = lookupNamedTemplate(projectNotesTemplate, templates, fieldTable);
    return hit || { kind: 'missing', name: String(projectNotesTemplate) };
  }
  return null;
}

module.exports = {
  checkConfigNotesTemplates,
  renderNotesText,
  resolveTemplateForMaps,
  gatherTierTemplates,
  lookupSlotList,
  lookupNamedTemplate,
  isTemplateChoice,
  resolveBodyRender,
  resolveNotesRender,
};
