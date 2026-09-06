'use strict';


const fs = require('fs');
const path = require('path');

const { FUNCTION_NAMES, entryName } = require('./render/parse');

const DASH = '—';
const SLASH = ' / ';

function entryLabel(entry) {
  if (typeof entry === 'string') return `\`${entry}\``;
  if (entry && typeof entry === 'object') {
    if (entry.include !== undefined) return `_(include: ${entry.include})_`;
    if (entry.raw !== undefined) return '_(raw)_';
    if (entry.allowExtra !== undefined) return '_(allowExtra)_';
    const name = entry.field || entry.name;
    return name ? `\`${name}\` _(override)_` : '_(?)_';
  }
  return '_(?)_';
}

function renderOf(decl) {
  if (!decl || typeof decl !== 'object') return 'bare';
  if (decl.render === 'bare') return 'bare';
  if (decl.render && FUNCTION_NAMES.includes(decl.render)) {
    return decl.render === 'join'
      ? `join "${decl.join !== undefined ? decl.join : '; '}"`
      : `${decl.render}()`;
  }
  if (decl.join !== undefined) return `join "${decl.join}"`;
  return 'bare';
}

function labelOf(decl) {
  if (!decl || typeof decl !== 'object') return DASH;
  const base = decl.label !== undefined && decl.label !== null ? String(decl.label) : null;
  if (decl.labelWhen && typeof decl.labelWhen === 'object') {
    const [, alt] = Object.entries(decl.labelWhen)[0] || [];
    if (alt !== undefined) return `${alt}${SLASH}${base || '(none)'} _(conditional)_`;
  }
  return base === null ? DASH : base;
}

function readsOf(name, decl) {
  const from = decl && decl.from !== undefined && decl.from !== null
    ? (Array.isArray(decl.from) ? decl.from : [decl.from])
    : [name];
  const flags = [];
  if (decl && decl.always) flags.push('always');
  if (decl && decl.block) flags.push('block');
  if (decl && decl.wrap) flags.push(`wrap ${decl.wrap}`);
  const paths = from.map((p) => `\`${p}\``).join(', ');
  return flags.length ? `${paths} _(${flags.join(', ')})_` : paths;
}

function expandForDisplay(list, groups) {
  const rows = [];
  for (const entry of list || []) {
    const name = entryName(entry);
    if (typeof entry === 'string' && Array.isArray(groups[entry])) {
      rows.push({ label: `**${entry}** _(group)_`, members: groups[entry].map(entryLabel) });
    } else {
      rows.push({ label: entryLabel(entry), members: null, name });
    }
  }
  return rows;
}

function tierSection(tierTemplates, groups) {
  if (!Array.isArray(tierTemplates) || tierTemplates.length === 0) return [];
  const out = ['## Role and tier templates', ''];
  out.push('_Selected per branch by `templateFor` (§13.4). A `base` entry keyed on a type',
    'overrides that type\'s body list on the branch; a free-standing name is one an item opts',
    'into with `render.template`. Each list expands one level of groups, like the table above._', '');

  const byBranch = new Map();
  for (const t of tierTemplates) {
    const key = `${t.branch}\x00${t.role}`;
    if (!byBranch.has(key)) byBranch.set(key, { branch: t.branch, role: t.role, entries: [] });
    byBranch.get(key).entries.push(t);
  }
  for (const { branch, role, entries } of byBranch.values()) {
    out.push(`### Branch \`${branch}\` ${DASH} role \`${role}\``, '');
    for (const { name, list } of entries) {
      out.push(`#### \`${name}\``, '');
      for (const row of expandForDisplay(list, groups)) {
        if (row.members) out.push(`- ${row.label}: ${row.members.join(', ')}`);
        else out.push(`- ${row.label}`);
      }
      out.push('');
    }
  }
  return out;
}

function generateSchemaTables(fieldTable, { title, tierTemplates } = {}) {
  const fields = (fieldTable && fieldTable.fields) || {};
  const groups = (fieldTable && fieldTable.groups) || {};
  const templates = (fieldTable && fieldTable.templates) || {};

  const groupNamedBy = new Map();
  for (const [tname, list] of Object.entries(templates)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const n = entryName(entry);
      if (n && Object.prototype.hasOwnProperty.call(groups, n)) {
        if (!groupNamedBy.has(n)) groupNamedBy.set(n, []);
        groupNamedBy.get(n).push(tname);
      }
    }
  }

  const out = [];
  out.push(`# ${title || 'Codex Loom'} ${DASH} generated field reference`, '');
  out.push('_Generated from `fields.cl.yaml` by `codex-loom --schema-tables` (v4 §13.8)._',
    '_The field, label and membership tables here supersede the hand-maintained copies in',
    '`SCHEMA.md` sections 3-5; where they disagree, `SCHEMA.md` has drifted. The authoring',
    'conventions (`SCHEMA.md` sections 1 and 7) are hand-written and not reproduced here._', '');

  out.push('## Fields', '');
  out.push('| Field | Label | Renders | Reads |', '|---|---|---|---|');
  for (const name of Object.keys(fields)) {
    const decl = fields[name];
    if (decl === null) continue;
    out.push(`| \`${name}\` | ${labelOf(decl)} | ${renderOf(decl)} | ${readsOf(name, decl)} |`);
  }
  out.push('');

  out.push('## Groups', '');
  out.push('| Group | Members | Named by |', '|---|---|---|');
  for (const [gname, members] of Object.entries(groups)) {
    if (!Array.isArray(members)) continue;
    const memberList = members.map(entryLabel).join(', ');
    const namedBy = (groupNamedBy.get(gname) || []).map((t) => `\`${t}\``).join(', ') || DASH;
    out.push(`| \`${gname}\` | ${memberList} | ${namedBy} |`);
  }
  out.push('');

  out.push('## Type to fields', '');
  out.push('_Every field a template renders, in order. A group name expands to its members._', '');
  for (const [tname, list] of Object.entries(templates)) {
    if (list === null) continue;
    out.push(`### \`${tname}\``, '');
    for (const row of expandForDisplay(list, groups)) {
      if (row.members) out.push(`- ${row.label}: ${row.members.join(', ')}`);
      else out.push(`- ${row.label}`);
    }
    out.push('');
  }

  out.push(...tierSection(tierTemplates, groups));

  return out.join('\n').trimEnd() + '\n';
}

function runSchemaTablesMode(fieldTable, outputDir, { title, tierTemplates } = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, 'schema-tables.md');
  fs.writeFileSync(file, generateSchemaTables(fieldTable, { title, tierTemplates }), 'utf8');
  return { written: [file] };
}

module.exports = { generateSchemaTables, runSchemaTablesMode };
