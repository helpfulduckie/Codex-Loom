'use strict';

/**
 * Two diagnostics that used to print straight to the console, now on the bus.
 *
 * `CL0633` replaced a pair of bare `console.warn` calls in the branch-framing walker, and
 * `CL0634` replaced a `console.error` header plus two lines per gap in `compile()`'s
 * requested-but-unwritten component check. Both were uncoded and unlocated, so nothing
 * could assert on them and `--lint`-style consumers never saw them at all.
 *
 * These are here rather than in `root-framing.integration.test.js` because that file's
 * `beforeAll` builds one project and compiles it once; both cases below need a project
 * shaped wrongly on purpose, and the `CL0634` one aborts the compile by design.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');
const { Diagnostics, CODES } = require('../../src/diag');

/** Build a throwaway project from `{relPath: content}` and compile it, capturing the bus. */
function compileProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-bus-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  const diagnostics = new Diagnostics();
  try {
    compile(path.join(dir, 'compile.yaml'), { diagnostics });
  } catch (err) {
    // Both subjects are diagnostics; a throw carries only a count.
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { diagnostics };
}

const ITEMS = [
  '- id: Aness',
  '  name: Aness',
  '  pronouns: female',
  '  aid: {type: Character, triggers: [Aness]}',
  '  render: {template: Character, wrapper: none}',
  '',
].join('\n');

describe('CL0633 — branchFraming at a node with nothing below it', () => {
  const project = (extra) => ({
    'templates/Character.template': '{$name}\n',
    'Codex/items.yaml': ITEMS,
    'compile.yaml': [
      'version: 4',
      'title: Framing Probe',
      'structure:',
      '  input:',
      "    items: ['./Codex']",
      "    templates: ['./templates']",
      "  output: './out'",
      'components:',
      '  branchFraming: "Which road do you take?"',
      ...extra,
      '',
    ].join('\n'),
  });

  test('a root branchFraming with no branches is a WARN on the bus, not a console.warn', () => {
    const { diagnostics } = compileProject(project([]));
    const found = diagnostics.all.filter((d) => d.code === CODES.BRANCH_FRAMING_IGNORED);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warn');
    expect(found[0].message).toMatch(/root/i);
  });

  test('branchFraming on a leaf branch names the branch', () => {
    const { diagnostics } = compileProject(project([
      'branches:',
      '  subject:',
      '    components:',
      '      branchFraming: Which year did they take you?',
    ]));
    const found = diagnostics.all.filter((d) => d.code === CODES.BRANCH_FRAMING_IGNORED);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((d) => d.message.includes('subject'))).toBe(true);
  });
});

describe('CL0634 — a requested component that produced no output', () => {
  test('a component whose source is missing is an ERROR on the bus carrying the spec', () => {
    const { diagnostics } = compileProject({
      'templates/Character.template': '{$name}\n',
      'Codex/items.yaml': ITEMS,
      'compile.yaml': [
        'version: 4',
        'title: Gap Probe',
        'structure:',
        '  input:',
        "    items: ['./Codex']",
        "    templates: ['./templates']",
        "  output: './out'",
        'components:',
        '  plotEssential: ./components/does-not-exist.yaml',
        '',
      ].join('\n'),
    });
    const found = diagnostics.all.filter((d) => d.code === CODES.COMPONENT_NO_OUTPUT);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].severity).toBe('error');
    // The spec is what makes the error actionable — it is the path the author typed.
    expect(found.some((d) => d.message.includes('does-not-exist.yaml'))).toBe(true);
  });
});

/**
 * An inline `opening:` carrying a `{$role}` token used to be a fatal `CL0634` — the
 * spec-resolver's brace guard rejected any `{` as an unexpanded path before the
 * inline-prose branch could take the string as content. The guard is now narrowed to
 * `{%…}` (a compile variable that named a path and did not resolve), and the leaf loop
 * runs the role/pronoun token pass over an `inlineProse` component's text. So a role
 * reference in an inline opening resolves; a genuinely unknown one leaks to the CL0430
 * output sweep exactly as it would from a `sections:` file; and a stray `{%var}` still
 * gaps, so the guard is narrowed rather than deleted.
 */
describe('inline opening: — role tokens resolve, the {%…} guard stays', () => {
  const read = (dir, ...p) => fs.readFileSync(path.join(dir, 'out', ...p), 'utf8');

  /** Compile `{relPath: content}` and keep the tree so `out/` can be read. */
  function compileKeeping(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-inline-open-'));
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    const diagnostics = new Diagnostics();
    try {
      compile(path.join(dir, 'compile.yaml'), { diagnostics });
    } catch (err) { /* diagnostics are the subject */ }
    return { dir, diagnostics };
  }

  const project = (openingLine) => ({
    'templates/Character.template': '{$name}\n',
    'Codex/items.yaml': [
      ITEMS,
      '- id: Voss',
      '  name: Voss',
      '  pronouns: nonbinary',
      '  aid: {type: Character, triggers: [Voss]}',
      '  render: {template: Character, wrapper: none}',
      '',
    ].join('\n'),
    'compile.yaml': [
      'version: 4',
      'title: Inline Opening Probe',
      'structure:',
      '  input:',
      "    items: ['./Codex']",
      "    templates: ['./templates']",
      "  output: './out'",
      'roles:',
      '  protagonist: Aness',
      '  rival: Voss',
      'components:',
      `  opening: ${openingLine}`,
      'branches:',
      '  subject: {}',
      '',
    ].join('\n'),
  });

  test('a declared role in an inline opening resolves, with no CL0634 and no CL0430', () => {
    const { dir, diagnostics } = compileKeeping(project('"You wake, and {$rival} is already gone."'));
    expect(diagnostics.all.filter((d) => d.code === CODES.COMPONENT_NO_OUTPUT)).toEqual([]);
    expect(diagnostics.all.filter((d) => d.code === CODES.LEAKED_FIELD_TOKEN)).toEqual([]);
    expect(read(dir, 'Branches', 'subject', 'Components', 'Opening.md'))
      .toBe('You wake, and Voss is already gone.\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an unknown {$token} in an inline opening leaks to CL0430, not CL0634', () => {
    const { dir, diagnostics } = compileKeeping(project('"You wake, and {$ghost} is gone."'));
    expect(diagnostics.all.filter((d) => d.code === CODES.COMPONENT_NO_OUTPUT)).toEqual([]);
    expect(diagnostics.all.some((d) => d.code === CODES.LEAKED_FIELD_TOKEN)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an unresolved {%var} in an inline opening is still CL0634', () => {
    const { dir, diagnostics } = compileKeeping(project('"{%missingPath}"'));
    const found = diagnostics.all.filter((d) => d.code === CODES.COMPONENT_NO_OUTPUT);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].severity).toBe('error');
    expect(found.some((d) => /\{%/.test(d.message))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
