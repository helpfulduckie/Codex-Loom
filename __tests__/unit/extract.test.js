'use strict';

/**
 * Named section-source transforms (v4 spec §7.7).
 *
 * The successor to `description.test.js`. `extractScriptBanner` moved out of a bespoke
 * description loader and became a row in a table, and the flag that used to tune it went
 * away — so the tests that used to pass `stripTrailingInstructions` now assert the one
 * behavior the extractor picked, and one new test pins the roster itself.
 */

const { scriptBanner, runExtractor, EXTRACTORS } = require('../../src/extract');

describe('the extractor roster', () => {
  test('an unknown name returns an error naming what is available', () => {
    const { text, error } = runExtractor('scriptBnner', '// - ModA@1.0.0');
    expect(text).toBeUndefined();
    expect(error).toContain('"scriptBanner"');
  });

  test('a known name runs and returns text', () => {
    expect(runExtractor('scriptBanner', '// Hello\n').text).toBe('Hello');
  });

  test('the roster is exactly what the docs and CL0618 name', () => {
    // A second extractor is meant to be a table row; this fails when one is added without
    // the documentation row that CL0618's message implicitly promises.
    expect(Object.keys(EXTRACTORS)).toEqual(['scriptBanner']);
  });
});

describe('scriptBanner', () => {
  test('strips the // prefix and returns the content lines', () => {
    const result = scriptBanner('// Hello world\n// Second line\ncode();\n');
    expect(result).toContain('Hello world');
    expect(result).toContain('Second line');
  });

  test('pure separator lines are omitted', () => {
    const result = scriptBanner('// ============================\n// Content line\n// ============================\n');
    expect(result).not.toMatch(/={4,}/);
    expect(result).toContain('Content line');
  });

  test('banner title lines are condensed to === title ===', () => {
    const result = scriptBanner('// ============= Standard Build - 1.0.0 ============\n');
    expect(result).toContain('=== Standard Build - 1.0.0 ===');
    expect(result).not.toMatch(/={6,}/);
  });

  test('empty stripped lines are skipped', () => {
    const result = scriptBanner('// Line one\n//\n// Line two\n');
    expect(result).toContain('Line one');
    expect(result).toContain('Line two');
    expect(result).not.toMatch(/\n\n\n/);
  });

  test('stops at the first non-comment line', () => {
    const result = scriptBanner('// Top comment\nconst x = 1;\n// After code — should NOT be included\n');
    expect(result).toContain('Top comment');
    expect(result).not.toContain('After code');
  });

  test('no leading newline — the block gap belongs to the emitter now', () => {
    // v3 returned a string starting with '\n' because it was concatenated onto the body by
    // hand. A section joins to its neighbours through BLOCK_GAP like any other, so the
    // separator moved out of the extractor and the extractor stopped owning layout.
    expect(scriptBanner('// Some line\n').startsWith('\n')).toBe(false);
  });

  test('returns empty string when the file has no comment block', () => {
    expect(scriptBanner('const x = 1;\n')).toBe('');
  });

  test('a full banner drops the install note and keeps the mod list', () => {
    const result = scriptBanner([
      '// ============================================================',
      '// ============= Standard Build - 26.9.6 - library ============',
      '// ============================================================',
      '// - UnifiedSettings@1.1.2',
      '// - DuckieDebug@1.0.3',
      '// ============================================================',
      '// Paste this ONLY into the library tab in AI Dungeon scripting',
      '// ============================================================',
      '',
      'const x = 0;',
    ].join('\n'));

    expect(result).toBe([
      '=== Standard Build - 26.9.6 - library ===',
      '- UnifiedSettings@1.1.2',
      '- DuckieDebug@1.0.3',
    ].join('\n'));
  });
});

/**
 * The heuristic that used to be `stripTrailingInstructions:`.
 *
 * §7.7 deleted the flag and asked the extractor to pick one behavior against the real
 * banners. It picked stripping, because both projects in the corpus that use a script
 * banner set the flag `true` and none sets it `false`. These three tests are what make
 * that safe to ship unattended: the heuristic needs an earlier bulleted group *and* an
 * unbulleted last one, so the two shapes it must not touch are pinned alongside the one
 * it exists for.
 */
describe('the trailing instruction group', () => {
  const banner = (...lines) => scriptBanner([...lines, 'const x = 1;'].join('\n'));

  test('is dropped when an earlier group has list items and it does not', () => {
    expect(banner('// ====', '// - ModA@1.0.0', '// ====', '// Paste this ONLY into the library tab'))
      .toBe('- ModA@1.0.0');
  });

  test('survives when it carries list items of its own', () => {
    expect(banner('// ====', '// - ModA@1.0.0', '// ====', '// - ModB@2.0.0'))
      .toBe('- ModA@1.0.0\n- ModB@2.0.0');
  });

  test('survives when no group has list items — an all-prose banner keeps all of it', () => {
    expect(banner('// ====', '// A thriller.', '// ====', '// By someone.'))
      .toBe('A thriller.\nBy someone.');
  });

  test('a single group is never dropped, however it reads', () => {
    expect(banner('// Paste this ONLY into the library tab')).toBe('Paste this ONLY into the library tab');
  });
});
