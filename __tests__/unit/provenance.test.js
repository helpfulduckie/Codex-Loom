'use strict';

/**
 * Unit tests for the §17.2 provenance report (Phase 10 Step 3).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  collectRows, formatProvenanceMd, formatProvenanceCsv, runProvenanceMode,
} = require('../../src/provenance');
const { ItemRegistry } = require('../../src/loader/registry');

describe('provenance collectRows', () => {
  test('lists resolved items with library source and project source', () => {
    const registry = new ItemRegistry();
    registry.set('aness', { id: 'aness', _canonSource: 'main', _source: 'library/Aness.yaml' });
    registry.set('guildmember', { id: 'guildmember', _source: 'project/cards.yaml' });

    const rows = collectRows(registry);
    expect(rows).toEqual([
      {
        id: 'aness', source: 'library:main', file: 'library/Aness.yaml', via: '', status: 'resolved',
      },
      {
        id: 'guildmember', source: 'project', file: 'project/cards.yaml', via: '', status: 'resolved',
      },
    ]);
  });

  test('lists one row per ambiguous rival', () => {
    const registry = new ItemRegistry();
    const a = { id: 'magic', _canonSource: 'grimwood', _source: 'grimwood/magic.yaml' };
    const b = { id: 'magic', _canonSource: 'hollow', _source: 'hollow/magic.yaml' };
    registry.qualified.set('grimwood:magic', a);
    registry.qualified.set('hollow:magic', b);
    registry.ambiguous.set('magic', [a, b]);

    const rows = collectRows(registry);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'ambiguous')).toBe(true);
    expect(rows.map((r) => r.source).sort()).toEqual(['library:grimwood', 'library:hollow']);
  });

  test('includes import ref in via column', () => {
    const registry = new ItemRegistry();
    registry.set('hero', { id: 'hero', import: 'Aness', _source: 'project/defs.yaml' });

    const rows = collectRows(registry);
    expect(rows[0].via).toBe('Aness');
  });
});

describe('provenance formatting', () => {
  test('formatProvenanceMd renders a table', () => {
    const rows = [
      { id: 'aness', source: 'library:main', file: 'library/Aness.yaml', via: '', status: 'resolved' },
    ];
    const md = formatProvenanceMd('output', rows);
    expect(md).toContain('# Item Provenance — output');
    expect(md).toContain('| aness | library:main | library/Aness.yaml | — | resolved |');
  });

  test('formatProvenanceCsv escapes commas and quotes', () => {
    const rows = [
      { id: 'a,b', source: 'project', file: 'say "hi"', via: '', status: 'resolved' },
    ];
    const csv = formatProvenanceCsv(rows);
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"say ""hi"""');
  });
});

describe('runProvenanceMode', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-provenance-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes md and csv and returns both paths', () => {
    const registry = new ItemRegistry();
    registry.set('x', { id: 'x', _source: 'x.yaml' });

    const { written } = runProvenanceMode(registry, tmpDir, 'MyProject');
    expect(written).toHaveLength(2);
    expect(written.every((p) => fs.existsSync(p))).toBe(true);
    expect(written[0]).toBe(path.join(tmpDir, 'MyProject.provenance.md'));
    expect(written[1]).toBe(path.join(tmpDir, 'MyProject.provenance.csv'));
  });
});
