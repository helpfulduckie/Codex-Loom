'use strict';


const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const { YAML_SUFFIXES, hasSuffix } = require('../util');

const V3_COMPONENT_TYPES = [
  'aiInstructions', 'opening', 'openingChoice', 'plotEssential',
  'authorsNote', 'scripts', 'description',
];

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

function collectCanonNames(config) {
  const canon = config?.structure?.input?.canon;
  return new Set(canon && typeof canon === 'object' ? Object.keys(canon) : []);
}

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

function mapScalars(doc, fn) {
  YAML.visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === 'string') {
        const next = fn(node.value);
        if (next !== node.value) {
          node.value = next;
          const stillBraced = next.startsWith('{');
          const isBlock = node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED';
          if (!stillBraced && !isBlock) delete node.type;
        }
      }
    },
  });
}

function migrateConfigDocument(doc) {
  const changes = [];
  const unresolved = [];
  const config = doc.toJS();

  const aliases = collectComponentAliases(config);
  const canonNames = collectCanonNames(config);

  mapScalars(doc, (value) => rewriteAtTokens(value, aliases, canonNames, unresolved));
  if (aliases.size > 0) changes.push(`inlined ${aliases.size} {@} component alias(es)`);

  if (doc.hasIn(['structure', 'input', 'cards'])) {
    const value = doc.getIn(['structure', 'input', 'cards'], true);
    const list = YAML.isSeq(value) ? value : new YAML.YAMLSeq();
    if (!YAML.isSeq(value)) list.add(value);
    doc.setIn(['structure', 'input', 'items'], list);
    doc.deleteIn(['structure', 'input', 'cards']);
    changes.push('structure.input.cards → items');
  }

  if (doc.hasIn(['structure', 'input', 'canon'])) {
    doc.setIn(['structure', 'input', 'library'], doc.getIn(['structure', 'input', 'canon'], true));
    doc.deleteIn(['structure', 'input', 'canon']);
    changes.push('structure.input.canon → library');
  }

  if (doc.hasIn(['structure', 'input', 'components'])) {
    doc.deleteIn(['structure', 'input', 'components']);
    changes.push('deleted structure.input.components');
  }

  if (doc.hasIn(['structure', 'overview'])) {
    doc.setIn(['structure', 'reports'], doc.getIn(['structure', 'overview'], true));
    doc.deleteIn(['structure', 'overview']);
    changes.push('structure.overview → structure.reports');
  }

  if (doc.hasIn(['components', 'scripts'])) {
    doc.set('scripts', doc.getIn(['components', 'scripts'], true));
    doc.deleteIn(['components', 'scripts']);
    changes.push('components.scripts → top-level scripts');
  }

  const renameFraming = (pathToComponents) => {
    if (!doc.hasIn([...pathToComponents, 'openingChoice'])) return;
    doc.setIn([...pathToComponents, 'branchFraming'], doc.getIn([...pathToComponents, 'openingChoice'], true));
    doc.deleteIn([...pathToComponents, 'openingChoice']);
    changes.push(`${pathToComponents.join('.')}.openingChoice → branchFraming`);
  };
  renameFraming(['components']);

  const renameProtagonist = (nodePath) => {
    if (!doc.hasIn([...nodePath, 'protagonist'])) return;
    doc.setIn([...nodePath, 'roles', 'protagonist'], doc.getIn([...nodePath, 'protagonist'], true));
    doc.deleteIn([...nodePath, 'protagonist']);
    changes.push(`${[...nodePath, 'protagonist'].join('.')} → ${[...nodePath, 'roles', 'protagonist'].join('.')}`);
  };
  renameProtagonist([]);

  const walkBranches = (branchPath) => {
    const node = doc.getIn(branchPath);
    if (!YAML.isMap(node)) return;
    for (const pair of node.items) {
      const name = String(pair.key.value);
      renameFraming([...branchPath, name, 'components']);
      renameProtagonist([...branchPath, name]);
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

  if (!doc.has('version')) {
    doc.contents.items.unshift(doc.createPair('version', 4));
    changes.push('added version: 4');
  }

  return { changes, unresolved };
}


function encodeTriggerPadding(raw) {
  let value = String(raw);

  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  if (quoted && quoted[2].length > 0) value = quoted[2];

  const core = value.replace(/^ +/, '').replace(/ +$/, '');
  const lead = value.length - value.replace(/^ +/, '').length;
  const trail = value.length - value.replace(/ +$/, '').length;

  if (lead === 0 && trail === 0) {
    if (/^_|_$/.test(value)) {
      return { value, note: `trigger "${value}" has an edge underscore, which §4.2 reads as a space — confirm that is meant` };
    }
    return { value, note: null };
  }
  return { value: '_'.repeat(lead) + core + '_'.repeat(trail), note: null };
}

function insertAfter(map, afterKey, pair) {
  const index = map.items.findIndex((p) => String(p.key.value) === afterKey);
  if (index === -1) map.items.push(pair);
  else map.items.splice(index + 1, 0, pair);
}

function notesMarkerPair() {
  const known = new YAML.Pair(new YAML.Scalar('known'), new YAML.Scalar(true));
  const map = new YAML.YAMLMap();
  map.flow = true;
  map.items.push(known);
  return new YAML.Pair(new YAML.Scalar('notes'), map);
}

function migrateItemDocument(doc) {
  const changes = { encapsulate: 0, known: 0, triggers: 0, stripFence: 0, title: 0, kindCandidates: 0 };
  const notes = [];

  YAML.visit(doc, {
    Map(_key, node) {
      if (node.has('stripFence')) {
        node.delete('stripFence');
        changes.stripFence++;
      }

      const aid = node.get('aid', true);
      if (!YAML.isMap(aid)) return;

      if (aid.has('encapsulate')) {
        aid.delete('encapsulate');
        changes.encapsulate++;
      }

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

      const title = aid.get('title');
      const name = node.get('name', true);
      const full = YAML.isMap(name) ? name.get('full') : (YAML.isScalar(name) ? name.value : undefined);
      if (typeof title === 'string' && title === full) {
        aid.delete('title');
        changes.title++;
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
        delete scalar.type;
        changes.triggers++;
      }

      const id = node.get('id');
      if (typeof id === 'string' && scalars.length === 0) {
        notes.push(
          `item "${id}" has no triggers — review for \`kind: reference\` (§4.8). `
          + 'The migrator does not set it: trigger-less means either a mod control item '
          + 'that meant it or a narrative card that lost them, and only you can tell.'
        );
        changes.kindCandidates++;
      }
    },
  });

  return { changes, notes };
}

function migrateItemFiles(rootDir, aliases = new Map(), canonNames = new Set(), options = {}) {
  const touched = [];
  const notes = [];
  const unresolved = [];
  const totals = { encapsulate: 0, known: 0, triggers: 0, stripFence: 0, kindCandidates: 0 };

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !hasSuffix(entry.name, YAML_SUFFIXES)) continue;
      if (path.resolve(full) === path.resolve(options.configPath || '')) continue;

      const source = fs.readFileSync(full, 'utf8');
      const doc = YAML.parseDocument(source);
      if (doc.errors.length > 0) throw new Error(`${full}: ${doc.errors[0].message}`);

      if (source.includes('{@')) {
        const local = [];
        mapScalars(doc, (value) => rewriteAtTokens(value, aliases, canonNames, local));
        for (const name of local) unresolved.push({ file: full, name });
      }

      const result = migrateItemDocument(doc);
      for (const key of Object.keys(totals)) totals[key] += result.changes[key];
      for (const note of result.notes) notes.push({ file: full, note });

      const bom = source.charCodeAt(0) === 0xFEFF ? '﻿' : '';
      const output = bom + doc.toString({ lineWidth: 0, flowCollectionPadding: false });
      if (output !== source) {
        if (!options.dryRun) fs.writeFileSync(full, output, 'utf8');
        touched.push(full);
      }
    }
  };

  walk(rootDir);

  if (totals.known > 0) {
    notes.push({
      file: rootDir,
      note: `${totals.known} item(s) converted aid.known to notes: {known: true}. Add a notes `
        + 'template rendering `{if $notes.known}[e]{/if}` and point render.notesTemplate at it '
        + 'in compile.yaml, or the marker is carried but never emitted (§4.5.1).',
    });
  }

  return { touched, notes, totals, unresolved };
}

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

module.exports = {
  migrateConfigFile,
  migrateConfigDocument,
  migrateItemDocument,
  migrateItemFiles,
  encodeTriggerPadding,
  collectComponentAliases,
  collectCanonNames,
  rewriteAtTokens,
};
