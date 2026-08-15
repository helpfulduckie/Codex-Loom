'use strict';

/**
 * v3 → v4 project migration (v4 spec §14.2).
 *
 * A library of named transformations, deliberately with no CLI. The `--migrate` mode,
 * its report of what it could not do, and the review queue for the medium-confidence
 * transformations arrive at the end, when the supervised pass over the real projects
 * happens. What is here is the config-level slice Phase 1 needs.
 *
 * Documents are edited through `yaml`'s Document API rather than re-emitted from a
 * parsed object, so comments and formatting survive. A migrator that strips an author's
 * comments is one they will not run twice.
 *
 * All v3 knowledge lives here (§3.3). The compiler proper carries no compatibility
 * branches, which is what the clean break buys.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const { YAML_SUFFIXES, hasSuffix } = require('../util');

/** The seven component types v3 accepted under `structure.input.components`. */
const V3_COMPONENT_TYPES = [
  'aiInstructions', 'opening', 'openingChoice', 'plotEssential',
  'authorsNote', 'scripts', 'description',
];

/**
 * Collect the `{@name} → value` map from `structure.input.components`.
 *
 * The per-type grouping is discarded, which loses nothing: v3's `lookupReference`
 * searched every type map in sequence and returned the first name match, so the grouping
 * never affected resolution. No project in the scenario tree declares one alias under two
 * types, because nobody could have depended on a distinction that did not work (§6.1).
 */
function collectComponentAliases(config) {
  const aliases = new Map();
  const components = config?.structure?.input?.components;
  if (!components || typeof components !== 'object') return aliases;

  for (const type of V3_COMPONENT_TYPES) {
    const group = components[type];
    if (!group || typeof group !== 'object') continue;
    for (const [name, value] of Object.entries(group)) {
      if (!aliases.has(name)) aliases.set(name, String(value));
    }
  }
  return aliases;
}

/** Canon names become `{%}` variables in v4, so `{@name}` referring to one just changes sigil. */
function collectCanonNames(config) {
  const canon = config?.structure?.input?.canon;
  return new Set(canon && typeof canon === 'object' ? Object.keys(canon) : []);
}

/**
 * Rewrite `{@name}` references in a string.
 *
 * A canon name becomes `{%name}`; a component alias is replaced by the value it was
 * declared as, which is what deletes the indirection. An unknown name is left alone and
 * reported, because guessing would be worse than a visible leftover.
 */
function rewriteAtTokens(text, aliases, canonNames, unresolved) {
  if (typeof text !== 'string' || !text.includes('{@')) return text;
  return text.replace(/\{@([^}]+)\}/g, (match, rawName) => {
    const name = rawName.trim();
    if (canonNames.has(name)) return `{%${name}}`;

    const exact = aliases.has(name)
      ? name
      : [...aliases.keys()].find((k) => k.toLowerCase() === name.toLowerCase());
    if (exact !== undefined) return aliases.get(exact);

    if (unresolved) unresolved.push(name);
    return match;
  });
}

/** Walk every scalar in a Document, applying `fn` to its string value. */
function mapScalars(doc, fn) {
  YAML.visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === 'string') {
        const next = fn(node.value);
        if (next !== node.value) {
          node.value = next;
          // Let the emitter re-choose quoting; a value that no longer starts with `{`
          // does not need the defensive quotes v3 required (§14.2).
          delete node.type;
        }
      }
    },
  });
}

/**
 * Migrate a `compile.yaml` Document in place.
 *
 * Returns `{ changes, unresolved }` — `changes` names each transformation applied, so a
 * caller can report what happened rather than only that something did.
 */
