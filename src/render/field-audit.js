'use strict';

/**
 * The unread-field audit (v4 spec §13.6, Phase 12 Step 4 — Decision 4).
 *
 * A field-list template names the `body:` keys it renders. Anything an item carries in
 * `body:` that no template the item renders through reads is content going nowhere, and
 * without this that is silent — the missing diagnostic the external SCHEMA.md was
 * hand-maintained to compensate for. This module raises it, splitting one symptom into the
 * three distinct failures the corpus proves exist:
 *
 *   CL0426  a `body:` key no declaration names            — a typo; content dropped
 *   CL0427  a key declared but read by none of the item's — misrouted; names the group
 *           renders
 *   CL0428  a declared field no template names            — a dead declaration
 *
 * All three are WARN and none is an opinion code (§12.5): a field is read or it is not,
 * there is no guess about intent. `lint.level` must not reach them.
 *
 * ── Per item, not per template (§13.6) ────────────────────────────────────────
 *
 * An item can render through several field lists on one branch — its story card, a Plot
 * Essentials roster slot, a terse context tier — and a key read by *any* of them is read.
 * `collectForItem` accumulates the union of every list's content paths per item id across
 * the whole compile; `finish()` walks each body once against that union. So `secret`, in
 * the full `Character` list but not the roster's, is not a misroute on the roster render.
 *
 * ── The mechanics that make it usable ────────────────────────────────────────
 *
 * **Dedupe on `(item id, field path)`.** `body:` fields resolve once per `variants:` /
 * `branches:` expansion, so the raw check fires 32 times on The Institute for one mistake.
 * Findings are keyed and collapsed, and `finish()` emits one per key (§4.4).
 *
 * **Only project-authored keys, for an imported item.** A `body:` key that arrived through
 * `import:` unchanged is the library author's concern; `resolveItem` stamps
 * `_projectAuthoredBody` with the leaves the consuming project introduced or changed, and
 * CL0426/CL0427 fire only on those. A pure local item carries no stamp and every key is in
 * scope — the unchanged behavior.
 *
 * **`allowExtra: true` opts a template out**, carried as a `{ allowExtra: true }` marker
 * in the template's list rather than per field — Directory and Unstructured compose their
 * bodies from author-shaped sub-keys feeding an interpolated value, and the property
 * belongs to the template. Any one of an item's lists carrying it opts the item out.
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

/**
 * Case-insensitive own-property lookup, matching the renderer's field matching (a
 * declaration `background` reads a body key `Background`). Exact-case hit wins first, so
 * behavior is unchanged where cases already match.
 */
function lookupCI(map, name) {
  if (!map || !name) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
  const lower = String(name).toLowerCase();
  const key = Object.keys(map).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : map[key];
}

/** `from:` as an array, or `[name]` when absent. Entries may be bare (root-relative) or
 * `$`-prefixed (absolute); `qualify` below resolves either into a root-qualified path. */
function fromPaths(decl, name) {
  if (decl && decl.from !== undefined && decl.from !== null) {
    return Array.isArray(decl.from) ? decl.from.map(String) : [String(decl.from)];
  }
  return name ? [name] : [];
}

/**
 * Root-qualify a dotted path. A bare path is root-relative — it takes `refRoot` (`body`
 * for a story-card/component render, `notes` for a `templateFor.notes` list). A
 * `$`-prefixed path is already absolute (`$body.X`, `$notes.X`, or another root such as
 * `$name.full`) and qualifies to itself with the `$` stripped — including to a root that
 * can never match a body leaf, which is what lets a `$name.` / `$aid.` ref fall out of the
 * body audit for free, with no exclusion rule to write.
 */
function qualify(path, refRoot) {
  const s = String(path);
  return s.startsWith('$') ? s.slice(1) : `${refRoot}.${s}`;
}

const IF_GUARD_RE = /\{if\s+\$(body|notes)\.([\w.]+)/g;
const IF_TAG_RE = /\{\/?if\b[^}]*\}/g;
const BODY_REF_RE = /\$(body|notes)\.([\w.]+)/g;
const INCLUDE_RE = /\{include\s+([\w.-]+)\s*\}/g;

