'use strict';

const fs = require('fs');
const path = require('path');
const { walkBranchChain, walkBranchTree } = require('../../src/model/branches');

const TREE = {
  'Free Form': {
    variables: { scenario: 'free', shared: 'root-level' },
    components: { opening: './free.md' },
    protagonist: 'Aness',
    branches: {
      Veryn: {
        variables: { protag: 'veryn', shared: 'branch-level' },
        components: { openingChoice: 'Who owns you?' },
        protagonist: 'Veryn',
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
    const { variables, complete } = walkBranchChain(TREE, ['Free Form', 'nope']);
    expect(variables).toEqual({ scenario: 'free', shared: 'root-level' });
    expect(complete).toBe(false);
  });
});

describe('walkBranchChain — inherited protagonist', () => {
  test('takes the nearest ancestor that declares one', () => {
    expect(walkBranchChain(TREE, ['Free Form', 'Veryn', 'lovesYou']).protagonist).toBe('Veryn');
  });

  test('falls back through a node that declares none', () => {
    expect(walkBranchChain(TREE, ['Free Form', 'Malcolm']).protagonist).toBe('Aness');
  });

  test('falls back to the root protagonist when no node declares one', () => {
    expect(walkBranchChain(TREE, ['Wyvern'], { rootProtagonist: 'Melli' }).protagonist).toBe('Melli');
  });

  test('is null when nothing declares one', () => {
    expect(walkBranchChain(TREE, ['Wyvern']).protagonist).toBeNull();
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

  test('complete is true when every segment matched', () => {
    expect(walkBranchChain(TREE, ['Free Form', 'Veryn']).complete).toBe(true);
  });

  test('an empty path returns a null terminal node', () => {
    expect(walkBranchChain(TREE, []).node).toBeNull();
  });
});

describe('walkBranchTree — enumeration, not lookup', () => {
  const visitAll = (tree, options) => {
    const seen = [];
    walkBranchTree(tree, (visit) => {
      seen.push(visit);
      return options && options.next ? options.next(visit) : undefined;
    }, options && options.state);
    return seen;
  };

  test('visits every node in the tree', () => {
    expect(visitAll(TREE).map((v) => v.path.join('/')).sort()).toEqual([
      'Free Form',
      'Free Form/Malcolm',
      'Free Form/Veryn',
      'Free Form/Veryn/lovesYou',
      'Wyvern',
    ]);
  });

  test('visits parents before their children', () => {
    const order = visitAll(TREE).map((v) => v.path.join('/'));
    expect(order.indexOf('Free Form')).toBeLessThan(order.indexOf('Free Form/Veryn'));
  });

  test('marks leaves correctly', () => {
    const leaves = visitAll(TREE).filter((v) => v.isLeaf).map((v) => v.path.join('/')).sort();
    expect(leaves).toEqual(['Free Form/Malcolm', 'Free Form/Veryn/lovesYou', 'Wyvern']);
  });

  test('a node whose branches mapping is empty counts as a leaf', () => {
    expect(visitAll({ a: { branches: {} } })[0].isLeaf).toBe(true);
  });

  test('carries state down when the visitor returns one', () => {
    const seen = visitAll(TREE, {
      state: { depth: 0 },
      next: (v) => ({ depth: v.state.depth + 1 }),
    });
    const byPath = Object.fromEntries(seen.map((v) => [v.path.join('/'), v.state.depth]));
    expect(byPath['Free Form']).toBe(0);
    expect(byPath['Free Form/Veryn']).toBe(1);
    expect(byPath['Free Form/Veryn/lovesYou']).toBe(2);
  });

  test('passes state through unchanged when the visitor returns undefined', () => {
    const seen = visitAll(TREE, { state: { tag: 'root' } });
    expect(seen.every((v) => v.state.tag === 'root')).toBe(true);
  });

  test('exposes the node itself', () => {
    const wyvern = visitAll(TREE).find((v) => v.name === 'Wyvern');
    expect(wyvern.node).toBe(TREE.Wyvern);
  });

  test('a null or non-object tree visits nothing', () => {
    expect(visitAll(null)).toEqual([]);
    expect(visitAll('nope')).toEqual([]);
  });

  test('preserves key casing, since enumeration has no key to match', () => {
    expect(visitAll(TREE).map((v) => v.name)).toContain('Free Form');
  });
});

describe('model/ purity (§3.3)', () => {
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

  test('every model module is covered by that check', () => {
    expect(fs.readdirSync(MODEL_DIR).filter((f) => f.endsWith('.js')).sort())
      .toEqual(['branches.js', 'fieldops.js', 'item.js', 'pronouns.js', 'refs.js']);
  });
});