function migrateConfigDocument(doc) {
  const changes = [];
  const unresolved = [];
  const config = doc.toJS();

  const aliases = collectComponentAliases(config);
  const canonNames = collectCanonNames(config);

  // Rewrite {@} everywhere before structural edits, so aliases are still readable.
  mapScalars(doc, (value) => rewriteAtTokens(value, aliases, canonNames, unresolved));
  if (aliases.size > 0) changes.push(`inlined ${aliases.size} {@} component alias(es)`);

  // structure.input.cards → items, sequence only.
  if (doc.hasIn(['structure', 'input', 'cards'])) {
    const value = doc.getIn(['structure', 'input', 'cards'], true);
    const list = YAML.isSeq(value) ? value : new YAML.YAMLSeq();
    if (!YAML.isSeq(value)) list.add(value);
    doc.setIn(['structure', 'input', 'items'], list);
    doc.deleteIn(['structure', 'input', 'cards']);
    changes.push('structure.input.cards → items');
  }

  // structure.input.components is deleted outright (§6.1).
  if (doc.hasIn(['structure', 'input', 'components'])) {
    doc.deleteIn(['structure', 'input', 'components']);
    changes.push('deleted structure.input.components');
  }

  // structure.overview → structure.reports.
  if (doc.hasIn(['structure', 'overview'])) {
    doc.setIn(['structure', 'reports'], doc.getIn(['structure', 'overview'], true));
    doc.deleteIn(['structure', 'overview']);
    changes.push('structure.overview → structure.reports');
  }

  // components.scripts becomes top-level scripts: (§6.3).
  if (doc.hasIn(['components', 'scripts'])) {
    doc.set('scripts', doc.getIn(['components', 'scripts'], true));
    doc.deleteIn(['components', 'scripts']);
    changes.push('components.scripts → top-level scripts');
  }

  // components.openingChoice → components.branchFraming, at root and on every branch.
  const renameFraming = (pathToComponents) => {
    if (!doc.hasIn([...pathToComponents, 'openingChoice'])) return;
    doc.setIn([...pathToComponents, 'branchFraming'], doc.getIn([...pathToComponents, 'openingChoice'], true));
    doc.deleteIn([...pathToComponents, 'openingChoice']);
    changes.push(`${pathToComponents.join('.')}.openingChoice → branchFraming`);
  };
  renameFraming(['components']);

  const walkBranches = (branchPath) => {
    const node = doc.getIn(branchPath);
    if (!YAML.isMap(node)) return;
    for (const pair of node.items) {
      const name = String(pair.key.value);
      renameFraming([...branchPath, name, 'components']);
      // v3 also allowed these directly on the branch node.
      if (doc.hasIn([...branchPath, name, 'openingChoice'])) {
        doc.setIn([...branchPath, name, 'components', 'branchFraming'],
          doc.getIn([...branchPath, name, 'openingChoice'], true));
        doc.deleteIn([...branchPath, name, 'openingChoice']);
        changes.push(`branches.${name}.openingChoice → components.branchFraming`);
      }
      if (doc.hasIn([...branchPath, name, 'opening'])) {
        doc.setIn([...branchPath, name, 'components', 'opening'],
          doc.getIn([...branchPath, name, 'opening'], true));
        doc.deleteIn([...branchPath, name, 'opening']);
        changes.push(`branches.${name}.opening → components.opening`);
      }
      walkBranches([...branchPath, name, 'branches']);
    }
  };
  walkBranches(['branches']);

  // version: 4 is required, and its absence is what tells a v3 project to migrate (§14.1).
  if (!doc.has('version')) {
    doc.contents.items.unshift(doc.createPair('version', 4));
    changes.push('added version: 4');
  }

  return { changes, unresolved };
}

// ── Templates (§8.3) ─────────────────────────────────────────────────────────

/**
 * Strip a v3 template's story-card envelope: everything up to and including the last
 * `~~~` line.
 *
 * The last fence rather than the second, because a v3 template was free to put the
 * heading, the fence and its keys wherever it liked — `{if}` blocks around `notes:` mean
 * the closing fence is not reliably the fourth line, and a template with no fence at all
 * is already body-only and must be left untouched.
 *
 * A code fence inside body prose is spelled ``` in every template in the corpus, so it is
 * not at risk here; a body that genuinely opened with `~~~` would be, which is why this
 * runs once under review rather than on every compile.
 */
