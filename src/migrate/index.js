'use strict';

/**
 * The whole v3 to v4 migration, in the one order that works (§14.2).
 *
 * The pieces existed before this file and had no entry point, which is how the Plot
 * Essentials conversion came to be missing for a whole phase: nothing named the full
 * sequence, so nothing showed the gap in it.
 *
 * ── Why the order is fixed ──────────────────────────────────────────────────
 *
 * Each step depends on the previous one having landed on disk. The config break has to come
 * first, because every later step reads the project through the compiler's own loader and
 * that loader rejects a v3 config outright. Item files come next, since the Plot Essentials
 * conversion looks items up to learn what a block resolved to. The notes template is wired
 * after items, because only then is it known whether anything needs it. Plot Essentials is
 * last, and is the only step that moves content between files.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const v3 = require('./v3');
const { migratePlotEssentialsFiles } = require('./plot-essentials-apply');
const { migrateDescriptionFiles } = require('./description');
const { migrateOpeningFiles } = require('./opening');
const { PRONOUN_SETS } = require('../model/pronouns');

/**
 * Point `render.notesTemplate` at a notes template, once `aid.known` has become `notes:`.
 *
 * Without this the conversion is half-done in a way that shows up only in the output: the
 * marker is carried on every item and rendered by nothing, so every `[e]` in the project
 * disappears. v3 emitted it from `{if $aid.known}` inside each body template, and §4.5.1
 * moved that to a named notes template — which is a config edit, not an item edit, and so
 * belongs to no per-item pass.
 *
 * Wired only when a template actually exists, on the same rule the `.hint` and `.you`
 * siblings use: guessing a name that resolves to nothing would trade a silent omission for
 * a loud crash without making the project any more correct.
 */
function wireNotesTemplate(configPath, options = {}) {
  const notes = [];
  const { loadCompileConfig, loadTemplates, loadItemsFromDir } = require('../loader');
  const { buildCanonRegistry } = require('../loader/registry');

  const saved = { log: console.log, warn: console.warn, error: console.error };
  let templateNames;
  let config;
  let needsOne = false;
  try {
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    config = loadCompileConfig(configPath);
    const { templates } = loadTemplates(config._resolvedTemplates);
    templateNames = new Map([...templates.keys()].map((k) => [String(k).toLowerCase(), k]));

    // Asked of the whole project, not of what this run happened to change. Baseline is the
    // case that forced it: its items are all canon imports, and the shared canon already
    // carried `notes: {known: true}` — so nothing local converted, and the marker still
    // needed a template. A `notes:` string renders verbatim and needs none; only a mapping
    // does, because a mapping is a field set that something has to lay out.
    const isMarker = (item) => item && item.notes && typeof item.notes === 'object'
      && !Array.isArray(item.notes);
    const canon = buildCanonRegistry(config._resolvedLibrary);
    for (const [, item] of canon) if (isMarker(item)) { needsOne = true; break; }
    if (!needsOne) {
      for (const item of loadItemsFromDir(config._resolvedItems)) {
        if (isMarker(item)) { needsOne = true; break; }
      }
    }
  } finally {
    Object.assign(console, saved);
  }

  if (!needsOne) return { notes, changed: false };
  if (config.render && config.render.notesTemplate) return { notes, changed: false };

  const name = templateNames.get('notes');
  if (!name) {
    notes.push(
      'no "Notes.template" found, so render.notesTemplate is not wired. Any item that carried '
      + 'aid.known now has notes: {known: true} and nothing renders it — write a template '
      + 'containing {if $notes.known}[e]{/if} and point render.notesTemplate at it (§4.5.1).',
    );
    return { notes, changed: false };
  }

  const source = fs.readFileSync(configPath, 'utf8');
  const doc = YAML.parseDocument(source);
  let render = doc.get('render', true);
  if (!YAML.isMap(render)) {
    render = doc.createNode({});
    doc.set('render', render);
  }
  render.set('notesTemplate', name);
  if (!options.dryRun) fs.writeFileSync(configPath, doc.toString({ lineWidth: 0 }), 'utf8');

  notes.push(
    'wired render.notesTemplate to "' + name + '" — aid.known became notes: {known: true}, and '
    + 'without a notes template the marker is carried and never emitted (§4.5.1).',
  );
  return { notes, changed: true };
}

