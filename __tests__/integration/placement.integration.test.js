'use strict';

/**
 * The item/slot inversion, end to end (v4 spec §7.2) — steps 3, 4 and 5 together.
 *
 * The unit tests cover each half; this covers the join, which is where v3's defect lived.
 * The three facts asserted here are the three the suppression side channel used to be
 * responsible for, and each is now a consequence of one item stating where it renders:
 * an item that names only a component produces no card, an item that names both produces
 * both, and a slot gated off on a branch takes its contents with it.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');

let tmpDir;

const read = (...parts) => fs.readFileSync(path.join(tmpDir, 'output', ...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(tmpDir, 'output', ...parts));
const plotEssentials = (branch) => read('Branches', branch, 'Components', 'Plot Essentials.md');

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-placement-'));
  const write = (rel, content) => {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };

  write('templates/Full.template', '{$name.full}\nTagline: {$body.tagline}');
  write('templates/Brief.template', '{$name.full} ({$body.tagline})');

  write('Codex/items.yaml', [
    // Renders only into Plot Essentials, and carries no `aid:` block — §7.4 asks for
    // triggers and a type only when a story-card target exists.
    '- id: Hero',
    '  name: {display: Hero, full: Hero Vale}',
    '  render:',
    '    template: Full',
    '    storyCard: false',
    '    plotEssential: {slot: you, order: 1}',
    '  body: {tagline: the protagonist}',
    '',
    // Both targets. `wrapper: curly` is deliberate: it governs the story card, and the
    // square cast slot must ignore it rather than nesting one inside the other (§8.4).
    '- id: Ally',
    '  name: {display: Ally, full: Ally Renn}',
    '  aid: {type: Character, triggers: [Ally]}',
    '  render:',
    '    template: Full',
    '    wrapper: curly',
    '    plotEssential: {slot: cast, order: 2, template: Brief}',
    '  body: {tagline: the second}',
    '',
    '- id: Extra',
    '  name: {display: Extra, full: Extra Quill}',
    '  aid: {type: Character, triggers: [Extra]}',
    '  render:',
    '    template: Full',
    '    plotEssential: {slot: cast, order: 1, template: Brief}',
    '  body: {tagline: the first}',
  ].join('\n'));

  write('components/plot-essentials.yaml', [
    'sections:',
    '  genre:',
    '    text: "Genre: Test"',
    '    render: {position: 1, wrapper: square}',
    '  you:',
    '    slot: true',
    '    render: {position: 2, wrapper: curly}',
    '  cast:',
    '    slot: true',
    '    heading: Cast',
    '    render: {position: 3, wrapper: square, wrap: all, compact: true}',
    '    branches: {hidden: ~}',
  ].join('\n'));

  write('compile.yaml', [
    'version: 4',
    'structure:',
    '  input:',
    `    items: [${tmpDir.replace(/\\/g, '/')}/Codex]`,
    `    templates: [${tmpDir.replace(/\\/g, '/')}/templates]`,
    `  output: ${tmpDir.replace(/\\/g, '/')}/output`,
    'components:',
    '  plotEssential: ./components/plot-essentials.yaml',
    'branches:',
    '  shown: {}',
    '  hidden: {}',
  ].join('\n'));

  const quiet = ['log', 'warn'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  try {
    compile(path.join(tmpDir, 'compile.yaml'));
  } finally {
    quiet.forEach((s) => s.mockRestore());
  }
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('story cards stop asking permission (step 5)', () => {
  test('an item that renders only into a component produces no story card', () => {
    expect(read('Branches', 'shown', 'Story Cards', 'Character', 'Character.md'))
      .not.toContain('Hero Vale');
  });

  test('an item that names both targets produces both', () => {
    const cards = read('Branches', 'shown', 'Story Cards', 'Character', 'Character.md');
    expect(cards).toContain('Ally Renn');
    expect(cards).toContain('Extra Quill');
    expect(plotEssentials('shown')).toContain('Ally Renn (the second)');
  });

  test('a story card carries the full template, not the slot\'s', () => {
    // Same item, two templates: the per-target `template:` is what `style: hint` was.
    expect(read('Branches', 'shown', 'Story Cards', 'Character', 'Character.md'))
      .toContain('Tagline: the second');
  });
});

describe('sections and slots (step 4)', () => {
  test('the whole document renders in position order with the declared wrapping', () => {
    expect(plotEssentials('shown')).toBe([
      '[',
      'Genre: Test',
      ']',
      '',
      '{',
      'Hero Vale',
      'Tagline: the protagonist',
      '}',
      '',
      '[',
      'Cast',
      'Extra Quill (the first)',
      'Ally Renn (the second)',
      ']',
      '',
    ].join('\n'));
  });

  test('the slot wrapper wins and the item\'s own wrapper is ignored', () => {
    // Ally declares `wrapper: curly`; the cast slot is square and wraps once. A brace
    // inside the cast block would mean the item's wrapper had leaked through.
    const cast = plotEssentials('shown').split('\n\n').at(-1);
    expect(cast).not.toContain('{');
  });

  test('a slot gated off on a branch takes its occupants with it', () => {
    const hidden = plotEssentials('hidden');
    expect(hidden).not.toContain('Cast');
    expect(hidden).not.toContain('Ally Renn (');
    // …and the items themselves are untouched: they still ship their story cards.
    expect(read('Branches', 'hidden', 'Story Cards', 'Character', 'Character.md'))
      .toContain('Ally Renn');
  });

  test('the you-block is written on every branch, gated or not', () => {
    expect(plotEssentials('hidden')).toContain('Hero Vale');
  });

  test('Plot Essentials lands where Velvet Lattice expects it', () => {
    expect(exists('Branches', 'shown', 'Components', 'Plot Essentials.md')).toBe(true);
  });
});