function stripTemplateHeader(text) {
  const lines = String(text).split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '~~~') last = i;
  }
  if (last === -1) return text;
  return lines.slice(last + 1).join('\n');
}

/** Strip the envelope from every `.template`/`.partial` under `rootDir`. */
function migrateTemplateFiles(rootDir, options = {}) {
  const touched = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(template|partial)$/i.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      const output = stripTemplateHeader(source);
      if (output !== source) {
        if (!options.dryRun) fs.writeFileSync(full, output, 'utf8');
        touched.push(full);
      }
    }
  };
  walk(rootDir);
  return { touched };
}

// ── Item YAML (§4.2, §4.5, §8.4) ─────────────────────────────────────────────

/**
 * Encode a v3 trigger's padding in §4.2's `_` form.
 *
 * v3 emitted `triggers: [{join(", ", $aid.triggers)}]` — the values went into the fence
 * unquoted — so authors reached the padding two different ways and only one of them
 * worked. `'" tea "'` carried literal quote characters into the fence, which VL's YAML
 * parse then stripped, leaving the spaces; `" Era "` was a plain padded string, whose
 * spaces the same parse discarded, so the trigger never matched anything. Both spellings
 * collapse to the same `_Era_` here, and the emitter is what decides how to write them.
 *
 * Returns `{ value, note }` — `note` names the case a human should look at.
 */
function encodeTriggerPadding(raw) {
  let value = String(raw);

  // The quoting hack: a value that is itself wrapped in quote characters.
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  if (quoted && quoted[2].length > 0) value = quoted[2];

  const core = value.replace(/^ +/, '').replace(/ +$/, '');
  const lead = value.length - value.replace(/^ +/, '').length;
  const trail = value.length - value.replace(/ +$/, '').length;

  if (lead === 0 && trail === 0) {
    // Nothing to encode — but an edge `_` already means a space to the emitter, so a v3
    // value that happened to start or end with one changes meaning if left alone.
    if (/^_|_$/.test(value)) {
      // Confirm rather than fix: a v3 trigger with a literal edge underscore and one this
      // pass already encoded are the same six characters, so the migrator cannot tell them
      // apart and a second run reports its own output. Reported, never rewritten.
      return { value, note: `trigger "${value}" has an edge underscore, which §4.2 reads as a space — confirm that is meant` };
    }
    return { value, note: null };
  }
  return { value: '_'.repeat(lead) + core + '_'.repeat(trail), note: null };
}

/** Insert `pair` directly after `afterKey` in a YAML map, or append if that key is absent. */
function insertAfter(map, afterKey, pair) {
  const index = map.items.findIndex((p) => String(p.key.value) === afterKey);
  if (index === -1) map.items.push(pair);
  else map.items.splice(index + 1, 0, pair);
}

/**
 * `notes: {known: true}` — the flag as data, for a template to render.
 *
 * Not `notes: '[e]'`, though that is the literal v3 emitted and it would need no template
 * to reproduce. The marker has to stay structured for two reasons that only show up
 * later. A convention pack (§8.2.2) cannot tell the string `[e]` from any other notes
 * text, so a flattened marker is unreadable to the thing meant to read it. And a branch
 * that does not load the mod the marker belongs to has no way to switch a baked-in string
 * off — swapping the notes template is the mechanism (§4.5.1), and a template can only
 * decide per card if the card carries a flag rather than a rendered answer.
 */
function notesMarkerPair() {
  const known = new YAML.Pair(new YAML.Scalar('known'), new YAML.Scalar(true));
  const map = new YAML.YAMLMap();
  map.flow = true;
  map.items.push(known);
  return new YAML.Pair(new YAML.Scalar('notes'), map);
}

/**
 * Migrate one item-YAML Document in place.
 *
 * Works on every map that carries an `aid:` mapping rather than on the top-level sequence,
 * because variants and branch overrides carry their own `aid:` blocks and a migration that
 * only saw declarations would leave `known:` alive in exactly the places hardest to spot.
 *
 * Returns `{ changes, notes }` — counts per rule, and the values needing a human look.
 */
