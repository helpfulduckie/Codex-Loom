'use strict';

const {
  resolveField,
  isTruthy,
  render,
  applyFieldRenderFunctions,
  normalizeWhitespace,
  applyWrapper,
  applyFieldInterpolation,
  applyVariableInterpolation,
} = require('../../src/template');
// The seven render-function evaluators live in render/eval.js; template.js no longer re-exports them.
const {
  evaluateInline,
  evaluateJoin,
  evaluateList,
  evaluateAnd,
  evaluateProse,
  evaluateBlock,
  evaluateKeys,
} = require('../../src/render/eval');
const { Diagnostics } = require('../../src/diag');

describe('resolveField', () => {
  const data = {
    name: 'Aness',
    body: {
      'Physical Traits': { gender: 'female', height: 'tall' },
      tagline: 'Healer',
    },
  };

  test('resolves top-level field', () => {
    expect(resolveField('$name', data)).toBe('Aness');
  });

  test('resolves nested body field case-insensitively', () => {
    expect(resolveField('$body.physical traits.GENDER', data)).toBe('female');
  });

  test('resolves simple body key case-insensitively', () => {
    expect(resolveField('$body.TAGLINE', data)).toBe('Healer');
  });

  test('returns null for nonexistent path', () => {
    expect(resolveField('$body.nonexistent', data)).toBeNull();
  });

  test('returns object for intermediate mapping (not null — for render functions)', () => {
    const val = resolveField('$body.Physical Traits', data);
    expect(val).toEqual({ gender: 'female', height: 'tall' });
  });

  test('returns array for array-valued field', () => {
    const d = { body: { tags: ['a', 'b', 'c'] } };
    expect(resolveField('$body.tags', d)).toEqual(['a', 'b', 'c']);
  });

  test('returns null for empty array', () => {
    const d = { body: { tags: [] } };
    expect(resolveField('$body.tags', d)).toBeNull();
  });

  test('returns null for empty string value', () => {
    const d = { name: '' };
    expect(resolveField('$name', d)).toBeNull();
  });

  test('returns null for whitespace-only scalar values', () => {
    expect(resolveField('$name', { name: ' \t ' })).toBeNull();
  });

  test('returns null for recursively empty arrays and mappings', () => {
    const d = { body: { array: ['', ['  ']], mapping: { first: '', nested: { value: ' ' } } } };
    expect(resolveField('$body.array', d)).toBeNull();
    expect(resolveField('$body.mapping', d)).toBeNull();
  });

  test('drops empty aggregate members without rewriting retained values', () => {
    const d = { body: { array: ['', '  keep  ', { empty: '', value: ' value ' }], mapping: { blank: '', value: '  keep  ', nested: { blank: '', value: ' value ' } } } };
    expect(resolveField('$body.array', d)).toEqual(['  keep  ', { value: ' value ' }]);
    expect(resolveField('$body.mapping', d)).toEqual({ value: '  keep  ', nested: { value: ' value ' } });
  });

  test('keeps false and zero values present for direct rendering', () => {
    expect(resolveField('$body.no', { body: { no: false } })).toBe('false');
    expect(resolveField('$body.count', { body: { count: 0 } })).toBe('0');
  });
});

describe('isTruthy', () => {
  test('present non-empty string is truthy', () => {
    expect(isTruthy('$name', { name: 'Aness' })).toBe(true);
  });

  test('missing field is falsy', () => {
    expect(isTruthy('$name', {})).toBe(false);
  });

  test('string "false" is falsy', () => {
    expect(isTruthy('$known', { known: 'false' })).toBe(false);
  });

  test('string "0" is falsy', () => {
    expect(isTruthy('$known', { known: '0' })).toBe(false);
  });

  test('non-empty array is truthy', () => {
    expect(isTruthy('$body.tags', { body: { tags: ['a'] } })).toBe(true);
  });

  test('empty array is falsy', () => {
    expect(isTruthy('$body.tags', { body: { tags: [] } })).toBe(false);
  });

  test('recursively empty aggregates are falsy while false and zero keep their contract', () => {
    const data = { body: { array: [''], mapping: { value: ' ' }, no: false, count: 0 } };
    expect(isTruthy('$body.array', data)).toBe(false);
    expect(isTruthy('$body.mapping', data)).toBe(false);
    expect(isTruthy('$body.no', data)).toBe(false);
    expect(isTruthy('$body.count', data)).toBe(false);
  });
});

