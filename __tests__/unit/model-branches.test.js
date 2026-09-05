'use strict';

const fs = require('fs');
const path = require('path');
const { walkBranchChain, walkBranchTree, localRoleKeysOf } = require('../../src/model/branches');
const { CODES } = require('../../src/diag');

// `protagonist` moved into `roles:` in Phase 8 (§9.2) — it is an ordinary role name now,
// not its own field, so the fixture below declares it there like any other project would.
const TREE = {
  'Free Form': {
    variables: { scenario: 'free', shared: 'root-level' },
    components: { opening: './free.md' },
    roles: { protagonist: 'Aness' },
    branches: {
      Veryn: {
        variables: { protag: 'veryn', shared: 'branch-level' },
        components: { openingChoice: 'Who owns you?' },
        roles: { protagonist: 'Veryn' },
        branches: { lovesYou: {} },
      },
      Malcolm: { variables: { protag: 'malcolm' } },
    },
  },
  Wyvern: { variables: { scenario: 'wyvern' } },
};

describe('walkBranchChain — folder path', () => {
  test('preserves the casing written in the YAML', () => {
    expect(walkBranchChain(TREE, ['free form', 'veryn']).folderPath).toEqual(['Free Form', 'Veryn']);
  });

  test('handles keys containing spaces', () => {
    expect(walkBranchChain(TREE, ['Free Form']).folderPath).toEqual(['Free Form']);
  });

  test('falls back to the id as written when a segment does not match', () => {
    expect(walkBranchChain(TREE, ['nope', 'alsoNope']).folderPath).toEqual(['nope', 'alsoNope']);
  });

  test('an empty path yields an empty folder path', () => {
    expect(walkBranchChain(TREE, []).folderPath).toEqual([]);
  });

  test('a null tree still returns the requested segments', () => {
    expect(walkBranchChain(null, ['a', 'b']).folderPath).toEqual(['a', 'b']);
  });
});

describe('walkBranchChain — merged variables and components', () => {
  test('merges root-to-leaf with the child winning', () => {
    const { variables } = walkBranchChain(TREE, ['Free Form', 'Veryn']);
    expect(variables).toEqual({ scenario: 'free', shared: 'branch-level', protag: 'veryn' });
  });

  test('a shallower path keeps the ancestor value', () => {
    expect(walkBranchChain(TREE, ['Free Form']).variables.shared).toBe('root-level');
  });

  test('components merge the same way', () => {
    const { components } = walkBranchChain(TREE, ['Free Form', 'Veryn']);
    expect(components).toEqual({ opening: './free.md', openingChoice: 'Who owns you?' });
  });

  test('siblings are independent', () => {
    expect(walkBranchChain(TREE, ['Free Form', 'Malcolm']).variables.protag).toBe('malcolm');
  });

  test('an unmatched segment stops accumulation rather than throwing', () => {
    const { variables } = walkBranchChain(TREE, ['Free Form', 'nope']);
    expect(variables).toEqual({ scenario: 'free', shared: 'root-level' });
  });
});

describe('walkBranchChain — inherited protagonist (roles.protagonist)', () => {
  test('takes the nearest ancestor that declares one', () => {
    expect(walkBranchChain(TREE, ['Free Form', 'Veryn', 'lovesYou']).roles.protagonist).toBe('Veryn');
  });

  test('falls back through a node that declares none', () => {
    expect(walkBranchChain(TREE, ['Free Form', 'Malcolm']).roles.protagonist).toBe('Aness');
  });

  test('falls back to the root roles table when no node declares one', () => {
    expect(walkBranchChain(TREE, ['Wyvern'], { rootRoles: { protagonist: 'Melli' } }).roles.protagonist).toBe('Melli');
  });

  test('is undefined when nothing declares one', () => {
    expect(walkBranchChain(TREE, ['Wyvern']).roles.protagonist).toBeUndefined();
  });
});

