'use strict';

const { inlineDiff, renderDiff, cardLines } = require('../../src/variance');

describe('inlineDiff', () => {
  test('marks a swapped word in place, with a space between the two marks', () => {
    expect(inlineDiff('asks whether she should later', 'asks whether you should later'))
      .toBe('asks whether ~~she~~ **you** should later');
  });

  test('leaves separators outside the marks so GFM renders them', () => {
    expect(inlineDiff('Appearance: Myceth; female; diminutive; purple mushroom cap', 'Appearance: female; diminutive'))
      .toBe('Appearance: ~~Myceth~~; female; diminutive; ~~purple mushroom cap~~');
  });

  test('marks consecutive changed words as one run', () => {
    expect(inlineDiff('Zaveth keeps her pointed', 'Zaveth respects her competence and keeps her pointed'))
      .toBe('Zaveth **respects her competence and** keeps her pointed');
  });

  test('a rewritten phrase is one struck run and one added run, not alternating words', () => {
    expect(inlineDiff('Magic: decay offense, earth area control', 'Magic: combat mage with a reputation built on results'))
      .toBe('Magic: ~~decay offense, earth area control~~ **combat mage with a reputation built on results**');
  });
});

describe('renderDiff', () => {
  const base = ['Name', 'Personality: quiet', '- Wants to be liked', 'Magic: growth', 'Background: none'];

  test('shows only changed lines, with … over an unchanged stretch', () => {
    const out = renderDiff(base, ['Name', 'Personality: quiet', '- Wants to be liked', 'Magic: growth', 'Background: the north']);
    expect(out).toEqual(['Background: ~~none~~ **the north**']);
  });

  test('an added bullet is introduced by the line its list hangs from', () => {
    const out = renderDiff(base, ['Name', 'Personality: quiet', '- Wants to be liked', '- Tries first', 'Magic: growth', 'Background: none']);
    // the unchanged bullet between the header and the addition is elided
    expect(out).toEqual(['Personality: quiet', '…', '- **Tries first**']);
  });

  test('a mostly-identical bullet is marked word by word, not struck and re-added', () => {
    const out = renderDiff(base, ['Name', 'Personality: quiet', '- Wants to be liked by you', 'Magic: growth', 'Background: none']);
    expect(out).toEqual(['Personality: quiet', '- Wants to be liked **by you**']);
  });

  test('a line that changed shape is struck and replaced whole', () => {
    const out = renderDiff(['Skills: spores and hyphae'], ['Skills:', '- good with animals']);
    expect(out).toContain('~~Skills: spores and hyphae~~');
    expect(out).toContain('- **good with animals**');
  });

  test('sentence punctuation stays outside the marks, once', () => {
    expect(inlineDiff('You like romance novels.', 'You like romance with pining.'))
      .toBe('You like romance ~~novels~~ **with pining**.');
  });

  test('a gap between two changes is marked', () => {
    const out = renderDiff(base, ['Name', 'Personality: loud', '- Wants to be liked', 'Magic: growth', 'Background: the north']);
    expect(out).toEqual(['Personality: ~~quiet~~ **loud**', '…', 'Background: ~~none~~ **the north**']);
  });
});

describe('cardLines', () => {
  test('drops the fence markers and the meta block, which never reach AID', () => {
    const rendered = [
      '## Melli', '~~~', 'triggers: [Melli]', 'meta:', '  duckieConv:', '    role: anchor',
      "notes: '[e]'", '~~~', '{', 'Melli - tamer', '}', '',
    ].join('\n');
    expect(cardLines(rendered)).toEqual(['Melli', 'triggers: [Melli]', "notes: '[e]'", '{', 'Melli - tamer', '}']);
  });
});
