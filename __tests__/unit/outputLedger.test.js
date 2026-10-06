'use strict';

const fs = require('fs');
const path = require('path');
const { withTmpDir } = require('../helpers/project');
const {
  startOutputLedger, takeOutputLedger, takeCapturedOutput,
  writeOutputFile, removeOutputFile, ensureOutputDir,
} = require('../../src/outputLedger');

afterEach(() => { takeOutputLedger(); });

describe('capture mode', () => {
  test('writeOutputFile stores content and leaves the disk untouched', () => {
    const tmp = withTmpDir();
    const file = path.join(tmp, 'out', 'deep', 'a.md');
    startOutputLedger({ capture: true });
    writeOutputFile(file, 'text\n');
    writeOutputFile(path.join(tmp, 'out', 'b.bin'), Buffer.from([1, 2, 3]));
    const captured = takeCapturedOutput();
    expect(captured.get(path.resolve(file))).toBe('text\n');
    expect(captured.get(path.resolve(tmp, 'out', 'b.bin'))).toEqual(Buffer.from([1, 2, 3]));
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  test('writeOutputFile records the path in the ledger', () => {
    const tmp = withTmpDir();
    const file = path.join(tmp, 'a.md');
    startOutputLedger({ capture: true });
    writeOutputFile(file, 'x');
    expect(takeOutputLedger().has(path.resolve(file))).toBe(true);
  });

  test('removeOutputFile leaves an existing file in place', () => {
    const tmp = withTmpDir();
    const file = path.join(tmp, 'keep.md');
    fs.writeFileSync(file, 'keep', 'utf8');
    startOutputLedger({ capture: true });
    removeOutputFile(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep');
  });

  test('ensureOutputDir creates no directory', () => {
    const tmp = withTmpDir();
    startOutputLedger({ capture: true });
    ensureOutputDir(path.join(tmp, 'made'));
    expect(fs.existsSync(path.join(tmp, 'made'))).toBe(false);
  });

  test('takeOutputLedger ends capture mode', () => {
    const tmp = withTmpDir();
    startOutputLedger({ capture: true });
    writeOutputFile(path.join(tmp, 'a.md'), 'x');
    takeOutputLedger();
    expect(takeCapturedOutput()).toBeNull();
    writeOutputFile(path.join(tmp, 'b.md'), 'y');
    expect(fs.readFileSync(path.join(tmp, 'b.md'), 'utf8')).toBe('y');
  });

  test('takeCapturedOutput returns null for a bracket that was not capturing', () => {
    startOutputLedger();
    expect(takeCapturedOutput()).toBeNull();
  });
});

describe('normal mode', () => {
  test('writeOutputFile creates the parent directory, writes the content and records the path', () => {
    const tmp = withTmpDir();
    const file = path.join(tmp, 'x', 'y', 'a.md');
    startOutputLedger();
    writeOutputFile(file, 'hello\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('hello\n');
    expect(takeOutputLedger().has(path.resolve(file))).toBe(true);
  });

  test('writeOutputFile writes a Buffer byte for byte', () => {
    const tmp = withTmpDir();
    const file = path.join(tmp, 'a.bin');
    writeOutputFile(file, Buffer.from([0, 255, 10]));
    expect([...fs.readFileSync(file)]).toEqual([0, 255, 10]);
  });

  test('removeOutputFile deletes an existing file and ignores a missing one', () => {
    const tmp = withTmpDir();
    const file = path.join(tmp, 'a.md');
    fs.writeFileSync(file, 'x', 'utf8');
    removeOutputFile(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => removeOutputFile(file)).not.toThrow();
  });

  test('ensureOutputDir creates nested directories', () => {
    const tmp = withTmpDir();
    ensureOutputDir(path.join(tmp, 'a', 'b'));
    expect(fs.statSync(path.join(tmp, 'a', 'b')).isDirectory()).toBe(true);
  });

  test('writes outside a bracket reach the disk and are not recorded', () => {
    const tmp = withTmpDir();
    const file = path.join(tmp, 'a.md');
    writeOutputFile(file, 'x');
    expect(fs.existsSync(file)).toBe(true);
    expect(takeOutputLedger()).toBeNull();
  });
});
