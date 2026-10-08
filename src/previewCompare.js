'use strict';

/**
 * What differs between two preview results, as plain data. See "Comparing two previews" in
 * the dev guide for the result layout.
 */

const lower = (value) => String(value).toLowerCase();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sectionsOf = (result, component) => (component.sections || []).map((index) => result.sections[index]);

function itemsOf(result, leaf) {
  const out = new Map();
  for (const index of leaf.items) {
    const item = result.items[index];
    if (item.id !== null) out.set(lower(item.id), item);
  }
  return out;
}

// Values only. Two previews of one project can read a library from different directories,
// so an origin differs between them where nothing an author wrote does.
function valuesOf(item) {
  return new Map(item.fields.map((field) => [JSON.stringify(field.path), field]));
}

function changedFields(a, b) {
  const before = valuesOf(a);
  const after = valuesOf(b);
  const paths = [];
  for (const [key, field] of before) {
    if (!after.has(key) || !same(field.value, after.get(key).value)) paths.push(field.path);
  }
  for (const [key, field] of after) {
    if (!before.has(key)) paths.push(field.path);
  }
  return paths;
}

// Everything an item writes on a leaf: its cards, and its text in each slot it occupies.
function outputsOf(result, leaf) {
  const out = new Map();
  const add = (id, entry) => {
    if (id === null || id === undefined) return;
    if (!out.has(lower(id))) out.set(lower(id), []);
    out.get(lower(id)).push(entry);
  };
  for (const index of leaf.cards) {
    const card = result.cards[index];
    add(card.itemId, ['card', card.type, card.name, card.rendered]);
  }
  for (const [key, component] of Object.entries(leaf.components)) {
    for (const section of sectionsOf(result, component)) {
      for (const occupant of section.occupants) {
        add(occupant.id, ['slot', key, section.name, occupant.order, occupant.text]);
      }
    }
  }
  return out;
}

function compareItems(a, leafA, b, leafB) {
  const itemsA = itemsOf(a, leafA);
  const itemsB = itemsOf(b, leafB);
  const outputA = outputsOf(a, leafA);
  const outputB = outputsOf(b, leafB);
  const rows = [];
  for (const id of new Set([...itemsA.keys(), ...itemsB.keys()])) {
    const inA = itemsA.get(id);
    const inB = itemsB.get(id);
    const output = !same(outputA.get(id) || [], outputB.get(id) || []);
    if (!inA || !inB) {
      rows.push({ id: (inA || inB).id, change: inA ? 'removed' : 'added', fields: [], output });
      continue;
    }
    const fields = changedFields(inA, inB);
    if (fields.length > 0 || output) rows.push({ id: inB.id, change: 'changed', fields, output });
  }
  return rows;
}

function compareCards(a, leafA, b, leafB) {
  const named = (result, leaf) => new Map(
    leaf.cards.map((index) => [result.cards[index].name, result.cards[index]]),
  );
  const cardsA = named(a, leafA);
  const cardsB = named(b, leafB);
  const rows = [];
  for (const name of new Set([...cardsA.keys(), ...cardsB.keys()])) {
    const inA = cardsA.get(name);
    const inB = cardsB.get(name);
    if (inA && inB && inA.type === inB.type && inA.rendered === inB.rendered) continue;
    rows.push({
      name,
      type: (inB || inA).type,
      itemId: (inB || inA).itemId,
      change: !inA ? 'added' : !inB ? 'removed' : 'changed',
    });
  }
  return rows;
}

function sectionSummary(section) {
  return [section.state, section.text, section.position, section.occupants.map((o) => [o.id, o.text])];
}

function compareComponents(a, leafA, b, leafB) {
  const rows = [];
  for (const key of new Set([...Object.keys(leafA.components), ...Object.keys(leafB.components)])) {
    const inA = leafA.components[key];
    const inB = leafB.components[key];
    if (!inA || !inB) {
      rows.push({ key, change: inA ? 'removed' : 'added', sections: [] });
      continue;
    }
    const byName = (result, component) => new Map(
      sectionsOf(result, component).map((section) => [lower(section.name), section]),
    );
    const sectionsA = byName(a, inA);
    const sectionsB = byName(b, inB);
    const sections = [];
    for (const name of new Set([...sectionsA.keys(), ...sectionsB.keys()])) {
      const sA = sectionsA.get(name);
      const sB = sectionsB.get(name);
      if (sA && sB && same(sectionSummary(sA), sectionSummary(sB))) continue;
      sections.push({
        name: (sB || sA).name,
        change: !sA ? 'added' : !sB ? 'removed' : 'changed',
      });
    }
    if (inA.text !== inB.text || sections.length > 0) rows.push({ key, change: 'changed', sections });
  }
  return rows;
}

