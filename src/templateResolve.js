'use strict';

const fs = require('fs');
const path = require('path');
const { resolveVariables, loadYaml } = require('./util');
const { walkBranchTree } = require('./model/branches');
const { render } = require('./template');
const { renderFieldList } = require('./render/field-list');
const { CODES } = require('./diag');

function checkConfigNotesTemplates(config, templates, diagnostics, configPath, fieldTable) {
  const fieldListTemplates = (fieldTable && fieldTable.templates) || {};

  const check = (node, where) => {
    const name = node && node.render && node.render.notesTemplate;
    if (!name || templates.has(String(name).toLowerCase()) || fieldListTemplates[String(name)]) return;
    diagnostics.error(
      CODES.NOTES_TEMPLATE_NOT_FOUND,
      `${where} declares render.notesTemplate "${name}", which is not loaded, so configured notes rendering cannot run; add or rename the notes template, and the notes fallback is used.`,
      { file: configPath },
      { hint: 'Add a matching .template file, or remove the key to fall back to rendering '
        + 'the notes value itself. Use `notesTemplate: ~` to turn notes off for a branch.' },
    );
  };

  walkBranchTree(config, ({ node, path: path_, isRoot }) => {
    check(node, isRoot ? 'The project' : `Branch "${path_.join('/')}"`);
  });
}

function renderNotesText(item, context, templates, partials, variables, projectNotesTemplate, diagnostics, extra = {}) {
  const { fieldTable = { templates: {} }, templateFor = {} } = extra;
  const resolved = resolveNotesRender(
    item, templates, fieldTable, projectNotesTemplate, templateFor,
  );
  if (!resolved) return undefined;

  if (resolved.kind === 'missing') {
    const label = item.id || (typeof item.name === 'string' ? item.name : String(item.name));
    diagnostics.error(
      CODES.ITEM_NOTES_TEMPLATE_NOT_FOUND,
      `item "${label}" declares render.notesTemplate "${resolved.name}", which is not loaded, so the item cannot use its requested notes rendering; add or rename the item’s notes template, and the item renders without it.`,
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
          `templateFor.${role} names "${file}", which was not found on the templates search path, so this role has no template; add the file to a configured templates path or correct the name.`,
          { file: configPath },
        );
        continue;
      }
      let doc;
      try {
        doc = loadYaml(abs);
      } catch (err) {
        diagnostics.error(CODES.FIELD_TABLE_UNUSABLE,
          `templateFor.${role} names this file, and it could not be read — so the templates `
          + 'it declares are unavailable, and every item on this branch falls back to its '
          + 'base template instead of the one this file names until the file is repaired.',
          { file: abs },
          { hint: `YAML error: ${err.cause ? err.cause.message : err.message}` });
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

function lookupSlotList(name, map) {
  if (!name || !map) return null;
  if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
  const lower = String(name).toLowerCase();
  const key = Object.keys(map).find((k) => k.toLowerCase() === lower);
  return key ? map[key] : null;
}

function lookupNamedTemplate(name, templates, fieldTable) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  if (templates.has(lower)) return { kind: 'text', entry: templates.get(lower), name: String(name) };
  const ft = fieldTable && fieldTable.templates;
  if (ft) {
    const key = Object.prototype.hasOwnProperty.call(ft, name)
      ? name
      : Object.keys(ft).find((k) => k.toLowerCase() === lower);
    if (key) return { kind: 'fieldList', list: ft[key], name: String(name) };
  }
  return null;
}

function isTemplateChoice(name, type) {
  if (!name) return false;
  return String(name).toLowerCase() !== String(type || '').toLowerCase();
}

function resolveRenderLadder(item, templates, fieldTable, { choice, maps, typeSlotName }) {
  const type = item.aid && item.aid.type;

  const lookupSlot = (name) => {
    for (const map of maps) {
      const hit = lookupSlotList(name, map);
      if (hit) return hit;
    }
    return null;
  };

  if (isTemplateChoice(choice, type)) {
    const slot = lookupSlot(choice);
    if (slot) return { kind: 'fieldList', list: slot, name: String(choice) };
    const hit = lookupNamedTemplate(choice, templates, fieldTable);
    if (hit) return hit;
  }
  if (type) {
    const slot = lookupSlot(type);
    if (slot) return { kind: 'fieldList', list: slot, name: typeSlotName };
    const hit = lookupNamedTemplate(type, templates, fieldTable);
    if (hit) return hit;
  }
  return null;
}

function resolveBodyRender(item, templates, fieldTable, templateForMaps) {
  const type = item.aid && item.aid.type;
  return resolveRenderLadder(item, templates, fieldTable, {
    choice: item.render && item.render.template,
    maps: [(templateForMaps && templateForMaps.base) || {}],
    typeSlotName: type,
  });
}

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
  resolveRenderLadder,
  resolveBodyRender,
  resolveNotesRender,
};
