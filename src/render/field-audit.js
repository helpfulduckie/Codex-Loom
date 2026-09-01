'use strict';

/**
 * The unread-field audit (v4 spec §13.6, Phase 12 Step 4 — Decision 4).
 *
 * A field-list template names the `body:` keys it renders. Anything an item carries in
 * `body:` that no field in the resolved template reads is content going nowhere, and today
 * that is silent — the missing diagnostic the external SCHEMA.md was hand-maintained to
 * compensate for. This module raises it, splitting one symptom into the three distinct
 * failures the corpus proves exist:
 *
 *   CL0426  a `body:` key no declaration names          — a typo; content dropped
 *   CL0427  a key declared globally but not in this list — misrouted; names the group
 *   CL0428  a declared field no template names           — a dead declaration
 *
 * All three are WARN and none is an opinion code (§12.5): a field is read or it is not,
 * there is no guess about intent. `lint.level` must not reach them.
 *
 * ── The two mechanics that make it usable ──────────────────────────────────────
 *
 * **Dedupe on `(item id, field path)`.** `body:` fields resolve once per `variants:` /
 * `branches:` expansion, so the raw check fires 32 times on The Institute for one mistake.
 * Findings are keyed and collapsed, and `finish()` emits one per key (§4.4).
 *
 * **`allowExtra: true` opts a template out**, carried as a `{ allowExtra: true }` marker
 * in the template's list rather than per field — Directory and Unstructured compose their
 * bodies from author-shaped sub-keys feeding an interpolated value, and the property
 * belongs to the template.
 *
 * ── Read vs acknowledged ──────────────────────────────────────────────────────
 *
 * A field-list entry contributes a *content* path (the field name, or each `from:` path):
 * the key and everything under it is rendered, so descent stops there. A raw/`include`
 * escape-hatch block is scanned for `$body.` / `$notes.` references — one inside a bare
 * `{if $body.X}` guard only *acknowledges* `X` (suppresses a finding for that exact path,
 * not its children), one anywhere else is a content read. This is what lets
 * `from: [personality.keywords, personality.expanded]` still flag `personality.other`
 * while `{if $body.personality}` on its own does not wave the whole subtree through.
 */

const { entryName } = require('./parse');
const { CODES } = require('../diag');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** `from:` as an array, or `[name]` when absent. */
function fromPaths(decl, name) {
  if (decl && decl.from !== undefined && decl.from !== null) {
    return Array.isArray(decl.from) ? decl.from.map(String) : [String(decl.from)];
  }
  return name ? [name] : [];
}

const IF_GUARD_RE = /\{if\s+\$(?:body|notes)\.([\w.]+)/g;
const IF_TAG_RE = /\{\/?if\b[^}]*\}/g;
const BODY_REF_RE = /\$(?:body|notes)\.([\w.]+)/g;
const INCLUDE_RE = /\{include\s+([\w.-]+)\s*\}/g;

/**
 * Resolve a template list to `{ content, ack, allowExtra }`.
 *
 * `content` — dotted paths that are rendered; a body path equal to or under one is read.
 * `ack`     — dotted paths named only by an `{if $body.X}` existence guard; the exact
 *             path is not a finding, but its children still are.
 */
