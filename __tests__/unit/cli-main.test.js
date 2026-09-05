'use strict';

// In-process counterpart to cli.test.js: calls `main(argv)` directly instead of spawning a
// child process. This is cheaper for the cases that don't need a real process exit code, and
// gives future CLI tests a pattern that isn't a spawnSync round trip. cli.test.js itself is
// left untouched — it is the only thing exercising the real process exit and require.main
// wiring.
//
// Every test here passes explicit absolute paths in argv and never touches process.cwd() or
// process.chdir(): changing the working directory in-process would leak into every other
// suite running in the same worker.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { main } = require('../../src/cli.js');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

const MINIMAL_COMPILE_YAML = `
version: 4
structure:
  input:
    items: []
  output: ./output
roles:
  protagonist: Test
branches:
  only: {}
`.trimStart();

describe('main(argv) — in-process', () => {
  let logSpy, warnSpy, errorSpy;

  beforeEach(() => {
    logSpy   = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy  = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('is exported and is a function', () => {
    expect(typeof main).toBe('function');
  });

  test('an unknown --lint-level value returns 1', () => {
    const result = main(['--lint-level=loud']);
    expect(result).toBe(1);
    expect(errorSpy.mock.calls.some(args => /off, error, warn/.test(args[0]))).toBe(true);
  });

  describe('with a temp project', () => {
    let tmp;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cli-main-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('a successful compile returns 0', () => {
      const cfgPath = path.join(tmp, 'compile.yaml');
      write(cfgPath, MINIMAL_COMPILE_YAML);

      const result = main(['--compile', cfgPath]);

      expect(result).toBe(0);
      expect(fs.existsSync(path.join(tmp, 'output'))).toBe(true);
    });

    test('a missing config returns 1', () => {
      const emptyDir = path.join(tmp, 'empty');
      fs.mkdirSync(emptyDir);

      const result = main([emptyDir]);

      expect(result).toBe(1);
    });
  });
});
