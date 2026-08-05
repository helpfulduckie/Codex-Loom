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
  collectComponentAliases,
  collectCanonNames,
  rewriteAtTokens,
  V3_COMPONENT_TYPES,
};