describe('evaluateJoin', () => {
  const data = { body: { a: 'alpha', c: 'gamma' } };

  test.each([
    ['joins present values with separator (double quotes)', 'join("; ", $body.a, $body.c)', 'alpha; gamma'],
    ['joins present values with separator (single quotes)', "join('; ', $body.a, $body.c)", 'alpha; gamma'],
    ['joins present values with separator (backtick quotes)', 'join(`; `, $body.a, $body.c)', 'alpha; gamma'],
    ['skips null/missing fields', 'join(", ", $body.a, $body.missing, $body.c)', 'alpha, gamma'],
    ['single value with no separator', 'join("; ", $body.a)', 'alpha'],
    ['all missing returns empty string', 'join("; ", $body.x, $body.y)', ''],
  ])('%s', (_label, expr, expected) => {
    expect(evaluateJoin(expr, data)).toBe(expected);
  });

  test('spreads array field into join', () => {
    const d = { body: { tags: ['x', 'y', 'z'] } };
    expect(evaluateJoin('join(", ", $body.tags)', d)).toBe('x, y, z');
  });

  test('mixes array and scalar refs in join', () => {
    const d = { body: { tags: ['x', 'y'], extra: 'z' } };
    expect(evaluateJoin('join("; ", $body.tags, $body.extra)', d)).toBe('x; y; z');
  });
});

describe('evaluateList', () => {
  test.each([
    ['renders multi-element array as bullet lines with leading newline',
      'list($body.items)', { body: { items: ['alpha', 'beta', 'gamma'] } }, '\n- alpha\n- beta\n- gamma'],
    ['passes string value through unchanged',
      'list($body.text)', { body: { text: '- already\n- bulleted' } }, '- already\n- bulleted'],
    ['returns empty string for missing field',
      'list($body.missing)', {}, ''],
    ['single-element array → renders inline as bare value (no bullet, no newline)',
      'list($body.items)', { body: { items: ['solo'] } }, 'solo'],
  ])('%s', (_label, expr, d, expected) => {
    expect(evaluateList(expr, d)).toBe(expected);
  });
});

describe('render', () => {
  test('interpolates top-level field', () => {
    expect(render('{$name}', { name: 'Aness' })).toBe('Aness');
  });

  test('renders name object as full name by default', () => {
    expect(render('{$name}', { name: { display: 'Aness', full: 'Aness Rozen' } })).toBe('Aness Rozen');
  });

  test('list() on name object renders both values as bullet list', () => {
    const result = render('{list($name)}', { name: { display: 'Aness', full: 'Aness Rozen' } });
    expect(result).toBe('- Aness\n- Aness Rozen');
  });

  test('escaped braces become literal braces', () => {
    expect(render('{{literal}}', {})).toBe('{literal}');
  });

  test('strips blank lines from output', () => {
    const result = render('line1\n\nline2', {});
    expect(result).toBe('line1\nline2');
  });

  test('collapses 3+ consecutive blank lines to no blank line', () => {
    const result = render('line1\n\n\n\nline2', {});
    expect(result).toBe('line1\nline2');
  });

  test('processes conditionals and inline in order', () => {
    const tmpl = '{if $show}[{$label}]{/if}';
    expect(render(tmpl, { show: 'true', label: 'E' })).toBe('[E]');
    expect(render(tmpl, { show: 'false', label: 'E' })).toBe('');
  });

  test('join expression in template', () => {
    const data = { body: { a: 'one', b: 'two' } };
    expect(render('{join("; ", $body.a, $body.b)}', data)).toBe('one; two');
  });

  test('missing field resolves to empty string', () => {
    expect(render('{$missing}', {})).toBe('');
  });
});