/**
 * Resolve a template list to `{ content, ack, allowExtra }`.
 *
 * `content` and `ack` hold root-qualified dotted paths (`body.X`, `notes.X`) rather than
 * the bare or `$`-prefixed spelling a declaration or raw block used — qualifying by root
 * is what keeps a `$notes.known` reference from also marking a `body.known` key read, and
 * what makes a `$`-prefixed `from:` path readable at all (§ latent bug, 2026-09-03 handoff).
 *
 * `content` — dotted paths that are rendered; a body path equal to or under one is read.
 * `ack`     — dotted paths named only by an `{if $body.X}` / `{if $notes.X}` existence
 *             guard; the exact path is not a finding, but its children still are.
 *
 * @param {string} refRoot  the root a *bare* path in this list qualifies to — `body` for a
 *   story-card/component render, `notes` for a `templateFor.notes` list. A raw block's own
 *   `$body.` / `$notes.` references are already absolute and ignore this.
 */
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

  /**
   * `parts:` (Decision 8's field-audit half, applied to the composition primitive): every
   * ref at every depth must reach `content`, root-qualified, or a `parts:` field the item
   * genuinely reads raises a phantom CL0428 dead-declaration finding. A `$`-prefixed entry
   * is a ref; any other string is a literal and contributes nothing; a mapping is a nested
   * declaration, walked the same way `addField` walks a top-level one — recursively through
   * its own `parts:`, and through `from:` if it carries that instead (the two are mutually
   * exclusive by CL0422, but this does not assume the loader caught it).
   */
  const collectPartsRefs = (parts) => {
    for (const entry of parts || []) {
      if (typeof entry === 'string') {
        if (entry.startsWith('$')) content.add(qualify(entry, refRoot).toLowerCase());
        continue; // a literal — no ref
      }
      if (!isPlainObject(entry)) continue;
      if (entry.from !== undefined) {
        for (const p of fromPaths(entry, undefined)) content.add(qualify(p, refRoot).toLowerCase());
      }
      if (entry.parts !== undefined) collectPartsRefs(entry.parts);
      if (entry.try !== undefined) collectTryRefs(entry.try);
      if (isPlainObject(entry.labelWhen)) {
        const whenKey = Object.keys(entry.labelWhen)[0];
        if (whenKey) ack.add(qualify(whenKey, refRoot).toLowerCase());
      }
    }
  };

  /**
   * `try:` (Decision 7's field-audit half): every source is read, whichever one resolves at
   * render time, so all of them must reach `content` — unlike `parts:`'s literals, `try:`
   * has no non-source entries to skip. A bare string follows `from:`'s ref rules (root-
   * relative, qualified by `refRoot`) and a `$`-prefixed string is already absolute; a
   * mapping is a nested declaration, walked the same way `addField` walks a top-level one.
   */
  const collectTryRefs = (list) => {
    for (const entry of list || []) {
      if (typeof entry === 'string') {
        content.add(qualify(entry, refRoot).toLowerCase());
        continue;
      }
      if (!isPlainObject(entry)) continue;
      if (entry.from !== undefined) {
        for (const p of fromPaths(entry, undefined)) content.add(qualify(p, refRoot).toLowerCase());
      }
      if (entry.parts !== undefined) collectPartsRefs(entry.parts);
      if (entry.try !== undefined) collectTryRefs(entry.try);
      if (isPlainObject(entry.labelWhen)) {
        const whenKey = Object.keys(entry.labelWhen)[0];
        if (whenKey) ack.add(qualify(whenKey, refRoot).toLowerCase());
      }
    }
  };

  const addField = (name, decl) => {
    if (decl && decl.try !== undefined) {
      collectTryRefs(decl.try);
    } else if (decl && decl.parts !== undefined) {
      collectPartsRefs(decl.parts);
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

/** Flatten `body` to `body.`-qualified dotted leaf paths, stopping descent at a content
 * path. `content` is itself root-qualified (`body.X` / `notes.X`), so a `notes.` entry
 * never suppresses a `body.` leaf — qualifying both sides is what closes that collapse. */
function bodyLeafPaths(body, content) {
  const out = [];
  // Comparisons are case-folded (the renderer matches body fields case-insensitively); a
  // caller may pass a content set in either case, so fold a working copy rather than assume.
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

/**
 * @param {object} deps  `{ fieldTable, partials, tierTemplates }` — the merged §13 table,
 *   the loaded partial map, and every field list a project's `templateFor` slot files
 *   produce across the branch tree (`[{ branch, role, name, list }]`, from
 *   `gatherTierTemplates`). All three are compile-wide. `tierTemplates` feeds the
 *   dead-declaration sweep only — the CL0427 tier suppression works off the branch's own
 *   resolved `templateFor` map, passed to `collectForItem` per render.
 * @returns {{ collectForItem: function, finish: function }}
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
      const refKey = ref.toLowerCase();
      if (!groupsByField.has(refKey)) groupsByField.set(refKey, []);
      groupsByField.get(refKey).push(gname);
    }
  }

  // list reference → refRoot → { content, ack, allowExtra }. Keyed on both, in case the
  // same list object is ever read under two roots (not true of today's two call sites,
  // which are both `body`, but nothing here should assume it stays that way).
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

  /** Did `list` come from a branch's `templateFor` map (a context tier or a component
   * rendering role, §13.4) rather than the shared field table? Reference identity against
   * the same resolved map the leaf loop passed — no second resolve. Such a list omits
   * declared fields by design, so its omissions are never CL0427 misroutes. */
  function listFromTemplateFor(list, tf) {
    return !!tf && Object.values(tf).some(
      (roleMap) => roleMap && typeof roleMap === 'object'
        && Object.values(roleMap).some((l) => l === list),
    );
  }

  // item id → the audit state accumulated across *every* list this item renders through:
  // its story-card body render, each slot placement, each tier variant. The check is
  // per-item, not per-template (§13.6) — a field read by one of an item's renders is read,
  // even if another render omits it — so the leaf walk is deferred to `finish()`, once the
  // union is complete.
  //   { content:Set, ack:Set, allowExtra:bool, sawRealTemplate:bool,
  //     bodies:[{ body, file, projectAuthored:Set|null }], seenBodies:Set }
  const perItem = new Map();

  // `templateName` is kept in the signature for call-site symmetry with the render paths
  // that pass it; the per-item check names no single template, so it is not read here.
  // `opts.refRoot` is the root a bare path in `list` qualifies to — `body` for a
  // story-card/component render, `notes` for a `templateFor.notes` list; defaults to
  // `body` since every call site today is a body render.
  function collectForItem(item, list, templateName, opts = {}) {
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
      // Fix 1 (§13.6): only body keys the consuming project introduced or changed are this
      // compile's to answer for. `resolveItem` stamps the list; absent (a pure local item,
      // or a non-import def) means every key is in scope, which is the unchanged behavior.
      const pa = item._projectAuthoredBody;
      acc.bodies.push({
        body,
        file: item && item._source,
        projectAuthored: Array.isArray(pa) ? new Set(pa) : null,
      });
    }
  }

  /** Emit every deduped finding, then the whole-table dead-declaration sweep (CL0428). */
  function finish(diagnostics) {
    if (!diagnostics) return;

    // (item id \x00 field path) → { code, message, file }
    const findings = new Map();
    for (const [itemId, acc] of perItem) {
      if (acc.allowExtra) continue;
      const { content, ack } = acc;
      for (const { body, file, projectAuthored } of acc.bodies) {
        for (const qualifiedLeaf of bodyLeafPaths(body, content)) {
          // `qualifiedLeaf` is `body.X` (bodyLeafPaths only ever walks item.body); strip
          // the root back off for the bare leaf everything downstream — declaredness,
          // messages, `projectAuthored` — already speaks in.
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

          // CL0427 only when the declared field is genuinely routed elsewhere — nothing
          // about it is read by any of this item's renders. A sub-key of a field one of
          // them *does* read (a typo such as `magic.focus` against
          // `from: [magic.affinity, magic.effect]`) is CL0426.
          if (declKey && !contentTouches) {
            // Every list this item rendered through was a `templateFor` slot/tier list,
            // each of which omits declared fields on purpose — the full list for the
            // role/type reads the field. Not a misroute; the CL0428 sweep below still
            // flags a field named by no list anywhere.
            if (!acc.sawRealTemplate) continue;
            const inGroups = groupsByField.get(declKeyLc) || [];
            const where = inGroups.length
              ? `is a declared field in group ${inGroups.map((g) => `\`${g}\``).join(', ')}, which no template this item renders through includes`
              : 'is a declared field no template this item renders through includes';
            findings.set(key, {
              code: CODES.FIELD_UNREAD_MISROUTED,
              message: `body key "${leaf}" on item "${itemId}" ${where} — its content is dropped from the compiled card.`,
              file,
            });
          } else {
            findings.set(key, {
              code: CODES.FIELD_UNREAD_UNKNOWN,
              message: `body key "${leaf}" on item "${itemId}" is read by no template this item renders through and no declaration names it — its content is dropped from the compiled card.`,
              file,
            });
          }
        }
      }
    }
    for (const { code, message, file } of findings.values()) {
      diagnostics.warn(code, message, file == null ? undefined : { file: String(file) });
    }

    // CL0428: a declared field named by no `templates:` list (directly or through a group
    // a list includes). The counterpart to CL0545's unused-role check — what stops the
    // field table rotting the way a hand-maintained document does.
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
    // A list entry contributes its name (a bare field, or a `{ field }` / `{ name }`
    // object) directly. An `{ include: partial }` entry contributes every `$body.` /
    // `$notes.` field the partial references — `readablePathsFor` already opens partials
    // and follows nested includes for CL0426/CL0427, and CL0428 has to see the same reads
    // or it reports a partial-only field dead. `content`/`ack` are root-qualified
    // (`body.X` / `notes.X`); the segment after the root is the field name — a deeper
    // `from:` path (`physical traits.gender`) resolves to a segment that is not a declared
    // field, which the `Object.keys(fields)` loop below simply never matches.
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
    // §13.4 — a field named only by a branch's `templateFor` slot file is used, not dead.
    // Fold every tier list into the same "named" set so a tier-only field (a terse
    // `backgroundBrief`, an opt-back-in `CharacterFull` member) does not raise CL0428.
    for (const { list } of tierLists) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) addFromEntry(entry);
    }
    const src = (table._sources && table._sources[0]) || null;
    for (const name of Object.keys(fields)) {
      if (fields[name] === null || named.has(name.toLowerCase())) continue;
      diagnostics.warn(
        CODES.FIELD_DECLARED_UNUSED,
        `field "${name}" is declared in the field table but no template names it, directly or through a group.`,
        src == null ? undefined : { file: String(src) },
      );
    }
  }

  return { collectForItem, finish };
}

module.exports = { CODES, buildFieldAudit, readablePathsFor, bodyLeafPaths };
