'use strict';

const { stripMarkdown } = require('../../src/emit/plainText');

describe('stripMarkdown removes markup and keeps the words', () => {
  test.each([
    ['strong with asterisks', 'a **bold** word', 'a bold word'],
    ['strong with underscores', 'a __bold__ word', 'a bold word'],
    ['emphasis with asterisks', 'a *slanted* word', 'a slanted word'],
    ['emphasis with underscores', 'a _slanted_ word', 'a slanted word'],
    ['strikethrough', 'a ~~gone~~ word', 'a gone word'],
    ['links keep the label', 'see [the map](https://example.com/m) now', 'see the map now'],
    ['images keep the alt text', 'x ![a harbor](h.png) y', 'x a harbor y'],
    ['images with no alt vanish', '![](h.png)', ''],
    ['headings lose their hashes', '## The Harbor', 'The Harbor'],
    ['dash list markers', '- one\n- two', 'one\ntwo'],
    ['star and plus list markers', '* one\n+ two', 'one\ntwo'],
    ['numbered list markers', '1. one\n2) two', 'one\ntwo'],
    ['blockquote markers', '> quoted\n> > nested', 'quoted\nnested'],
    ['inline code backticks', 'run `go` now', 'run go now'],
    ['HTML tags', 'a <b>bold</b> <br/> word', 'a bold  word'],
    ['HTML comments', 'a <!-- note --> word', 'a  word'],
  ])('%s', (_title, input, expected) => {
    expect(stripMarkdown(input)).toBe(expected);
  });

  test('fenced code keeps its contents and loses the fence lines', () => {
    expect(stripMarkdown('before\n```js\nlet x = 1;\n```\nafter')).toBe('before\n\nlet x = 1;\n\nafter');
  });

  test('horizontal rules are removed', () => {
    expect(stripMarkdown('one\n\n---\n\ntwo\n\n* * *\n\nthree')).toBe('one\n\ntwo\n\nthree');
  });

  test('lines are trimmed, paragraph breaks kept, and runs of blank lines collapse', () => {
    expect(stripMarkdown('  one  \n  two\n\n\n\n\n   three  \n')).toBe('one\ntwo\n\nthree');
  });

  test('CRLF input produces LF output', () => {
    expect(stripMarkdown('one\r\n\r\ntwo')).toBe('one\n\ntwo');
  });

  test('a non-string or empty input gives an empty string', () => {
    expect(stripMarkdown(null)).toBe('');
    expect(stripMarkdown('')).toBe('');
    expect(stripMarkdown('---')).toBe('');
  });
});

describe('stripMarkdown leaves look-alike characters alone', () => {
  test.each([
    ['underscores inside a word', 'use snake_case_name here'],
    ['double underscores inside a word', 'the __init__file thing', ],
    ['a spaced asterisk as multiplication', 'what is 5 * 3 * 2'],
    ['a lone asterisk', 'a * b'],
    ['a lone underscore', 'a _ b'],
  ])('%s', (_title, input) => {
    expect(stripMarkdown(input)).toBe(input);
  });
});