// ── Pseudo-roles (§9.1, §9.5, Phase 8 Step 3) ────────────────────────────────

/**
 * The gendered pronoun words the review queue watches for — read off `PRONOUN_SETS`
 * rather than hand-listed, so the queue and the token-pass resolver agree by construction
 * (per the Session B handoff). `verb_is`/`verb_was` are excluded: "is" and "was" are
 * shared with every other pronoun set and would flag nearly every sentence.
 */
const GENDERED_PRONOUN_FIELDS = ['subject', 'object', 'possessive', 'reflexive', 'contraction'];
const GENDERED_PRONOUN_WORDS = [...new Set(
  ['female', 'male'].flatMap((set) => GENDERED_PRONOUN_FIELDS.map((field) => PRONOUN_SETS[set][field])),
)];
const GENDERED_PRONOUN_RE = new RegExp(
  `\\b(?:${GENDERED_PRONOUN_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite `{%name}` to `{$ROLE}` in a string, moving a trailing `'s` inside the brace.
 *
 * `{%li}'s` and `{$LI's}` render the same possessive text, but only the second reaches
 * `applyTokenPass`'s protagonist check (pronouns.js `:229`) — a token-for-token rewrite
 * that left the apostrophe outside would look correct and silently drop that check.
 */
function rewritePseudoRoleTokens(text, name, roleName) {
  const possessive = new RegExp(`\\{%${escapeRegExp(name)}\\}'s`, 'gi');
  const plain = new RegExp(`\\{%${escapeRegExp(name)}\\}`, 'gi');
  let changed = false;
  let out = text.replace(possessive, () => { changed = true; return `{$${roleName}'s}`; });
  out = out.replace(plain, () => { changed = true; return `{$${roleName}}`; });
  return { text: out, changed };
}

/** True for any file the pseudo-role pass reads as prose: items, components, templates. */
function isProseFile(name) {
  return /\.(ya?ml|md|template|partial)$/i.test(name);
}

function walkFiles(dir, skip, fn) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkFiles(full, skip, fn); continue; }
    if (!entry.isFile() || !isProseFile(entry.name)) continue;
    if (skip && path.resolve(full) === path.resolve(skip)) continue;
    fn(full);
  }
}

/**
 * Convert a v3 hand-rolled pseudo-role — a variable whose value is a character's item id,
 * standing in for the `roles:` indirection §9.2 gives a name (§9.1's `li: Malcolm`) — into
 * a real role, and emit §9.5's review queue.
 *
 * Runs after the config break and after item structural migration, on the compiler's own
 * loader (`wireNotesTemplate`'s neighbor): both `migrateConfigDocument` (edits a bare YAML
 * Document, no registry in reach) and `migrateProjectFiles` (string rewriting with nothing
 * to resolve against) run before the project is loadable, and "does this variable's value
 * name a known item" needs a registry to ask.
 *
 * Detection (the handoff's one open question, settled here): a variable converts only if
 * (a) it is referenced as `{%name}` somewhere in item or component prose, and (b) every
 * value it is ever bound to — root and every branch — resolves to a known item id. (a)
 * is load-bearing on its own: a project may declare other variables whose values happen to
 * name an item (The Institute's `protag`/`liname`, used only to build `openingFile`'s
 * path) without ever meaning them as a role, and (a) is what keeps those from converting.
 * A false positive is the most destructive thing this migrator can do — it rewrites prose
 * in every file — so every conversion is named in the notes for review rather than made
 * silently.
 */
