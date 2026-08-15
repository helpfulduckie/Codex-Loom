'use strict';

/**
 * Tests for the Velvet Lattice emitter (§8).
 *
 * Three obligations, in descending order of how badly a failure would hurt:
 *
 *   1. Reproduce v3's bytes for content that was already correct. Step 4 wires this in
 *      and the re-baseline diff has to be readable; every value that did not need to
 *      change must come out identical.
 *   2. Fix what was silently broken — the padded triggers §4.2 exists for.
 *   3. Refuse what VL cannot carry: a comma inside a trigger, a mapping in `notes:`.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const {
  renderCard, parseCards, cardTitle, decodeTriggerPadding, defaultNotesText, writeScalar,
} = require('../../src/emit/vl');
const { Diagnostics, CODES } = require('../../src/diag');

const aness = () => ({
  id: 'Aness',
  name: { display: 'Aness', full: 'Aness Rozen' },
  aid: { title: 'Aness Rozen', type: 'Character', triggers: ['Aness'] },
});

describe('cardTitle', () => {
  test('prefers aid.title', () => {
    expect(cardTitle(aness())).toBe('Aness Rozen');
  });

  test('falls back through name.full, name.display, then id', () => {
    expect(cardTitle({ id: 'A', name: { full: 'Full', display: 'Disp' } })).toBe('Full');
    expect(cardTitle({ id: 'A', name: { display: 'Disp' } })).toBe('Disp');
    expect(cardTitle({ id: 'A' })).toBe('A');
  });

  test('accepts a bare string name, as the System templates write it', () => {
    expect(cardTitle({ id: 'Template', name: 'Template' })).toBe('Template');
  });

  test('skips a blank candidate rather than emitting an empty heading', () => {
    expect(cardTitle({ id: 'A', aid: { title: '   ' }, name: { full: 'Full' } })).toBe('Full');
  });
});

describe('decodeTriggerPadding', () => {
  test.each([
    ['_Aria', ' Aria'],
    ['Voss_', 'Voss '],
    ['_the Warrens_', ' the Warrens '],
    ['__Aria', '  Aria'],
    ['Aria', 'Aria'],
    ['snake_case', 'snake_case'],
    ['_snake_case_', ' snake_case '],
  ])('%s -> %s', (input, expected) => {
    expect(decodeTriggerPadding(input)).toBe(expected);
  });
});

describe('writeScalar', () => {
  test('leaves an ordinary value plain', () => {
    expect(writeScalar('Felicia', { flow: true })).toBe('Felicia');
  });

  test('leaves an interior apostrophe plain — it needs no quoting in YAML', () => {
    expect(writeScalar("King's Land", { flow: true })).toBe("King's Land");
  });

  test('quotes padding', () => {
    expect(writeScalar(' Ruin ', { flow: true })).toBe("' Ruin '");
  });

  test('quotes a leading indicator', () => {
    expect(writeScalar('[e]')).toBe("'[e]'");
    expect(writeScalar('#hash', { flow: true })).toBe("'#hash'");
  });

  test('leaves a plus sign plain — it is not a YAML indicator', () => {
    expect(writeScalar('++', { flow: true })).toBe('++');
  });

  test('quotes YAML 1.1 booleans, which PyYAML would otherwise resolve', () => {
    for (const value of ['no', 'No', 'yes', 'on', 'off', 'y', 'N', 'true', 'null', '~']) {
      expect(writeScalar(value, { flow: true })).toBe(`'${value}'`);
    }
  });

  test('quotes numbers so they stay strings', () => {
    for (const value of ['142', '1.0', '0x1f', '-3', '1e5']) {
      expect(writeScalar(value, { flow: true })).toBe(`'${value}'`);
    }
  });

  test('quotes flow terminators only in flow context', () => {
    expect(writeScalar('a, b', { flow: true })).toBe("'a, b'");
    expect(writeScalar('a, b', { flow: false })).toBe('a, b');
  });

  test('falls back to double quotes when the value contains a single quote', () => {
    expect(writeScalar(" it's ", { flow: true })).toBe('" it\'s "');
  });

  test('quotes the empty string', () => {
    expect(writeScalar('', { flow: true })).toBe("''");
  });

  /**
   * The invariant the hand-written cases above are only examples of: whatever we emit,
   * a YAML 1.1 parse must give the string back unchanged. Asserting the round trip
   * rather than the spelling is what catches a wrong guess about which characters are
   * indicators — `+` looks like one and is not.
   */
  test('every emitted trigger round-trips through a YAML 1.1 parse', () => {
    const values = [
      'Felicia', "King's Land", ' Ruin ', ' Era ', 'cell ', '++', '#hash', '[e]', '',
      'no', 'yes', 'on', 'off', 'y', 'N', 'true', 'False', 'null', '~', '-', '?',
      '142 Cohort', '1.0', '0x1f', '-3', '1e5', '.inf', 'a: b', 'a # b', 'weapons R&D',
      'Shadow\'s Embrace', '" quoted "', "' single '", 'a[b]c', 'a{b}c', 'tab\there',
      '_leading', 'trailing_', 'multi word trigger', 'Ünïcödé', ':colon', '@at', '`tick',
    ];
    const line = `triggers: [${values.map((v) => writeScalar(v, { flow: true })).join(', ')}]`;
    expect(YAML.parse(line, { version: '1.1' }).triggers.map(String)).toEqual(values);
  });

  test('every emitted notes value round-trips through a YAML 1.1 parse', () => {
    for (const value of ['[e]', 'plain', 'a: b', 'no', '142', " it's ", ' padded ', '~']) {
      const parsed = YAML.parse(`notes: ${writeScalar(value)}`, { version: '1.1' });
      expect(String(parsed.notes)).toBe(value);
    }
  });
});

