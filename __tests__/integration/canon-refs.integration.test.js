'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');

// A self-contained fixture (not the shared golden tree under test/) so this doesn't touch
// the snapshot other integration tests guard. Two canon sets both define "dup"; the project
// reaches one qualified and renames the other on import (§17.4), and both must land in the
// compiled output distinctly.

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-canon-refs-'));

  const canonA = path.join(tmpDir, 'canonA');
  const canonB = path.join(tmpDir, 'canonB');
  const cards = path.join(tmpDir, 'cards');
  const templates = path.join(tmpDir, 'templates');
  fs.mkdirSync(canonA, { recursive: true });
  fs.mkdirSync(canonB, { recursive: true });
  fs.mkdirSync(cards, { recursive: true });
  fs.mkdirSync(templates, { recursive: true });

  fs.writeFileSync(path.join(canonA, 'dup.cl.yaml'), [
    'id: Dup',
    'name: Alpha Dup',
    'aid:',
    '  type: Character',
    '  title: Alpha Dup',
    '  triggers: [AlphaDup]',
    '  encapsulate: true',
    '  known: true',
    'render:',
    '  template: Character',
    '  wrapper: none',
    'body:',
    '  Tagline: from alpha',
    '',
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(canonB, 'dup.cl.yaml'), [
    'id: Dup',
    'name: Beta Dup',
    'aid:',
    '  type: Character',
    '  title: Beta Dup',
    '  triggers: [BetaDup]',
    '  encapsulate: true',
    '  known: true',
    'render:',
    '  template: Character',
    '  wrapper: none',
    'body:',
    '  Tagline: from beta',
    '',
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(cards, 'items.cl.yaml'), [
    '- import: alpha:dup',
    '- id: dup2',
    '  import: beta:dup',
    '',
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(templates, 'Character.template'), [
    '{$aid.title} - {$body.Tagline}',
    '',
  ].join('\n'), 'utf8');

  const configPath = path.join(tmpDir, 'compile.yaml');
  fs.writeFileSync(configPath, [
    'version: 4',
    'structure:',
    '  input:',
    '    items:',
    `      - ${cards}`,
    '    canon:',
    `      alpha: ${canonA}`,
    `      beta: ${canonB}`,
    '    templates:',
    `      - ${templates}`,
    `  output: ${tmpDir}/output`,
    'protagonist: Aness',
    'branches:',
    '  main:',
    '    protagonist: Aness',
    '',
  ].join('\n'), 'utf8');

  compile(configPath);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function characterCardFile() {
  return path.join(tmpDir, 'output', 'Branches', 'main', 'Story Cards', 'Character', 'Character.md');
}

describe('canon resolution — qualified import and rename-on-import (§17)', () => {
  test('both the qualified import and the renamed import reach the compiled output', () => {
    const content = fs.readFileSync(characterCardFile(), 'utf8');
    expect(content).toContain('Alpha Dup - from alpha');
    expect(content).toContain('Beta Dup - from beta');
  });
});
