'use strict';

/**
 * Schema-surface coverage: which keys a schema declares, and which a document populates.
 *
 * This is the machinery behind the kitchen-sink fixtures. The Phase 1 audit found two bugs
 * that every existing test missed, and both were *shape* gaps rather than output gaps —
 * `structure.output` and `structure.reports` skipped the variable expander, and the three
 * golden fixture projects happen never to put a token in either key. Pinning compiled
 * output cannot catch that; pinning the key surface can.
 *
 * A kitchen-sink fixture that is merely large decays: a key added in a later phase is not
 * in it, nothing says so, and the fixture quietly stops being a kitchen sink. Comparing
 * `declaredPaths` against `coveredPaths` is what stops that — adding a schema key with no
 * fixture coverage is a red test naming the key.
 *
 * ── Why not `buildKeyIndex` ─────────────────────────────────────────────────
 *
 * `src/schema.js` already walks a schema, but with a *global* seen-set: a descriptor shared
 * between two levels is indexed at whichever path reaches it first. `COMPONENTS` and
 * `SCRIPTS` live at both the config root and on every branch node, so that walk reports
 * them under one and not the other — which is exactly the coverage claim this file has to
 * make honestly. The guard here is the current path *stack* instead, so a shared descriptor
 * is enumerated at every home it has, while the self-referential branch node still
 * terminates.
 */

const TYPES_MAP = 'map';
const TYPES_RECORD = 'record';
const TYPES_SEQ = 'seq';

/** A record's open key position and a sequence's element position, in a dotted path. */
const RECORD_KEY = '*';
const SEQ_INDEX = '[]';

function typesOf(descriptor) {
  return Array.isArray(descriptor.type) ? descriptor.type : [descriptor.type];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Every dotted key path a schema declares.
 *
 * `branches.*.components.plotEssential`, `structure.input.canon`, `render.notesTemplate`.
 * A record's keys are the author's to choose, so its open position collapses to `*` and its
 * value descriptor is walked once rather than per hypothetical key.
 */
function declaredPaths(schema) {
  const paths = new Set();
  const stack = [];

  const walk = (descriptor, path) => {
    if (!descriptor || typeof descriptor !== 'object') return;
    if (stack.includes(descriptor)) return;
    stack.push(descriptor);

    const types = typesOf(descriptor);
    if (types.includes(TYPES_MAP) && descriptor.keys) {
      for (const [key, child] of Object.entries(descriptor.keys)) {
        const childPath = [...path, key];
        paths.add(childPath.join('.'));
        walk(child, childPath);
      }
    }
    if (types.includes(TYPES_RECORD) && descriptor.of) walk(descriptor.of, [...path, RECORD_KEY]);
    if (types.includes(TYPES_SEQ) && descriptor.of) walk(descriptor.of, [...path, SEQ_INDEX]);

    stack.pop();
  };

  walk(schema, []);
  return paths;
}

/**
 * Every dotted key path a parsed document actually populates, in the same vocabulary.
 *
 * Only declared keys are recorded: an unknown key is the schema validator's business, not
 * a coverage claim. A key present with a `~` value counts as covered — writing `rival: ~`
 * is exercising the key, and §6.4 makes the unbind a distinct thing worth exercising.
 */
function coveredPaths(value, schema) {
  const paths = new Set();

  const walk = (node, descriptor, path) => {
    if (!descriptor || typeof descriptor !== 'object') return;
    if (node === undefined) return;

    const types = typesOf(descriptor);

    if (isPlainObject(node) && types.includes(TYPES_MAP) && descriptor.keys) {
      for (const [key, child] of Object.entries(node)) {
        const declared = descriptor.keys[key];
        if (!declared) continue;
        const childPath = [...path, key];
        paths.add(childPath.join('.'));
        walk(child, declared, childPath);
      }
      return;
    }

    if (isPlainObject(node) && types.includes(TYPES_RECORD) && descriptor.of) {
      for (const child of Object.values(node)) walk(child, descriptor.of, [...path, RECORD_KEY]);
      return;
    }

    if (Array.isArray(node) && types.includes(TYPES_SEQ) && descriptor.of) {
      for (const child of node) walk(child, descriptor.of, [...path, SEQ_INDEX]);
    }
  };

  walk(value, schema, []);
  return paths;
}

/** Declared paths the document does not populate, sorted so a failure reads as a to-do list. */
function missingPaths(value, schema) {
  const covered = coveredPaths(value, schema);
  return [...declaredPaths(schema)].filter((p) => !covered.has(p)).sort();
}

/**
 * Every dotted path whose descriptor carries a `note` — the not-yet-implemented keys.
 *
 * The kitchen-sink fixtures assert that the WARNs a maximal valid document produces are
 * exactly these, so a phase that implements a key and forgets to drop its `note` fails
 * here rather than shipping a warning about a feature that works.
 */
function notedPaths(schema) {
  const paths = new Set();
  const stack = [];

  const walk = (descriptor, path) => {
    if (!descriptor || typeof descriptor !== 'object') return;
    if (stack.includes(descriptor)) return;
    stack.push(descriptor);

    if (descriptor.note && path.length) paths.add(path.join('.'));

    const types = typesOf(descriptor);
    if (types.includes(TYPES_MAP) && descriptor.keys) {
      for (const [key, child] of Object.entries(descriptor.keys)) walk(child, [...path, key]);
    }
    if (types.includes(TYPES_RECORD) && descriptor.of) walk(descriptor.of, [...path, RECORD_KEY]);
    if (types.includes(TYPES_SEQ) && descriptor.of) walk(descriptor.of, [...path, SEQ_INDEX]);

    stack.pop();
  };

  walk(schema, []);
  return paths;
}

module.exports = { declaredPaths, coveredPaths, missingPaths, notedPaths, RECORD_KEY, SEQ_INDEX };