function migratePseudoRoles(configPath, options = {}) {
  const notes = [];
  const touched = [];
  const conversions = [];
  const reviewQueue = [];
  const projectDir = path.dirname(configPath);

  const { loadCompileConfig, loadItemsFromDir, buildRegistry, mergeRegistries } = require('../loader');
  const { buildCanonRegistry } = require('../loader/registry');

  const saved = { log: console.log, warn: console.warn, error: console.error };
  let registry;
  try {
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    const config = loadCompileConfig(configPath);
    const canonRegistry = buildCanonRegistry(config._resolvedLibrary);
    const projectItems = loadItemsFromDir(config._resolvedItems).filter((d) => !d.include);
    const projectRegistry = buildRegistry(projectItems, 'project');
    registry = mergeRegistries(canonRegistry, projectRegistry);
  } finally {
    Object.assign(console, saved);
  }

  // Step 1: names actually used as {%name} in prose. Config-only variables (path pieces,
  // scenario switches) never reach this set, no matter what their value looks like.
  const usedNames = new Set();
  walkFiles(projectDir, configPath, (full) => {
    const text = fs.readFileSync(full, 'utf8');
    for (const m of text.matchAll(/\{%([A-Za-z0-9_]+)\}/g)) usedNames.add(m[1].toLowerCase());
  });
  if (usedNames.size === 0) return { notes, touched, conversions, reviewQueue };

  // Step 2: every declared value of each such name, at root and every branch.
  const source = fs.readFileSync(configPath, 'utf8');
  const doc = YAML.parseDocument(source);
  const declaredAt = new Map(); // lowercase name -> [{ nodePath, key, value }]

  const collectAt = (nodePath) => {
    const vars = doc.getIn([...nodePath, 'variables']);
    if (!YAML.isMap(vars)) return;
    for (const pair of vars.items) {
      const key = String(pair.key.value);
      const lower = key.toLowerCase();
      if (!usedNames.has(lower)) continue;
      const value = pair.value && pair.value.value;
      if (typeof value !== 'string') continue;
      if (!declaredAt.has(lower)) declaredAt.set(lower, []);
      declaredAt.get(lower).push({ nodePath, key, value });
    }
  };
  collectAt([]);
  const walkBranches = (branchPath) => {
    const node = doc.getIn(branchPath);
    if (!YAML.isMap(node)) return;
    for (const pair of node.items) {
      const name = String(pair.key.value);
      collectAt([...branchPath, name]);
      walkBranches([...branchPath, name, 'branches']);
    }
  };
  walkBranches(['branches']);

  // Step 3: a name is a pseudo-role only if every binding it was ever given resolves — one
  // unconverted binding means it is an ordinary variable that happens to share a value
  // with an item somewhere, not a role (rebinding to a *different* known item, as `li`
  // does across The Institute's branches, is corroboration but is not required).
  const candidates = [];
  for (const [lower, bindings] of declaredAt) {
    if (bindings.every((b) => registry.has(b.value.toLowerCase()))) {
      candidates.push({ name: bindings[0].key, roleName: bindings[0].key.toUpperCase(), bindings });
    }
  }
  if (candidates.length === 0) return { notes, touched, conversions, reviewQueue };

  // Step 4: move each candidate from variables: to roles: at every node it was declared,
  // and rewrite {%name} to {$ROLE} in the config's own scalars — a component's text can be
  // written inline in compile.yaml (§9.7) as well as in a separate file.
  for (const { name, roleName, bindings } of candidates) {
    for (const { nodePath } of bindings) {
      const value = doc.getIn([...nodePath, 'variables', name], true);
      doc.setIn([...nodePath, 'roles', roleName], value);
      doc.deleteIn([...nodePath, 'variables', name]);
    }
    conversions.push({ name, roleName, values: [...new Set(bindings.map((b) => b.value))] });
  }
  YAML.visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value !== 'string') return;
      let next = node.value;
      let changed = false;
      for (const { name, roleName } of candidates) {
        const result = rewritePseudoRoleTokens(next, name, roleName);
        next = result.text;
        changed = changed || result.changed;
      }
      if (changed) {
        if (GENDERED_PRONOUN_RE.test(next)) {
          reviewQueue.push({ file: path.relative(projectDir, configPath), line: null, text: next.trim() });
        }
        node.value = next;
        delete node.type;
      }
    },
  });
  const output = doc.toString({ lineWidth: 0 });
  if (output !== source) {
    if (!options.dryRun) fs.writeFileSync(configPath, output, 'utf8');
    touched.push(configPath);
  }

  // Step 5: the same rewrite over every other prose file, tracking the review queue —
  // every line that now carries a converted role token beside a hardcoded gendered
  // pronoun (§9.1's own TI.Veryn.yaml case: "{$LI} was your secret lover ... his betrayal").
  walkFiles(projectDir, configPath, (full) => {
    const fileSource = fs.readFileSync(full, 'utf8');
    let text = fileSource;
    let changed = false;
    for (const { name, roleName } of candidates) {
      const result = rewritePseudoRoleTokens(text, name, roleName);
      text = result.text;
      changed = changed || result.changed;
    }
    if (!changed) return;
    if (!options.dryRun) fs.writeFileSync(full, text, 'utf8');
    touched.push(full);

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!candidates.some(({ roleName }) => line.includes(`{$${roleName}`))) continue;
      if (GENDERED_PRONOUN_RE.test(line)) {
        reviewQueue.push({ file: path.relative(projectDir, full), line: i + 1, text: line.trim() });
      }
    }
  });

  for (const { name, roleName, values } of conversions) {
    notes.push(
      `converted variable "${name}" to role "${roleName}" — its value (${values.join(', ')}) resolved `
      + 'to a known item id everywhere it was bound (§9.1, §9.2). Check the review queue for prose '
      + 'combining the new role token with a hardcoded pronoun.',
    );
  }

  return { notes, touched, conversions, reviewQueue };
}

