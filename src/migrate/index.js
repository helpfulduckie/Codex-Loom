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
const { Diagnostics } = require('../diag');

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
  const { loadTemplates } = require('../loader');
  const { loadCompileConfig } = require('../config/load');
  const { loadItemsFromDir, buildCanonRegistry } = require('../loader/registry');
  const { Diagnostics } = require('../diag');

  // A private bus soaks up the loaders' diagnostics: this pass answers one yes/no question
  // about the project and reports nothing of its own. `loadCompileConfig` returns null for a
  // config it cannot load at all (Phase 17 Step 8) — nothing to inspect, so nothing to wire.
  const diagnostics = new Diagnostics();
  const config = loadCompileConfig(configPath, { diagnostics });
  if (!config) {
    notes.push(
      'could not load the migrated config to check whether a notes template is needed — '
      + 'render.notesTemplate is left unwired. Re-run --migrate once the config loads.',
    );
    return { notes, changed: false };
  }

  const { templates } = loadTemplates(config._resolvedTemplates, { diagnostics });
  const templateNames = new Map([...templates.keys()].map((k) => [String(k).toLowerCase(), k]));

  // Asked of the whole project, not of what this run happened to change. Baseline is the
  // case that forced it: its items are all canon imports, and the shared canon already
  // carried `notes: {known: true}` — so nothing local converted, and the marker still
  // needed a template. A `notes:` string renders verbatim and needs none; only a mapping
  // does, because a mapping is a field set that something has to lay out.
  const isMarker = (item) => item && item.notes && typeof item.notes === 'object'
    && !Array.isArray(item.notes);
  let needsOne = false;
  const canon = buildCanonRegistry(config._resolvedLibrary, { diagnostics });
  for (const [, item] of canon) if (isMarker(item)) { needsOne = true; break; }
  if (!needsOne) {
    for (const item of loadItemsFromDir(config._resolvedItems, { diagnostics })) {
      if (isMarker(item)) { needsOne = true; break; }
    }
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
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GENDERED_PRONOUN_FIELDS = ['subject', 'object', 'possessive', 'reflexive', 'contraction'];
const GENDERED_PRONOUN_WORDS = [...new Set(
  ['female', 'male'].flatMap((set) => GENDERED_PRONOUN_FIELDS.map((field) => PRONOUN_SETS[set][field])),
)];
const GENDERED_PRONOUN_RE = new RegExp(
  `\\b(?:${GENDERED_PRONOUN_WORDS.map((w) => escapeRegExp(w)).join('|')})\\b`,
  'i',
);

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
 * Document, no registry in reach) and the `{@}` rewrite folded into `migrateItemFiles`
 * (a parsed-Document scalar walk, nothing to resolve against) run before the project is
 * loadable, and "does this variable's value name a known item" needs a registry to ask.
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

  const { loadCompileConfig } = require('../config/load');
  const { loadItemsFromDir, buildRegistry, mergeRegistries, buildCanonRegistry } = require('../loader/registry');
  const { Diagnostics } = require('../diag');

  // Every loader here takes the bus: the registry builders throw a raw `Error` on a
  // duplicate id without one (and `--migrate` treats any throw from here as a fatal abort),
  // so a bus routes the clash to CL0140 / CL0141 — the codes the compile path raises — and
  // the run finishes with the finding in the report. The loader's own path/YAML warnings
  // land on the same bus and are dropped; only the errors reach the notes below.
  const diagnostics = new Diagnostics();
  const config = loadCompileConfig(configPath, { diagnostics });
  if (!config) {
    notes.push(
      'could not load the migrated config, so the pseudo-role pass was skipped. '
      + 'Re-run --migrate once the config loads.',
    );
    return { notes, touched, conversions, reviewQueue };
  }
  const canonRegistry = buildCanonRegistry(config._resolvedLibrary, { diagnostics });
  const projectItems = loadItemsFromDir(config._resolvedItems, { diagnostics }).filter((d) => !d.include);
  const projectRegistry = buildRegistry(projectItems, 'project', { diagnostics });
  const registry = mergeRegistries(canonRegistry, projectRegistry, { diagnostics });
  for (const diag of diagnostics.errors) {
    notes.push(`${diag.code}: ${diag.message.replace(/\n\s*/g, ' ')}`);
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

  // Item structural migration and the {@} rewrite are one walk: a single parsed-Document
  // pass per file gives every file the fidelity compile.yaml already gets, where a {@foo}
  // in a comment is left alone rather than rewritten by a blind string replace.
  const items = v3.migrateItemFiles(projectDir, config.aliases, config.canonNames, {
    ...options, configPath,
  });
  touched.push(...items.touched);
  notes.push(...items.notes.map((n) => n.note));
  for (const entry of items.unresolved) {
    notes.push('unresolved {@' + entry.name + '} in ' + entry.file + '.');
  }

  const wired = wireNotesTemplate(configPath, options);
  notes.push(...wired.notes);
  if (wired.changed) touched.push(configPath);

  // Phase 8 Step 3 (§9.1, §9.2). Beside wireNotesTemplate for the same reason: both need
  // the project read back through the compiler's own loader, which only exists once the
  // config break above has run.
  const pseudoRoles = migratePseudoRoles(configPath, options);
  notes.push(...pseudoRoles.notes);
  touched.push(...pseudoRoles.touched);

  // The three file stages below read the project back through the compiler's own loaders
  // and answer one question each about it. A soak-up bus takes what the loaders say, the
  // same shape `wireNotesTemplate` and `migratePseudoRoles` use for their own reads; the
  // stages used to get the same silence by nulling `console` around a bus-less load.
  // Whether anything on it should reach the migration notes is a separate decision.
  const stageOptions = { ...options, diagnostics: new Diagnostics() };

  const pe = migratePlotEssentialsFiles(configPath, stageOptions);
  notes.push(...pe.notes);
  touched.push(...pe.touched);

  // §7.7. After the config stage, because the description's path is read through
  // `buildCompileContext` and that needs a v4-valid config to resolve an alias.
  const desc = migrateDescriptionFiles(configPath, stageOptions);
  notes.push(...desc.notes);
  touched.push(...desc.touched);

  // §7.1's fourth syntax. Same position as the description stage and for the same reason:
  // the opening's path is read through `buildCompileContext`, which needs a v4-valid config.
  const opening = migrateOpeningFiles(configPath, stageOptions);
  notes.push(...opening.notes);
  touched.push(...opening.touched);

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
  migrateProjectFully, wireNotesTemplate, renameConfigToCl,
  migratePseudoRoles, rewritePseudoRoleTokens, GENDERED_PRONOUN_RE, GENDERED_PRONOUN_WORDS,
};
