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
const path = require('path');

const { loadComponentDocument } = require('../../src/loader/component');
const { originAt } = require('../../src/origin');
const { Diagnostics, CODES } = require('../../src/diag');
const { withTmpDir } = require('../helpers/project');

let tmpDir;
beforeEach(() => { tmpDir = withTmpDir(); });

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
    expect(originAt(component, 'sections', 'genre', 'text')).toMatchObject({
      file: spec, path: ['sections', 'genre', 'text'], line: 6,
    });
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

  test('a missing file is reported at the key that requested it when one is given', () => {
    const diagnostics = new Diagnostics();
    const requestedAt = { file: 'compile.yaml', line: 12, col: 5 };
    loadComponentDocument(path.join(tmpDir, 'gone.yaml'), { diagnostics, requestedAt });
    expect(diagnostics.warnings[0]).toMatchObject({ code: CODES.YAML_FILE_UNREADABLE, ...requestedAt });
  });
});

describe('component origins follow the value that wins', () => {
  const find = (component, name) => component.sections.find((s) => s.name === name);

  test('a recursive import keeps each overlaid path and each untouched sibling at its own author', () => {
    const base = write('base.yaml', [
      'sections:',
      '  intro:',
      '    heading: Intro',
      '    text: Base text',
      '    render: {position: 3, wrapper: square}',
      '  cast:',
      '    slot: true',
    ].join('\n'));
    const mid = write('mid.yaml', [
      'imports:',
      '  - from: ./base.yaml',
      'sections:',
      '  intro:',
      '    render: {position: 1}',
    ].join('\n'));
    const top = write('top.yaml', [
      'imports:',
      '  - from: ./mid.yaml',
      'sections:',
      '  intro:',
      '    text: Top text',
    ].join('\n'));

    const component = loadComponentDocument(top, { diagnostics: new Diagnostics(), base: tmpDir });
    const intro = find(component, 'intro');
    expect(intro).toMatchObject({ text: 'Top text', heading: 'Intro', position: 1, wrapper: 'square' });
    expect(originAt(intro, 'text')).toMatchObject({ file: top, line: 5, path: ['sections', 'intro', 'text'] });
    expect(originAt(intro, 'position')).toMatchObject({
      file: mid, line: 5, path: ['sections', 'intro', 'render', 'position'],
    });
    expect(originAt(intro, 'wrapper')).toMatchObject({
      file: base, line: 5, path: ['sections', 'intro', 'render', 'wrapper'],
    });
    expect(originAt(intro, 'heading')).toMatchObject({ file: base, line: 3 });
    // The overlays name paths inside the section; the section itself is still base's.
    expect(originAt(intro, [])).toMatchObject({ file: base, line: 2 });
    expect(originAt(find(component, 'cast'), 'isSlot')).toMatchObject({ file: base, line: 7 });
  });

  test('an importVariants selector owns the paths it changes and reports a miss at its own entry', () => {
    const lib = write('lib.yaml', [
      'sections:',
      '  mood:',
      '    heading: Mood',
      '    text: Calm',
      '    variants:',
      '      storm:',
      '        text: Storm',
    ].join('\n'));
    const top = write('sel.yaml', [
      'imports:',
      '  - from: ./lib.yaml',
      '    importVariants:',
      '      - nope',
      '      - storm',
    ].join('\n'));

    const diagnostics = new Diagnostics();
    const mood = find(loadComponentDocument(top, { diagnostics, base: tmpDir }), 'mood');
    expect(mood.text).toBe('Storm');
    expect(originAt(mood, 'text')).toMatchObject({
      file: lib, line: 7, path: ['sections', 'mood', 'variants', 'storm', 'text'],
    });
    expect(originAt(mood, 'heading')).toMatchObject({ file: lib, line: 3 });
    const miss = diagnostics.all.find((d) => d.code === CODES.SELECTOR_MATCHED_NOTHING);
    expect(miss).toMatchObject({ file: top, line: 4 });
  });

  test('import and merge findings point at the entry, the deletion, and the imported section', () => {
    const empty = write('empty.yaml', 'sections:\n  blank:\n    render: {position: 2}\n');
    const top = write('merge.yaml', [
      'imports:',
      '  - from: ./absent.yaml',
      '  - from: ./empty.yaml',
      'sections:',
      '  gone: ~',
      '  keep:',
      '    text: Kept',
    ].join('\n'));

    const diagnostics = new Diagnostics();
    loadComponentDocument(top, { diagnostics, base: tmpDir });
    const byCode = (code) => diagnostics.all.filter((d) => d.code === code);
    expect(byCode(CODES.IMPORT_NOT_FOUND)[0]).toMatchObject({ file: top, line: 2 });
    expect(byCode(CODES.IMPORT_DELETE_UNKNOWN)[0]).toMatchObject({ file: top, line: 5 });
    // The imported file reports its own copy, and the merged copy is still that section.
    expect(byCode(CODES.SECTION_RENDERS_NOTHING).map((d) => [d.file, d.line]))
      .toEqual([[empty, 2], [empty, 2]]);
  });

  test('loaded text is located in its file, while a missing source stays at the declaration', () => {
    const story = write('story.txt', 'Once upon a time.\n');
    const spec = write('sourced.yaml', [
      'sections:',
      '  story:',
      '    file: ./story.txt',
      '  lost:',
      '    file: ./nowhere.txt',
    ].join('\n'));

    const diagnostics = new Diagnostics();
    const component = loadComponentDocument(spec, { diagnostics, base: tmpDir });
    const origin = originAt(find(component, 'story'), 'text');
    expect(origin).toEqual({ file: story, path: [] });
    expect(diagnostics.all.find((d) => d.code === CODES.SECTION_SOURCE_NOT_FOUND))
      .toMatchObject({ file: spec, line: 5 });
  });
});
