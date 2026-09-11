'use strict';

const path = require('path');
const fs = require('fs');
const { buildCompileContext, resolveBranchItems } = require('../../src/branchCompile');
const { buildRegistry, buildCanonRegistry, loadItemsFromDir, resolveIncludes } = require('../../src/loader/registry');
const { Diagnostics } = require('../../src/diag');
const { attachOrigins, createOriginIndex, originAt } = require('../../src/origin');
const { withTmpDir, writeTree } = require('../helpers/project');
const { resolveCrossItemRenderFunctions } = require('../../src/crossItem');
const { parseYaml } = require('../../src/loader/yaml');

test('cross-item cycles retain exact dependency fields and related sources', () => {
  const items = ['A', 'B'].map((id, i) => {
    const { value, sourceMap } = parseYaml(`id: ${id}\nbody:\n  ref:\n    - '{join(", ", $${i === 0 ? 'B' : 'A'}.body.ref)}'`, `${id}.yaml`);
    return attachOrigins(value, sourceMap.exportOrigins());
  });
  const diagnostics = new Diagnostics();
  resolveCrossItemRenderFunctions(items, new Map(items.map(item => [item.id.toLowerCase(), item])), diagnostics, { branch: 'main' });
  const finding = diagnostics.errors[0];
  expect(finding).toMatchObject({ file: 'B.yaml', line: 4, col: 7, branch: 'main' });
  expect(finding.related[0]).toMatchObject({ file: 'A.yaml', line: 4, col: 7 });
  expect(finding.message).toContain('"B".ref → "A"');
});

describe('item diagnostics retain loader origins', () => {
  test('programmatic items without an origin index keep their file-only warning fallback', () => {
    const diagnostics = new Diagnostics();
    resolveBranchItems([{ id: 'Hero', _source: 'item.yaml', body: { text: 'original' },
      aid: { type: 'Character' }, branches: { main: 'local' }, variants: { local: { text: '-{absent}' } },
    }], new Map(), ['main'], {}, diagnostics);
    expect(diagnostics.all.find(d => d.code === 'CL0328')).toMatchObject({ file: 'item.yaml', line: null, branch: 'main' });
  });

  function loaded(project, library = '- id: Hero\n  name: Hero\n  aid: {type: Character}\n  body: {text: inherited}') {
    const dir = writeTree(withTmpDir(), { 'library/items.yaml': library, 'project/items.yaml': project });
    const diagnostics = new Diagnostics();
    const registry = buildCanonRegistry(new Map([['canon', path.join(dir, 'library')]]), { diagnostics });
    const defs = loadItemsFromDir(path.join(dir, 'project'), { diagnostics });
    return { dir, diagnostics, registry, defs };
  }

  test('library registry stamping and variable aliases preserve inherited sibling locations', () => {
    const state = loaded('- import: Hero\n  variables: {local: quiet}',
      '- id: Hero\n  name: Hero\n  aid: {type: Character}\n  vars: {inherited: steady}\n  body: {text: inherited}');
    const [item] = resolveBranchItems(state.defs, state.registry, ['main'], {}, state.diagnostics);
    expect(originAt(item, ['body', 'text'])).toMatchObject({ file: path.join(state.dir, 'library/items.yaml'), line: 5 });
    expect(originAt(item, ['v', 'inherited'])).toMatchObject({ path: ['vars', 'inherited'], line: 4 });
    expect(originAt(item, ['v', 'local'])).toMatchObject({ file: path.join(state.dir, 'project/items.yaml'), path: ['variables', 'local'], line: 2 });
  });

  test('duplicate imports point to the rejected import and the earlier claim, with a branch', () => {
    const state = loaded('- import: Hero\n- import: Hero');
    resolveBranchItems(state.defs, state.registry, ['main'], {}, state.diagnostics);
    const finding = state.diagnostics.errors.find(d => d.code === 'CL0325');
    expect(finding).toMatchObject({ file: path.join(state.dir, 'project/items.yaml'), line: 2, col: 3, branch: 'main' });
    expect(finding.related).toEqual([{ label: 'first definition', file: finding.file, line: 1, col: 3 }]);
  });

  test('registry conflicts retain both authored identity positions', () => {
    const state = loaded('- id: Copy\n  name: First\n- id: Copy\n  name: Second');
    buildRegistry(state.defs, 'project', { diagnostics: state.diagnostics });
    const finding = state.diagnostics.errors.find(d => d.related.length);
    expect(finding).toMatchObject({ line: 3, col: 3 });
    expect(finding.related[0]).toMatchObject({ line: 1, col: 3 });
  });

  test('nested branch selection and operation no-ops identify the action on that branch', () => {
    const state = loaded('- import: Hero\n  branches:\n    main:\n      apply: local\n      branches:\n        child: missing\n  variants:\n    local:\n      body:\n        text: -{absent}');
    resolveBranchItems(state.defs, state.registry, ['main', 'child'], {}, state.diagnostics);
    const selector = state.diagnostics.all.find(d => d.code === 'CL0321');
    const operation = state.diagnostics.all.find(d => d.code === 'CL0328');
    expect(selector).toMatchObject({ line: 6, col: 9, branch: 'main/child' });
    expect(operation).toMatchObject({ line: 10, col: 9, branch: 'main/child' });
  });

  test('include dispatch belongs to the including file while item fields stay in the included file', () => {
    const state = loaded('- include: ../library/items.yaml\n  branches:\n    main: missing\n    "*": null');
    const included = resolveIncludes(state.defs, state.registry, { _base: path.join(state.dir, 'project') }, { diagnostics: state.diagnostics });
    const [item] = resolveBranchItems(included, state.registry, ['main'], {}, state.diagnostics);
    expect(originAt(item, ['body', 'text'])).toMatchObject({ file: path.join(state.dir, 'library/items.yaml'), line: 4 });
    const selector = state.diagnostics.all.find(d => d.code === 'CL0326');
    expect(selector).toMatchObject({ file: path.join(state.dir, 'project/items.yaml'), line: 3, branch: 'main' });
    const wildcard = state.diagnostics.all.find(d => /null wildcard/.test(d.message));
    expect(wildcard).toMatchObject({ file: path.join(state.dir, 'project/items.yaml'), line: 4, branch: 'main' });
  });
});

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
      [attachOrigins({ import: 'Anes', _source: 'items.cl.yaml' }, createOriginIndex([{
        file: 'items.cl.yaml', path: ['import'], line: 4, col: 3,
      }]))],
      canon(), [], {}, diagnostics,
    );
    const finding = diagnostics.errors.find((d) => d.code === 'CL0324');
    expect(finding).toBeDefined();
    expect(finding.location).toBe('items.cl.yaml:4:3');
    expect(finding.message).not.toContain('Did you mean');
    expect(finding.hint).toBe('Did you mean "aness"?');
  });
});
