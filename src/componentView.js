'use strict';

/**
 * A component's sections as one leaf sees them, for a caller that shows the component rather
 * than writes it. See "Preview API" in the dev guide for the record layout.
 */

const { sectionsForBranch } = require('./model/component');
const { sortOccupants } = require('./emit/components');
const { originAt } = require('./origin');

// Normalized section field → the path an author writes it at.
const SETTINGS = [
  ['isSlot', ['slot']], ['heading', ['heading']], ['headingLevel', ['headingLevel']],
  ['position', ['render', 'position']], ['wrapper', ['render', 'wrapper']],
  ['wrap', ['render', 'wrap']], ['compact', ['render', 'compact']],
  ['bullet', ['render', 'bullet']], ['text', ['text']],
];

const SECTION_KEY = 'section:';

function describeSections(component, branchPath, filled, segments) {
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
      settings: SETTINGS
        .filter(([field]) => section[field] !== undefined && section[field] !== null)
        .map(([field, authoredPath]) => ({
          path: authoredPath, value: section[field], origin: originAt(section, [field]),
        })),
      occupants,
      text,
    };
  });

  sections.sort((a, b) => (a.position - b.position) || (a.index - b.index));
  return sections.map(({ index, ...section }) => section);
}

module.exports = { describeSections };
