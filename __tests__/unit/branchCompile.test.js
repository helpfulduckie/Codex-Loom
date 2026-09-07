'use strict';

const path = require('path');
const fs = require('fs');
const { buildCompileContext, resolveBranchItems } = require('../../src/branchCompile');
const { buildRegistry } = require('../../src/loader/registry');
const { Diagnostics } = require('../../src/diag');
const { withTmpDir } = require('../helpers/project');

// ── buildCompileContext ───────────────────────────────────────────────────────

const baseCtxConfig = {
  _base: '/project',
  _resolvedComponents: {},
  variables: {},
  components: {},
  branches: null,
};

describe('buildCompileContext', () => {
  test('empty branchPath returns root variables', () => {
    const config = { ...baseCtxConfig, variables: { theme: 'dark' } };
    const { variables } = buildCompileContext(config, []);
    expect(variables).toEqual({ theme: 'dark' });
  });

  test('branch variables are merged over root', () => {
    const config = {
      ...baseCtxConfig,
      variables: { a: '1', b: '2' },
      branches: { main: { variables: { b: 'branch', c: '3' } } },
    };
    const { variables } = buildCompileContext(config, ['main']);
    expect(variables).toEqual({ a: '1', b: 'branch', c: '3' });
  });

  test('two-level nested path merges variables in order', () => {
    const config = {
      ...baseCtxConfig,
      variables: { a: 'root' },
      branches: {
        tier1: {
          variables: { b: 'tier1' },
          branches: { tier2: { variables: { c: 'tier2' } } },
        },
      },
    };
    const { variables } = buildCompileContext(config, ['tier1', 'tier2']);
    expect(variables).toEqual({ a: 'root', b: 'tier1', c: 'tier2' });
  });

  test('unknown branch key stops at root variables', () => {
    const config = {
      ...baseCtxConfig,
      variables: { a: 'root' },
      branches: { main: { variables: { b: 'branch' } } },
    };
    const { variables } = buildCompileContext(config, ['nonexistent']);
    expect(variables).toEqual({ a: 'root' });
  });

  test('branch key lookup is case-insensitive', () => {
    const config = {
      ...baseCtxConfig,
      branches: { Main: { variables: { role: 'knight' } } },
    };
    const { variables } = buildCompileContext(config, ['main']);
    expect(variables.role).toBe('knight');
  });

  test('all componentRefs are null when components block is empty', () => {
    const { componentRefs } = buildCompileContext(baseCtxConfig, []);
    for (const val of Object.values(componentRefs)) {
      expect(val).toBeNull();
    }
  });
});

// ── token coverage: % in component specs + @ canon in specs ───────────────────

describe('buildCompileContext — % in component specs', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = withTmpDir(); });

  const makeConfig = (over) => ({
    _base: tmpDir,
    _resolvedComponents: {},
    _resolvedCanon: new Map(),
    variables: {},
    components: {},
    branches: null,
    ...over,
  });

  test('{%var} in a component spec resolves to the matching file path', () => {
    fs.writeFileSync(path.join(tmpDir, 'pe-knight.yaml'), 'x\n', 'utf8');
    const config = makeConfig({
      variables: { role: 'pe-knight' },
      components: { plotEssential: '{%role}.yaml' },
    });
    const { componentRefs } = buildCompileContext(config, []);
    expect(componentRefs.plotEssential).toBe(path.join(tmpDir, 'pe-knight.yaml'));
  });

  test('branch variable overrides root in a component spec', () => {
    fs.writeFileSync(path.join(tmpDir, 'pe-mage.yaml'), 'x\n', 'utf8');
    const config = makeConfig({
      variables: { role: 'pe-knight' },
      components: { plotEssential: '{%role}.yaml' },
      branches: { mage: { variables: { role: 'pe-mage' } } },
    });
    const { componentRefs } = buildCompileContext(config, ['mage']);
    expect(componentRefs.plotEssential).toBe(path.join(tmpDir, 'pe-mage.yaml'));
  });

  test('a canon name resolves in a component spec', () => {
    const peDir = path.join(tmpDir, 'shared');
    fs.mkdirSync(peDir);
    fs.writeFileSync(path.join(peDir, 'pe.yaml'), 'x\n', 'utf8');
    const config = makeConfig({
      _resolvedCanon: new Map([['lore', peDir]]),
      _variables: { lore: peDir },
      components: { plotEssential: '{%lore}/pe.yaml' },
    });
    const { componentRefs } = buildCompileContext(config, []);
    expect(componentRefs.plotEssential).toBe(path.join(peDir, 'pe.yaml'));
  });
});

