'use strict';

const YAML = require('yaml');
const { preparse, findSwallowedTokens } = require('../../src/loader/preparse');

/** Parse the preparsed text, asserting it is valid YAML on the way through. */
function roundTrip(text) {
  const doc = YAML.parseDocument(preparse(text));
  expect(doc.errors).toEqual([]);
  return doc.toJS();
}

describe('block position — the case that motivated the feature', () => {
  test('wraps a value whose first characters are {$', () => {
    expect(preparse('Tagline: {$Aness} is a healer\n'))
      .toBe("Tagline: '{$Aness} is a healer'\n");
  });

  test('wraps a value whose first characters are {%', () => {
    expect(preparse('house: {%setting} — Northern Wing\n'))
      .toBe("house: '{%setting} — Northern Wing'\n");
  });

  test('the wrapped value parses to the original text', () => {
    expect(roundTrip('Tagline: {$Aness} is a healer\n')).toEqual({ Tagline: '{$Aness} is a healer' });
  });

  test('a bare token with no trailing prose still parses', () => {
    expect(roundTrip('who: {$LI}\n')).toEqual({ who: '{$LI}' });
  });

  test('wraps a sequence entry introduced by a dash', () => {
    expect(roundTrip('- {$Aness} is a healer\n')).toEqual(['{$Aness} is a healer']);
  });

  test('wraps inside a nested sequence entry', () => {
    expect(roundTrip('- - {$Aness} speaks\n')).toEqual([['{$Aness} speaks']]);
  });

  test('wraps a mapping value nested under a dash', () => {
    expect(roundTrip('- name: {$Aness} of Vale\n')).toEqual([{ name: '{$Aness} of Vale' }]);
  });

  test('escapes an internal single quote by doubling it', () => {
    expect(preparse("Tagline: {$Aness}'s clinic\n")).toBe("Tagline: '{$Aness}''s clinic'\n");
    expect(roundTrip("Tagline: {$Aness}'s clinic\n")).toEqual({ Tagline: "{$Aness}'s clinic" });
  });

  test('preserves indentation and nesting', () => {
    expect(roundTrip('body:\n  Tagline: {$Aness} is a healer\n'))
      .toEqual({ body: { Tagline: '{$Aness} is a healer' } });
  });
});

describe('values that must be left alone', () => {
  const unchanged = (text) => expect(preparse(text)).toBe(text);

  test('a token in mid-value position', () => {
    unchanged('desc: ./components/{%initials}.description.yaml\n');
  });

  test('an already single-quoted value', () => {
    unchanged("Tagline: '{$Aness} is a healer'\n");
  });

  test('an already double-quoted value', () => {
    unchanged('Tagline: "{$Aness} is a healer"\n');
  });

  test('preparse is idempotent', () => {
    const once = preparse('Tagline: {$Aness} is a healer\n');
    expect(preparse(once)).toBe(once);
  });

  test('a document with no tokens at all', () => {
    unchanged('a: 1\nb: [x, y]\nc:\n  - d\n');
  });

  test('a genuine flow mapping value', () => {
    unchanged('name: {display: Aness, full: Aness Vale}\n');
  });

  test('a colon inside a plain scalar does not create a second wrap', () => {
    unchanged('note: he said: hello there\n');
  });

  test('an anchor before a token', () => {
    unchanged('a: &anchor {$x}\n');
  });

  test('an alias reference', () => {
    unchanged('base: &b\n  k: v\nuse: *b\n');
  });

  test('a whole-line comment mentioning a token', () => {
    unchanged('# Tagline: {$Aness} is a healer\n');
  });
});

describe('field operations — the golden-fixture regression', () => {
  // `+{...}` is Codex Loom's append operation, not a YAML flow mapping. An earlier
  // scanner counted its brace, went into flow mode, and wrapped a fragment of the
  // sentence at the next comma. The fixtures caught it; these pin the fix.

  test('leaves an append operation containing a token and a comma untouched', () => {
    const src = '- +{Before the Institute, {%li} was your lover, but you still love him}\n';
    expect(preparse(src)).toBe(src);
  });

  test('the append operation parses as a single scalar', () => {
    const src = '- +{Before the Institute, {%li} was your lover, but you still love him}\n';
    expect(roundTrip(src)).toEqual(['+{Before the Institute, {%li} was your lover, but you still love him}']);
  });

  test('does not corrupt the lines that follow a field operation', () => {
    const src = [
      'body:',
      '  - +{Some prose, with a comma, and {%li} inside}',
      'Tagline: {$Aness} is a healer',
      '',
    ].join('\n');
    expect(roundTrip(src)).toEqual({
      body: ['+{Some prose, with a comma, and {%li} inside}'],
      Tagline: '{$Aness} is a healer',
    });
  });

  test('a removal operation is equally untouched', () => {
    const src = 'body: -{some, text}\n';
    expect(preparse(src)).toBe(src);
  });

  test('a substitution operation is equally untouched', () => {
    const src = 'body: /{old, thing}/{new, thing}\n';
    expect(preparse(src)).toBe(src);
  });
});

