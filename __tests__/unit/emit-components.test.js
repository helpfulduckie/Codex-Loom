'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DECLARATION, DOCUMENT_COMPONENTS, OTHER_COMPONENTS, emitDocumentComponent,
} = require('../../src/emit/components');

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-emit-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const AIN = DOCUMENT_COMPONENTS.find((d) => d.key === 'aiInstructions');
const AN = DOCUMENT_COMPONENTS.find((d) => d.key === 'authorsNote');

function write(name, content) {
  const full = path.join(tmpDir, name);
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function emit(descriptor, spec) {
  return emitDocumentComponent(descriptor, spec, {
    outputDir: tmpDir,
    registry: new Map(),
    compileContext: { branchPath: [], variables: {}, componentRefs: {} },
  });
}

describe('the descriptor table', () => {
  test('AI Instructions and Author\'s Note are table rows, not bespoke blocks', () => {
    expect(DOCUMENT_COMPONENTS.map((d) => d.key)).toEqual(['aiInstructions', 'authorsNote']);
  });

  test('every row declares the fields the emitter needs', () => {
    for (const descriptor of DOCUMENT_COMPONENTS) {
      expect(typeof descriptor.load).toBe('function');
      expect(typeof descriptor.compile).toBe('function');
      expect(typeof descriptor.write).toBe('function');
      expect(descriptor.label).toEqual(expect.any(String));
    }
  });

  test('declaration describes branch-chain merging, not a write location', () => {
    // The distinction matters: VL inherits components itself, so "written at every leaf"
    // is the emitter's current strategy rather than a property of the component.
    expect(AIN.declaration).toBe(DECLARATION.INHERITED);
    expect(OTHER_COMPONENTS.find((d) => d.key === 'branchFraming').declaration).toBe(DECLARATION.NODE);
    expect(OTHER_COMPONENTS.find((d) => d.key === 'description').declaration).toBe(DECLARATION.PROJECT);
  });

  test('the two tables together cover the §7.3 component set', () => {
    const covered = [...DOCUMENT_COMPONENTS, ...OTHER_COMPONENTS].map((d) => d.key).sort();
    expect(covered).toEqual([
      'aiInstructions', 'authorsNote', 'branchFraming', 'description',
      'opening', 'plotEssential', 'scripts',
    ]);
  });
});

describe('emitDocumentComponent', () => {
  test('an absent spec emits nothing and reports no gap', () => {
    expect(emit(AIN, null)).toEqual({ content: null, written: null, gap: null });
  });

  test('a spec pointing nowhere reports a gap rather than throwing', () => {
    expect(emit(AIN, path.join(tmpDir, 'missing.md')).gap).toBe('source not found');
  });

  test('a non-string spec reports a gap', () => {
    expect(emit(AIN, { not: 'a path' }).gap).toBe('source not found');
  });

  test('.md passes through verbatim', () => {
    const { content, written } = emit(AIN, write('ain.md', 'Stay in character.\n\n'));
    expect(content).toBe('Stay in character.');
    expect(fs.readFileSync(written, 'utf8')).toContain('Stay in character.');
  });

  test('.txt passes through verbatim too', () => {
    expect(emit(AIN, write('ain.txt', 'Plain text.')).content).toBe('Plain text.');
  });

  test('an empty passthrough file reports a gap', () => {
    expect(emit(AIN, write('ain.md', '   \n')).gap).toBe('compiled to empty content');
  });

  test('a YAML spec is loaded and compiled rather than passed through', () => {
    const spec = write('ain.cl.yaml', 'sections:\n  - text: Compiled section.\n');
    expect(emit(AIN, spec).content).toContain('Compiled section.');
  });

  test('each row writes to its own filename', () => {
    const ainPath = emit(AIN, write('ain.md', 'A')).written;
    const anPath = emit(AN, write('an.md', 'B')).written;
    expect(path.basename(ainPath)).toBe('AI Instructions.md');
    // Deliberately not "Author's Note.md" — Velvet Lattice requires this spelling.
    expect(path.basename(anPath)).toBe('Author Notes.md');
  });

  test('both rows run through the same code path', () => {
    for (const descriptor of DOCUMENT_COMPONENTS) {
      const result = emit(descriptor, write(`${descriptor.key}.md`, 'Shared.'));
      expect(result.content).toBe('Shared.');
      expect(result.gap).toBeNull();
    }
  });
});
