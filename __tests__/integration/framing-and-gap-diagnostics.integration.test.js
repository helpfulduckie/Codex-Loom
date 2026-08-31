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
  const consoleWarnText = [];
  const spies = ['log', 'warn', 'error'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  spies[1].mockImplementation((...args) => { consoleWarnText.push(args.join(' ')); });
  try {
    compile(path.join(dir, 'compile.yaml'), { diagnostics });
  } catch (err) {
    // Both subjects are diagnostics; a throw carries only a count.
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { diagnostics, consoleWarnText };
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
    const { diagnostics, consoleWarnText } = compileProject(project([]));
    const found = diagnostics.all.filter((d) => d.code === CODES.BRANCH_FRAMING_IGNORED);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warn');
    expect(found[0].message).toMatch(/root/i);
    // The bus renders its own WARNs through `console.warn`, so the proof is not that
    // nothing printed — it is that nothing printed the *bare* string. Every console line
    // mentioning branch framing must be a formatted diagnostic carrying the code.
    const bare = consoleWarnText.filter((t) => /branchFraming/.test(t) && !t.includes('CL0633'));
    expect(bare).toEqual([]);
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