describe('flow collections', () => {
  test('wraps a token as the first entry of a flow sequence', () => {
    expect(roundTrip('aid:\n  triggers: [{$name.display}, Voss]\n'))
      .toEqual({ aid: { triggers: ['{$name.display}', 'Voss'] } });
  });

  test('wraps a token in a later entry', () => {
    expect(roundTrip('triggers: [Voss, {$name.display}]\n'))
      .toEqual({ triggers: ['Voss', '{$name.display}'] });
  });

  test('wraps several token entries in one sequence', () => {
    expect(roundTrip('triggers: [{$a}, {%b}, plain]\n'))
      .toEqual({ triggers: ['{$a}', '{%b}', 'plain'] });
  });

  test('wraps a token value inside a flow mapping', () => {
    expect(roundTrip('name: {display: {$Aness}, full: Vale}\n'))
      .toEqual({ name: { display: '{$Aness}', full: 'Vale' } });
  });

  test('handles a nested flow sequence', () => {
    expect(roundTrip('m: [[{$a}], [plain, {%b}]]\n'))
      .toEqual({ m: [['{$a}'], ['plain', '{%b}']] });
  });

  test('handles a flow sequence spanning several lines', () => {
    const src = 'triggers: [\n  {$name.display},\n  Voss\n]\n';
    expect(roundTrip(src)).toEqual({ triggers: ['{$name.display}', 'Voss'] });
  });

  test('resumes normal block handling after a multi-line flow closes', () => {
    const src = 'triggers: [\n  {$a}\n]\nTagline: {$b} speaks\n';
    expect(roundTrip(src)).toEqual({ triggers: ['{$a}'], Tagline: '{$b} speaks' });
  });

  test('a token entry containing a dot and braces keeps its full extent', () => {
    expect(roundTrip('t: [{$name.display}]\n')).toEqual({ t: ['{$name.display}'] });
  });
});

describe('comments after values', () => {
  test('wraps the value but not the trailing comment', () => {
    expect(preparse('Tagline: {$Aness} is a healer # a note\n'))
      .toBe("Tagline: '{$Aness} is a healer' # a note\n");
  });

  test('the comment does not become part of the scalar', () => {
    expect(roundTrip('Tagline: {$Aness} is a healer # a note\n'))
      .toEqual({ Tagline: '{$Aness} is a healer' });
  });

  test('a hash not preceded by whitespace stays inside the value', () => {
    expect(roundTrip('tag: {$a}#notacomment\n')).toEqual({ tag: '{$a}#notacomment' });
  });

  test('a comment after a flow entry is preserved', () => {
    expect(roundTrip('t: [{$a}] # note\n')).toEqual({ t: ['{$a}'] });
  });
});

describe('block and folded scalars', () => {
  test('literal block scalar content is untouched', () => {
    const src = 'body: |\n  {$Aness} is a healer\n  second line\n';
    expect(preparse(src)).toBe(src);
  });

  test('folded block scalar content is untouched', () => {
    const src = 'body: >\n  {$Aness} is a healer\n';
    expect(preparse(src)).toBe(src);
  });

  test('chomping indicators are recognized', () => {
    const src = 'body: |-\n  {$Aness} speaks\n';
    expect(preparse(src)).toBe(src);
  });

  test('keep-chomping indicators are recognized', () => {
    const src = 'body: |+\n  {$Aness} speaks\n';
    expect(preparse(src)).toBe(src);
  });

  test('blank lines inside a block scalar do not end it', () => {
    const src = 'body: |\n  {$a} one\n\n  {$b} two\n';
    expect(preparse(src)).toBe(src);
  });

  test('processing resumes once the block scalar dedents', () => {
    const src = 'body: |\n  {$a} literal\nTagline: {$b} is a healer\n';
    expect(preparse(src)).toBe("body: |\n  {$a} literal\nTagline: '{$b} is a healer'\n");
  });

  test('the block scalar keeps its exact content through a round trip', () => {
    expect(roundTrip('body: |\n  {$Aness} is a healer\n'))
      .toEqual({ body: '{$Aness} is a healer\n' });
  });
});