// ── applyFieldRenderFunctions ─────────────────────────────────────────────────

describe('applyFieldRenderFunctions', () => {
  test('expands join() in a body field', () => {
    const card = {
      body: {
        head: '{join("; ", $body.gender, $body.hair)}',
        gender: 'female',
        hair: 'black hair',
      },
    };
    applyFieldRenderFunctions(card);
    expect(card.body.head).toBe('female; black hair');
  });

  test('expands and() in a body field — three elements', () => {
    const card = {
      body: {
        summary: '{and($body.tags)}',
        tags: ['brave', 'clever', 'loyal'],
      },
    };
    applyFieldRenderFunctions(card);
    expect(card.body.summary).toBe('brave, clever, and loyal');
  });

  test('{and()} — two-element array → "a and b"', () => {
    const card = {
      body: {
        pair: '{and($body.tags)}',
        tags: ['brave', 'loyal'],
      },
    };
    applyFieldRenderFunctions(card);
    expect(card.body.pair).toBe('brave and loyal');
  });

  test('expands inline() on a nested mapping', () => {
    const card = {
      body: {
        compact: '{inline($body.traits)}',
        traits: { gender: 'female', build: 'willowy' },
      },
    };
    applyFieldRenderFunctions(card);
    expect(card.body.compact).toBe('female willowy');
  });

  test('descends into nested body mappings', () => {
    const card = {
      body: {
        Physical: {
          combined: '{join("; ", $body.Physical.hair, $body.Physical.eyes)}',
          hair: 'black hair',
          eyes: 'brown eyes',
        },
      },
    };
    applyFieldRenderFunctions(card);
    expect(card.body.Physical.combined).toBe('black hair; brown eyes');
  });

  test('leaves pronoun tokens untouched', () => {
    const card = {
      body: {
        note: '{$she} is kind',
        tagline: '{$Id} returns',
      },
    };
    applyFieldRenderFunctions(card);
    expect(card.body.note).toBe('{$she} is kind');
    expect(card.body.tagline).toBe('{$Id} returns');
  });

  test('leaves non-render-function braced tokens untouched', () => {
    const card = {
      body: { note: '{$body.something}' },
    };
    applyFieldRenderFunctions(card);
    // {$body.something} is not a render function call — left as-is
    expect(card.body.note).toBe('{$body.something}');
  });

  test('expands render function in array element', () => {
    const card = {
      body: {
        lines: ['{join(", ", $body.a, $body.b)}', 'plain line'],
        a: 'alpha',
        b: 'beta',
      },
    };
    applyFieldRenderFunctions(card);
    expect(card.body.lines[0]).toBe('alpha, beta');
    expect(card.body.lines[1]).toBe('plain line');
  });

  test('does nothing when card has no body', () => {
    const card = { id: 'test', aid: { type: 'Character' } };
    expect(() => applyFieldRenderFunctions(card)).not.toThrow();
  });

  describe('cross-card refs via itemMap', () => {
    test('join() spreads mapping values from another card', () => {
      const card = {
        id: 'nyra',
        body: { affinity: '{join("; ", $Aness.body.magic.affinity)}' },
      };
      const itemMap = new Map([
        ['aness', { id: 'Aness', body: { magic: { affinity: { ice: 'high ice-affinity', growth: 'moderate growth-affinity' } } } }],
      ]);
      applyFieldRenderFunctions(card, itemMap);
      expect(card.body.affinity).toBe('high ice-affinity; moderate growth-affinity');
    });

    test('join() spreads array values from another card', () => {
      const card = {
        id: 'nyra',
        body: { keywords: '{join(", ", $Aness.body.personality.keywords)}' },
      };
      const itemMap = new Map([
        ['aness', { id: 'Aness', body: { personality: { keywords: ['inquisitive', 'polite', 'sarcastic'] } } }],
      ]);
      applyFieldRenderFunctions(card, itemMap);
      expect(card.body.keywords).toBe('inquisitive, polite, sarcastic');
    });

    test('join() resolves scalar value from another card', () => {
      const card = {
        id: 'nyra',
        body: { tagline: '{join("; ", $Aness.body.tagline)}' },
      };
      const itemMap = new Map([
        ['aness', { id: 'Aness', body: { tagline: 'Journeyman Healer' } }],
      ]);
      applyFieldRenderFunctions(card, itemMap);
      expect(card.body.tagline).toBe('Journeyman Healer');
    });

    test('join() returns empty when no itemMap is passed (backward compat)', () => {
      const card = {
        id: 'nyra',
        body: { affinity: '{join("; ", $Aness.body.magic.affinity)}' },
      };
      applyFieldRenderFunctions(card);
      expect(card.body.affinity).toBe('');
    });

    test('join() returns empty when card ID not in itemMap', () => {
      const card = {
        id: 'nyra',
        body: { affinity: '{join("; ", $Unknown.body.field)}' },
      };
      const itemMap = new Map([
        ['aness', { id: 'Aness', body: { magic: { affinity: 'ice' } } }],
      ]);
      applyFieldRenderFunctions(card, itemMap);
      expect(card.body.affinity).toBe('');
    });

    test('join() with cross-card ref embedded in surrounding text', () => {
      const card = {
        id: 'bishop',
        body: { member: 'Alice ({join("; ", $Alice.body.traits)})' },
      };
      const itemMap = new Map([
        ['alice', { id: 'Alice', body: { traits: { hair: 'blond', eyes: 'blue' } } }],
      ]);
      applyFieldRenderFunctions(card, itemMap);
      expect(card.body.member).toBe('Alice (blond; blue)');
    });
  });
});