function compareFiles(a, b) {
  const content = (file) => (file.binary ? `binary:${file.bytes}` : file.content);
  const filesA = new Map(a.files.map((file) => [file.path, content(file)]));
  const filesB = new Map(b.files.map((file) => [file.path, content(file)]));
  const out = { changed: [], added: [], removed: [] };
  for (const [file, text] of filesA) {
    if (!filesB.has(file)) out.removed.push(file);
    else if (filesB.get(file) !== text) out.changed.push(file);
  }
  for (const file of filesB.keys()) if (!filesA.has(file)) out.added.push(file);
  return out;
}

// The ids a library item compiles under in this result. A project can import an item under
// an id of its own, so the match is on where the definition sits, not on the id.
function compiledIdsByDefinition(result) {
  const out = new Map();
  for (const item of result.items) {
    if (!item.definition || item.id === null) continue;
    const key = `${item.definition.file}:${item.definition.line}`;
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(lower(item.id));
  }
  return out;
}

function libraryItems(result) {
  const compiled = compiledIdsByDefinition(result);
  const out = new Map();
  for (const library of result.libraries) {
    for (const file of library.files) {
      for (const item of file.items) {
        out.set(`${lower(library.name)}:${lower(item.id)}`, {
          library: library.name,
          id: item.id,
          file: result.sourceFiles[file.file],
          digest: item.digest,
          imported: item.imported,
          compiledAs: [...(compiled.get(`${file.file}:${item.line}`) || [])],
        });
      }
    }
  }
  return out;
}

function compareLibraries(a, b, outputChanged) {
  const itemsA = libraryItems(a);
  const itemsB = libraryItems(b);
  const rows = [];
  for (const key of new Set([...itemsA.keys(), ...itemsB.keys()])) {
    const inA = itemsA.get(key);
    const inB = itemsB.get(key);
    if (inA && inB && inA.digest === inB.digest) continue;
    const compiledAs = [...new Set([...(inA ? inA.compiledAs : []), ...(inB ? inB.compiledAs : [])])];
    rows.push({
      library: (inB || inA).library,
      id: (inB || inA).id,
      change: !inA ? 'added' : !inB ? 'removed' : 'changed',
      fileA: inA ? inA.file : null,
      fileB: inB ? inB.file : null,
      imported: !!((inA && inA.imported) || (inB && inB.imported)),
      compiledAs,
      reachesOutput: compiledAs.some((id) => outputChanged.has(id)),
    });
  }
  return rows;
}

function comparePreviews(a, b, options = {}) {
  if (a.status !== 'ok' || b.status !== 'ok') {
    return {
      status: 'blocked', leaves: [], unpaired: { a: [], b: [] }, items: [], libraries: [],
      files: { changed: [], added: [], removed: [] },
    };
  }

  const leavesA = new Map(a.leaves.map((leaf) => [leaf.label, leaf]));
  const leavesB = new Map(b.leaves.map((leaf) => [leaf.label, leaf]));
  const pairs = options.pairs
    || [...leavesA.keys()].filter((label) => leavesB.has(label)).map((label) => [label, label]);

  const leaves = [];
  const byItem = new Map();
  for (const [labelA, labelB] of pairs) {
    const leafA = leavesA.get(labelA);
    const leafB = leavesB.get(labelB);
    if (!leafA || !leafB) continue;
    const items = compareItems(a, leafA, b, leafB);
    leaves.push({
      a: labelA,
      b: labelB,
      items,
      cards: compareCards(a, leafA, b, leafB),
      components: compareComponents(a, leafA, b, leafB),
    });
    for (const row of items) {
      const key = lower(row.id);
      if (!byItem.has(key)) byItem.set(key, { id: row.id, outputLeaves: [], fieldLeaves: [] });
      (row.output ? byItem.get(key).outputLeaves : byItem.get(key).fieldLeaves).push([labelA, labelB]);
    }
  }

  const items = [...byItem.values()];
  const outputChanged = new Set(items.filter((row) => row.outputLeaves.length > 0).map((row) => lower(row.id)));
  const paired = { a: new Set(pairs.map(([label]) => label)), b: new Set(pairs.map(([, label]) => label)) };
  return {
    status: 'ok',
    leaves,
    unpaired: {
      a: [...leavesA.keys()].filter((label) => !paired.a.has(label)),
      b: [...leavesB.keys()].filter((label) => !paired.b.has(label)),
    },
    items,
    libraries: compareLibraries(a, b, outputChanged),
    files: compareFiles(a, b),
  };
}

module.exports = { comparePreviews };
