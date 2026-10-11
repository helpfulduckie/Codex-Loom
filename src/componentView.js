'use strict';

/**
 * A component's sections as one leaf sees them, for a caller that shows the component rather
 * than writes it. See "Preview API" in the dev guide for the record layout.
 */

const { sectionsForBranch } = require('./model/component');
const { SECTION_SETTINGS } = require('./model/componentSettings');
const { sortOccupants } = require('./emit/components');
const { originAt } = require('./origin');
const { findKey, isPlainObject } = require('./util');

const SECTION_KEY = 'section:';

function valueAt(def, authoredPath) {
  let node = def;
  for (const part of authoredPath) {
    if (!isPlainObject(node)) return undefined;
    const key = findKey(node, part);
    if (key === null) return undefined;
    node = node[key];
  }
  return node;
}

// Each record that wrote one setting of one section, in the order they applied: the files
// merged through `imports:`, then the variants dispatched on this leaf. `value` is as
// authored, so a text operation appears as written rather than as its result.
function settingLayers(contributions, declared, applied, authoredPath) {
  let layers = [];
  for (const { file, variant, sections } of contributions || []) {
    const key = isPlainObject(sections) ? findKey(sections, declared.name) : null;
    if (key === null) continue;
    const def = sections[key];
    // A `~` deletes what the imports provided; a later record starts the section again.
    if (def === null || def === undefined) { layers = []; continue; }
    const value = valueAt(def, authoredPath);
    if (value === undefined) continue;
    layers.push({ file, variant, value, at: originAt(def, authoredPath) });
  }
  for (const name of applied) {
    const key = isPlainObject(declared.variants) ? findKey(declared.variants, String(name)) : null;
    if (key === null) continue;
    const value = valueAt(declared.variants[key], authoredPath);
    if (value === undefined) continue;
    const at = originAt(declared, ['variants', key, ...authoredPath]);
    layers.push({ file: at ? at.file : null, variant: name, value, at });
  }
  // One record is the setting's origin, which the setting already names.
  return layers.length > 1 ? layers : [];
}

function describeSections(component, branchPath, filled, segments, contributions = null, sectionUsage = null) {
  const applicable = sectionsForBranch(component, branchPath, null);
  if (applicable === null) return [];

  const onLeaf = new Map(applicable.map((entry) => [entry.section.name.toLowerCase(), entry]));
  const rendered = new Map();
  for (const segment of segments || []) {
    if (segment.key.startsWith(SECTION_KEY)) {
      rendered.set(segment.key.slice(SECTION_KEY.length).toLowerCase(), segment.text);
    }
  }

  const sections = component.sections.map((declared) => {
    const lower = declared.name.toLowerCase();
    const entry = onLeaf.get(lower);
    // A gated section is described as declared: no variant applies where it does not render.
    const section = entry ? entry.section : declared;
    const text = entry && rendered.has(lower) ? rendered.get(lower) : null;
    const occupants = entry && section.isSlot
      ? sortOccupants(filled.get(lower)).map((o) => ({
        id: o.id, order: o.order, template: o.template || null, text: o.text,
      }))
      : [];
    return {
      name: section.name,
      slot: section.isSlot,
      state: !entry ? 'gated' : text === null ? 'empty' : 'rendered',
      position: section.position,
      index: section.index,
      variants: entry ? entry.variants : [],
      source: originAt(section, []),
      settings: SECTION_SETTINGS
        .filter(({ field, visible }) => visible && section[field] !== undefined && section[field] !== null)
        .map(({ field, authoredPath }) => ({
          path: authoredPath,
          value: section[field],
          origin: originAt(section, [field]),
          layers: settingLayers(contributions, declared, entry ? entry.variants : [], authoredPath),
        })),
      occupants,
      uses: (entry && sectionUsage && sectionUsage.get(lower)) || { variables: new Set(), roles: new Set() },
      text,
    };
  });

  sections.sort((a, b) => (a.position - b.position) || (a.index - b.index));
  return sections.map(({ index, ...section }) => section);
}

module.exports = { describeSections };