/**
 * Phase 4's migration step, which converts nothing — and says so out loud (§15).
 *
 * There is no v3 Codex Loom syntax for player placeholders. `placeholders:` is a new
 * `compile.cl.yaml` key with no v3 spelling to rename from, and no v3 project holds the
 * data in some other form: measured across `Git\Scenarios`, all eighteen projects with a
 * `compile.yaml` have no `Placeholders.yaml` and no `%key%` anywhere in their sources.
 *
 * The two `Placeholders.yaml` files that do exist in that repo belong to hand-authored
 * Velvet Lattice trees — Traveling Terraces and MonsterEvolution — which have no `Loom/`
 * directory and no config, so the migrator never sees them. Adopting one into Codex Loom
 * means reading a VL tree and producing a project from it, which is a different tool from
 * the v3-to-v4 migrator and is not this function's job.
 *
 * **This exists because a no-op that is merely true is indistinguishable from one that was
 * forgotten.** §15's rule — a phase that changes syntax and does not name its migration
 * step has not finished planning — was written after Phase 3 recorded "migrate/v3.js
 * untouched, per plan" and nothing carried the obligation forward, so the migrator silently
 * lacked the one phase that changed structure for months. A stage that returns a note is
 * checkable; an absence is not.
 */
function migratePlaceholders() {
  return {
    changed: false,
    notes: [],
  };
}

/**
 * Rename the entry point to `compile.cl.yaml` (§4.6), when asked and only when asked.
 *
 * §4.6 settles the default: plain `.yaml` is not deprecated, every loader accepts both
 * suffixes, and `--migrate` renames only on request. §14.2's table listed the rename beside
 * `version: 4` as though it were unconditional, which is the half of the row the migrator
 * never implemented — so the table claimed a transformation that did not exist while the
 * spec elsewhere said it should not happen by default. This closes it as an option rather
 * than as a default, which is what §4.6 asks for.
 *
 * **The entry point only, not every file Codex Loom authors.** §4.6's naming convention is
 * uniform across items, components and lint packs, but a migrator that renamed those would
 * have to rewrite every `include:` and every component path that names them, and an
 * un-rewritten reference fails at load rather than degrading. The entry point has no such
 * dependents: it is located by directory search, and `structure.input` paths resolve
 * relative to its directory regardless of what it is called. Renaming the rest is a
 * reference-rewriting pass, and belongs with whatever builds the `--migrate` CLI surface.
 *
 * Runs last. Every earlier stage reads the project back through the compiler's own loader
 * using `configPath`, so moving the file before they run would invalidate the handle they
 * were given.
 */
