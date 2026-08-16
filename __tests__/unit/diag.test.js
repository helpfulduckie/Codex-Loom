'use strict';

const path = require('path');
const fs = require('fs');
const { Diagnostic, Diagnostics, SEVERITY, CODES, SEVERITY_BY_CODE, severityOf, busWarner } = require('../../src/diag');

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

describe('severityOf', () => {
  test('returns ERROR for CL0323', () => {
    expect(severityOf('CL0323')).toBe(SEVERITY.ERROR);
  });

  test('returns WARN for CL0321', () => {
    expect(severityOf('CL0321')).toBe(SEVERITY.WARN);
  });

  test('defaults an unregistered code to WARN, never drops it', () => {
    expect(severityOf('CL9999')).toBe(SEVERITY.WARN);
  });
});

describe('busWarner', () => {
  test('routes an ERROR-severity code onto the bus with its code/message intact', () => {
    const bus = new Diagnostics();
    const onWarn = busWarner(bus);
    onWarn('CL0323', 'item declares both notes: and description:');
    expect(bus.hasErrors()).toBe(true);
    expect(bus.all[0].code).toBe('CL0323');
    expect(bus.all[0].message).toBe('item declares both notes: and description:');
  });

  test('routes a WARN-severity code without setting hasErrors', () => {
    const bus = new Diagnostics();
    const onWarn = busWarner(bus);
    onWarn('CL0321', 'variant not found');
    expect(bus.hasErrors()).toBe(false);
  });

  test('carries a supplied location onto the diagnostic', () => {
    const bus = new Diagnostics();
    const onWarn = busWarner(bus, { file: 'x.cl.yaml', line: 4 });
    onWarn('CL0321', 'variant not found');
    expect(bus.all[0].location).toBe('x.cl.yaml:4');
  });
});

describe('SEVERITY_BY_CODE roster', () => {
  // A new model/ code that skips this table would silently default to WARN via
  // severityOf's fallback — which is the exact failure this change exists to end.
  test('every model/ code reachable through onWarn is registered', () => {
    const itemCodes = Object.values(require('../../src/model/item').CODES);
    const fieldopsCodes = Object.values(require('../../src/model/fieldops').CODES);
    const pronounsCodes = Object.values(require('../../src/model/pronouns').CODES);
    for (const code of [...itemCodes, ...fieldopsCodes, ...pronounsCodes]) {
      expect(SEVERITY_BY_CODE).toHaveProperty(code);
    }
  });
});

describe('SEVERITY_BY_CODE agrees with documentation/11-diagnostics.md', () => {
  test('every registered code matches the severity documented in the registry table', () => {
    const docPath = path.join(__dirname, '../../documentation/11-diagnostics.md');
    const doc = fs.readFileSync(docPath, 'utf8');
    const documented = {};
    const rowRe = /^\|\s*`(CL\d+)`\s*\|\s*(ERROR|WARN|INFO)\s*\|/gm;
    let m;
    while ((m = rowRe.exec(doc)) !== null) {
      documented[m[1]] = m[2].toLowerCase();
    }
    for (const [code, severity] of Object.entries(SEVERITY_BY_CODE)) {
      expect(documented[code]).toBe(severity);
    }
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
    CL03: ['ITEM_RESOLUTION_FAILED'],
    CL04: ['TEMPLATE_NOT_FOUND', 'RENDER_FAILED'],
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

describe('CL0324/CL0420/CL0421 (compile.js/pe.js item and render failures)', () => {
  // These deliberately have no SEVERITY_BY_CODE entry: they are raised through
  // `diagnostics.error()` at call sites in compile.js/pe.js that already hold a bus,
  // not through model/'s severity-blind `onWarn(code, message)` callback.
  test('ITEM_RESOLUTION_FAILED is CL0324', () => {
    expect(CODES.ITEM_RESOLUTION_FAILED).toBe('CL0324');
  });

  test('TEMPLATE_NOT_FOUND is CL0420', () => {
    expect(CODES.TEMPLATE_NOT_FOUND).toBe('CL0420');
  });

  test('RENDER_FAILED is CL0421', () => {
    expect(CODES.RENDER_FAILED).toBe('CL0421');
  });
});
