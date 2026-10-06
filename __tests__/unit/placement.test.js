'use strict';

const { placeWithOverrides, buildPlacementTree } = require('../../src/inherit');

/** What each leaf resolves to under VL inheritance: the nearest write on its path. */
function resolve(leafPaths, writes) {
  return leafPaths.map((p) => {
    let found = null;
    for (let depth = 0; depth <= p.length; depth += 1) {
      const hit = writes.find((w) => w.path.length === depth && w.path.every((s, i) => s === p[i]));
      if (hit) found = hit.version;
    }
    return found;
  });
}

const place = (leafPaths, versions) => {
  const leafVersion = new Map();
  versions.forEach((v, i) => { if (v !== null) leafVersion.set(i, v); });
  const count = Math.max(-1, ...versions.filter((v) => v !== null)) + 1;
  return placeWithOverrides(buildPlacementTree(leafPaths), leafVersion, count);
};
const at = (writes) => writes.map((w) => `${w.path.join('/') || '(root)'}=${w.version}`).sort();

describe('placeWithOverrides', () => {
  test('a card every leaf renders the same way is written once, at the root', () => {
    expect(at(place([['a'], ['b'], ['c']], [0, 0, 0]))).toEqual(['(root)=0']);
  });

  test('one odd leaf takes an override under the common version', () => {
    expect(at(place([['a'], ['b'], ['c']], [0, 1, 0]))).toEqual(['(root)=0', 'b=1']);
  });

  test('two leaves that differ get a copy each, with no override when it saves nothing', () => {
    expect(at(place([['a'], ['b']], [0, 1]))).toEqual(['a=0', 'b=1']);
  });

  test('a leaf without the card blocks any copy above it, because VL cannot remove a card', () => {
    expect(at(place([['a'], ['b'], ['c']], [0, 0, null]))).toEqual(['a=0', 'b=0']);
  });

  test('the common version sits at the deepest node whose leaves all have the card', () => {
    const leaves = [['t', 'x'], ['t', 'y'], ['t', 'z'], ['u']];
    expect(at(place(leaves, [0, 1, 0, null]))).toEqual(['t/y=1', 't=0']);
  });

  test('random trees: every leaf resolves to its own version, in no more copies than exact partition', () => {
    let seed = 7;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
    let checked = 0; let saved = 0;
    for (let run = 0; run < 300; run += 1) {
      const leaves = [];
      const grow = (prefix, depth) => {
        // The root always branches; deeper nodes branch about half the time.
        const kids = depth >= 3 ? 0 : depth === 0 ? 2 + rand(3) : (rand(2) ? 2 + rand(2) : 0);
        if (kids === 0) { leaves.push(prefix); return; }
        for (let k = 0; k < kids; k += 1) grow([...prefix, `n${k}`], depth + 1);
      };
      grow([], 0);
      checked += 1;
      const versions = leaves.map(() => (rand(5) === 0 ? null : rand(3)));
      const writes = place(leaves, versions);
      expect(resolve(leaves, writes)).toEqual(versions);

      // The exact-partition layout: one copy per maximal subtree that is uniform in a version.
      const tree = buildPlacementTree(leaves);
      const leafIdx = new Map(leaves.map((p, i) => [p.join('/'), i]));
      const under = (node) => (node.leaf !== null ? [node.leaf] : [])
        .concat(...[...node.children.values()].map(under));
      let partition = 0;
      const count = (node) => {
        const vs = new Set(under(node).map((i) => versions[i]));
        if (vs.size === 1 && !vs.has(null)) { partition += 1; return; }
        if (node.leaf !== null && versions[node.leaf] !== null) partition += 1;
        for (const kid of node.children.values()) count(kid);
      };
      count(tree);
      expect(leafIdx.size).toBe(leaves.length);
      expect(writes.length).toBeLessThanOrEqual(partition);
      if (writes.length < partition) saved += 1;
    }
    expect(checked).toBe(300);
    expect(saved).toBeGreaterThan(0); // overrides actually occur, so the check above is not vacuous
  });
});