function readablePathsFor(list, fieldTable, partials) {
  const content = new Set();
  const ack = new Set();
  let allowExtra = false;

  const scanRaw = (str) => {
    let m;
    IF_GUARD_RE.lastIndex = 0;
    while ((m = IF_GUARD_RE.exec(str)) !== null) ack.add(m[1]);
    const stripped = String(str).replace(IF_TAG_RE, ' ');
    BODY_REF_RE.lastIndex = 0;
    while ((m = BODY_REF_RE.exec(stripped)) !== null) content.add(m[1]);
  };

  const addField = (name, decl) => {
    for (const p of fromPaths(decl, name)) content.add(p);
    if (decl && isPlainObject(decl.labelWhen)) {
      const whenKey = Object.keys(decl.labelWhen)[0];
      if (whenKey) ack.add(whenKey);
    }
  };

  const seenPartials = new Set();
  const walkEntry = (entry, allowGroup) => {
    if (typeof entry === 'string') {
      const group = fieldTable.groups && fieldTable.groups[entry];
      if (allowGroup && Array.isArray(group)) {
        for (const member of group) walkEntry(member, false);
        return;
      }
      addField(entry, (fieldTable.fields && fieldTable.fields[entry]) || {});
      return;
    }
    if (!isPlainObject(entry)) return;
    if (entry.include !== undefined) {
      const pname = String(entry.include).toLowerCase();
      if (seenPartials.has(pname) || !partials || !partials.has(pname)) return;
      seenPartials.add(pname);
      const src = partials.get(pname).content || '';
      scanRaw(src);
      let m;
      INCLUDE_RE.lastIndex = 0;
      while ((m = INCLUDE_RE.exec(src)) !== null) walkEntry({ include: m[1] }, false);
      return;
    }
    if (entry.raw !== undefined) { scanRaw(entry.raw); return; }
    if (entry.allowExtra !== undefined) { allowExtra = allowExtra || entry.allowExtra === true; return; }
    const name = entry.field || entry.name;
    if (name) {
      const base = (fieldTable.fields && fieldTable.fields[name]) || {};
      const { field: _f, name: _n, ...override } = entry;
      addField(name, { ...base, ...override });
    }
  };

  for (const entry of list || []) walkEntry(entry, true);
  return { content, ack, allowExtra };
}

/** Flatten `body` to dotted leaf paths, stopping descent at a content path. */
function bodyLeafPaths(body, content) {
  const out = [];
  const hasContentBelow = (prefix) => {
    const p = `${prefix}.`;
    for (const c of content) if (c.startsWith(p)) return true;
    return false;
  };
  const walk = (obj, prefix) => {
    for (const key of Object.keys(obj)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (content.has(p)) continue; // rendered — and so is everything under it
      const val = obj[key];
      if (isPlainObject(val) && hasContentBelow(p)) walk(val, p);
      else out.push(p);
    }
  };
  if (isPlainObject(body)) walk(body, '');
  return out;
}

/**
 * @param {object} deps  `{ fieldTable, partials, tierTemplates }` — the merged §13 table,
 *   the loaded partial map, and every field list a project's `templateFor` slot files
 *   produce across the branch tree (`[{ branch, role, name, list }]`, from
 *   `gatherTierTemplates`). All three are compile-wide. `tierTemplates` feeds the
 *   dead-declaration sweep only — the per-card CL0427 suppression works off the branch's
 *   own resolved `templateFor` map, passed to `auditBody`.
 * @returns {{ auditBody: function, finish: function }}
 */
