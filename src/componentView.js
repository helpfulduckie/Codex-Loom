'use strict';

/**
 * A component's sections as one leaf sees them, for a caller that shows the component rather
 * than writes it. See "Preview API" in the dev guide for the record layout.
 */

const { sectionsForBranch, layersOf } = require('./model/component');
const { SECTION_SETTINGS } = require('./model/componentSettings');
const { sortOccupants } = require('./emit/components');
const { originAt } = require('./origin');

const SECTION_KEY = 'section:';

const samePath = (a, b) => a.length === b.length && a.every((part, i) => String(part).toLowerCase() === String(b[i]).toLowerCase());

// The steps that changed one setting of a section, in the order the merge applied them:
// later files through `imports:`, `importVariants:` selections, a file read for `file:` or
// `from:`, then the variants dispatched on this leaf. The first record is the setting's
// base, named by each first layer's `beforeOrigin`, so a setting written once has none.
function settingLayers(section, authoredPath) {
  return (layersOf(section) || []).filter((entry) => samePath(entry.path, authoredPath));
}

function describeSections(component, branchPath, filled, segments, sectionUsage = null) {
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
          layers: settingLayers(section, authoredPath),
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