describe('walkBranchChain — merged roles', () => {
  const ROLE_TREE = {
    root: {
      roles: { LI: 'Malcolm', rival: 'Voss' },
      branches: {
        zephon: { roles: { LI: 'Zephon' } },
        unbound: { roles: { rival: null } },
        ghost: { roles: { neverInherited: null } },
      },
    },
  };
  const merge = (path, onWarn) =>
    walkBranchChain(ROLE_TREE, path, { rootRoles: {}, onWarn }).roles;

  test('a branch inherits root roles and overrides its own', () => {
    expect(merge(['root', 'zephon'])).toEqual({ LI: 'Zephon', rival: 'Voss' });
  });

  test('~ unbinds a role rather than setting it null', () => {
    const merged = merge(['root', 'unbound']);
    expect('rival' in merged).toBe(false);
    expect(merged.LI).toBe('Malcolm');
  });

  test('unbinding a role never inherited warns CL0544 and removes nothing', () => {
    const warnings = [];
    merge(['root', 'ghost'], (code, message) => warnings.push({ code, message }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(CODES.ROLE_UNBIND_UNKNOWN);
    expect(warnings[0].message).toMatch(/never inherited/);
  });

  test('rootRoles seeds the root of the chain', () => {
    expect(walkBranchChain(ROLE_TREE, [], { rootRoles: { protagonist: 'Aness' } }).roles)
      .toEqual({ protagonist: 'Aness' });
  });
});

describe('walkBranchChain — retrofitted variable unbind (Decision 1)', () => {
  const VAR_TREE = {
    unbound: { variables: { li: null } },
    ghost: { variables: { neverInherited: null } },
  };
  const merge = (path, onWarn) =>
    walkBranchChain(VAR_TREE, path, { rootVariables: { li: 'Malcolm', scenario: 'x' }, onWarn }).variables;

  test('~ deletes a variable rather than setting it null', () => {
    const merged = merge(['unbound']);
    expect('li' in merged).toBe(false);
    expect(merged.scenario).toBe('x');
  });

  test('the merged result carries no trace of the deleted key to re-add', () => {
    // Regression guard for the bug the retrofit exists to fix: `buildCompileContext` used
    // to re-merge the root table on top of `chain.variables` after this call, which would
    // silently put a deleted root key back. That re-merge is gone; this asserts the value
    // this function alone returns is already correct without it.
    expect(merge(['unbound'])).toEqual({ scenario: 'x' });
  });

  test('unbinding a variable never inherited warns CL0512', () => {
    const warnings = [];
    merge(['ghost'], (code, message) => warnings.push({ code, message }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('CL0512');
    expect(warnings[0].message).toMatch(/never inherited/);
  });
});

describe('localRoleKeysOf', () => {
  test('returns declared role names, minus unbinds', () => {
    expect(localRoleKeysOf({ roles: { LI: 'Malcolm', rival: null } })).toEqual(['LI']);
  });

  test('a node with no roles returns an empty list', () => {
    expect(localRoleKeysOf({})).toEqual([]);
    expect(localRoleKeysOf(null)).toEqual([]);
  });
});

describe('walkBranchChain — terminal node and chain', () => {
  test('returns the terminal node', () => {
    expect(walkBranchChain(TREE, ['Free Form', 'Malcolm']).node).toBe(TREE['Free Form'].branches.Malcolm);
  });

  test('collects every node along the chain, root-first', () => {
    const { nodes } = walkBranchChain(TREE, ['Free Form', 'Veryn']);
    expect(nodes).toEqual([TREE['Free Form'], TREE['Free Form'].branches.Veryn]);
  });

  test('an empty path returns a null terminal node', () => {
    expect(walkBranchChain(TREE, []).node).toBeNull();
  });
});

describe('walkBranchTree — enumeration rooted at the project node', () => {
  const ROOT = { branches: TREE };

  const visitAll = (rootNode, options) => {
    const seen = [];
    walkBranchTree(rootNode, (visit) => {
      seen.push(visit);
      return options && options.next ? options.next(visit) : undefined;
    }, options && options.state);
    return seen;
  };

  const pathOf = (v) => v.path.join('/');

  test('visits the project root first, marked isRoot', () => {
    const seen = visitAll(ROOT);
    expect(seen[0].isRoot).toBe(true);
    expect(seen[0].path).toEqual([]);
    expect(seen[0].name).toBeNull();
    expect(seen[0].node).toBe(ROOT);
    expect(seen.slice(1).every((v) => v.isRoot === false)).toBe(true);
  });

  test('visits every node in the tree', () => {
    expect(visitAll(ROOT).map(pathOf).sort()).toEqual([
      '',
      'Free Form',
      'Free Form/Malcolm',
      'Free Form/Veryn',
      'Free Form/Veryn/lovesYou',
      'Wyvern',
    ]);
  });

  test('a root with branches is not a leaf', () => {
    expect(visitAll(ROOT)[0].isLeaf).toBe(false);
  });

  test('a root with no branches is the tree\'s only node, and a leaf', () => {
    const seen = visitAll({ title: 'Unbranched' });
    expect(seen).toHaveLength(1);
    expect(seen[0].isRoot).toBe(true);
    expect(seen[0].isLeaf).toBe(true);
  });

  test('visits parents before their children', () => {
    const order = visitAll(ROOT).map(pathOf);
    expect(order.indexOf('Free Form')).toBeLessThan(order.indexOf('Free Form/Veryn'));
  });

  test('marks leaves correctly', () => {
    const leaves = visitAll(ROOT).filter((v) => v.isLeaf).map(pathOf).sort();
    expect(leaves).toEqual(['Free Form/Malcolm', 'Free Form/Veryn/lovesYou', 'Wyvern']);
  });

  test('a node whose branches mapping is empty counts as a leaf', () => {
    const seen = visitAll({ branches: { a: { branches: {} } } });
    expect(seen[0].isLeaf).toBe(false);
    expect(seen[1].isLeaf).toBe(true);
  });

  test('carries state down when the visitor returns one', () => {
    const seen = visitAll(ROOT, {
      state: { depth: 0 },
      next: (v) => ({ depth: v.state.depth + 1 }),
    });
    const byPath = Object.fromEntries(seen.map((v) => [pathOf(v), v.state.depth]));
    expect(byPath['']).toBe(0);
    expect(byPath['Free Form']).toBe(1);
    expect(byPath['Free Form/Veryn']).toBe(2);
    expect(byPath['Free Form/Veryn/lovesYou']).toBe(3);
  });

  test('passes state through unchanged when the visitor returns undefined', () => {
    const seen = visitAll(ROOT, { state: { tag: 'root' } });
    expect(seen.every((v) => v.state.tag === 'root')).toBe(true);
  });

  test('exposes the node itself', () => {
    const wyvern = visitAll(ROOT).find((v) => v.name === 'Wyvern');
    expect(wyvern.node).toBe(TREE.Wyvern);
  });

  test('a null or non-object root visits nothing', () => {
    expect(visitAll(null)).toEqual([]);
    expect(visitAll('nope')).toEqual([]);
  });

  test('preserves key casing, since enumeration has no key to match', () => {
    expect(visitAll(ROOT).map((v) => v.name)).toContain('Free Form');
  });
});

describe('model/ purity', () => {
  const MODEL_DIR = path.resolve(__dirname, '../../src/model');

  // The invariant that makes the compiler testable without fixtures on disk, and that
  // §4.6 notes is most of a language server. Enforced mechanically because it is the
  // kind of rule that erodes one convenient console.warn at a time.
  test.each(fs.readdirSync(MODEL_DIR).filter((f) => f.endsWith('.js')))(
    'model/%s uses neither fs nor console',
    (file) => {
      const source = fs.readFileSync(path.join(MODEL_DIR, file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code).not.toMatch(/require\(['"]fs['"]\)/);
      expect(code).not.toMatch(/require\(['"]path['"]\)/);
      expect(code).not.toMatch(/console\s*\./);
    }
  );

});