// ── render integration ────────────────────────────────────────────────────────

describe('render — whitespace and wrapper', () => {
  test('square wrapper with scalar heading + array entries has no blank line between them', () => {
    const data = { render: { wrapper: 'square' }, body: { heading: 'Title', entries: ['A', 'B'] } };
    const result = render('{wrapper}\n{$body.heading}\n{$body.entries}\n{/wrapper}', data, new Map());
    expect(result).toBe('[\nTitle\n- A\n- B\n]');
  });

  test('{preserve} block protects internal blank lines from collapse', () => {
    const data = { render: { wrapper: 'none' } };
    const tmpl = 'before\n{preserve}\nline1\n\nline2\n{/preserve}\nafter';
    const result = render(tmpl, data, new Map());
    expect(result).toBe('before\nline1\n\nline2\nafter');
  });

  test('auto-wrapper applied to entire output when template has no {wrapper} block', () => {
    const data = { body: { Tagline: 'the archivist' }, render: { wrapper: 'square' } };
    const result = render('{$body.Tagline}', data, new Map());
    expect(result).toBe('[\nthe archivist\n]');
  });

  test('auto-wrapper not applied when render.wrapper is "none"', () => {
    const data = { body: { Tagline: 'hello' }, render: { wrapper: 'none' } };
    expect(render('{$body.Tagline}', data, new Map())).toBe('hello');
  });
});

// ── render — template context tokens ─────────────────────────────────────────

