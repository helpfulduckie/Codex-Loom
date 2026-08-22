'use strict';

/**
 * v3 opening block list → sections (§7.1, §14.2).
 *
 * The successor to `opening.test.js`, which tested `src/opening.js` — the fourth of §7.1's
 * four syntaxes for "an ordered collection of content with per-branch dispatch". That module
 * is deleted, so what used to be rendering behavior is migration behavior now, and the tests
 * that proved a block rendered correctly live in `compile.integration.test.js`, where the
 * same v3 block list is migrated and then compiled with every original assertion intact.
 *
 * What is left here is the two judgments the conversion has to make on its own: what a
 * section is called, and whether a block's `text:` was prose or a path.
 */

const { convertOpening, namesFromSource } = require('../../src/migrate/opening');

const NL = String.fromCharCode(10);
const src = (...lines) => lines.join(NL);

describe('naming the sections', () => {
  test('a comment above a block becomes that block\'s name', () => {
    // §7.2 makes a name load-bearing — an anonymous block cannot be overridden,
    // repositioned or deleted by an importing project — and a `# ── Awakening ──` header is
    // the closest thing to a name the v3 format ever had. Reading it from the source rather
    // than the parsed document is the only way to get it: `yaml` drops comments on parse.
    expect(namesFromSource(src(
      '# ── Awakening ──────────',
      '- text: One',
      '# ── The Offer ──────────',
      '- text: Two',
    ), 2)).toEqual(['awakening', 'theOffer']);
  });

  test('blocks with no usable comment get generated names', () => {
    expect(namesFromSource(src('- text: One', '- text: Two'), 2)).toEqual(['block1', 'block2']);
  });

  test('a long comment is prose, not a name', () => {
    const long = '# This paragraph explains at length why the block below exists at all';
    expect(namesFromSource(src(long, '- text: One'), 1)).toEqual(['block1']);
  });

  test('duplicate names are disambiguated rather than colliding', () => {
    // Two sections with one name would silently merge, and the second block's text would
    // replace the first's — a whole paragraph lost with nothing reported.
    expect(namesFromSource(src(
      '# Role', '- text: One', '# Role', '- text: Two',
    ), 2)).toEqual(['role', 'role_']);
  });

  test('a project whose blocks are all unnamed says so in the notes', () => {
    const { notes } = convertOpening(
      [{ text: 'One' }, { text: 'Two' }], src('- text: One', '- text: Two'), __dirname,
    );
    expect(notes.join(' ')).toContain('2 opening block(s) had no comment');
  });
});

describe('text: stops being overloaded', () => {
  test('prose stays text:', () => {
    const { sections } = convertOpening([{ text: 'A world awaits.' }], '- text: x', __dirname);
    expect(sections.block1).toEqual({ text: 'A world awaits.' });
  });

  test('a path that resolves to a file becomes file:', () => {
    // v3 decided this on every compile by testing the string against the filesystem, so a
    // block whose prose happened to look like a path was silently read as one. The question
    // is asked once, here, and the answer is written down.
    const { sections } = convertOpening(
      [{ text: './migrate-opening.test.js' }], '- text: x', __dirname,
    );
    expect(sections.block1).toEqual({ file: './migrate-opening.test.js' });
  });

  test('a path that resolves to nothing stays text:, because that is what v3 rendered', () => {
    const { sections } = convertOpening([{ text: './no-such-file.md' }], '- text: x', __dirname);
    expect(sections.block1).toEqual({ text: './no-such-file.md' });
  });

  test('a {%variable} path is read by shape, since no table exists at migration time', () => {
    const { sections } = convertOpening(
      [{ text: '{%openings}/knight.md' }, { text: 'Your role is {%role}.' }],
      '- text: x' + NL + '- text: y', __dirname,
    );
    expect(sections.block1).toEqual({ file: '{%openings}/knight.md' });
    expect(sections.block2).toEqual({ text: 'Your role is {%role}.' });
  });

  test('multi-line prose is never mistaken for a path', () => {
    const { sections } = convertOpening([{ text: 'One.' + NL + 'Two.' }], '- text: x', __dirname);
    expect(sections.block1.file).toBeUndefined();
  });
});

describe('dispatch and variants carry across', () => {
  test('branches: is copied unchanged, because both sides run resolveBranchSpec', () => {
    const branches = { subject: { branches: { mage: [] } }, _: null };
    const { sections } = convertOpening([{ text: 'x', branches }], '- text: x', __dirname);
    expect(sections.block1.branches).toBe(branches);
  });

  test('a variant is already a valid section delta and is copied as written', () => {
    // A v3 opening variant was `{text: …}` and nothing else, which the section vocabulary
    // accepts as-is. The vocabulary widens rather than changing, so no variant is rewritten.
    const variants = { terse: { text: 'Short.' } };
    const { sections, notes } = convertOpening([{ text: 'x', variants }], '- text: x', __dirname);
    expect(sections.block1.variants).toBe(variants);
    expect(notes.filter((n) => n.includes('applied only the first'))).toHaveLength(0);
  });

  test('two variants on one block get a note, because the stacking rule changed', () => {
    // This is the one behavior difference the conversion cannot hide. v3 took the first
    // dispatched name and discarded the rest; sections apply all of them in order. A block
    // with one variant cannot notice, which is why the note fires only from two.
    const { notes } = convertOpening(
      [{ text: 'x', variants: { a: { text: 'A' }, b: { text: 'B' } } }], '- text: x', __dirname,
    );
    expect(notes.join(' ')).toContain('applied only the first');
  });
});

describe('what is not a v3 opening', () => {
  test('a mapping is already a component document and converts to nothing', () => {
    expect(convertOpening({ sections: {} }, '', __dirname)).toBeNull();
  });
});
