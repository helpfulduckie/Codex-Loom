'use strict';

const fs = require('fs');
const path = require('path');
const {
  SLOTTED_COMPONENTS,
  isPassthrough, readPassthrough,
  renderSectionedComponent, writeSectionedComponent, renderFrontmatter,
} = require('../../src/emit/components');
const { normalizeComponent } = require('../../src/model/component');
const { withTmpDir } = require('../helpers/project');

let tmpDir;
beforeEach(() => { tmpDir = withTmpDir(); });

const AIN = SLOTTED_COMPONENTS.find((d) => d.key === 'aiInstructions');

function write(name, content) {
  const full = path.join(tmpDir, name);
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

describe('passthrough components', () => {
  test('.md is prose to copy, not a document to compile', () => {
    const spec = write('ain.md', 'Stay in character.');
    expect(isPassthrough(spec)).toBe(true);
    expect(readPassthrough(spec)).toBe('Stay in character.');
  });

  test('.txt counts too, and trailing blank lines are trimmed', () => {
    expect(isPassthrough(write('ain.txt', 'Plain text.'))).toBe(true);
    expect(readPassthrough(write('trail.md', 'Body.\n\n\n'))).toBe('Body.');
  });

  test('a whitespace-only file reads as nothing rather than as blank prose', () => {
    expect(readPassthrough(write('blank.md', '   \n'))).toBeNull();
  });

  test('a YAML spec is not passthrough, so it goes down the sections path', () => {
    expect(isPassthrough(write('ain.cl.yaml', 'sections: {}'))).toBe(false);
    expect(isPassthrough(null)).toBe(false);
    expect(isPassthrough({ not: 'a path' })).toBe(false);
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

  // §9.7: the call site most likely to be skipped, since `applyTokenPass` runs against
  // `item: {}` here — a role resolving in component prose is the half of the feature
  // that reaches AI Instructions and Author's Note, not only character card bodies.
  test('a role token resolves in section text', () => {
    const malcolm = { id: 'malcolm', name: 'Malcolm', pronouns: 'male' };
    const registry = new Map([['malcolm', malcolm]]);
    const { text } = renderSectionedComponent(
      component({ relationship: { text: 'History with {$LI} is unresolved. {$LI.He} does not raise it.' } }),
      [], new Map(),
      {
        defaultHeadingLevel: 0, variables: {}, registry,
        roles: { LI: 'Malcolm' }, branchProtagonist: null,
      },
    );
    expect(text).toBe('History with Malcolm is unresolved. He does not raise it.');
  });

  test('an undeclared role in section text raises CL0540 through onWarn', () => {
    const onWarn = jest.fn();
    renderSectionedComponent(
      component({ relationship: { text: '{$Nope} is unresolved.' } }), [], new Map(),
      {
        defaultHeadingLevel: 0, variables: {}, registry: new Map(),
        roles: { LI: 'Malcolm' }, branchProtagonist: null, onWarn,
      },
    );
    expect(onWarn).toHaveBeenCalledWith('CL0540', expect.stringContaining('Nope'));
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

// ── The AI Instructions format, after its own pipeline was deleted ────────────
//
// These were `ain.test.js`'s `compileAIN` cases. They live here now because the behavior
// does: `ain.js` had its own section renderer, its own sort, and its own heading default,
// and all three turned out to be the sectioned renderer with `defaultHeadingLevel: 2`.
// Keeping the cases is the point — the golden fixtures cannot fail on any of this, since
// every fixture's AI Instructions is a `.md` passthrough.

const renderAIN = (sections, branchPath = []) => renderSectionedComponent(
  component(sections), branchPath, new Map(),
  { defaultHeadingLevel: AIN.defaultHeadingLevel, variables: {}, registry: new Map() },
).text;

describe('renderSectionedComponent — the AI Instructions heading default', () => {
  test('a bare heading renders at level 2', () => {
    expect(renderAIN({ rules: { heading: 'Rules', text: 'Stay in character.' } }))
      .toBe('## Rules\n\nStay in character.');
  });

  test('an explicit headingLevel overrides the default', () => {
    expect(renderAIN({ rules: { heading: 'Rules', headingLevel: 3, text: 'x' } }))
      .toBe('### Rules\n\nx');
  });

  test('headingLevel 0 renders the heading with no hashes at all', () => {
    // Which is how the same key behaves in Plot Essentials by default — the two formats
    // disagree about the default, never about what a level means.
    expect(renderAIN({ rules: { heading: 'Rules', headingLevel: 0, text: 'x' } }))
      .toBe('Rules\n\nx');
  });
});

describe('renderSectionedComponent — the AI Instructions section shapes', () => {
  test('mapping-form text renders one line per entry, names discarded', () => {
    // The names are not output; they exist so a variant can replace or delete one rule
    // without restating the block.
    expect(renderAIN({
      rules: { text: { pacing: 'Scenes advance on player action.', register: 'Close third person.' } },
    })).toBe('Scenes advance on player action.\nClose third person.');
  });

  test('bullet renders each line of a mapping as a list item', () => {
    expect(renderAIN({
      rules: { text: { a: 'First.', b: 'Second.' }, render: { bullet: true } },
    })).toBe('- First.\n- Second.');
  });

  test('sections sort by render.position, and declaration order breaks the tie', () => {
    expect(renderAIN({
      last: { text: 'C', render: { position: 9 } },
      first: { text: 'A', render: { position: 1 } },
      alsoFive: { text: 'B1' },
      andFive: { text: 'B2' },
    })).toBe('A\n\nB1\n\nB2\n\nC');
  });

  test('a document whose every section is empty renders as nothing, not as blank lines', () => {
    expect(renderAIN({ hollow: { text: '' } })).toBeNull();
    expect(renderAIN({})).toBeNull();
  });

  test('compact suppresses the blank line between a heading and its text', () => {
    expect(renderAIN({ rules: { heading: 'Rules', text: 'x', render: { compact: true } } }))
      .toBe('## Rules\nx');
  });
});
