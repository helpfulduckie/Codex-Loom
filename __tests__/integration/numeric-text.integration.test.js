'use strict';

const fs = require('fs');
const path = require('path');
const { preview } = require('../../src/compile');
const { withTmpDir, writeTree, compileProject } = require('../helpers/project');

function project(extra, files) {
  const dir = withTmpDir();
  writeTree(dir, {
    'compile.yaml': [
      'version: 4', 'structure:', '  input:', '    items: [%TMP%/items]',
      '    templates: [%TMP%/templates]', '  output: %TMP%/output', ...extra,
    ].join('\n'),
    'items/card.yaml': '- id: school\n  name: School\n  aid: {type: Character}\n  render: {template: Card}\n  body: {gpa: 3.30}\n  v: {schoolId: 0107420, grade: 12}',
    'templates/Card.template': 'Grade {$v.grade}; GPA {$body.gpa}; ID {$v.schoolId}',
    ...files,
  });
  return preview(path.join(dir, 'compile.yaml'), { tolerant: false });
}

test('numeric variables and item data render as typed, with branch overrides', () => {
  const result = project([
    'variables: {month: 6, zero: 0, decimal: 1.50, code: 007, exponent: 1e3, serial: 12345678901234567890}',
    'components: {aiInstructions: "%TMP%/components/ai.cl.yaml"}',
    'branches: {base: {}, changed: {variables: {month: 12}}}',
  ], { 'components/ai.cl.yaml': 'sections: {date: {text: "Month {%month}; {%zero}; {%decimal}; {%code}; {%exponent}; {%serial}"}}' });
  expect(result.status).toBe('ok');
  expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  const text = result.leaves.map(leaf => leaf.components.aiInstructions.text);
  expect(text).toEqual(expect.arrayContaining(['Month 6; 0; 1.50; 007; 1e3; 12345678901234567890', 'Month 12; 0; 1.50; 007; 1e3; 12345678901234567890']));
  expect(result.cards.every(card => card.rendered.includes('Grade 12; GPA 3.30; ID 0107420'))).toBe(true);
});

test('numeric item and component variants reach rendered output', () => {
  const result = project(['branches: {selected: {}}', 'components: {aiInstructions: "%TMP%/components/ai.cl.yaml"}'], {
    'items/card.yaml': '- id: school\n  name: School\n  aid: {type: Character}\n  body: {grade: 12}\n  variants: {alt: {name: 007, aid: {title: 0, triggers: [6, 0]}}}\n  branches: {selected: alt}',
    'templates/Character.template': '{$body.grade}',
    'components/ai.cl.yaml': 'sections:\n  intro:\n    text: Base\n    variants: {alt: {heading: 0, text: 1.50}}\n    branches: {selected: alt}',
  });
  expect(result.status).toBe('ok');
  expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  expect(result.cards[0].rendered).toContain('12');
  expect(result.cards[0]).toMatchObject({ name: '0' });
  expect(result.leaves[0].components.aiInstructions.text).toContain('0');
  expect(result.leaves[0].components.aiInstructions.text).toContain('1.50');
});

test('strict compile writes numeric variable substitutions to component files', () => {
  const { tmpDir, diagnostics, threw } = compileProject({
    'compile.yaml': 'version: 4\nstructure: {output: "%TMP%/output"}\nvariables: {month: 6, day: 0}\ncomponents: {aiInstructions: "%TMP%/components/ai.cl.yaml"}',
    'components/ai.cl.yaml': 'sections: {date: {text: "Date {%month}/{%day}"}}',
  });
  expect(threw).toBeNull();
  expect(diagnostics.errors).toEqual([]);
  expect(fs.readFileSync(path.join(tmpDir, 'output', 'Components', 'AI Instructions.md'), 'utf8')).toContain('Date 6/0');
});

test('numeric field-table labels, separators and raw text survive rendering', () => {
  const result = project([], {
    'items/card.yaml': '- id: school\n  name: School\n  aid: {type: Character}\n  render: {template: Numeric}\n  body: {subjects: [English, Chemistry]}',
    'templates/fields.cl.yaml': 'fields: {subjects: {label: 0, join: 6}}\ntemplates: {Numeric: [{raw: 0}, subjects]}',
  });
  expect(result.status).toBe('ok');
  expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  expect(result.cards[0].rendered).toContain('0: English6Chemistry');
  expect(result.cards[0].rendered).toMatch(/\n0\n/);
});

test('numeric inline opening and root framing write zero as text', () => {
  const { tmpDir, diagnostics, threw } = compileProject({
    'compile.yaml': 'version: 4\nstructure: {output: "%TMP%/output"}\ncomponents: {branchFraming: 0}\nbranches: {selected: {components: {opening: 0}}}',
  });
  expect(threw).toBeNull();
  expect(diagnostics.errors).toEqual([]);
  expect(fs.readFileSync(path.join(tmpDir, 'output', 'Components', 'Opening.md'), 'utf8')).toBe('0\n');
  expect(fs.readFileSync(path.join(tmpDir, 'output', 'Branches', 'selected', 'Components', 'Opening.md'), 'utf8')).toBe('0\n');
});
