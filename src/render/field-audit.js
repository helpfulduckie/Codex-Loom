'use strict';


const { entryName } = require('./parse');
const { CODES } = require('../diag');
const { isPlainObject } = require('../util');

function lookupCI(map, name) {
  if (!map || !name) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
  const lower = String(name).toLowerCase();
  const key = Object.keys(map).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : map[key];
}

function fromPaths(decl, name) {
  if (decl && decl.from !== undefined && decl.from !== null) {
    return Array.isArray(decl.from) ? decl.from.map(String) : [String(decl.from)];
  }
  return name ? [name] : [];
}

function qualify(path, refRoot) {
  const s = String(path);
  return s.startsWith('$') ? s.slice(1) : `${refRoot}.${s}`;
}

const IF_GUARD_RE = /\{if\s+\$(body|notes)\.([\w.]+)/g;
const IF_TAG_RE = /\{\/?if\b[^}]*\}/g;
const BODY_REF_RE = /\$(body|notes)\.([\w.]+)/g;
const INCLUDE_RE = /\{include\s+([\w.-]+)\s*\}/g;

function readablePathsFor(list, fieldTable, partials, refRoot = 'body') {
  const content = new Set();
  const ack = new Set();
  let allowExtra = false;

  const scanRaw = (str) => {
    let m;
    IF_GUARD_RE.lastIndex = 0;
    while ((m = IF_GUARD_RE.exec(str)) !== null) ack.add(`${m[1]}.${m[2]}`.toLowerCase());
    const stripped = String(str).replace(IF_TAG_RE, ' ');
    BODY_REF_RE.lastIndex = 0;
    while ((m = BODY_REF_RE.exec(stripped)) !== null) content.add(`${m[1]}.${m[2]}`.toLowerCase());
  };

  const collectRefs = (list, isTrySource) => {
    for (const entry of list || []) {
      if (typeof entry === 'string') {
        if (isTrySource || entry.startsWith('$')) content.add(qualify(entry, refRoot).toLowerCase());
        continue; // parts: a literal — no ref
      }
      if (!isPlainObject(entry)) continue;
      if (entry.from !== undefined) {
        for (const p of fromPaths(entry, undefined)) content.add(qualify(p, refRoot).toLowerCase());
      }
      if (entry.parts !== undefined) collectRefs(entry.parts, false);
      if (entry.try !== undefined) collectRefs(entry.try, true);
      if (isPlainObject(entry.labelWhen)) {
        const whenKey = Object.keys(entry.labelWhen)[0];
        if (whenKey) ack.add(qualify(whenKey, refRoot).toLowerCase());
      }
    }
  };

  const addField = (name, decl) => {
    if (decl && decl.try !== undefined) {
      collectRefs(decl.try, true);
    } else if (decl && decl.parts !== undefined) {
      collectRefs(decl.parts, false);
    } else {
      for (const p of fromPaths(decl, name)) content.add(qualify(p, refRoot).toLowerCase());
    }
    if (decl && isPlainObject(decl.labelWhen)) {
      const whenKey = Object.keys(decl.labelWhen)[0];
      if (whenKey) ack.add(qualify(whenKey, refRoot).toLowerCase());
    }
  };

  const seenPartials = new Set();
  const walkEntry = (entry, allowGroup) => {
    if (typeof entry === 'string') {
      const group = lookupCI(fieldTable.groups, entry);
      if (allowGroup && Array.isArray(group)) {
        for (const member of group) walkEntry(member, false);
        return;
      }
      addField(entry, lookupCI(fieldTable.fields, entry) || {});
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
      const base = lookupCI(fieldTable.fields, name) || {};
      const { field: _f, name: _n, ...override } = entry;
      addField(name, { ...base, ...override });
    }
  };

  for (const entry of list || []) walkEntry(entry, true);
  return { content, ack, allowExtra };
}

function bodyLeafPaths(body, content) {
  const out = [];
  const contentLc = new Set([...content].map((c) => String(c).toLowerCase()));
  const hasContentBelow = (qualifiedPrefix) => {
    const p = `${qualifiedPrefix.toLowerCase()}.`;
    for (const c of contentLc) if (c.startsWith(p)) return true;
    return false;
  };
  const walk = (obj, prefix) => {
    for (const key of Object.keys(obj)) {
      const p = prefix ? `${prefix}.${key}` : key;
      const qualified = `body.${p}`;
      if (contentLc.has(qualified.toLowerCase())) continue; // rendered — and so is everything under it
      const val = obj[key];
      if (isPlainObject(val) && hasContentBelow(qualified)) walk(val, p);
      else out.push(qualified);
    }
  };
  if (isPlainObject(body)) walk(body, '');
  return out;
}