describe('renderCard', () => {
  test('reproduces the v3 envelope byte-for-byte', () => {
    const item = {
      id: 'Grayls',
      name: { full: 'Felicia Grayls' },
      aid: { title: 'Felicia Grayls', type: 'Character', triggers: ['Felicia', 'Grayls'] },
      notes: '[e]',
    };
    const body = '{\nFelicia Grayls - Academy Researcher; minor nobility\n}';
    const { text } = renderCard({ item, bodyText: body });
    expect(text).toBe([
      '## Felicia Grayls',
      '~~~',
      'triggers: [Felicia, Grayls]',
      'encapsulate: false',
      "notes: '[e]'",
      '~~~',
      body,
    ].join('\n'));
  });

  test('writes encapsulate: false even with nothing else to say', () => {
    const { text } = renderCard({ item: { id: 'Bare' }, bodyText: 'x' });
    expect(text).toBe('## Bare\n~~~\nencapsulate: false\n~~~\nx');
  });

  test('omits triggers entirely rather than writing an empty list', () => {
    const { text } = renderCard({ item: { id: 'Config', aid: { triggers: [] } }, bodyText: 'x' });
    expect(text).not.toMatch(/triggers/);
  });

  test('omits notes when the rendered text is empty — the known: false case', () => {
    const { text } = renderCard({ item: aness(), bodyText: 'x', notesText: '' });
    expect(text).not.toMatch(/notes/);
  });

  test('a pre-rendered notesTemplate result wins over the item field', () => {
    const item = { ...aness(), notes: 'ignored' };
    const { text } = renderCard({ item, bodyText: 'x', notesText: 'marker: [e]' });
    expect(text).toMatch(/notes: 'marker: \[e\]'/);
  });

  test('multi-line notes become a literal block scalar, never nested keys', () => {
    const item = { ...aness(), notes: { marker: '[e]', mood: 'clinical' } };
    const { text } = renderCard({ item, bodyText: 'x' });
    expect(text).toContain('notes: |-\n  marker: [e]\n  mood: clinical');
    // VL types notes as str; a nested mapping would reach AID as a Python dict.
    expect(parseCards(text)[0].notes).toBe('marker: [e]\nmood: clinical');
  });

  test('description is accepted as the alias for notes (§4.5)', () => {
    const item = { id: 'A', description: '[e]' };
    expect(renderCard({ item, bodyText: 'x' }).text).toMatch(/notes: '\[e\]'/);
  });

  test('decodes padded triggers and quotes them so the padding survives VL', () => {
    const item = { id: 'Ruin', aid: { triggers: ['_Ruin_', 'ruins'] } };
    expect(renderCard({ item, bodyText: 'x' }).text)
      .toContain("triggers: [' Ruin ', ruins]");
  });

  test('a comma inside a trigger is an ERROR — VL cannot represent it', () => {
    const diagnostics = new Diagnostics();
    renderCard({ item: { id: 'A', aid: { triggers: ['Vale, Aness'] } }, bodyText: 'x', diagnostics });
    expect(diagnostics.errors.map((d) => d.code)).toEqual([CODES.TRIGGER_CONTAINS_COMMA]);
  });

  test('an empty trigger is a WARN — it reaches AID as an empty key', () => {
    const diagnostics = new Diagnostics();
    renderCard({ item: { id: 'A', aid: { triggers: ['Aness', ''] } }, bodyText: 'x', diagnostics });
    expect(diagnostics.warnings.map((d) => d.code)).toEqual([CODES.TRIGGER_EMPTY]);
  });

  test('a clean card produces no diagnostics', () => {
    const { diagnostics } = renderCard({ item: aness(), bodyText: 'x' });
    expect(diagnostics.all).toEqual([]);
  });
});