describe('multi-document YAML', () => {
  test('wraps values in every document', () => {
    const src = 'a: {$x} one\n---\nb: {$y} two\n';
    expect(preparse(src)).toBe("a: '{$x} one'\n---\nb: '{$y} two'\n");
  });

  test('a document marker resets an unterminated block scalar', () => {
    const src = 'body: |\n  literal\n---\nTagline: {$b} speaks\n';
    expect(preparse(src)).toContain("Tagline: '{$b} speaks'");
  });

  test('an explicit document terminator is handled', () => {
    const src = 'a: {$x}\n...\n';
    expect(preparse(src)).toBe("a: '{$x}'\n...\n");
  });
});

describe('line endings', () => {
  test('CRLF endings are preserved exactly', () => {
    expect(preparse('Tagline: {$Aness} is a healer\r\n'))
      .toBe("Tagline: '{$Aness} is a healer'\r\n");
  });

  test('the carriage return does not end up inside the quotes', () => {
    const out = preparse('a: {$x} one\r\nb: {$y} two\r\n');
    expect(out).toBe("a: '{$x} one'\r\nb: '{$y} two'\r\n");
  });

  test('mixed endings are each preserved', () => {
    expect(preparse('a: {$x}\r\nb: {$y}\n')).toBe("a: '{$x}'\r\nb: '{$y}'\n");
  });

  test('a file with no trailing newline is handled', () => {
    expect(preparse('a: {$x} one')).toBe("a: '{$x} one'");
  });
});

describe('non-string and empty input', () => {
  test.each([null, undefined, 42, {}])('returns %p unchanged', (value) => {
    expect(preparse(value)).toBe(value);
  });

  test('an empty string is unchanged', () => {
    expect(preparse('')).toBe('');
  });
});

describe('findSwallowedTokens', () => {
  test('finds a token absorbed as a flow-sequence entry', () => {
    const value = YAML.parse('triggers: [{$name.display}]');
    const found = findSwallowedTokens(value);
    expect(found).toHaveLength(1);
    expect(found[0].token).toBe('{$name.display}');
    expect(found[0].path).toEqual(['triggers', '0']);
  });

  test('finds a token absorbed in block position', () => {
    const found = findSwallowedTokens(YAML.parse('Tagline: {$Aness}'));
    expect(found[0]).toMatchObject({ key: '$Aness', path: ['Tagline'] });
  });

  // Only `$` produces the silent failure. `%` and `@` are reserved indicators in YAML,
  // so an unquoted `{%role}` or `{@pe}` is a hard parse error rather than a mapping that
  // quietly reaches the compiler. The guard still covers all three — a mapping of that
  // shape can arrive from a source other than a plain parse — but these two cases have
  // to be built directly, because YAML will not produce them.

  test('only the $ sigil is reachable by parsing — % is a hard parse error', () => {
    expect(() => YAML.parse('k: {%role}')).toThrow(/directive indicator character %/);
  });

  test('only the $ sigil is reachable by parsing — @ is a hard parse error', () => {
    expect(() => YAML.parse('k: {@pe}')).toThrow(/reserved character @/);
  });

  test('the $ sigil, by contrast, parses silently into a wrong-typed value', () => {
    expect(YAML.parse('triggers: [{$name}]')).toEqual({ triggers: [{ $name: null }] });
  });

  test('finds a percent-sigil token when one is constructed', () => {
    expect(findSwallowedTokens({ k: { '%role': null } })[0].token).toBe('{%role}');
  });

  test('finds an at-sigil token when one is constructed', () => {
    expect(findSwallowedTokens({ k: { '@pe': null } })[0].token).toBe('{@pe}');
  });

  test('reports nothing for a correctly quoted document', () => {
    expect(findSwallowedTokens(YAML.parse("Tagline: '{$Aness} is a healer'"))).toEqual([]);
  });

  test('does not flag an ordinary single-key mapping', () => {
    expect(findSwallowedTokens({ name: { display: 'Aness' } })).toEqual([]);
  });

  test('does not flag a multi-key mapping that happens to contain a sigil key', () => {
    expect(findSwallowedTokens({ '$a': null, b: 1 })).toEqual([]);
  });

  test('searches inside arrays and nested mappings', () => {
    const found = findSwallowedTokens({ a: { b: [{ c: { '$x': null } }] } });
    expect(found[0].path).toEqual(['a', 'b', '0', 'c']);
  });

  test('handles scalars and null without throwing', () => {
    expect(findSwallowedTokens(null)).toEqual([]);
    expect(findSwallowedTokens('text')).toEqual([]);
    expect(findSwallowedTokens(undefined)).toEqual([]);
  });

  test('finds every occurrence, not just the first', () => {
    expect(findSwallowedTokens({ a: { '$x': null }, b: { '%y': null } })).toHaveLength(2);
  });
});
