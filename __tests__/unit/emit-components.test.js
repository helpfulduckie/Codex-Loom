'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DECLARATION, DOCUMENT_COMPONENTS, SLOTTED_COMPONENTS, OTHER_COMPONENTS, emitDocumentComponent,
  renderSectionedComponent, writeSectionedComponent,
} = require('../../src/emit/components');
const { normalizeComponent } = require('../../src/model/component');

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-emit-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const AIN = DOCUMENT_COMPONENTS.find((d) => d.key === 'aiInstructions');
const AN = DOCUMENT_COMPONENTS.find((d) => d.key === 'authorsNote');

function write(name, content) {
  const full = path.join(tmpDir, name);
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function emit(descriptor, spec) {
  return emitDocumentComponent(descriptor, spec, {
    outputDir: tmpDir,
    registry: new Map(),
    compileContext: { branchPath: [], variables: {}, componentRefs: {} },
  });
}

describe('the descriptor table', () => {
  test('AI Instructions and Author\'s Note are table rows, not bespoke blocks', () => {
    expect(DOCUMENT_COMPONENTS.map((d) => d.key)).toEqual(['aiInstructions', 'authorsNote']);
  });

  test('every row declares the fields the emitter needs', () => {
    for (const descriptor of DOCUMENT_COMPONENTS) {
      expect(typeof descriptor.load).toBe('function');
      expect(typeof descriptor.compile).toBe('function');
      expect(typeof descriptor.write).toBe('function');
      expect(descriptor.label).toEqual(expect.any(String));
    }
  });

  test('declaration describes branch-chain merging, not a write location', () => {
    // The distinction matters: VL inherits components itself, so "written at every leaf"
    // is the emitter's current strategy rather than a property of the component.
    expect(AIN.declaration).toBe(DECLARATION.INHERITED);
    expect(OTHER_COMPONENTS.find((d) => d.key === 'branchFraming').declaration).toBe(DECLARATION.NODE);
    expect(OTHER_COMPONENTS.find((d) => d.key === 'description').declaration).toBe(DECLARATION.PROJECT);
  });

  test('Plot Essentials is a slotted component, no longer its own pipeline', () => {
    const pe = SLOTTED_COMPONENTS.find((d) => d.key === 'plotEssential');
    expect(pe.file).toBe('Plot Essentials.md');
    expect(pe.declaration).toBe(DECLARATION.INHERITED);
    // v3's two formats disagree about a bare heading; Plot Essentials reads it as level 0.
    expect(pe.defaultHeadingLevel).toBe(0);
  });

  test('Summary is the second slotted component and shares Plot Essentials\' settings', () => {
    // §7.3 treats the two identically because authors shape them alike — one states
    // standing fact and the other narrative past, but both are Plot-Essentials-shaped.
    expect(SLOTTED_COMPONENTS.map((d) => d.key)).toEqual(['plotEssential', 'summary']);
    const summary = SLOTTED_COMPONENTS.find((d) => d.key === 'summary');
    expect(summary.file).toBe('Summary.md');
    expect(summary.declaration).toBe(DECLARATION.INHERITED);
    expect(summary.defaultHeadingLevel).toBe(0);
  });

  test('the three tables together cover the §7.3 component set', () => {
    const covered = [...DOCUMENT_COMPONENTS, ...SLOTTED_COMPONENTS, ...OTHER_COMPONENTS]
      .map((d) => d.key).sort();
    expect(covered).toEqual([
      'aiInstructions', 'authorsNote', 'branchFraming', 'description',
      'opening', 'plotEssential', 'scripts', 'summary',
    ]);
  });
});

describe('emitDocumentComponent', () => {
  test('an absent spec emits nothing and reports no gap', () => {
    expect(emit(AIN, null)).toEqual({ content: null, written: null, gap: null });
  });

  test('a spec pointing nowhere reports a gap rather than throwing', () => {
    expect(emit(AIN, path.join(tmpDir, 'missing.md')).gap).toBe('source not found');
  });

  test('a non-string spec reports a gap', () => {
    expect(emit(AIN, { not: 'a path' }).gap).toBe('source not found');
  });

  test('.md passes through verbatim', () => {
    const { content, written } = emit(AIN, write('ain.md', 'Stay in character.\n\n'));
    expect(content).toBe('Stay in character.');
    expect(fs.readFileSync(written, 'utf8')).toContain('Stay in character.');
  });

  test('.txt passes through verbatim too', () => {
    expect(emit(AIN, write('ain.txt', 'Plain text.')).content).toBe('Plain text.');
  });

  test('an empty passthrough file reports a gap', () => {
    expect(emit(AIN, write('ain.md', '   \n')).gap).toBe('compiled to empty content');
  });

  test('a YAML spec is loaded and compiled rather than passed through', () => {
    const spec = write('ain.cl.yaml', 'sections:\n  - text: Compiled section.\n');
    expect(emit(AIN, spec).content).toContain('Compiled section.');
  });

  test('each row writes to its own filename', () => {
    const ainPath = emit(AIN, write('ain.md', 'A')).written;
    const anPath = emit(AN, write('an.md', 'B')).written;
    expect(path.basename(ainPath)).toBe('AI Instructions.md');
    // Deliberately not "Author's Note.md" — Velvet Lattice requires this spelling.
    expect(path.basename(anPath)).toBe('Author Notes.md');
  });

  test('both rows run through the same code path', () => {
    for (const descriptor of DOCUMENT_COMPONENTS) {
      const result = emit(descriptor, write(`${descriptor.key}.md`, 'Shared.'));
      expect(result.content).toBe('Shared.');
      expect(result.gap).toBeNull();
    }
  });
});

// ── Sections and slots (§7.2, §7.4) ──────────────────────────────────────────
//
// Explicit expectations rather than snapshots. A snapshot cannot fail on its first run, so
// writing one would be the moment the wrapping and join rules were decided — and those
// rules are the whole of what step 4 does, so they are the last thing that should be
// frozen by agreement with themselves.

const PE = SLOTTED_COMPONENTS.find((d) => d.key === 'plotEssential');

/** Build a normalized component the way the loader would, without touching disk. */
function component(sections) {
  return normalizeComponent({ sections });
}

/** `occupants` as compile() hands it over: slot name lowercased → unsorted occupants. */
function fill(entries) {
  const map = new Map();
  for (const [slot, list] of Object.entries(entries)) map.set(slot.toLowerCase(), list);
  return map;
}

const renderPE = (sections, occupants = {}, branchPath = []) => renderSectionedComponent(
  component(sections), branchPath, fill(occupants),
  { defaultHeadingLevel: PE.defaultHeadingLevel, variables: {}, registry: new Map() },
);

describe('renderSectionedComponent — slots', () => {
  test('wrap: each brackets every occupant on its own', () => {
    // The Institute's cast: four separately bracketed blocks, not one.
    const { text } = renderPE(
      { cast: { slot: true, render: { wrapper: 'square' } } },
      { cast: [{ id: 'Malcolm', order: 1, text: 'Malcolm' }, { id: 'Zephon', order: 2, text: 'Zephon' }] },
    );
    expect(text).toBe('[\nMalcolm\n]\n\n[\nZephon\n]');
  });

  test('wrap: all brackets the collection once', () => {
    // Coinflip Company's party directory: one bracketed block, occupants on their own
    // lines with no blank line between them.
    const { text } = renderPE(
      { party: { slot: true, render: { wrapper: 'curly', wrap: 'all' } } },
      { party: [{ id: 'Bryn', order: 2, text: 'Bryn' }, { id: 'Kaiden', order: 1, text: 'Kaiden' }] },
    );
    expect(text).toBe('{\nKaiden\nBryn\n}');
  });

  test('a heading inside wrap: all sits under the wrapper, with a blank line', () => {
    const { text } = renderPE(
      { party: { slot: true, heading: 'The Party', render: { wrapper: 'curly', wrap: 'all' } } },
      { party: [{ id: 'Kaiden', order: 1, text: 'Kaiden' }] },
    );
    expect(text).toBe('{\nThe Party\n\nKaiden\n}');
  });

  test('compact suppresses the blank line after the heading', () => {
    const { text } = renderPE(
      { party: { slot: true, heading: 'The Party', render: { wrapper: 'curly', wrap: 'all', compact: true } } },
      { party: [{ id: 'Kaiden', order: 1, text: 'Kaiden' }] },
    );
    expect(text).toBe('{\nThe Party\nKaiden\n}');
  });

  test('the slot owns the wrapping, so an unwrapped slot ships unwrapped', () => {
    const { text } = renderPE(
      { cast: { slot: true } },
      { cast: [{ id: 'A', order: 1, text: 'A' }] },
    );
    expect(text).toBe('A');
  });

  test('occupants sort by order, then by item id', () => {
    const { text } = renderPE(
      { cast: { slot: true } },
      {
        cast: [
          { id: 'Zephon', order: 1, text: 'Zephon' },
          { id: 'Aness', order: 1, text: 'Aness' },
          { id: 'Malcolm', order: 0, text: 'Malcolm' },
        ],
      },
    );
    // Not the order they arrived in: `order:` first, then the id tiebreak that keeps
    // output reproducible when filesystem traversal is the only other candidate.
    expect(text).toBe('Malcolm\n\nAness\n\nZephon');
  });

  test('an empty slot contributes nothing rather than an empty wrapper', () => {
    expect(renderPE({ cast: { slot: true, render: { wrapper: 'square' } } }, { cast: [] }).text)
      .toBeNull();
  });

  test('a slot no item named contributes nothing', () => {
    expect(renderPE({ cast: { slot: true } }).text).toBeNull();
  });

  test('an occupant that rendered to whitespace is not an occupant', () => {
    expect(renderPE({ cast: { slot: true } }, { cast: [{ id: 'A', order: 1, text: '  \n' }] }).text)
      .toBeNull();
  });
});

describe('renderSectionedComponent — the document', () => {
  test('sections come out in position order, separated by a blank line', () => {
    const { text } = renderPE({
      you: { text: 'You.', render: { position: 5 } },
      genre: { text: 'Genre.', render: { position: 1 } },
    });
    expect(text).toBe('Genre.\n\nYou.');
  });

  test('a bare heading is level 0 in Plot Essentials', () => {
    // The default is a column on the descriptor because v3's two formats disagree:
    // AI Instructions reads the same `heading:` as level 2.
    expect(renderPE({ cast: { heading: 'Cast', text: 'x' } }).text).toBe('Cast\n\nx');
  });

  test('an explicit headingLevel wins over the component default', () => {
    expect(renderPE({ cast: { heading: 'Cast', headingLevel: 2, text: 'x' } }).text)
      .toBe('## Cast\n\nx');
  });

  test('a section excluded on this branch is dropped entirely', () => {
    const sections = {
      genre: { text: 'Genre.' },
      cast: { slot: true, branches: { flashback: null } },
    };
    const occupants = { cast: [{ id: 'A', order: 1, text: 'A' }] };
    expect(renderPE(sections, occupants, ['present']).text).toBe('Genre.\n\nA');
    expect(renderPE(sections, occupants, ['flashback']).text).toBe('Genre.');
  });

  test('a component whose every section is empty renders to nothing', () => {
    expect(renderPE({ cast: { slot: true } }, { cast: [] })).toEqual({ text: null, segments: [] });
  });

  test('segments are keyed by section name, for the cross-branch reports', () => {
    const { segments } = renderPE({
      genre: { text: 'Genre.', render: { position: 1 } },
      cast: { slot: true, render: { position: 2 } },
    }, { cast: [{ id: 'A', order: 1, text: 'A' }] });
    expect(segments).toEqual([
      { key: 'section:genre', text: 'Genre.' },
      { key: 'section:cast', text: 'A' },
    ]);
  });

  test('a null component renders to nothing rather than throwing', () => {
    expect(renderSectionedComponent(null, [], new Map())).toEqual({ text: null, segments: [] });
  });
});

describe('renderSectionedComponent — text sections', () => {
  test('a mapping text renders one line per entry', () => {
    expect(renderPE({ rules: { text: { a: 'First.', b: 'Second.' } } }).text)
      .toBe('First.\nSecond.');
  });

  test('bullet prefixes each entry', () => {
    expect(renderPE({ rules: { text: { a: 'First.', b: 'Second.' }, render: { bullet: true } } }).text)
      .toBe('- First.\n- Second.');
  });

  test('{%variables} resolve in section text', () => {
    const { text } = renderSectionedComponent(
      component({ genre: { text: 'Setting: {%setting}' } }), [], new Map(),
      { defaultHeadingLevel: 0, variables: { setting: 'Luviel' }, registry: new Map() },
    );
    expect(text).toBe('Setting: Luviel');
  });

  test('a heading with no text still renders', () => {
    expect(renderPE({ divider: { heading: 'Cast' } }).text).toBe('Cast');
  });
});

describe('writeSectionedComponent', () => {
  test('null content writes no file', () => {
    expect(writeSectionedComponent(tmpDir, PE, null)).toBeNull();
  });

  test('content lands in Components/ under the descriptor filename, newline-terminated', () => {
    const outPath = writeSectionedComponent(tmpDir, PE, '[\nGenre\n]');
    expect(outPath).toBe(path.join(tmpDir, 'Components', 'Plot Essentials.md'));
    expect(fs.readFileSync(outPath, 'utf8')).toBe('[\nGenre\n]\n');
  });
});