describe('defaultNotesText', () => {
  test('a scalar passes through verbatim', () => {
    expect(defaultNotesText('[e]')).toBe('[e]');
  });

  test('a mapping renders as key: value lines', () => {
    expect(defaultNotesText({ startDate: '06/28/1320', startTime: '9:00 PM' }))
      .toBe('startDate: 06/28/1320\nstartTime: 9:00 PM');
  });

  test('nothing renders to nothing', () => {
    expect(defaultNotesText(undefined)).toBe('');
    expect(defaultNotesText(null)).toBe('');
  });
});

describe('parseCards', () => {
  const file = [
    '## Felicia Grayls',
    '~~~',
    'triggers: [Felicia, Grayls]',
    'encapsulate: false',
    "notes: '[e]'",
    '~~~',
    '{',
    'Felicia Grayls - Academy Researcher',
    '}',
    '',
    '## Kaiden Ventus',
    '~~~',
    'triggers: [Kaiden]',
    'encapsulate: false',
    '~~~',
    'Kaiden Ventus - Knight',
    '',
  ].join('\n');

  test('splits a multi-card file on its headings', () => {
    const cards = parseCards(file, { type: 'Character' });
    expect(cards.map((c) => c.title)).toEqual(['Felicia Grayls', 'Kaiden Ventus']);
    expect(cards.every((c) => c.type === 'Character')).toBe(true);
  });

  test('reads triggers, notes and body', () => {
    const [card] = parseCards(file);
    expect(card.triggers).toEqual(['Felicia', 'Grayls']);
    expect(card.notes).toBe('[e]');
    expect(card.body).toBe('{\nFelicia Grayls - Academy Researcher\n}');
  });

  test('a card without notes reports an empty string, as VL does', () => {
    expect(parseCards(file)[1].notes).toBe('');
  });

  test('parses the fence as YAML 1.1, matching PyYAML', () => {
    const [card] = parseCards('## A\n~~~\ntriggers: [no, yes]\n~~~\nbody');
    // PyYAML resolves these to booleans and stringifies them with str(); modelling it
    // in 1.2 would report them as the strings "no" and "yes" and hide the corruption.
    expect(card.triggers).toEqual(['false', 'true']);
  });

  test('survives a malformed fence rather than throwing', () => {
    const cards = parseCards('## A\n~~~\ntriggers: [unclosed\n~~~\nbody');
    expect(cards).toHaveLength(1);
    expect(cards[0].triggers).toEqual([]);
    expect(cards[0].body).toBe('body');
  });

  test('a file with no heading is one card, as VL treats it', () => {
    const cards = parseCards('~~~\ntriggers: [A]\n~~~\nbody', { fallbackTitle: 'Stem' });
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Stem');
    expect(cards[0].triggers).toEqual(['A']);
  });

  test('empty input yields no cards', () => {
    expect(parseCards('')).toEqual([]);
    expect(parseCards(null)).toEqual([]);
  });

  test('a ## inside the body does not start a new card', () => {
    const text = '## A\n~~~\ntriggers: [A]\n~~~\nline\n##notaheading\nmore';
    expect(parseCards(text)).toHaveLength(1);
  });

  test('round-trips what renderCard produces', () => {
    const item = {
      id: 'Aria',
      name: { full: 'Aria' },
      aid: { triggers: ['_Aria_', "King's Land", '142 Cohort'] },
      notes: '[e]',
    };
    const { text } = renderCard({ item, bodyText: '{\nbody\n}' });
    const [card] = parseCards(text);
    expect(card.title).toBe('Aria');
    expect(card.triggers).toEqual([' Aria ', "King's Land", '142 Cohort']);
    expect(card.notes).toBe('[e]');
    expect(card.body).toBe('{\nbody\n}');
  });
});

describe('against real compiled fixture output', () => {
  const FIXTURE = path.resolve(
    __dirname,
    '../../goldenFixtures/Esudia/The Institute/v3/Branches/Alpha-Omega/Branches/Aness'
      + '/Branches/Malcolm/Branches/hatesYou/Story Cards/Character/Character.md',
  );

  test('parses a real v3 story-card file', () => {
    const cards = parseCards(fs.readFileSync(FIXTURE, 'utf8'), { type: 'Character' });
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.title).toBeTruthy();
      expect(card.meta.encapsulate).toBe(false);
      expect(card.body).not.toContain('~~~');
      expect(card.body).not.toMatch(/^## /m);
    }
  });

  test('re-emitting a parsed card reproduces the original envelope', () => {
    const source = fs.readFileSync(FIXTURE, 'utf8');
    for (const card of parseCards(source)) {
      const { text } = renderCard({
        item: { id: card.title, name: { full: card.title }, aid: { triggers: card.triggers } },
        bodyText: card.body,
        notesText: card.notes,
      });
      // The exact bytes the file already contains, for content that was never broken.
      expect(source).toContain(text);
    }
  });
});
