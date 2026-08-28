'use strict';

/**
 * The generated schema reference (v4 spec §13.8, Phase 12 Step 5 — Decision 7).
 *
 * The external `SCHEMA.md` in `Scenarios/_CodexLoom/Design/` is authored from the
 * templates and has drifted from them. §13.8 splits it three ways: the field/label tables
 * and the type-to-field membership are mechanically derivable from `fields.cl.yaml` and
 * are generated here; the authoring conventions (§1, §7 of that document — budget targets,
 * compression register, the card-role spectrum) stay hand-written and are untouched.
 *
 * This does not write `SCHEMA.md` — that file lives in another repo and this compiler has
 * never written outside its own tree. It writes `schema-tables.md` under the resolved
 * reports directory; a human copies the tables across. Where the generation disagrees with
 * the committed document, **the document is wrong** — it is the drift this step corrects,
 * the opposite of the pathological fixture's authored-from-spec rule.
 *
 * Emitted opt-in (`--schema-tables`), during the compile that already loaded the field
 * table, and frozen by the golden harness the same way `--with-inventory` is.
 */

const fs = require('fs');
const path = require('path');

const { FUNCTION_NAMES } = require('./render/parse');

const DASH = '—';
const SLASH = ' / ';

function entryName(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') return entry.field || entry.name || null;
  return null;
}

/** A one-line description of an entry as it appears in a template/group list. */
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

/** How a field's value is rendered, from its declaration. */
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

/** The rendered label fragment, including a `labelWhen` conditional. */
function labelOf(decl) {
  if (!decl || typeof decl !== 'object') return DASH;
  const base = decl.label !== undefined && decl.label !== null ? String(decl.label) : null;
  if (decl.labelWhen && typeof decl.labelWhen === 'object') {
    const [, alt] = Object.entries(decl.labelWhen)[0] || [];
    if (alt !== undefined) return `${alt}${SLASH}${base || '(none)'} _(conditional)_`;
  }
  return base === null ? DASH : base;
}

/** `from:` paths, or the field's own name; plus the structural flags that change layout. */
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

/** Expand a template/group list to display rows, one level of groups. */
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

/** Build the markdown. */
function generateSchemaTables(fieldTable, { title } = {}) {
  const fields = (fieldTable && fieldTable.fields) || {};
  const groups = (fieldTable && fieldTable.groups) || {};
  const templates = (fieldTable && fieldTable.templates) || {};

  // Which templates name each group directly.
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

  // ---- Fields ----
  out.push('## Fields', '');
  out.push('| Field | Label | Renders | Reads |', '|---|---|---|---|');
  for (const name of Object.keys(fields)) {
    const decl = fields[name];
    if (decl === null) continue;
    out.push(`| \`${name}\` | ${labelOf(decl)} | ${renderOf(decl)} | ${readsOf(name, decl)} |`);
  }
  out.push('');

  // ---- Groups ----
  out.push('## Groups', '');
  out.push('| Group | Members | Named by |', '|---|---|---|');
  for (const [gname, members] of Object.entries(groups)) {
    if (!Array.isArray(members)) continue;
    const memberList = members.map(entryLabel).join(', ');
    const namedBy = (groupNamedBy.get(gname) || []).map((t) => `\`${t}\``).join(', ') || DASH;
    out.push(`| \`${gname}\` | ${memberList} | ${namedBy} |`);
  }
  out.push('');

  // ---- Type to fields ----
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

  return out.join('\n').trimEnd() + '\n';
}

/**
 * Write `schema-tables.md` into `outputDir`. Returns the written paths (matching the
 * other report modes).
 */
function runSchemaTablesMode(fieldTable, outputDir, { title } = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, 'schema-tables.md');
  fs.writeFileSync(file, generateSchemaTables(fieldTable, { title }), 'utf8');
  return [file];
}

module.exports = { generateSchemaTables, runSchemaTablesMode };