/**
 * A project def carrying `import:` and no `id:` of its own (§17.4).
 *
 * [[2026-08-17 The Document Layer Goes]] recorded such a def as having become *silently
 * inert* when `buildOverlays` was deleted, and asked for a diagnostic. The symptom has
 * changed shape since: Phase 3's `resolveBranchItems` iterates every def including bare
 * imports, so the def renders — under the id of the item it names, which is the behavior
 * `documentation/04-imports-and-includes.md` documents throughout and the one an author
 * wants. Nothing is inert.
 *
 * What replaced it is a duplicate. `buildRegistry` skips a bare import by design, so two
 * of them naming one canon item never meet in the registry and its duplicate-id check
 * never runs — while the resolver produces two items with the same id, one story card
 * name and one trigger list. `resolveBranchItems` raises CL0325 on that, because it is
 * the only stage that sees both resolved items at once, and it asks per branch: branch
 * dispatch can legitimately send one of a colliding pair away.
 */
describe('a bare import def carries no id of its own', () => {
  const canon = () => buildRegistry([{
    id: 'aness', name: 'Aness', aid: { type: 'Character', triggers: ['Aness'] },
    body: { text: 'canon body' }, _source: 'canon.cl.yaml',
  }], 'canon');

  test('it resolves and renders, under the id of the item it imports', () => {
    const defs = [{ import: 'Aness', _source: 'project.cl.yaml' }];
    const items = resolveBranchItems(defs, canon(), [], {}, new Diagnostics());
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('aness');
    expect(items[0].body.text).toBe('canon body');
  });

  test('it claims no registry id, which is what keeps rename-on-import a rename', () => {
    expect([...buildRegistry([
      { import: 'Aness', _source: 'project.cl.yaml' },
      { id: 'dragon', import: 'Aness', _source: 'project.cl.yaml' },
    ], 'project').keys()]).toEqual(['dragon']);
  });

  test('two of them resolving to one id is an ERROR naming both sources', () => {
    const defs = [
      { import: 'Aness', body: { text: 'first' }, _source: 'a.cl.yaml' },
      { import: 'Aness', body: { text: 'second' }, _source: 'b.cl.yaml' },
    ];
    const diagnostics = new Diagnostics();
    resolveBranchItems(defs, canon(), [], {}, diagnostics);

    expect(diagnostics.errors).toHaveLength(1);
    expect(diagnostics.errors[0].code).toBe('CL0325');
    expect(diagnostics.errors[0].message).toMatch(/the first is in a\.cl\.yaml/);
    expect(diagnostics.errors[0].file).toBe('b.cl.yaml');
  });

  test('a bare import colliding with an explicit def of that id reports the same way', () => {
    const defs = [
      { id: 'Aness', name: 'Aness', _source: 'items.cl.yaml' },
      { import: 'Aness', body: { text: 'second' }, _source: 'items.cl.yaml' },
    ];
    const diagnostics = new Diagnostics();
    resolveBranchItems(defs, canon(), [], {}, diagnostics);

    expect(diagnostics.errors.map((d) => d.code)).toEqual(['CL0325']);
  });

  test('branch dispatch sending one of the pair away is not a collision', () => {
    const defs = [
      { import: 'Aness', body: { text: 'first' }, branches: { alpha: [], beta: null }, _source: 'a.cl.yaml' },
      { import: 'Aness', body: { text: 'second' }, branches: { alpha: null, beta: [] }, _source: 'b.cl.yaml' },
    ];
    const diagnostics = new Diagnostics();
    const items = resolveBranchItems(defs, canon(), ['alpha'], {}, diagnostics);

    expect(items).toHaveLength(1);
    expect(diagnostics.all).toHaveLength(0);
  });

  test('the same collision through explicit ids is still caught earlier, at load', () => {
    const diagnostics = new Diagnostics();
    buildRegistry([
      { id: 'aness', name: 'Aness', _source: 'a.cl.yaml' },
      { id: 'aness', name: 'Aness', _source: 'b.cl.yaml' },
    ], 'project', { diagnostics });
    expect(diagnostics.errors.some((d) => /Duplicate item ID/i.test(d.message))).toBe(true);
  });

  test('CL0324 keeps the import hint separate and points at import:', () => {
    const diagnostics = new Diagnostics();
    resolveBranchItems(
      [{ import: 'Anes', _source: 'items.cl.yaml', _importLocation: {
        file: 'items.cl.yaml', line: 4, col: 3,
      } }],
      canon(), [], {}, diagnostics,
    );
    const finding = diagnostics.errors.find((d) => d.code === 'CL0324');
    expect(finding).toBeDefined();
    expect(finding.location).toBe('items.cl.yaml:4:3');
    expect(finding.message).not.toContain('Did you mean');
    expect(finding.hint).toBe('Did you mean "aness"?');
  });
});