function buildFieldAudit({ fieldTable, partials, tierTemplates } = {}) {
  const table = fieldTable || { fields: {}, groups: {}, templates: {} };
  const fields = table.fields || {};
  const groups = table.groups || {};
  const templates = table.templates || {};
  const tierLists = Array.isArray(tierTemplates) ? tierTemplates : [];

  const groupsByField = new Map();
  for (const [gname, members] of Object.entries(groups)) {
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      const ref = entryName(member);
      if (!ref) continue;
      const refKey = ref.toLowerCase();
      if (!groupsByField.has(refKey)) groupsByField.set(refKey, []);
      groupsByField.get(refKey).push(gname);
    }
  }

  const readableCache = new Map();
  const readable = (list, refRoot) => {
    let byRoot = readableCache.get(list);
    if (!byRoot) { byRoot = new Map(); readableCache.set(list, byRoot); }
    let hit = byRoot.get(refRoot);
    if (!hit) { hit = readablePathsFor(list, table, partials, refRoot); byRoot.set(refRoot, hit); }
    return hit;
  };

  const isDeclared = (name) => {
    const v = lookupCI(fields, name);
    return v !== undefined && v !== null;
  };

  function listFromTemplateFor(list, tf) {
    return !!tf && Object.values(tf).some(
      (roleMap) => roleMap && typeof roleMap === 'object'
        && Object.values(roleMap).some((l) => l === list),
    );
  }

  const perItem = new Map();

  function collectForItem(item, list, opts = {}) {
    if (!list) return;
    const body = item && item.body;
    if (!isPlainObject(body)) return;
    const itemId = (item.id || item.name || '').toString();
    const refRoot = opts.refRoot || 'body';
    const { content, ack, allowExtra } = readable(list, refRoot);
    const fromTemplateFor = listFromTemplateFor(list, opts.templateFor);

    let acc = perItem.get(itemId);
    if (!acc) {
      acc = {
        content: new Set(), ack: new Set(), allowExtra: false,
        sawRealTemplate: false, bodies: [], seenBodies: new Set(),
      };
      perItem.set(itemId, acc);
    }
    for (const c of content) acc.content.add(c);
    for (const a of ack) acc.ack.add(a);
    if (allowExtra) acc.allowExtra = true;
    if (!fromTemplateFor) acc.sawRealTemplate = true;

    if (!acc.seenBodies.has(body)) {
      acc.seenBodies.add(body);
      const pa = item._projectAuthoredBody;
      acc.bodies.push({
        body,
        file: item && item._source,
        projectAuthored: Array.isArray(pa) ? new Set(pa) : null,
      });
    }
  }

  function finish(diagnostics) {
    const findings = new Map();
    for (const [itemId, acc] of perItem) {
      if (acc.allowExtra) continue;
      const { content, ack } = acc;
      for (const { body, file, projectAuthored } of acc.bodies) {
        for (const qualifiedLeaf of bodyLeafPaths(body, content)) {
          const leaf = qualifiedLeaf.slice('body.'.length);
          const leafLc = leaf.toLowerCase();
          if (ack.has(qualifiedLeaf.toLowerCase())) continue;
          const key = `${itemId}\x00${leaf}`;
          if (findings.has(key)) continue;
          if (projectAuthored && !projectAuthored.has(leafLc)) continue;

          const firstSeg = leaf.split('.')[0];
          const declKey = isDeclared(leaf) ? leaf : (isDeclared(firstSeg) ? firstSeg : null);
          const declKeyLc = declKey ? declKey.toLowerCase() : null;
          const contentTouches = declKeyLc && (content.has(`body.${declKeyLc}`)
            || [...content].some((c) => c.startsWith(`body.${declKeyLc}.`)));

          if (declKey && !contentTouches) {
            if (!acc.sawRealTemplate) continue;
            const inGroups = groupsByField.get(declKeyLc) || [];
            const where = inGroups.length
              ? `is a declared field in group ${inGroups.map((g) => `\`${g}\``).join(', ')}, which no template this item renders through includes`
              : 'is a declared field no template this item renders through includes';
            findings.set(key, {
              code: CODES.FIELD_UNREAD_MISROUTED,
              message: `body key "${leaf}" on item "${itemId}" ${where} — its content is dropped from the compiled card; include the field in a rendered template or remove it.`,
              file,
            });
          } else {
            findings.set(key, {
              code: CODES.FIELD_UNREAD_UNKNOWN,
              message: `body key "${leaf}" on item "${itemId}" is read by no template this item renders through and no declaration names it — its content is dropped from the compiled card; remove or declare and render the key.`,
              file,
            });
          }
        }
      }
    }
    for (const { code, message, file } of findings.values()) {
      diagnostics.warn(code, message, file == null ? undefined : { file: String(file) });
    }

    const named = new Set();
    const addName = (ref, allowGroup) => {
      if (!ref) return;
      const group = lookupCI(groups, ref);
      if (allowGroup && Array.isArray(group)) {
        for (const m of group) addName(entryName(m), false);
        return;
      }
      named.add(String(ref).toLowerCase());
    };
    const addFromEntry = (entry) => {
      const name = entryName(entry);
      if (name) { addName(name, true); return; }
      if (isPlainObject(entry) && entry.include !== undefined) {
        const { content, ack } = readablePathsFor([entry], table, partials);
        for (const p of content) addName(String(p).split('.')[1], false);
        for (const p of ack) addName(String(p).split('.')[1], false);
      }
    };
    for (const list of Object.values(templates)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) addFromEntry(entry);
    }
    for (const { list } of tierLists) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) addFromEntry(entry);
    }
    const src = (table._sources && table._sources[0]) || null;
    for (const name of Object.keys(fields)) {
      if (fields[name] === null || named.has(name.toLowerCase())) continue;
      diagnostics.warn(
        CODES.FIELD_DECLARED_UNUSED,
        `field "${name}" is declared in the field table but no template names it, directly or through a group, so the declaration has no effect; remove it or reference it.`,
        src == null ? undefined : { file: String(src) },
      );
    }
  }

  return { collectForItem, finish };
}

module.exports = { buildFieldAudit, readablePathsFor, bodyLeafPaths };
