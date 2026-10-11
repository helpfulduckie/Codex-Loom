'use strict';

const { SECTION_SETTINGS } = require('../../src/model/componentSettings');
const { normalizeComponent } = require('../../src/model/component');
const { describeSections } = require('../../src/componentView');
const { attachOrigins, originAt } = require('../../src/origin');

test('shared descriptors keep presentation order and hidden selector origins', () => {
  expect(SECTION_SETTINGS.filter((setting) => setting.visible).map((setting) => setting.field))
    .toEqual(['isSlot', 'heading', 'headingLevel', 'position', 'wrapper', 'wrap', 'compact', 'bullet', 'text']);
  expect(SECTION_SETTINGS.filter((setting) => !setting.visible).map((setting) => setting.field))
    .toEqual(['branches', 'variants']);
  const raw = { slot: false, text: 'hello', heading: 'Intro', headingLevel: 2,
    render: { position: 1, wrapper: 'curly', wrap: 'all', compact: true, bullet: true },
    branches: { A: 'bold' }, variants: { bold: { text: 'changed' } } };
  const origins = new Map(SECTION_SETTINGS.map(({ authoredPath }, index) => [JSON.stringify(authoredPath),
    { file: 'component.yaml', line: index + 1, col: 3, path: authoredPath }]));
  attachOrigins(raw, origins);
  const component = normalizeComponent({ sections: { intro: raw } });
  for (const { authoredPath, field } of SECTION_SETTINGS) {
    expect(originAt(component.sections[0], [field])).toEqual(originAt(raw, authoredPath));
  }
  const [section] = describeSections(component, [], new Map(), [{ key: 'section:intro', text: 'hello' }]);
  expect(section.settings.map((setting) => setting.path))
    .toEqual(SECTION_SETTINGS.filter((setting) => setting.visible).map((setting) => setting.authoredPath));
});