function migrateItemDocument(doc) {
  const changes = { encapsulate: 0, known: 0, triggers: 0, stripFence: 0, title: 0 };
  const notes = [];

  YAML.visit(doc, {
    Map(_key, node) {
      // `render.stripFence` went with the envelope it stripped (§8.3).
      if (node.has('stripFence')) {
        node.delete('stripFence');
        changes.stripFence++;
      }

      const aid = node.get('aid', true);
      if (!YAML.isMap(aid)) return;

      // §8.4: `encapsulate: false` is unconditional now, so the key has no author-facing
      // meaning left to carry.
      if (aid.has('encapsulate')) {
        aid.delete('encapsulate');
        changes.encapsulate++;
      }

      // §8.2.1: the compiler must not know what `[e]` means. `aid.known` existed only so
      // `{if $aid.known}notes: '[e]'{/if}` could fire, so it becomes the notes text itself.
      if (aid.has('known')) {
        const known = aid.get('known');
        aid.delete('known');
        changes.known++;
        if (known === true) {
          if (node.has('notes')) {
            notes.push('item already declares notes:, so known: true was dropped rather than merged');
          } else {
            insertAfter(node, 'aid', notesMarkerPair());
          }
        }
      }

      // A card had one heading in v3 too, but which field it came from was the template's
      // choice per type — the shared cardHeader read `{$name.full}`, other templates read
      // `{$aid.title}` — so authors wrote both and kept them in step by hand. §8.2 gives
      // the heading to the emitter and one ladder, which makes a duplicate `aid.title`
      // not merely redundant but a trap: a variant that renames the character updates
      // `name:` and leaves the stale title behind, and the ladder prefers the title. Where
      // the two genuinely differ the title is a deliberate override and is kept.
      const title = aid.get('title');
      const name = node.get('name', true);
      const full = YAML.isMap(name) ? name.get('full') : (YAML.isScalar(name) ? name.value : undefined);
      if (typeof title === 'string' && title === full) {
        aid.delete('title');
        changes.title++;
        // Reported because the heading is not the only reader: a body template is free to
        // interpolate `{$aid.title}`, and that token renders empty once the key is gone.
        notes.push(`dropped aid.title "${title}", identical to name.full — check templates for {$aid.title}`);
      }

      const triggers = aid.get('triggers', true);
      const scalars = YAML.isSeq(triggers)
        ? triggers.items.filter((t) => YAML.isScalar(t))
        : (YAML.isScalar(triggers) ? [triggers] : []);
      for (const scalar of scalars) {
        if (typeof scalar.value !== 'string') continue;
        const { value, note } = encodeTriggerPadding(scalar.value);
        if (note) notes.push(note);
        if (value === scalar.value) continue;
        scalar.value = value;
        // Let the emitter re-choose quoting: `_Era_` needs none of what `" Era "` did.
        delete scalar.type;
        changes.triggers++;
      }
    },
  });

  return { changes, notes };
}