describe('render — template context tokens', () => {
  const richData = {
    name:     { display: 'Roshan', full: 'Elder Roshan' },
    aid:      { type: 'Character', title: 'Elder Roshan', triggers: ['Roshan'], encapsulate: true, known: false },
    render:   { template: 'Character', wrapper: 'none' },
    pronouns: 'male',
    v:        { affiliation: 'guild' },
    body:     {},
    id:       'roshan',
  };

  test.each([
    ['{$name.display}',    'Roshan'],
    ['{$name.full}',       'Elder Roshan'],
    ['{$aid.title}',       'Elder Roshan'],
    ['{$aid.type}',        'Character'],
    ['{$aid.known}',       'false'],
    ['{$aid.encapsulate}', 'true'],
    ['{$render.template}', 'Character'],
    ['{$pronouns}',        'male'],
    ['{$v.affiliation}',   'guild'],
  ])('%s → %s', (token, expected) => {
    expect(render(token, richData)).toBe(expected);
  });
});

// ── normalizeWhitespace ───────────────────────────────────────────────────────

describe('normalizeWhitespace', () => {
  test('trims leading/trailing whitespace from every line', () => {
    expect(normalizeWhitespace('  hello  \n  world  ')).toBe('hello\nworld');
  });

  test('strips tabs', () => {
    expect(normalizeWhitespace('\thello\n\tworld')).toBe('hello\nworld');
  });

  test('collapses multiple consecutive spaces to one', () => {
    expect(normalizeWhitespace('hello   world')).toBe('hello world');
  });

  test('collapses multiple blank lines to a single newline', () => {
    expect(normalizeWhitespace('A\n\n\nB')).toBe('A\nB');
  });

  test('trims document edges', () => {
    expect(normalizeWhitespace('\nhello\n')).toBe('hello');
  });

  test('{preserve} blocks skip whitespace normalization inside', () => {
    const input = 'before\n{preserve}\n  indented  \n\n  spaced  \n{/preserve}\nafter';
    const result = normalizeWhitespace(input);
    expect(result).toContain('  indented  ');
    expect(result).toContain('  spaced  ');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });
});

// ── applyWrapper ──────────────────────────────────────────────────────────────

describe('applyWrapper', () => {
  test('square → wraps with [ and ]', () => {
    expect(applyWrapper('content', 'square')).toBe('[\ncontent\n]');
  });

  test('curly → wraps with { and }', () => {
    expect(applyWrapper('content', 'curly')).toBe('{\ncontent\n}');
  });

  test('none → returns text unchanged', () => {
    expect(applyWrapper('content', 'none')).toBe('content');
  });

  test('undefined wrapper → returns text unchanged', () => {
    expect(applyWrapper('content', undefined)).toBe('content');
  });

  test('case-insensitive wrapper name', () => {
    expect(applyWrapper('content', 'SQUARE')).toBe('[\ncontent\n]');
  });
});

// ── evaluate* helpers ─────────────────────────────────────────────────────────

const evalData = {
  body: {
    Tagline: 'the archivist',
    Keywords: ['brave', 'wise'],
    Traits: { hair: 'silver', eyes: 'grey' },
  },
  aid: {},
  render: {},
  name: 'Roshan',
  id: 'roshan',
  v: {},
};

describe('evaluateProse', () => {
  test.each([
    ['string value → capitalized with period', 'prose($body.Tagline)', 'The archivist.'],
    ['array → each item sentence-cased and joined with spaces', 'prose($body.Keywords)', 'Brave. Wise.'],
    ['null field → empty string', 'prose($body.Missing)', ''],
  ])('%s', (_label, expr, expected) => {
    expect(evaluateProse(expr, evalData)).toBe(expected);
  });

  test('trailing punctuation replaced with period', () => {
    const d = { ...evalData, body: { ...evalData.body, Note: 'done!' } };
    expect(evaluateProse('prose($body.Note)', d)).toBe('Done.');
  });

  test('malformed syntax → throws', () => {
    expect(() => evaluateProse('prose(bad)', evalData)).toThrow('Malformed prose()');
  });
});

