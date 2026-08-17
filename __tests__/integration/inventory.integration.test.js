'use strict';

/**
 * `--inventory` end to end (v4 spec §7.9) — step 9.
 *
 * The unit tests cover the two compressions on synthetic leaves; this covers the capture,
 * which is the half that can silently disagree with the compiler. The report reads
 * `slotIndex` and the occupant map rather than the output file, so it is capable of
 * claiming a placement the emitter did not make — and the assertions below pair each
 * inventory row against the Plot Essentials file it describes.
 *
 * The three corpora cannot check any of this. All three fill every slot they declare on
 * every branch, so the empty and gated states never occur, and their only passthrough is
 * an AI Instructions `.md` that declares no slots to report.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { compile } = require('../../src/compile');

let tmpDir;

const inventory = () => fs.readFileSync(
  path.join(tmpDir, 'output', 'Overview', 'Inventory.md'), 'utf8',
);
const plotEssentials = (branch) => fs.readFileSync(
  path.join(tmpDir, 'output', 'Branches', branch, 'Components', 'Plot Essentials.md'), 'utf8',
);

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-inventory-'));
  const write = (rel, content) => {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };

  write('templates/Brief.template', '{$name.full}');

  write('Codex/items.yaml', [
    // `order:` is deliberately the reverse of alphabetical, so a report that re-sorted
    // by id would disagree with the file rather than merely look different.
    '- id: Zara',
    '  name: {display: Zara, full: Zara Ondt}',
    '  aid: {type: Character, triggers: [Zara]}',
    '  render: {template: Brief, plotEssential: {slot: cast, order: 1}}',
    '',
    '- id: Aldo',
    '  name: {display: Aldo, full: Aldo Pike}',
    '  aid: {type: Character, triggers: [Aldo]}',
    '  render: {template: Brief, plotEssential: {slot: cast, order: 2}}',
    '',
    // Only on the `solo` branch, so its slot occupancy differs per branch.
    '- id: Guest',
    '  name: {display: Guest, full: Guest Marlow}',
    '  aid: {type: Character, triggers: [Guest]}',
    '  render: {template: Brief, plotEssential: {slot: cast, order: 3}}',
    '  branches: {duo: ~}',
  ].join('\n'));

  write('components/plot-essentials.yaml', [
    'sections:',
    '  genre:',
    '    text: "Genre: Test"',
    '    render: {position: 1}',
    '  cast:',
    '    slot: true',
    '    heading: Cast',
    '    render: {position: 2}',
    // Declared everywhere, gated off on `duo` — the state §7.4 keeps legitimate.
    '  hints:',
    '    slot: true',
    '    heading: Hints',
    '    render: {position: 3}',
    '    branches: {duo: ~}',
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
    '  solo: {}',
    '  duo: {}',
  ].join('\n'));

  const quiet = ['log', 'warn'].map((l) => jest.spyOn(console, l).mockImplementation(() => {}));
  try {
    compile(path.join(tmpDir, 'compile.yaml'), { inventory: true });
  } finally {
    quiet.forEach((s) => s.mockRestore());
  }
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('--inventory reports what the slots hold', () => {
  test('a slot filled differently per branch gets one row per occupancy', () => {
    const report = inventory();
    expect(report).toContain('| Zara, Aldo, Guest | 1 — `solo` |');
    expect(report).toContain('| Zara, Aldo | 1 — `duo` |');
  });

  test('the reported order is the file order, not alphabetical', () => {
    // `order:` 1/2/3 against ids sorting Aldo, Guest, Zara — so the two disagree, and
    // agreement with the file is what proves the report read §7.4's sort.
    const pe = plotEssentials('solo');
    expect(pe.indexOf('Zara Ondt')).toBeLessThan(pe.indexOf('Aldo Pike'));
    expect(pe.indexOf('Aldo Pike')).toBeLessThan(pe.indexOf('Guest Marlow'));
    expect(inventory()).toContain('Zara, Aldo, Guest');
  });

  test('a declared slot nobody filled reads as empty, not as absent', () => {
    // `hints` is placeable on `solo` and no item targets it — CL0614's WARN case.
    expect(inventory()).toContain('| (empty) | 1 — `solo` |');
  });

  test('a slot the component gated off is reported as gated, not as empty', () => {
    expect(inventory()).toContain('| (gated off this branch) | 1 — `duo` |');
    // And the distinction is real: the gated branch has no Hints heading at all, while
    // the empty one is a declared slot that simply drew no occupants.
    expect(plotEssentials('duo')).not.toContain('Hints');
  });

  test('the item table gives each item its target and the branches it landed on', () => {
    const report = inventory();
    expect(report).toContain('| Guest | Plot Essentials / `cast` | 1 — `solo` |');
    expect(report).toContain('| Zara | Plot Essentials / `cast` | all 2 |');
  });

  test('a text section is not a slot and stays out of the report', () => {
    expect(inventory()).not.toContain('`genre`');
  });
});
