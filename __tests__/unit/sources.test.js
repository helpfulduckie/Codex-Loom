'use strict';

const fs = require('fs');
const path = require('path');
const { withTmpDir } = require('../helpers/project');
const { withSourceOverrides, readSource } = require('../../src/sources');

function diskFile(text) {
  const file = path.join(withTmpDir(), 'a.txt');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

describe('source overrides', () => {
  test('an override replaces the file content inside the bracket', () => {
    const file = diskFile('disk');
    const read = withSourceOverrides({ [file]: 'override' }, () => readSource(file));
    expect(read).toBe('override');
  });

  test('a Map of overrides is accepted', () => {
    const file = diskFile('disk');
    expect(withSourceOverrides(new Map([[file, 'mapped']]), () => readSource(file))).toBe('mapped');
  });

  test('a path with no override reads the disk', () => {
    const file = diskFile('disk');
    const other = diskFile('other disk');
    expect(withSourceOverrides({ [other]: 'x' }, () => readSource(file))).toBe('disk');
  });

  test('with no overrides installed the disk is read', () => {
    const file = diskFile('disk');
    expect(readSource(file)).toBe('disk');
    expect(withSourceOverrides(null, () => readSource(file))).toBe('disk');
  });

  test('the override is gone once the bracket returns', () => {
    const file = diskFile('disk');
    withSourceOverrides({ [file]: 'override' }, () => readSource(file));
    expect(readSource(file)).toBe('disk');
  });

  test('the previous state is restored when the callback throws', () => {
    const file = diskFile('disk');
    expect(() => withSourceOverrides({ [file]: 'override' }, () => { throw new Error('boom'); }))
      .toThrow('boom');
    expect(readSource(file)).toBe('disk');
  });

  test('a nested bracket restores the outer overrides', () => {
    const file = diskFile('disk');
    withSourceOverrides({ [file]: 'outer' }, () => {
      withSourceOverrides({ [file]: 'inner' }, () => {});
      expect(readSource(file)).toBe('outer');
    });
  });

  test('an unnormalized path matches its resolved form', () => {
    const file = diskFile('disk');
    const dir = path.dirname(file);
    const roundabout = path.join(dir, '..', path.basename(dir), 'a.txt');
    expect(withSourceOverrides({ [roundabout]: 'override' }, () => readSource(file))).toBe('override');
  });

  const onWindows = process.platform === 'win32';

  (onWindows ? test : test.skip)('paths that differ only by case name the same file on win32', () => {
    const file = diskFile('disk');
    expect(withSourceOverrides({ [file.toUpperCase()]: 'override' }, () => readSource(file)))
      .toBe('override');
  });

  (onWindows ? test.skip : test)('paths that differ by case name different files off win32', () => {
    const file = diskFile('disk');
    expect(withSourceOverrides({ [file.toUpperCase()]: 'override' }, () => readSource(file)))
      .toBe('disk');
  });
});
