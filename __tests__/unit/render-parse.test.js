'use strict';

const { render } = require('../../src/template');
const { Diagnostics } = require('../../src/diag');

describe('conditionals', () => {
  test('truthy field — body is kept', () => {
    expect(render('{if $known}yes{/if}', { known: 'true' }, new Map())).toBe('yes');
  });

  test('falsy field — body is removed', () => {
    expect(render('{if $known}yes{/if}', {}, new Map())).toBe('');
  });

  test('else branch used when condition is false', () => {
    expect(render('{if $known}yes{else}no{/if}', {}, new Map())).toBe('no');
  });

  test('else branch skipped when condition is true', () => {
    expect(render('{if $known}yes{else}no{/if}', { known: '1' }, new Map())).toBe('yes');
  });

  test('nested conditionals resolve innermost first', () => {
    const tmpl = '{if $a}{if $b}both{/if}{/if}';
    expect(render(tmpl, { a: 'x', b: 'y' }, new Map())).toBe('both');
    expect(render(tmpl, { a: 'x' }, new Map())).toBe('');
    expect(render(tmpl, {}, new Map())).toBe('');
  });

  test('recursively empty aggregates take the false branch', () => {
    expect(render('{if $body.items}yes{else}no{/if}', { body: { items: [''] } }, new Map())).toBe('no');
    expect(render('{if $body.values}yes{else}no{/if}', { body: { values: { entry: ' ' } } }, new Map())).toBe('no');
  });

  test('false and zero retain their existing false conditional branch', () => {
    expect(render('{if $body.flag}yes{else}no{/if}', { body: { flag: false } }, new Map())).toBe('no');
    expect(render('{if $body.count}yes{else}no{/if}', { body: { count: 0 } }, new Map())).toBe('no');
  });
});

describe('wrapper blocks', () => {
  test('square wrapper replaces {wrapper}...{/wrapper} block', () => {
    expect(render('{wrapper}content{/wrapper}', { render: { wrapper: 'square' } }, new Map()))
      .toBe('[\ncontent\n]');
  });

  test('curly wrapper replaces block', () => {
    expect(render('{wrapper}content{/wrapper}', { render: { wrapper: 'curly' } }, new Map()))
      .toBe('{\ncontent\n}');
  });

  test('none wrapper returns content unchanged', () => {
    expect(render('{wrapper}content{/wrapper}', { render: { wrapper: 'none' } }, new Map()))
      .toBe('content');
  });

  test('no render block → treated as none', () => {
    expect(render('{wrapper}content{/wrapper}', {}, new Map())).toBe('content');
  });
});

describe('includes', () => {
  test('expands a simple include', () => {
    const partials = new Map([['header', { content: 'HEADER' }]]);
    expect(render('{include header}', {}, partials)).toBe('HEADER');
  });

  test('name lookup is case-insensitive', () => {
    const partials = new Map([['footer', { content: 'FOOTER' }]]);
    expect(render('{include Footer}', {}, partials)).toBe('FOOTER');
  });

  test('expands nested partials depth-first', () => {
    const partials = new Map([
      ['outer', { content: 'A{include inner}B' }],
      ['inner', { content: 'X' }],
    ]);
    expect(render('{include outer}', {}, partials)).toBe('AXB');
  });

  test('partial content participates in conditional processing', () => {
    const partials = new Map([['cond', { content: '{if $show}yes{/if}' }]]);
    expect(render('{include cond}', { show: 'true' }, partials)).toBe('yes');
    expect(render('{include cond}', { show: 'false' }, partials)).toBe('');
  });

  test('expands variables in outer, nested, and dynamically selected partials before parsing includes', () => {
    const partials = new Map([
      ['outer', { content: '{%greeting} {include {%next}}' }],
      ['inner', { content: '{%subject} {include tail}' }],
      ['tail', { content: '{%ending}' }],
    ]);
    expect(render('{include outer}', {}, partials, {
      greeting: 'Hello', next: 'inner', subject: 'world', ending: '!',
    })).toBe('Hello world !');
  });

  test('an undeclared partial variable reports the partial source', () => {
    const diagnostics = new Diagnostics();
    const partials = new Map([['outer', { content: '{%missing}', _source: 'outer.partial' }]]);
    render('{include outer}', {}, partials, {}, { diagnostics, file: 'main.template' });
    expect(diagnostics.all).toHaveLength(1);
    expect(diagnostics.all[0]).toMatchObject({ code: 'CL0510', file: 'outer.partial' });
  });

  test('literal braces in partial survive render', () => {
    const partials = new Map([['lit', { content: '{{curly}}' }]]);
    expect(render('{include lit}', {}, partials)).toBe('{curly}');
  });

  test('unknown partial reports CL0417 instead of throwing', () => {
    const diagnostics = new Diagnostics();
    const result = render('{include ghost}', {}, new Map(), null, { diagnostics, file: 'x.template' });
    expect(result).toBe('');
    expect(diagnostics.all.map(d => d.code)).toEqual(['CL0417']);
  });

  test('circular partial include reports CL0416 instead of throwing', () => {
    const diagnostics = new Diagnostics();
    const partials = new Map([
      ['a', { content: '{include b}' }],
      ['b', { content: '{include a}' }],
    ]);
    const result = render('{include a}', {}, partials, null, { diagnostics, file: 'x.template' });
    expect(result).toBe('');
    expect(diagnostics.all.map(d => d.code)).toEqual(['CL0416']);
  });
});