describe('evaluateBlock', () => {
  test.each([
    ['string value → returned as-is', 'block($body.Tagline)', 'the archivist'],
    ['array → joined with newlines', 'block($body.Keywords)', 'brave\nwise'],
    ['null field → empty string', 'block($body.Missing)', ''],
  ])('%s', (_label, expr, expected) => {
    expect(evaluateBlock(expr, evalData)).toBe(expected);
  });

  test('malformed syntax → throws', () => {
    expect(() => evaluateBlock('block(bad)', evalData)).toThrow('Malformed block()');
  });
});

describe('evaluateKeys', () => {
  test.each([
    ['object field → - key: value per line', 'keys($body.Traits)', '- hair: silver\n- eyes: grey'],
    ['null field → empty string', 'keys($body.Missing)', ''],
  ])('%s', (_label, expr, expected) => {
    expect(evaluateKeys(expr, evalData)).toBe(expected);
  });

  test('malformed syntax → throws', () => {
    expect(() => evaluateKeys('keys(bad)', evalData)).toThrow('Malformed keys()');
  });
});

describe('evaluateInline', () => {
  test.each([
    ['object field → space-joined values', 'inline($body.Traits)', 'silver grey'],
    ['array field → space-joined', 'inline($body.Keywords)', 'brave wise'],
    ['string field → returned as string', 'inline($body.Tagline)', 'the archivist'],
    ['null field → empty string', 'inline($body.Missing)', ''],
  ])('%s', (_label, expr, expected) => {
    expect(evaluateInline(expr, evalData)).toBe(expected);
  });

  test('malformed syntax → throws', () => {
    expect(() => evaluateInline('inline(bad)', evalData)).toThrow('Malformed inline()');
  });
});

// ── applyFieldInterpolation ───────────────────────────────────────────────────

describe('applyFieldInterpolation', () => {
  test('no card.body → returns without error', () => {
    expect(() => applyFieldInterpolation({ id: 'hero', aid: {} })).not.toThrow();
  });

  test('expands {$body.X} token referencing another body field', () => {
    const card = {
      id: 'hero',
      body: { Tagline: 'Rank: {$body.Title}', Title: 'Guard Captain' },
      aid: {},
      render: {},
    };
    applyFieldInterpolation(card);
    expect(card.body.Tagline).toBe('Rank: Guard Captain');
  });

  test('expands {$v.X} token from card.v', () => {
    const card = {
      id: 'hero',
      body: { Tagline: 'Role: {$v.role}' },
      v: { role: 'knight' },
      aid: {},
      render: {},
    };
    applyFieldInterpolation(card);
    expect(card.body.Tagline).toBe('Role: knight');
  });

  test('mutates body in place', () => {
    const body = { Tagline: 'hello' };
    const card = { id: 'hero', body, aid: {}, render: {} };
    applyFieldInterpolation(card);
    expect(card.body).toBe(body);
  });

  // Field-ref surface parity: dotted aid/render/name refs now resolve in card data.
  test('expands {$aid.X}, {$name.full}, {$render.X} in a body field', () => {
    const card = {
      id: 'hero',
      name: { display: 'Aria', full: 'Aria Voss' },
      aid: { title: 'The Bold' },
      render: { wrapper: 'curly' },
      body: { Tagline: '{$aid.title} / {$name.full} / {$render.wrapper}' },
    };
    applyFieldInterpolation(card);
    expect(card.body.Tagline).toBe('The Bold / Aria Voss / curly');
  });

  // Namespace boundary: bare single-segment {$X} stays for the pronoun/char-ref pass.
  test('leaves bare {$she} and {$Aria} untouched (no dot → not a field ref)', () => {
    const card = { id: 'hero', body: { Tagline: '{$she} meets {$Aria}' }, aid: {}, render: {} };
    applyFieldInterpolation(card);
    expect(card.body.Tagline).toBe('{$she} meets {$Aria}');
  });

  // Coverage parity: field refs resolve inside aid/render/name fields too.
  test('expands {$body.X} placed inside an aid field', () => {
    const card = {
      id: 'hero',
      body: { Title: 'Guard Captain' },
      aid: { title: 'Rank: {$body.Title}' },
      render: {},
    };
    applyFieldInterpolation(card);
    expect(card.aid.title).toBe('Rank: Guard Captain');
  });
});

