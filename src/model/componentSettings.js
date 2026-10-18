'use strict';

// Defaults inherit the section key's origin; hidden selectors still transfer their own
// origins during normalization even though they are not displayed as section settings.
const SECTION_SETTINGS = Object.freeze([
  ['isSlot', ['slot'], true], ['heading', ['heading'], true],
  ['headingLevel', ['headingLevel'], true], ['position', ['render', 'position'], true],
  ['wrapper', ['render', 'wrapper'], true], ['wrap', ['render', 'wrap'], true],
  ['compact', ['render', 'compact'], true], ['bullet', ['render', 'bullet'], true],
  ['text', ['text'], true], ['branches', ['branches'], false],
  ['variants', ['variants'], false],
].map(([field, authoredPath, visible]) => Object.freeze({
  field, authoredPath: Object.freeze(authoredPath), visible,
})));

module.exports = { SECTION_SETTINGS };
