'use strict';

const path = require('path');
const fs = require('fs');
const { Diagnostic, Diagnostics, SEVERITY, REGISTRY, CODES, severityOf, busWarner } = require('../../src/diag');

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

  test('appends the branch to the header when the diagnostic carries one', () => {
    const d = new Diagnostic({
      code: 'CL0542', severity: SEVERITY.ERROR, message: 'role "LI" does not resolve on this branch.',
      file: 'compile.cl.yaml', branch: 'felix/hard',
    });
    expect(d.format().split('\n')[0]).toBe('ERROR CL0542 compile.cl.yaml (branch felix/hard)');
  });

  test('renders the branch after a bare code when there is no location', () => {
    const d = new Diagnostic({ code: 'CL0542', severity: SEVERITY.ERROR, message: 'x', branch: '(root)' });
    expect(d.format().split('\n')[0]).toBe('ERROR CL0542 (branch (root))');
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

  test('throws on an unknown code — every raised code is in REGISTRY, so a miss is a typo', () => {
    expect(() => severityOf('CL9999')).toThrow(/unknown diagnostic code/);
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

  test('carries a supplied branch onto the diagnostic — the model layer cannot name it', () => {
    const bus = new Diagnostics();
    const onWarn = busWarner(bus, { file: 'x.cl.yaml', branch: 'a/b' });
    onWarn('CL0542', 'role "LI" does not resolve on this branch.');
    expect(bus.all[0].branch).toBe('a/b');
    expect(bus.all[0].format()).toMatch(/^ERROR CL0542 x\.cl\.yaml \(branch a\/b\)\n/);
  });

  test('leaves branch null when the location names none', () => {
    const bus = new Diagnostics();
    busWarner(bus, { file: 'x.cl.yaml' })('CL0321', 'variant not found');
    expect(bus.all[0].branch).toBeNull();
  });
});

describe('REGISTRY agrees with documentation/11-diagnostics.md', () => {
  // The registry in diag.js and the prose registry in 11-diagnostics.md are two views of
  // one thing. This binds them: same code set, same severities, same bands. The prose
  // "Meaning" column stays hand-written and richer than REGISTRY's `summary` — only id,
  // severity and band presence are machine-checked.
  const doc = fs.readFileSync(
    path.join(__dirname, '../../documentation/11-diagnostics.md'), 'utf8'
  );
  const documented = {};
  const rowRe = /^\|\s*`(CL\d{4})`\s*\|\s*(ERROR|WARN|INFO)\s*\|/gm;
  for (let m; (m = rowRe.exec(doc)) !== null; ) documented[m[1]] = m[2].toLowerCase();

  const registryById = {};
  for (const entry of Object.values(REGISTRY)) registryById[entry.id] = entry;

  test('every registry code is documented, with a matching severity', () => {
    for (const [id, entry] of Object.entries(registryById)) {
      expect(documented[id]).toBe(entry.severity);
    }
  });

  test('every documented code exists in the registry (CL0143 and CL0310 are reserved in prose only)', () => {
    const reserved = new Set(['CL0143', 'CL0310']);
    for (const id of Object.keys(documented)) {
      if (reserved.has(id)) continue;
      expect(registryById).toHaveProperty(id);
    }
  });

  test('every registry code sits in the band its id number names', () => {
    // The doc groups rows under `### CL0Nxx — <concern>` headings; a code's id must fall
    // in the band it is written under.
    const bandRe = /^### (CL0(\d)xx) —/gm;
    const headings = [...doc.matchAll(bandRe)].map((m) => ({ band: m[1], digit: m[2], at: m.index }));
    const bandForId = (id) => {
      const pos = doc.indexOf(`| \`${id}\``);
      let band = null;
      for (const h of headings) if (h.at < pos) band = h.digit;
      return band;
    };
    for (const id of Object.keys(registryById)) {
      expect(id[3]).toBe(bandForId(id));
    }
  });
});

describe('every CL code raised in src/ is in the registry', () => {
  // A grep for `'CLNNNN'` string literals anywhere in src/ outside diag.js: after
  // centralization there should be none. A raised code that is not in REGISTRY would
  // throw from severityOf (onWarn path) or simply be undocumented — this catches the
  // second case at the source.
  const srcDir = path.join(__dirname, '../../src');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.js') ? [p] : [];
  });

  test('no src/ module outside diag.js declares a raw CL literal', () => {
    const offenders = [];
    for (const file of walk(srcDir)) {
      if (file.endsWith(`${path.sep}diag.js`)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const lits = [...src.matchAll(/'(CL0\d{3})'/g)].map((m) => m[1]);
      if (lits.length) offenders.push(`${path.relative(srcDir, file)}: ${[...new Set(lits)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  test('every CL id in the registry is unique', () => {
    const ids = Object.values(REGISTRY).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the compiler / lint split (§12.5)', () => {
  const { isOpinion, applyLintLevel, LINT_LEVELS } = require('../../src/diag');

  test('the opinion layer is exactly the four codes tagged layer: opinion', () => {
    const opinionIds = Object.values(REGISTRY)
      .filter((e) => e.layer === 'opinion')
      .map((e) => e.id)
      .sort();
    expect(opinionIds).toEqual(['CL0436', 'CL0437', 'CL0535', 'CL0536']);
    for (const id of opinionIds) expect(isOpinion(id)).toBe(true);
  });

  test('a fact is not an opinion, wherever the check that raises it runs', () => {
    // CL0433 is found by the same sweep as CL0436, and CL0532 by the same pass as CL0535.
    // Sharing a call site is not sharing a layer.
    for (const code of ['CL0430', 'CL0433', 'CL0435', 'CL0532', 'CL0710', 'CL0712']) {
      expect(isOpinion(code)).toBe(false);
    }
  });

  test('level names the one severity the opinion layer speaks at', () => {
    expect(applyLintLevel('error', 'off')).toBeNull();
    expect(applyLintLevel('warn', 'off')).toBeNull();

    // `error` — validate my mod configs, skip the prose heuristics.
    expect(applyLintLevel('error', 'error')).toBe('error');
    expect(applyLintLevel('warn', 'error')).toBeNull();

    // `warn` — hear everything, and let nothing in this layer fail the build.
    expect(applyLintLevel('error', 'warn')).toBe('warn');
    expect(applyLintLevel('warn', 'warn')).toBe('warn');
  });

  test('unset is not a level — an unclamped opinion keeps the severity it was raised with', () => {
    expect(applyLintLevel('error', null)).toBe('error');
    expect(applyLintLevel('warn', undefined)).toBe('warn');
  });

  test('LINT_LEVELS is the closed set the config and the CLI both validate against', () => {
    expect(LINT_LEVELS).toEqual(['off', 'error', 'warn']);
  });
});

describe('Diagnostics applies the ceiling at add time', () => {
  test('an opinion is demoted on the way in, so hasErrors() sees the demoted severity', () => {
    const d = new Diagnostics({ lintLevel: 'warn' });
    d.error(CODES.PLACEHOLDER_UNUSED, 'declared and never used');
    expect(d.hasErrors()).toBe(false);
    expect(d.all[0].severity).toBe('warn');
  });

  test('a fact is untouched by any level — an author cannot silence one', () => {
    const d = new Diagnostics({ lintLevel: 'off' });
    d.error(CODES.LEAKED_FIELD_TOKEN, 'unresolved token {$she}');
    expect(d.all.map((x) => x.code)).toEqual(['CL0430']);
    expect(d.hasErrors()).toBe(true);
  });

  test('a dropped opinion is not added at all, and add returns null', () => {
    const d = new Diagnostics({ lintLevel: 'off' });
    expect(d.warn(CODES.PLACEHOLDER_DUPLICATE_QUESTION, 'two keys, one question')).toBeNull();
    expect(d.isEmpty()).toBe(true);
  });

  test('setLintLevel governs what arrives after it, which is how compile() uses it', () => {
    const d = new Diagnostics();
    d.warn(CODES.PLACEHOLDER_UNUSED, 'before');
    d.setLintLevel('off');
    d.warn(CODES.PLACEHOLDER_UNUSED, 'after');
    expect(d.all.map((x) => x.message)).toEqual(['before']);
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

describe('every registered code is raised somewhere in src/', () => {
  // A code the registry and the docs both carry but no call site raises is dead surface
  // that the doc cross-check above cannot see. There is no allowlist: a new code is added
  // together with the site that raises it, or not at all.
  const fs = require('fs');
  const path = require('path');
  const srcRoot = path.resolve(__dirname, '../../src');
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (full.endsWith('.js') && path.basename(full) !== 'diag.js') out.push(full);
    }
    return out;
  };
  const sources = walk(srcRoot).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  test.each(Object.keys(REGISTRY))('%s', (name) => {
    // Bare name rather than `CODES.<name>`: compile.js aliases the table and several
    // modules destructure it, so the name is the one spelling every raise site shares.
    expect(new RegExp(`\\b${name}\\b`).test(sources)).toBe(true);
  });
});

describe('CODES / REGISTRY shape', () => {
  test('CODES is name → id, derived from REGISTRY', () => {
    for (const [name, entry] of Object.entries(REGISTRY)) {
      expect(CODES[name]).toBe(entry.id);
    }
    expect(Object.keys(CODES).sort()).toEqual(Object.keys(REGISTRY).sort());
  });

});