// ── applyVariableInterpolation ────────────────────────────────────────────────

describe('applyVariableInterpolation', () => {
  test('no card.body → returns without error', () => {
    expect(() => applyVariableInterpolation({ id: 'hero' }, { role: 'x' })).not.toThrow();
  });

  test('null variables → returns without error, body unchanged', () => {
    const card = { body: { Tagline: '{%role}' } };
    applyVariableInterpolation(card, null);
    expect(card.body.Tagline).toBe('{%role}');
  });

  test('expands {%var} tokens in body strings', () => {
    const card = { body: { Tagline: 'Role: {%role}' } };
    applyVariableInterpolation(card, { role: 'knight' });
    expect(card.body.Tagline).toBe('Role: knight');
  });

  // {@name} is a path/prose-only construct; it must NOT be expanded in card bodies.
  // Guards against accidentally wiring component-key expansion into body rendering.
  test('leaves {@name} references untouched in body strings', () => {
    const card = { body: { Tagline: '{@main}/x and {%role}' } };
    applyVariableInterpolation(card, { role: 'knight' });
    expect(card.body.Tagline).toBe('{@main}/x and knight');
  });

  test('expands {%var} in aid.title and aid.triggers', () => {
    const card = { body: {}, aid: { title: '{%role} Codex', triggers: ['{%role}', 'Voss'] } };
    applyVariableInterpolation(card, { role: 'Knight' });
    expect(card.aid.title).toBe('Knight Codex');
    expect(card.aid.triggers).toEqual(['Knight', 'Voss']);
  });

  test('expands {%var} in render.template and render.wrapper', () => {
    const card = { body: {}, render: { template: '{%kind}', wrapper: '{%wrap}' } };
    applyVariableInterpolation(card, { kind: 'Character', wrap: 'curly' });
    expect(card.render.template).toBe('Character');
    expect(card.render.wrapper).toBe('curly');
  });

  test('leaves non-string aid/render fields untouched', () => {
    const card = { body: {}, aid: { encapsulate: true, known: false }, render: { position: 5 } };
    applyVariableInterpolation(card, { x: 'y' });
    expect(card.aid.encapsulate).toBe(true);
    expect(card.aid.known).toBe(false);
    expect(card.render.position).toBe(5);
  });

  test('leaves {@name} untouched in aid fields', () => {
    const card = { body: {}, aid: { title: '{@main} Codex' } };
    applyVariableInterpolation(card, { role: 'x' });
    expect(card.aid.title).toBe('{@main} Codex');
  });

  test('mutates body in place', () => {
    const body = { Tagline: '{%x}' };
    const card = { body };
    applyVariableInterpolation(card, { x: 'y' });
    expect(card.body).toBe(body);
    expect(body.Tagline).toBe('y');
  });

  // card.name is normalized to {display, full} by resolveCard before applyVariableInterpolation runs
  test('expands {%var} tokens in card.name object (display and full)', () => {
    const card = { name: { display: "{%employer}'s", full: "{%employer}'s Penthouse" }, body: {} };
    applyVariableInterpolation(card, { employer: 'Zephon' });
    expect(card.name.full).toBe("Zephon's Penthouse");
    expect(card.name.display).toBe("Zephon's");
  });

  test('expands {%var} tokens in card.id', () => {
    const card = { name: { display: 'Home', full: 'Home' }, id: 'home-{%employer}', body: {} };
    applyVariableInterpolation(card, { employer: 'Zephon' });
    expect(card.id).toBe('home-Zephon');
  });

  test('name object and body expanded together', () => {
    const card = { name: { display: '{%pcName}', full: '{%pcName} home' }, body: { desc: '{%pcName} lives here' } };
    applyVariableInterpolation(card, { pcName: 'Aness' });
    expect(card.name.full).toBe('Aness home');
    expect(card.name.display).toBe('Aness');
    expect(card.body.desc).toBe('Aness lives here');
  });

  test('string-form card.name (defensive fallback) is still expanded', () => {
    const card = { name: "{%employer}'s Penthouse", body: {} };
    applyVariableInterpolation(card, { employer: 'Zephon' });
    expect(card.name).toBe("Zephon's Penthouse");
  });

  test('non-object non-string name (e.g. number) left unchanged', () => {
    const card = { name: 42, body: {} };
    applyVariableInterpolation(card, { x: 'y' });
    expect(card.name).toBe(42);
  });
});

