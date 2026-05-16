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
  test('renders array as bullet lines', () => {
    const d = { body: { items: ['alpha', 'beta', 'gamma'] } };
    expect(evaluateList('list($body.items)', d)).toBe('- alpha\n- beta\n- gamma');
  });

  test('passes string value through unchanged', () => {
    const d = { body: { text: '- already\n- bulleted' } };
    expect(evaluateList('list($body.text)', d)).toBe('- already\n- bulleted');
  });

  test('returns empty string for missing field', () => {
    expect(evaluateList('list($body.missing)', {})).toBe('');
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

  test('escaped braces become literal braces', () => {
    expect(render('{{literal}}', {})).toBe('{literal}');
  });

  test('normalizes multiple blank lines to single blank line', () => {
    const result = render('line1\n\nline2', {});
    expect(result).toBe('line1\n\nline2');
  });

  test('collapses 3+ consecutive blank lines to single blank line', () => {
    const result = render('line1\n\n\n\nline2', {});
    expect(result).toBe('line1\n\nline2');
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

  test('expands and() in a body field', () => {
    const card = {
      body: {
        summary: '{and($body.tags)}',
        tags: ['brave', 'clever', 'loyal'],
      },
    };
    applyFieldRenderFunctions(card);
    expect(card.body.summary).toBe('brave, clever, and loyal');
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