function renameConfigToCl(configPath, options = {}) {
  const notes = [];
  if (path.basename(configPath) !== 'compile.yaml') {
    return { notes, changed: false, configPath };
  }

  const target = path.join(path.dirname(configPath), 'compile.cl.yaml');
  if (fs.existsSync(target)) {
    notes.push(
      'compile.cl.yaml already exists beside compile.yaml, so the rename was skipped. Two '
      + 'configs in one directory is a load-time ERROR (§4.6) — delete whichever is stale.',
    );
    return { notes, changed: false, configPath };
  }

  if (!options.dryRun) fs.renameSync(configPath, target);
  notes.push('renamed compile.yaml to compile.cl.yaml (§4.6).');
  return { notes, changed: true, configPath: target };
}

/**
 * Migrate a v3 project in place. Returns every note the run produced.
 *
 * Notes are the deliverable as much as the edits are: slot names are guesses, a dropped
 * `isPlayer` is a judgement, and a missing item entry is work left for the author. A caller
 * that ignores them has not finished migrating.
 */
function migrateProjectFully(configPath, options = {}) {
  const notes = [];
  const touched = [];
  const projectDir = path.dirname(configPath);

  const config = v3.migrateConfigFile(configPath, options);
  for (const name of config.unresolved) {
    notes.push('unresolved {@' + name + '} in compile.yaml — no canon or component alias matches it.');
  }

  const rewritten = v3.migrateProjectFiles(projectDir, config.aliases, config.canonNames, {
    ...options, configPath,
  });
  touched.push(...rewritten.touched);
  for (const entry of rewritten.unresolved) {
    notes.push('unresolved {@' + entry.name + '} in ' + entry.file + '.');
  }

  const items = v3.migrateItemFiles(projectDir, options);
  touched.push(...items.touched);
  notes.push(...items.notes.map((n) => n.note));

  const wired = wireNotesTemplate(configPath, options);
  notes.push(...wired.notes);
  if (wired.changed) touched.push(configPath);

  // Phase 8 Step 3 (§9.1, §9.2). Beside wireNotesTemplate for the same reason: both need
  // the project read back through the compiler's own loader, which only exists once the
  // config break above has run.
  const pseudoRoles = migratePseudoRoles(configPath, options);
  notes.push(...pseudoRoles.notes);
  touched.push(...pseudoRoles.touched);

  const pe = migratePlotEssentialsFiles(configPath, options);
  notes.push(...pe.notes);
  touched.push(...pe.touched);

  // §7.7. After the config stage, because the description's path is read through
  // `buildCompileContext` and that needs a v4-valid config to resolve an alias.
  const desc = migrateDescriptionFiles(configPath, options);
  notes.push(...desc.notes);
  touched.push(...desc.touched);

  // §7.1's fourth syntax. Same position as the description stage and for the same reason:
  // the opening's path is read through `buildCompileContext`, which needs a v4-valid config.
  const opening = migrateOpeningFiles(configPath, options);
  notes.push(...opening.notes);
  touched.push(...opening.touched);

  // Phase 4. Deliberately last and deliberately empty — see migratePlaceholders.
  const placeholders = migratePlaceholders();
  notes.push(...placeholders.notes);

  // §4.6, opt-in. After every stage that reads the project back through configPath.
  let finalConfigPath = configPath;
  if (options.renameToCl) {
    const renamed = renameConfigToCl(configPath, options);
    notes.push(...renamed.notes);
    if (renamed.changed) touched.push(renamed.configPath);
    finalConfigPath = renamed.configPath;
  }

  return {
    notes, touched, changes: config.changes, configPath: finalConfigPath,
    reviewQueue: pseudoRoles.reviewQueue,
  };
}

module.exports = {
  migrateProjectFully, wireNotesTemplate, migratePlaceholders, renameConfigToCl,
  migratePseudoRoles, rewritePseudoRoleTokens, GENDERED_PRONOUN_RE, GENDERED_PRONOUN_WORDS,
};
