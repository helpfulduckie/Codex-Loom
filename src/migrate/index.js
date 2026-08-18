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
    const canon = buildCanonRegistry(config._resolvedCanon);
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

  const pe = migratePlotEssentialsFiles(configPath, options);
  notes.push(...pe.notes);
  touched.push(...pe.touched);

  // Phase 4. Deliberately last and deliberately empty — see migratePlaceholders.
  const placeholders = migratePlaceholders();
  notes.push(...placeholders.notes);

  return { notes, touched, changes: config.changes };
}

module.exports = { migrateProjectFully, wireNotesTemplate, migratePlaceholders };