// ── render — diagnostics (Phase 9 Step 0/1) ──────────────────────────────────
//
// `render()`'s fifth argument threads a diagnostics bus through the parser/eval engine.
// These pin the six stop conditions the Phase 9 Session A handoff names: a malformed call
// reports CL0413 naming the template file (replacing a bare `console.warn`), an unclosed
// {if} reports CL0415 and still renders literally (so the CL0433 leak sweep also catches
// it downstream — the corpus proves that, not a unit test), an unknown/circular partial
// reports CL0417/CL0416 instead of throwing, the \x00LBRACE\x00/\x00RBRACE\x00 sentinels
// are gone from src/, and a {preserve} block's boundary survives data that contains the
// literal text "{/preserve}".

describe('render — diagnostics', () => {
  test('malformed join() in a template reports CL0413 naming the file', () => {
    const diagnostics = new Diagnostics();
    const result = render('{join($body.x)}', { body: { x: 'a' } }, new Map(), null, {
      diagnostics, file: 'Broken.template', name: 'Broken',
    });
    expect(result).toBe('');
    expect(diagnostics.all).toHaveLength(1);
    expect(diagnostics.all[0].code).toBe('CL0413');
    expect(diagnostics.all[0].file).toBe('Broken.template');
    expect(diagnostics.all[0].line).toBe(1);
    expect(diagnostics.all[0].col).toBe(1);
  });

  test('an unclosed {if} block reports CL0415 and still renders as literal text', () => {
    const diagnostics = new Diagnostics();
    const result = render('{if $body.x}yes', { body: { x: 'true' } }, new Map(), null, {
      diagnostics, file: 'Unclosed.template',
    });
    // Renders literally — same fallback the v3 regex engine used for a tag it couldn't
    // match — so the output-sweep's CL0433 LEAKED_TEMPLATE_TAG check still catches it too
    // (per the Phase 9 Session A handoff's Unknowns: both reports are correct).
    expect(result).toBe('{if $body.x}yes');
    expect(diagnostics.all.map(d => d.code)).toEqual(['CL0415']);
  });

  test('an unknown partial reports CL0417 instead of throwing', () => {
    const diagnostics = new Diagnostics();
    const result = render('{include ghost}', {}, new Map(), null, { diagnostics, file: 'x.template' });
    expect(result).toBe('');
    expect(diagnostics.all.map(d => d.code)).toEqual(['CL0417']);
  });

  test('a circular partial include reports CL0416 instead of throwing', () => {
    const diagnostics = new Diagnostics();
    const partials = new Map([
      ['a', { content: '{include b}' }],
      ['b', { content: '{include a}' }],
    ]);
    const result = render('{include a}', {}, partials, null, { diagnostics, file: 'x.template' });
    expect(result).toBe('');
    expect(diagnostics.all.map(d => d.code)).toEqual(['CL0416']);
  });

  test('a {preserve} block is bounded by the source, not by data that contains "{/preserve}"', () => {
    const tmpl = 'A\n{preserve}\n{$body.text}\n{/preserve}\nB';
    const data = { body: { text: 'line1{/preserve}line2' } };
    expect(render(tmpl, data, new Map())).toBe('A\nline1{/preserve}line2\nB');
  });

});
