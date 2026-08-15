'use strict';

const { Diagnostic, Diagnostics, SEVERITY, CODES } = require('../../src/diag');

describe('Diagnostic.location', () => {
  const base = { code: 'CL0101', severity: SEVERITY.ERROR, message: 'boom' };

  test('renders file:line:col when fully located', () => {
    expect(new Diagnostic({ ...base, file: 'a.yaml', line: 12, col: 3 }).location).toBe('a.yaml:12:3');
  });

  test('drops the column when only a line is known', () => {
    expect(new Diagnostic({ ...base, file: 'a.yaml', line: 12 }).location).toBe('a.yaml:12');
  });

  test('degrades to the file alone when there is no position', () => {
    expect(new Diagnostic({ ...base, file: 'a.yaml' }).location).toBe('a.yaml');
  });

  test('is empty when there is no file', () => {
    expect(new Diagnostic(base).location).toBe('');
  });

  test('treats column 0 as a real position rather than absent', () => {
    expect(new Diagnostic({ ...base, file: 'a.yaml', line: 1, col: 0 }).location).toBe('a.yaml:1:0');
  });
});

describe('Diagnostic.format', () => {
  test('matches the §4.4 shape', () => {
    const d = new Diagnostic({
      code: 'CL0310',
      severity: SEVERITY.ERROR,
      message: 'Item "Kaiden" dispatches branch "felix" to variant "Felix".',
      file: 'codex/npcs.cl.yaml',
      line: 112,
      col: 9,
    });
    expect(d.format()).toBe(
      'ERROR CL0310 codex/npcs.cl.yaml:112:9\n  Item "Kaiden" dispatches branch "felix" to variant "Felix".'
    );
  });

  test('indents every line of a multi-line message', () => {
    const d = new Diagnostic({ code: 'CL0101', severity: SEVERITY.WARN, message: 'one\ntwo' });
    expect(d.format()).toBe('WARN CL0101\n  one\n  two');
  });

  test('appends an indented hint when present', () => {
    const d = new Diagnostic({
      code: 'CL0210',
      severity: SEVERITY.ERROR,
      message: 'Unknown item key "triggers".',
      file: 'monsters.cl.yaml',
      line: 12,
      col: 3,
      hint: '"triggers" is valid under "aid:" — did you mean to nest it there?',
    });
    expect(d.format().split('\n')).toEqual([
      'ERROR CL0210 monsters.cl.yaml:12:3',
      '  Unknown item key "triggers".',
      '  "triggers" is valid under "aid:" — did you mean to nest it there?',
    ]);
  });
});

describe('Diagnostics collection', () => {
  let diags;
  beforeEach(() => { diags = new Diagnostics(); });

  test('starts empty', () => {
    expect(diags.isEmpty()).toBe(true);
    expect(diags.length).toBe(0);
    expect(diags.hasErrors()).toBe(false);
  });

  test('records severity via the helpers', () => {
    diags.error('CL0001', 'e');
    diags.warn('CL0002', 'w');
    diags.info('CL0003', 'i');
    expect(diags.errors.map((d) => d.code)).toEqual(['CL0001']);
    expect(diags.warnings.map((d) => d.code)).toEqual(['CL0002']);
    expect(diags.bySeverity(SEVERITY.INFO).map((d) => d.code)).toEqual(['CL0003']);
    expect(diags.length).toBe(3);
  });

  test('hasErrors is false when only warnings were collected', () => {
    diags.warn('CL0002', 'w');
    expect(diags.hasErrors()).toBe(false);
  });

  test('carries the location through from the loc argument', () => {
    diags.error('CL0101', 'bad', { file: 'x.yaml', line: 4, col: 2 });
    expect(diags.all[0].location).toBe('x.yaml:4:2');
  });

  test('carries a hint through from opts', () => {
    diags.error('CL0210', 'bad', {}, { hint: 'try aid:' });
    expect(diags.all[0].hint).toBe('try aid:');
  });

  test('all returns a copy, so callers cannot mutate the collection', () => {
    diags.error('CL0001', 'e');
    diags.all.push('junk');
    expect(diags.length).toBe(1);
  });

  test('merge absorbs another collector', () => {
    const other = new Diagnostics();
    other.warn('CL0002', 'w');
    diags.error('CL0001', 'e');
    diags.merge(other);
    expect(diags.length).toBe(2);
    expect(diags.warnings).toHaveLength(1);
  });

  test('merge accepts a plain array', () => {
    diags.merge([new Diagnostic({ code: 'CL0001', severity: SEVERITY.ERROR, message: 'e' })]);
    expect(diags.hasErrors()).toBe(true);
  });

  test('merge ignores null', () => {
    expect(() => diags.merge(null)).not.toThrow();
    expect(diags.length).toBe(0);
  });

  test('clear empties the collection', () => {
    diags.error('CL0001', 'e');
    expect(diags.clear().length).toBe(0);
  });

  test('format separates diagnostics with a blank line', () => {
    diags.error('CL0001', 'first');
    diags.warn('CL0002', 'second');
    expect(diags.format()).toBe('ERROR CL0001\n  first\n\nWARN CL0002\n  second');
  });
});

describe('module purity', () => {
  test('diag.js requires neither fs nor console — model/ depends on this (§3.3)', () => {
    const source = require('fs').readFileSync(require.resolve('../../src/diag'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/require\(['"]fs['"]\)/);
    expect(code).not.toMatch(/console\./);
  });
});

describe('CODES', () => {
  /**
   * The bands diag.js declares in its header, restated as data. Listing every code here
   * means adding one to the wrong band fails, and adding one to no band fails too — the
   * bands exist so documented codes never have to move, which only holds if they are
   * checked rather than intended.
   */
  const BANDS = {
    CL01: ['YAML_PARSE_FAILED', 'YAML_FILE_UNREADABLE', 'YAML_EMPTY_FILE',
      'YAML_NULL_DOCUMENT', 'TOKEN_SWALLOWED_BY_YAML'],
    CL07: ['TRIGGER_CONTAINS_COMMA', 'TRIGGER_EMPTY'],
  };

  test('every code sits in the band its area declares', () => {
    for (const [band, names] of Object.entries(BANDS)) {
      for (const name of names) expect(CODES[name]).toMatch(new RegExp(`^${band}\\d\\d$`));
    }
  });

  test('every declared code is assigned to a band', () => {
    expect(Object.keys(CODES).sort()).toEqual(Object.values(BANDS).flat().sort());
  });

  test('codes are unique', () => {
    const values = Object.values(CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});