/** Migrate every item YAML file under `rootDir`. Returns per-file reports. */
function migrateItemFiles(rootDir, options = {}) {
  const touched = [];
  const notes = [];
  const totals = { encapsulate: 0, known: 0, triggers: 0, stripFence: 0 };

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !hasSuffix(entry.name, YAML_SUFFIXES)) continue;

      const source = fs.readFileSync(full, 'utf8');
      const doc = YAML.parseDocument(source);
      if (doc.errors.length > 0) throw new Error(`${full}: ${doc.errors[0].message}`);

      const result = migrateItemDocument(doc);
      for (const key of Object.keys(totals)) totals[key] += result.changes[key];
      for (const note of result.notes) notes.push({ file: full, note });

      // Emitter options chosen to round-trip the corpus rather than to taste: no line
      // wrapping, because the sources keep long prose values on one line and re-folding
      // them at 80 columns rewrites most of the file; and no flow padding, because
      // `triggers: [a, b]` must not become `[ a, b ]`. A migration whose diff is mostly
      // reformatting is one nobody can review for the changes that matter — and the BOM
      // is restored for the same reason, since `yaml` drops it on parse.
      const bom = source.charCodeAt(0) === 0xFEFF ? '﻿' : '';
      const output = bom + doc.toString({ lineWidth: 0, flowCollectionPadding: false });
      if (output !== source) {
        if (!options.dryRun) fs.writeFileSync(full, output, 'utf8');
        touched.push(full);
      }
    }
  };

  walk(rootDir);

  // Said once, loudly, rather than per item: the conversion above is only half the
  // change. `aid.known` used to be rendered by every template's `{if $aid.known}notes:
  // '[e]'{/if}`, and those templates are gone. Without a notes template the flag is
  // carried and never written, so every `[e]` in the project silently disappears.
  if (totals.known > 0) {
    notes.push({
      file: rootDir,
      note: `${totals.known} item(s) converted aid.known to notes: {known: true}. Add a notes `
        + 'template rendering `{if $notes.known}[e]{/if}` and point render.notesTemplate at it '
        + 'in compile.yaml, or the marker is carried but never emitted (§4.5.1).',
    });
  }

  return { touched, notes, totals };
}

/** Migrate a config file on disk. Returns the report; writes only when something changed. */
function migrateConfigFile(configPath, options = {}) {
  const source = fs.readFileSync(configPath, 'utf8');
  const doc = YAML.parseDocument(source);
  if (doc.errors.length > 0) throw new Error(`${configPath}: ${doc.errors[0].message}`);

  const config = doc.toJS();
  const aliases = collectComponentAliases(config);
  const canonNames = collectCanonNames(config);

  const result = migrateConfigDocument(doc);
  const output = doc.toString({ lineWidth: 0 });

  if (!options.dryRun && output !== source) fs.writeFileSync(configPath, output, 'utf8');
  return { ...result, aliases, canonNames, output };
}

/**
 * Rewrite `{@}` references in every other YAML file of a project.
 *
 * Component files and item files use them too — `include: '{@characters}/You.yaml'`
 * reaches canon, `script: '{@scripts}/library.js'` reaches a component alias — so
 * migrating only `compile.yaml` would leave the project half-converted.
 */
function migrateProjectFiles(rootDir, aliases, canonNames, options = {}) {
  const touched = [];
  const unresolved = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !hasSuffix(entry.name, YAML_SUFFIXES)) continue;
      if (path.resolve(full) === path.resolve(options.configPath || '')) continue;

      const source = fs.readFileSync(full, 'utf8');
      if (!source.includes('{@')) continue;

      const local = [];
      const output = rewriteAtTokens(source, aliases, canonNames, local);
      if (output !== source) {
        if (!options.dryRun) fs.writeFileSync(full, output, 'utf8');
        touched.push(full);
      }
      for (const name of local) unresolved.push({ file: full, name });
    }
  };

  walk(rootDir);
  return { touched, unresolved };
}

/** Migrate a whole project: its config, then every other YAML file beside it. */
function migrateProject(configPath, options = {}) {
  const config = migrateConfigFile(configPath, options);
  const files = migrateProjectFiles(path.dirname(configPath), config.aliases, config.canonNames, {
    ...options,
    configPath,
  });
  return {
    changes: config.changes,
    filesTouched: files.touched,
    unresolved: [...config.unresolved.map((name) => ({ file: configPath, name })), ...files.unresolved],
  };
}

module.exports = {
  migrateProject,
  migrateConfigFile,
  migrateConfigDocument,
  migrateProjectFiles,
  migrateItemDocument,
  migrateItemFiles,
  migrateTemplateFiles,
  stripTemplateHeader,
  encodeTriggerPadding,
  collectComponentAliases,
  collectCanonNames,
  rewriteAtTokens,
  V3_COMPONENT_TYPES,
};
