'use strict';

const { reportIdentity } = require('../../src/report');

describe('reportIdentity', () => {
  test('uses a trimmed literal title for the label and stem', () => {
    expect(reportIdentity('  {%setting} {$protagonist}  ', 'output')).toEqual({
      label: '{%setting} {$protagonist}',
      stem: '{%setting} {$protagonist}',
    });
  });

  test.each([undefined, '', '   '])('falls back for title %s', (title) => {
    expect(reportIdentity(title, 'project folder')).toEqual({
      label: 'project folder', stem: 'project folder',
    });
  });

  test.each([
    ['a/b', 'a_b'], ['line\nbreak', 'line_break'], ['C:\u0000title', 'C__title'],
    ['雪の城', '雪の城'], ['Title.  ', 'Title'], ['...', 'output'], ['CON', '_CON'],
    ['COM1.txt', '_COM1.txt'], ['AUX.', '_AUX'], ['LPT9', '_LPT9'],
  ])('creates safe stem for %j', (title, expected) => {
    expect(reportIdentity(title, 'output').stem).toBe(expected);
  });

  test('uses the final safe stem when neither title nor folder has a usable stem', () => {
    expect(reportIdentity('...', '..')).toEqual({ label: '...', stem: 'report' });
  });
});
