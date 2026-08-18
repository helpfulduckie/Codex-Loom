'use strict';

/**
 * `Placeholders.yaml` generation (§12.2).
 *
 * Velvet Lattice reads one flat `key: question` mapping per scenario node and merges it
 * down the tree with `{**parent, **local}` — per key, not per file. So each node emits
 * only what it *adds*, and VL's own inheritance carries the rest: output stays minimal and
 * a branch's file diffs against that branch's declarations rather than against the whole
 * accumulated table.
 *
 * ## Why the questions are expanded here
 *
 * AID supports nested placeholders — `${What is ${Your friend's name?} like?}` prompts
 * twice, the outer question showing the inner answer. Velvet Lattice produces that shape
 * only *by accident*. `process_placeholders` is a single pass, one `text.replace()` per
 * declared key in mapping order, and it never re-runs over question values; nesting works
 * only because substituting the outer key drops its question into the text, where the
 * inner key's `%name%` is still waiting for a loop iteration that has not happened yet.
 * Declare the inner key first and the loop passes it before it exists in the text, so a
 * literal `%name%` ships to the AI. VL's warning scan runs pre-substitution and never
 * sees it.
 *
 * That trap is not reachable by ordering alone: VL merges parent keys ahead of local ones,
 * so declaring the shared inner question at the root and the branch-specific outer question
 * on a branch — the layout this module's own minimality encourages — is exactly the broken
 * order, and no amount of sorting within one file can fix a dependency that crosses nodes.
 *
 * So nesting resolves here, at compile time, and what VL receives is already fully nested.
 * Its single pass then produces the right output regardless of key order or which node
 * declared what. That also keeps compiled output independent of mapping order, which is
 * what §7.4 spends its ordering rules on everywhere else.
 *
 * ## Why `~` emits nothing
 *
 * VL has no way to *remove* an inherited key — a child file can only add or override — so
 * an unbind is unrepresentable downstream and is a compile-time concept only. It costs
 * nothing: a placeholder VL still inherits but no text on that branch references produces
 * no `${...}` in the output, and therefore no prompt. What the unbind actually buys is the
 * §12.3 check — `%x%` on a branch that unbound `x` is an undeclared reference, and that
 * question is answered here rather than downstream.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { CODES } = require('../diag');
const { resolveVariables } = require('../util');

/** VL's own pattern, so detection cannot drift from what it will substitute. */
const PLACEHOLDER_RE = /%(\w+)%/g;

const FILENAME = 'Placeholders.yaml';

/**
 * Expand one table's question text: `{%vars}` first, then nested `%key%` references.
 *
 * Returns a new table; the input is not mutated. Every key in `table` is expanded, because
 * a node's local question may nest a key it inherited and the emitted value has to carry
 * the inherited question inline.
 *
 * A reference to an undeclared key is left as written rather than reported here. §12.3's
 * check 1 owns that diagnostic and owns it at every write point, so raising it a second
 * time in this module would double-report the one case it can see and stay silent on the
 * many it cannot.
 *
 * Cycles are the one case that reports. A key in a loop, or a key that can reach one, is
 * left exactly as written and its `%key%` references survive into the emitted file — which
 * looks worse than a partial expansion and is better, because a partially expanded question
 * reads as an intentional nest while carrying a literal `%key%` inside it.
 */
function expandQuestions(table, variables, { onWarn, file } = {}) {
  const keys = Object.keys(table).filter((k) => table[k] !== null && table[k] !== undefined);

  // `{%vars}` first and once. Every later step reads these strings, so a variable that
  // expands *into* a `%key%` reference is picked up by the dependency graph below rather
  // than being missed by it.
  const base = {};
  for (const key of keys) base[key] = resolveVariables(String(table[key]), variables || {});

  const refsOf = (text) => {
    const out = [];
    String(text).replace(PLACEHOLDER_RE, (match, name) => {
      if (Object.prototype.hasOwnProperty.call(base, name)) out.push(name);
      return match;
    });
    return out;
  };

  // Cycles are found before anything expands, rather than during. Detecting them on the
  // way *out* of a recursion leaves the keys above the loop half-expanded — a question
  // that reads as an intentional nest and carries a literal `%key%` inside it, which is
  // the exact noise §12.3's undeclared check exists to keep out of the upload. So the
  // whole tainted set is left as written and the ERROR is the only thing to act on.
  const state = new Map(); // key → 'visiting' | 'done'
  const tainted = new Set();
  const reported = new Set();

  const findCycles = (key, trail) => {
    if (state.get(key) === 'visiting') {
      const loop = trail.slice(trail.indexOf(key)).concat(key);
      for (const k of loop) tainted.add(k);
      const signature = [...new Set(loop)].sort().join(' ');
      if (!reported.has(signature) && onWarn) {
        reported.add(signature);
        onWarn(
          CODES.PLACEHOLDER_CYCLE,
          `placeholders form a reference cycle: ${loop.join(' → ')}. A question cannot `
          + 'contain itself, directly or through other questions.',
          file,
        );
      }
      return;
    }
    if (state.get(key) === 'done') return;

    state.set(key, 'visiting');
    for (const ref of refsOf(base[key])) findCycles(ref, [...trail, key]);
    state.set(key, 'done');
  };
  for (const key of keys) findCycles(key, []);

  // A key that merely *reaches* a cycle is tainted too. Expanding it would inline a
  // tainted question, putting the literal `%key%` one level further from the ERROR that
  // explains it.
  let grew = true;
  while (grew) {
    grew = false;
    for (const key of keys) {
      if (tainted.has(key)) continue;
      if (refsOf(base[key]).some((ref) => tainted.has(ref))) {
        tainted.add(key);
        grew = true;
      }
    }
  }

  // What remains is acyclic, so plain memoized substitution terminates.
  const expanded = {};
  const expand = (key) => {
    if (Object.prototype.hasOwnProperty.call(expanded, key)) return expanded[key];
    if (tainted.has(key)) {
      expanded[key] = base[key];
      return expanded[key];
    }
    const text = base[key].replace(PLACEHOLDER_RE, (match, name) => (
      Object.prototype.hasOwnProperty.call(base, name) ? `\${${expand(name)}}` : match
    ));
    expanded[key] = text;
    return text;
  };
  for (const key of keys) expand(key);

  return expanded;
}

