'use strict';

/**
 * Loading a component document (v4 spec §7.2).
 *
 * The case worth the most attention here is the v3 sequence. That file is valid YAML, so
 * the parser has nothing to say about it, and "must be a mapping" without naming the
 * change is the least useful thing that could be said to someone holding a Plot Essentials
 * file that compiled yesterday.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadComponentDocument } = require('../../src/loader/component');
const { Diagnostics } = require('../../src/diag');

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-component-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function write(name, content) {
  const full = path.join(tmpDir, name);
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

describe('loadComponentDocument', () => {
  test('an absent spec loads nothing and reports nothing', () => {
    const diagnostics = new Diagnostics();
    expect(loadComponentDocument(null, { diagnostics })).toBeNull();
    expect(diagnostics.isEmpty()).toBe(true);
  });

  test('a missing file is a WARN, not a throw', () => {
    const diagnostics = new Diagnostics();
    expect(loadComponentDocument(path.join(tmpDir, 'gone.yaml'), { diagnostics })).toBeNull();
    expect(diagnostics.warnings).toHaveLength(1);
  });

  test('an empty file loads nothing', () => {
    expect(loadComponentDocument(write('empty.yaml', ''), {})).toBeNull();
  });

  test('a document with no sections loads nothing', () => {
    expect(loadComponentDocument(write('bare.yaml', 'sections: {}\n'), {})).toBeNull();
  });

  test('a v3 block sequence is refused with a message that names the change', () => {
    const spec = write('v3.yaml', '- id: genreBlock\n  body: {text: Genre}\n');
    expect(() => loadComponentDocument(spec, {}))
      .toThrow(/YAML sequence.*`sections:` record/s);
  });

  test('sections are normalized and slots indexed', () => {
    const spec = write('pe.yaml', [
      'sections:',
      '  you:',
      '    slot: true',
      '    render: {position: 2, wrapper: curly}',
      '  genre:',
      '    text: Genre line',
      '    render: {position: 1, wrapper: square}',
    ].join('\n'));

    const component = loadComponentDocument(spec, {});
    expect(component.sections.map((s) => s.name)).toEqual(['genre', 'you']);
    expect([...component.slots.keys()]).toEqual(['you']);
    expect(component.source).toBe(spec);
  });

  test('the schema runs, so an unknown key is reported with a position', () => {
    const diagnostics = new Diagnostics();
    const spec = write('typo.yaml', 'sections:\n  cast:\n    slot: true\n    blocks: []\n');
    loadComponentDocument(spec, { diagnostics, label: 'Plot Essentials' });
    const reported = diagnostics.all.map((d) => d.message).join('\n');
    // `blocks:` is v3's nested grouping, and its absence from the schema is the intended
    // migration signal rather than an oversight.
    expect(reported).toMatch(/blocks/);
    expect(diagnostics.all[0].line).toEqual(expect.any(Number));
  });

  test('model-level section warnings reach the bus with their code', () => {
    const diagnostics = new Diagnostics();
    loadComponentDocument(write('both.yaml', 'sections:\n  cast:\n    slot: true\n    text: Party\n'), { diagnostics });
    expect(diagnostics.all.map((d) => d.code)).toContain('CL0601');
  });
});