function buildFieldAudit({ fieldTable, partials, tierTemplates } = {}) {
  const table = fieldTable || { fields: {}, groups: {}, templates: {} };
  const fields = table.fields || {};
  const groups = table.groups || {};
  const templates = table.templates || {};
  const tierLists = Array.isArray(tierTemplates) ? tierTemplates : [];

  // field name → the groups that name it, for CL0427's message.
  const groupsByField = new Map();
  for (const [gname, members] of Object.entries(groups)) {
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      const ref = entryName(member);
      if (!ref) continue;
      if (!groupsByField.has(ref)) groupsByField.set(ref, []);
      groupsByField.get(ref).push(gname);
    }
  }

  const readableCache = new Map(); // list reference → { content, ack, allowExtra }
  const readable = (list) => {
    let hit = readableCache.get(list);
    if (!hit) { hit = readablePathsFor(list, table, partials); readableCache.set(list, hit); }
    return hit;
  };

  const isDeclared = (name) => Object.prototype.hasOwnProperty.call(fields, name) && fields[name] !== null;

  // (item id \x00 field path) → { code, message, file }
  const findings = new Map();

  function auditBody(item, list, templateName, opts = {}) {
    if (!list) return;
    const { content, ack, allowExtra } = readable(list);
    if (allowExtra) return;

    // Did this list come from the branch's `templateFor` map (a context tier, §13.4)
    // rather than the shared field table? Reference identity against the same resolved
    // map the leaf loop passed — no second resolve. A tier list omits declared fields on
    // purpose, so its omissions are not CL0427 misroutes; a field that no list anywhere
    // reads is still caught by the tier-aware CL0428 sweep in `finish()`.
    const tf = opts.templateFor;
    const fromTemplateFor = !!tf && Object.values(tf).some(
      (roleMap) => roleMap && typeof roleMap === 'object'
        && Object.values(roleMap).some((l) => l === list),
    );
    const body = item && item.body;
    if (!isPlainObject(body)) return;
    const itemId = (item.id || item.name || '').toString();
    const file = item && item._source;

    for (const leaf of bodyLeafPaths(body, content)) {
      if (ack.has(leaf)) continue;
      const key = `${itemId}\x00${leaf}`;
      if (findings.has(key)) continue;

      const firstSeg = leaf.split('.')[0];
      const declKey = isDeclared(leaf) ? leaf : (isDeclared(firstSeg) ? firstSeg : null);
      const contentTouches = declKey && (content.has(declKey)
        || [...content].some((c) => c.startsWith(`${declKey}.`)));

      // CL0427 only when the declared field is genuinely routed elsewhere — nothing about
      // it is read here. A sub-key of a field this template *does* read (a typo such as
      // `magic.focus` against `from: [magic.affinity, magic.effect]`) is CL0426.
      if (declKey && !contentTouches) {
        // A tier list's omission is deliberate — the full list for this role/type reads
        // the field. Skip CL0427; `finish()`'s tier-aware CL0428 sweep still flags a
        // field named by no list at all.
        if (fromTemplateFor) continue;
        const inGroups = groupsByField.get(declKey) || [];
        const where = inGroups.length
          ? `group ${inGroups.map((g) => `\`${g}\``).join(', ')}, which template "${templateName}" does not include`
          : `not listed by template "${templateName}"`;
        findings.set(key, {
          code: CODES.FIELD_UNREAD_MISROUTED,
          message: `body key "${leaf}" on item "${itemId}" is a declared field but ${where} — its content is dropped from the compiled card.`,
          file,
        });
      } else {
        findings.set(key, {
          code: CODES.FIELD_UNREAD_UNKNOWN,
          message: `body key "${leaf}" on item "${itemId}" is read by no field in template "${templateName}" and no declaration names it — its content is dropped from the compiled card.`,
          file,
        });
      }
    }
  }

  /** Emit every deduped finding, then the whole-table dead-declaration sweep (CL0428). */
  function finish(diagnostics) {
    if (!diagnostics) return;
    for (const { code, message, file } of findings.values()) {
      diagnostics.warn(code, message, file == null ? undefined : { file: String(file) });
    }

    // CL0428: a declared field named by no `templates:` list (directly or through a group
    // a list includes). The counterpart to CL0545's unused-role check — what stops the
    // field table rotting the way a hand-maintained document does.
    const named = new Set();
    const addName = (ref, allowGroup) => {
      if (!ref) return;
      if (allowGroup && Array.isArray(groups[ref])) {
        for (const m of groups[ref]) addName(entryName(m), false);
        return;
      }
      named.add(ref);
    };
    for (const list of Object.values(templates)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) addName(entryName(entry), true);
    }
    // §13.4 — a field named only by a branch's `templateFor` slot file is used, not dead.
    // Fold every tier list into the same "named" set so a tier-only field (a terse
    // `backgroundBrief`, an opt-back-in `CharacterFull` member) does not raise CL0428.
    for (const { list } of tierLists) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) addName(entryName(entry), true);
    }
    const src = (table._sources && table._sources[0]) || null;
    for (const name of Object.keys(fields)) {
      if (fields[name] === null || named.has(name)) continue;
      diagnostics.warn(
        CODES.FIELD_DECLARED_UNUSED,
        `field "${name}" is declared in the field table but no template names it, directly or through a group.`,
        src == null ? undefined : { file: String(src) },
      );
    }
  }

  return { auditBody, finish };
}

module.exports = { CODES, buildFieldAudit, readablePathsFor, bodyLeafPaths };