/**
 * §12.3 check 1: every `%x%` reaching compiled output must be declared.
 *
 * Velvet Lattice substitutes only the keys its merged table holds; anything else survives
 * its single pass untouched and is uploaded to AID as the literal text `%x%`, where it
 * reads to the model as noise in the middle of a sentence. Nothing downstream reports it —
 * VL's own warning scan is about *context*, not declaration, and fires on keys that are
 * perfectly fine.
 *
 * Reported once per key per site. A name repeated four times in one card body is one
 * mistake, and four copies of the message would bury the other three sites.
 *
 * `skip` suppresses names a caller has already reported against a *finer* location in
 * the same output file. An occupant's body is scanned per placement, where the item and
 * the slot are both known, and then again inside the assembled component — which is the
 * same bytes described worse. The assembled scan still runs, because a section's own
 * `text:` reaches the file without passing through any item, and nothing else would see
 * it. A story card is *not* skipped: an item routed into both a card and a component
 * ships the literal text into two different files, and each is separately wrong.
 *
 * `where` names the thing an author can go and edit — an item, a component, a branch
 * label — because by the time text reaches a write point the file it came from may be a
 * template, a component document, or `compile.cl.yaml`, and the path alone rarely locates
 * the `%x%`.
 */
function checkUndeclaredPlaceholders(text, table, { diagnostics, file, where, branch, skip } = {}) {
  if (!text || !diagnostics) return [];

  const declared = table || {};
  const seen = new Set();
  const undeclared = [];
  String(text).replace(PLACEHOLDER_RE, (match, name) => {
    if (skip && skip.has(name)) return match;
    if (Object.prototype.hasOwnProperty.call(declared, name) || seen.has(name)) return match;
    seen.add(name);
    undeclared.push(name);
    return match;
  });
  if (undeclared.length === 0) return [];

  const known = Object.keys(declared);
  // The declared list is the actionable half: an undeclared key is usually a typo of a
  // real one, and a `%heroname%` against a declared `heroName` is invisible until the two
  // are printed together.
  const hint = known.length
    ? `Declared on this branch: ${known.join(', ')}.`
    : 'No placeholders are declared on this branch.';

  for (const name of undeclared) {
    diagnostics.error(
      CODES.PLACEHOLDER_UNDECLARED,
      `undeclared placeholder "%${name}%" in ${where}${branch ? ` on branch "${branch}"` : ''}`
      + ' — Velvet Lattice substitutes only declared keys, so this reaches the AI as the'
      + ` literal text "%${name}%".`,
      { file: file == null ? undefined : String(file) },
      { hint },
    );
  }
  return undeclared;
}

/**
 * The keys a node contributes: its own declarations, minus unbinds.
 *
 * `~` is filtered rather than emitted as null, because a null value in the YAML would read
 * back as a placeholder whose question is empty, and VL would substitute `${}` for it.
 */
function localKeysOf(node) {
  const local = node && node.placeholders;
  if (!local || typeof local !== 'object') return [];
  return Object.keys(local).filter((k) => local[k] !== null && local[k] !== undefined);
}

/**
 * Write one node's `Placeholders.yaml`, or remove a stale one when the node adds nothing.
 *
 * Removing matters more than writing. A node that used to declare placeholders and no
 * longer does would otherwise keep an orphan file that VL still reads and still inherits
 * down the subtree, so the declaration would outlive its deletion from the source.
 */
function writeNodePlaceholders(nodeDir, node, mergedTable, variables, { onWarn, file, diagnostics } = {}) {
  const keys = localKeysOf(node);
  const outPath = path.join(nodeDir, FILENAME);

  if (keys.length === 0) {
    if (fs.existsSync(outPath)) fs.rmSync(outPath);
    return null;
  }

  // Expanded against the *merged* table: a local question may nest a key declared at an
  // ancestor, and the emitted value has to carry that ancestor's question inline because
  // VL will not resolve the reference itself.
  const expanded = expandQuestions(mergedTable, variables, { onWarn, file });

  const emitted = {};
  for (const key of keys) {
    if (expanded[key] !== undefined && expanded[key] !== null) emitted[key] = expanded[key];
  }
  if (Object.keys(emitted).length === 0) {
    if (fs.existsSync(outPath)) fs.rmSync(outPath);
    return null;
  }

  // A `%x%` surviving expansion is unambiguously undeclared: every declared key was
  // available to substitute and did not match. Cyclic keys keep their own references, but
  // those name declared keys and so are not reported here — the cycle ERROR covers them.
  for (const [key, question] of Object.entries(emitted)) {
    checkUndeclaredPlaceholders(question, mergedTable, {
      diagnostics, file, where: `the question text for placeholder "${key}"`,
    });
  }

  fs.mkdirSync(nodeDir, { recursive: true });
  fs.writeFileSync(outPath, YAML.stringify(emitted), 'utf8');
  return outPath;
}

module.exports = {
  FILENAME,
  PLACEHOLDER_RE,
  checkUndeclaredPlaceholders,
  expandQuestions,
  localKeysOf,
  writeNodePlaceholders,
};
