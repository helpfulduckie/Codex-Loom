'use strict';

/**
 * Story-card placement with overrides, through a real compile.
 *
 * Velvet Lattice resolves a leaf's card by name, nearest copy first, so a card that one
 * branch renders differently can sit once at the parent with the odd branch overriding it.
 * `resolveAt` is the repo's model of that lookup, so asserting through it checks that each
 * leaf still receives exactly its own rendering.
 */

const fs = require('fs');
const path = require('path');
const { compileProject } = require('../helpers/project');
const { resolveAt } = require('../../src/compiledTree');

const config = [
  'version: 4',
  'structure:',
  '  input:',
  '    items: [%TMP%/Codex]',
  '    templates: [%TMP%/templates]',
  '  output: %TMP%/output',
  'branches:',
  '  a: {}',
  '  b: {}',
  '  c: {}',
].join('\n');

const items = [
  '- id: Elder',
  '  name: Elder',
  '  aid: {type: Character, triggers: [Elder]}',
  '  render: {template: Card}',
  '  body: {Text: The usual elder.}',
  '  variants:',
  '    odd: {body: {Text: The odd elder.}}',
  '  branches: {b: odd}',
  '- id: Hermit',
  '  name: Hermit',
  '  aid: {type: Character, triggers: [Hermit]}',
  '  render: {template: Card}',
  '  body: {Text: Lives alone.}',
  '  branches: {c: ~}',
].join('\n');

const build = () => compileProject({
  'templates/Card.template': '{$body.Text}',
  'compile.yaml': config,
  'Codex/items.yaml': items,
});

const own = (tmpDir, ...branch) => {
  const dir = branch.reduce((d, b) => path.join(d, 'Branches', b), path.join(tmpDir, 'output'));
  const file = path.join(dir, 'Story Cards', 'Character', 'Character.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

describe('a card one branch renders differently', () => {
  test('is written once at the root, with the odd branch carrying its override', () => {
    const { tmpDir } = build();
    expect(own(tmpDir)).toContain('The usual elder.');
    expect(own(tmpDir, 'b')).toContain('The odd elder.');
    expect(own(tmpDir, 'a')).not.toContain('Elder');
    expect(own(tmpDir, 'c')).not.toContain('Elder');
  });

  test('every leaf still resolves to its own rendering', () => {
    const { tmpDir } = build();
    const elder = (b) => resolveAt(path.join(tmpDir, 'output', 'Branches', b))
      .resolved.cards.find((card) => card.title === 'Elder');
    expect(elder('a').body).toContain('The usual elder.');
    expect(elder('b').body).toContain('The odd elder.');
    expect(elder('c').body).toContain('The usual elder.');
  });
});

describe('a card one branch excludes', () => {
  test('is never written above that branch, since an inherited card cannot be removed', () => {
    const { tmpDir } = build();
    expect(own(tmpDir)).not.toContain('Hermit');
    expect(own(tmpDir, 'a')).toContain('Lives alone.');
    expect(own(tmpDir, 'b')).toContain('Lives alone.');
    expect(own(tmpDir, 'c')).not.toContain('Hermit');
  });
});
