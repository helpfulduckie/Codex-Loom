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
} = require('../../src/template');

describe('resolveField', () => {
  const data = {
    name: 'Aness',
    fields: {
      'Physical Traits': { gender: 'female', height: 'tall' },
      tagline: 'Healer',
    },
  };

  test('resolves top-level field', () => {
    expect(resolveField('$name', data)).toBe('Aness');
  });

  test('resolves nested field case-insensitively', () => {
    expect(resolveField('$fields.physical traits.GENDER', data)).toBe('female');
  });

  test('resolves simple fields key case-insensitively', () => {
    expect(resolveField('$fields.TAGLINE', data)).toBe('Healer');
  });

  test('returns null for nonexistent path', () => {
    expect(resolveField('$fields.nonexistent', data)).toBeNull();
  });

  test('returns null for intermediate object (not a scalar)', () => {
    expect(resolveField('$fields.Physical Traits', data)).toBeNull();
  });

  test('returns array for array-valued field', () => {
    const d = { fields: { tags: ['a', 'b', 'c'] } };
    expect(resolveField('$fields.tags', d)).toEqual(['a', 'b', 'c']);
  });

  test('returns null for empty array', () => {
    const d = { fields: { tags: [] } };
    expect(resolveField('$fields.tags', d)).toBeNull();
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
    expect(isTruthy('$fields.tags', { fields: { tags: ['a'] } })).toBe(true);
  });

  test('empty array is falsy', () => {
    expect(isTruthy('$fields.tags', { fields: { tags: [] } })).toBe(false);
  });
});

describe('evaluateJoin', () => {
  const data = { fields: { a: 'alpha', c: 'gamma' } };

  test('joins present values with separator', () => {
    const result = evaluateJoin('join("; ", $fields.a, $fields.c)', data);
    expect(result).toBe('alpha; gamma');
  });

  test('skips null/missing fields', () => {
    const result = evaluateJoin('join(", ", $fields.a, $fields.missing, $fields.c)', data);
    expect(result).toBe('alpha, gamma');
  });

  test('single value with no separator', () => {
    const result = evaluateJoin('join("; ", $fields.a)', data);
    expect(result).toBe('alpha');
  });

  test('all missing returns empty string', () => {
    const result = evaluateJoin('join("; ", $fields.x, $fields.y)', data);
    expect(result).toBe('');
  });

  test('spreads array field into join', () => {
    const d = { fields: { tags: ['x', 'y', 'z'] } };
    expect(evaluateJoin('join(", ", $fields.tags)', d)).toBe('x, y, z');
  });

  test('mixes array and scalar refs in join', () => {
    const d = { fields: { tags: ['x', 'y'], extra: 'z' } };
    expect(evaluateJoin('join("; ", $fields.tags, $fields.extra)', d)).toBe('x; y; z');
  });
});

describe('evaluateList', () => {
  test('renders array as bullet lines', () => {
    const d = { fields: { items: ['alpha', 'beta', 'gamma'] } };
    expect(evaluateList('list($fields.items)', d)).toBe('- alpha\n- beta\n- gamma');
  });

  test('passes string value through unchanged', () => {
    const d = { fields: { text: '- already\n- bulleted' } };
    expect(evaluateList('list($fields.text)', d)).toBe('- already\n- bulleted');
  });

  test('returns empty string for missing field', () => {
    expect(evaluateList('list($fields.missing)', {})).toBe('');
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

  test('removes blank lines', () => {
    const result = render('line1\n\nline2', {});
    expect(result).toBe('line1\nline2');
  });

  test('processes conditionals and inline in order', () => {
    const tmpl = '{if $show}[{$label}]{/if}';
    expect(render(tmpl, { show: 'true', label: 'E' })).toBe('[E]');
    expect(render(tmpl, { show: 'false', label: 'E' })).toBe('');
  });

  test('join expression in template', () => {
    const data = { fields: { a: 'one', b: 'two' } };
    expect(render('{join("; ", $fields.a, $fields.b)}', data)).toBe('one; two');
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
