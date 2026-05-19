'use strict';

const {
  resolveField,
  isTruthy,
  evaluateJoin,
  evaluateList,
  processConditionals,
  processInline,
  processIncludes,
  render,
  applyFieldRenderFunctions,
  normalizeWhitespace,
  applyWrapper,
  resolveTemplateName,
  evaluateProse,
  evaluateBlock,
  evaluateKeys,
  evaluateInline,
  processWrapperBlocks,
  applyFieldInterpolation,
  applyVariableInterpolation,
} = require('../../src/template');

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
});

describe('evaluateJoin', () => {
  const data = { body: { a: 'alpha', c: 'gamma' } };

  test('joins present values with separator (double quotes)', () => {
    const result = evaluateJoin('join("; ", $body.a, $body.c)', data);
    expect(result).toBe('alpha; gamma');
  });

  test('joins present values with separator (single quotes)', () => {
    const result = evaluateJoin("join('; ', $body.a, $body.c)", data);
    expect(result).toBe('alpha; gamma');
  });

  test('joins present values with separator (backtick quotes)', () => {
    const result = evaluateJoin('join(`; `, $body.a, $body.c)', data);
    expect(result).toBe('alpha; gamma');
  });

  test('skips null/missing fields', () => {
    const result = evaluateJoin('join(", ", $body.a, $body.missing, $body.c)', data);
    expect(result).toBe('alpha, gamma');
  });

  test('single value with no separator', () => {
    const result = evaluateJoin('join("; ", $body.a)', data);
    expect(result).toBe('alpha');
  });

  test('all missing returns empty string', () => {
    const result = evaluateJoin('join("; ", $body.x, $body.y)', data);
    expect(result).toBe('');
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
  test('renders multi-element array as bullet lines with leading newline', () => {
    const d = { body: { items: ['alpha', 'beta', 'gamma'] } };
    expect(evaluateList('list($body.items)', d)).toBe('\n- alpha\n- beta\n- gamma');
  });

  test('passes string value through unchanged', () => {
    const d = { body: { text: '- already\n- bulleted' } };
    expect(evaluateList('list($body.text)', d)).toBe('- already\n- bulleted');
  });

  test('returns empty string for missing field', () => {
    expect(evaluateList('list($body.missing)', {})).toBe('');
  });

  test('single-element array → renders inline as bare value (no bullet, no newline)', () => {
    const d = { body: { items: ['solo'] } };
    expect(evaluateList('list($body.items)', d)).toBe('solo');
  });
});

describe('processConditionals', () => {
  test('truthy field — body is kept', () => {
    expect(processConditionals('{if $known}yes{/if}', { known: 'true' })).toBe('yes');
  });

  test('falsy field — body is removed', () => {
    expect(processConditionals('{if $known}yes{/if}', {})).toBe('');
  });

  test('else branch used when condition is false', () => {
    expect(processConditionals('{if $known}yes{else}no{/if}', {})).toBe('no');
  });

  test('else branch skipped when condition is true', () => {
    expect(processConditionals('{if $known}yes{else}no{/if}', { known: '1' })).toBe('yes');
  });

  test('nested conditionals resolve innermost first', () => {
    const tmpl = '{if $a}{if $b}both{/if}{/if}';
    expect(processConditionals(tmpl, { a: 'x', b: 'y' })).toBe('both');
    expect(processConditionals(tmpl, { a: 'x' })).toBe('');
    expect(processConditionals(tmpl, {})).toBe('');
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

// ── processIncludes ──────────────────────────────────────────────────────────

describe('processIncludes', () => {
  test('expands a simple include', () => {
    const partials = new Map([['header', { content: 'HEADER' }]]);
    expect(processIncludes('{include header}', partials)).toBe('HEADER');
  });

  test('name lookup is case-insensitive', () => {
    const partials = new Map([['footer', { content: 'FOOTER' }]]);
    expect(processIncludes('{include Footer}', partials)).toBe('FOOTER');
  });

  test('expands nested partials depth-first', () => {
    const partials = new Map([
      ['outer', { content: 'A{include inner}B' }],
      ['inner', { content: 'X' }],
    ]);
    expect(processIncludes('{include outer}', partials)).toBe('AXB');
  });

  test('throws on unknown partial', () => {
    expect(() => processIncludes('{include ghost}', new Map())).toThrow(/Unknown partial "ghost"/);
  });

  test('throws on circular include', () => {
    const partials = new Map([
      ['a', { content: '{include b}' }],
      ['b', { content: '{include a}' }],
    ]);
    expect(() => processIncludes('{include a}', partials)).toThrow(/Circular partial include/);
  });

  test('partial content participates in conditional processing via render', () => {
    const partials = new Map([['cond', { content: '{if $show}yes{/if}' }]]);
    expect(render('{include cond}', { show: 'true' }, partials)).toBe('yes');
    expect(render('{include cond}', { show: 'false' }, partials)).toBe('');
  });

  test('literal braces in partial survive render', () => {
    const partials = new Map([['lit', { content: '{{curly}}' }]]);
    expect(render('{include lit}', {}, partials)).toBe('{curly}');
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

  test('emit warning and leave match intact on bad render function call', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const card = {
      body: { broken: '{join($body.oops)}' }, // missing separator arg
    };
    // Should not throw; bad calls are caught and warned
    expect(() => applyFieldRenderFunctions(card)).not.toThrow();
    warnSpy.mockRestore();
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

  test('{$name.display} → display name', () => {
    expect(render('{$name.display}', richData)).toBe('Roshan');
  });

  test('{$name.full} → full name string', () => {
    expect(render('{$name.full}', richData)).toBe('Elder Roshan');
  });

  test('{$aid.title} → aid title field', () => {
    expect(render('{$aid.title}', richData)).toBe('Elder Roshan');
  });

  test('{$aid.type} → aid type field', () => {
    expect(render('{$aid.type}', richData)).toBe('Character');
  });

  test('{$aid.known} → "false" for boolean false', () => {
    expect(render('{$aid.known}', richData)).toBe('false');
  });

  test('{$aid.encapsulate} → "true" for boolean true', () => {
    expect(render('{$aid.encapsulate}', richData)).toBe('true');
  });

  test('{$render.template} → render template field', () => {
    expect(render('{$render.template}', richData)).toBe('Character');
  });

  test('{$pronouns} → pronoun set string', () => {
    expect(render('{$pronouns}', richData)).toBe('male');
  });

  test('{$v.affiliation} → v block field', () => {
    expect(render('{$v.affiliation}', richData)).toBe('guild');
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

// ── resolveTemplateName ───────────────────────────────────────────────────────

describe('resolveTemplateName', () => {
  test('no style → returns name unchanged', () => {
    expect(resolveTemplateName('character', undefined)).toBe('character');
  });

  test('hint style → appends .hint suffix', () => {
    expect(resolveTemplateName('character', 'hint')).toBe('character.hint');
  });

  test('other style → returns name unchanged', () => {
    expect(resolveTemplateName('character', 'skip')).toBe('character');
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
  test('string value → capitalized with period', () => {
    expect(evaluateProse('prose($body.Tagline)', evalData)).toBe('The archivist.');
  });

  test('trailing punctuation replaced with period', () => {
    const d = { ...evalData, body: { ...evalData.body, Note: 'done!' } };
    expect(evaluateProse('prose($body.Note)', d)).toBe('Done.');
  });

  test('array → each item sentence-cased and joined with spaces', () => {
    expect(evaluateProse('prose($body.Keywords)', evalData)).toBe('Brave. Wise.');
  });

  test('null field → empty string', () => {
    expect(evaluateProse('prose($body.Missing)', evalData)).toBe('');
  });

  test('malformed syntax → throws', () => {
    expect(() => evaluateProse('prose(bad)', evalData)).toThrow('Malformed prose()');
  });
});

describe('evaluateBlock', () => {
  test('string value → returned as-is', () => {
    expect(evaluateBlock('block($body.Tagline)', evalData)).toBe('the archivist');
  });

  test('array → joined with newlines', () => {
    expect(evaluateBlock('block($body.Keywords)', evalData)).toBe('brave\nwise');
  });

  test('null field → empty string', () => {
    expect(evaluateBlock('block($body.Missing)', evalData)).toBe('');
  });

  test('malformed syntax → throws', () => {
    expect(() => evaluateBlock('block(bad)', evalData)).toThrow('Malformed block()');
  });
});

describe('evaluateKeys', () => {
  test('object field → key: value per line', () => {
    expect(evaluateKeys('keys($body.Traits)', evalData)).toBe('hair: silver\neyes: grey');
  });

  test('null field → empty string', () => {
    expect(evaluateKeys('keys($body.Missing)', evalData)).toBe('');
  });

  test('malformed syntax → throws', () => {
    expect(() => evaluateKeys('keys(bad)', evalData)).toThrow('Malformed keys()');
  });
});

describe('evaluateInline', () => {
  test('object field → space-joined values', () => {
    expect(evaluateInline('inline($body.Traits)', evalData)).toBe('silver grey');
  });

  test('array field → space-joined', () => {
    expect(evaluateInline('inline($body.Keywords)', evalData)).toBe('brave wise');
  });

  test('string field → returned as string', () => {
    expect(evaluateInline('inline($body.Tagline)', evalData)).toBe('the archivist');
  });

  test('null field → empty string', () => {
    expect(evaluateInline('inline($body.Missing)', evalData)).toBe('');
  });

  test('malformed syntax → throws', () => {
    expect(() => evaluateInline('inline(bad)', evalData)).toThrow('Malformed inline()');
  });
});

// ── processWrapperBlocks ──────────────────────────────────────────────────────

describe('processWrapperBlocks', () => {
  test('square wrapper replaces {wrapper}...{/wrapper} block', () => {
    expect(processWrapperBlocks('{wrapper}content{/wrapper}', { render: { wrapper: 'square' } }))
      .toBe('[\ncontent\n]');
  });

  test('curly wrapper replaces block', () => {
    expect(processWrapperBlocks('{wrapper}content{/wrapper}', { render: { wrapper: 'curly' } }))
      .toBe('{\ncontent\n}');
  });

  test('none wrapper returns content unchanged', () => {
    expect(processWrapperBlocks('{wrapper}content{/wrapper}', { render: { wrapper: 'none' } }))
      .toBe('content');
  });

  test('no render block → treated as none', () => {
    expect(processWrapperBlocks('{wrapper}content{/wrapper}', {})).toBe('content');
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

  test('mutates body in place', () => {
    const body = { Tagline: '{%x}' };
    const card = { body };
    applyVariableInterpolation(card, { x: 'y' });
    expect(card.body).toBe(body);
    expect(body.Tagline).toBe('y');
  });
});
