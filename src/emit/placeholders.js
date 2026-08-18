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
 * Find AID's native `${...}` form, counting a nested placeholder as one occurrence.
 *
 * Brace-balanced rather than a regex, because `${What is ${Their name?} like?}` is one
 * placeholder and a non-greedy `\\$\\{[^}]*}` reads it as one truncated match plus a stray
 * tail. Nesting is a documented AID feature and Codex Loom emits it (§12.2), so the
 * matcher has to survive its own output.
 */
function findNativePlaceholders(text) {
  const found = [];
  const s = String(text || '');
  for (let i = 0; i < s.length - 1; i += 1) {
    if (s[i] !== '$' || s[i + 1] !== '{') continue;
    let depth = 0;
    let j = i;
    for (; j < s.length; j += 1) {
      if (s[j] === '{') depth += 1;
      else if (s[j] === '}') {
        depth -= 1;
        if (depth === 0) { j += 1; break; }
      }
    }
    found.push(s.slice(i, j));
    i = j - 1;
  }
  return found;
}

/**
 * Every placeholder in a text, in either spelling.
 *
 * The context check needs both, and the undeclared check needs only `%key%` — because a
 * native `${...}` carries its question inline and has nothing to be declared. Where a
 * placeholder may not go, however, it may not go in either spelling.
 */
function findAllPlaceholders(text) {
  const found = [];
  String(text || '').replace(PLACEHOLDER_RE, (match) => { found.push(match); return match; });
  return found.concat(findNativePlaceholders(text));
}

/**
 * §12.3 check 3, rescoped against AID's real rules rather than Velvet Lattice's warnings.
 *
 * VL warns on Label, Description/Prompt, AI Instructions and Summary. Two of those are
 * stale: AID's own documentation added AI Instructions and Story Summary in March 2026,
 * and placeholders work in every component and in a story card's entry, name, triggers
 * and notes. Adopting VL's list would make Codex Loom stricter than the tool it compiles
 * for, on rules that no longer exist.
 *
 * What is left is two destinations where a placeholder does not function at all — the
 * scenario Description, and a story card's `type` — and two titles where what happens is
 * not what an author writing one would expect. A branch title half-works: the prompt
 * fills, the player sees the answer while choosing, and the saved adventure keeps the raw
 * text. A scenario title does not fill at all. Both are WARNs, because both are legal to
 * write and a deliberate one is imaginable.
 *
 * The check is per *placement*, not per file: §7.10 lets an item route into any
 * component, so the same item body is legal in one destination and not another, on a
 * per-branch basis. Only the caller knows where the text landed.
 */
function checkPlaceholderContext(text, { diagnostics, file, where, branch, severity = 'error', reason } = {}) {
  if (!text || !diagnostics) return [];
  const found = findAllPlaceholders(text);
  if (found.length === 0) return [];

  const unique = [...new Set(found)];
  for (const occurrence of unique) {
    diagnostics[severity === 'warn' ? 'warn' : 'error'](
      severity === 'warn' ? CODES.PLACEHOLDER_IN_TITLE : CODES.PLACEHOLDER_INVALID_CONTEXT,
      `placeholder "${occurrence}" in ${where}${branch ? ` on branch "${branch}"` : ''} — ${reason}`,
      { file: file == null ? undefined : String(file) },
    );
  }
  return unique;
}

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
 * `usage` records every *declared* key this text referenced, keyed by the branch path the
 * text was written for. §12.3's declared-but-unused check reads it. Collected here rather
 * than by a separate scan because this function already visits every `%key%` at every write
 * point, and a second scanner would be a second list of destinations to keep in step — the
 * exact drift that made check 1 worth centralizing.
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
function checkUndeclaredPlaceholders(text, table, { diagnostics, file, where, branch, skip, usage, usagePath } = {}) {
  if (!text || !diagnostics) return [];

  const declared = table || {};
  const seen = new Set();
  const undeclared = [];
  String(text).replace(PLACEHOLDER_RE, (match, name) => {
    // Usage is recorded before `skip`, and for declared names only. A name the caller has
    // already reported elsewhere was still *used* here, and suppressing the second report
    // must not also suppress the fact.
    if (Object.prototype.hasOwnProperty.call(declared, name)) {
      recordUsage(usage, name, usagePath);
      return match;
    }
    if (skip && skip.has(name)) return match;
    if (seen.has(name)) return match;
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
 * Note that `name` was referenced by text written for `usagePath`.
 *
 * The path is the branch path as a `/`-joined string, with the empty string for text that
 * belongs to the project rather than to any branch — the Description, the scenario title.
 * §12.3's check is subtree-scoped, so the path is what makes "declared at the root and used
 * on one branch of three" distinguishable from "declared on a branch and used on its
 * sibling".
 */
function recordUsage(usage, name, usagePath) {
  if (!usage) return;
  if (!usage.has(name)) usage.set(name, new Set());
  usage.get(name).add(usagePath || '');
}

/**
 * §12.3 check 2: a placeholder declared and never referenced beneath its declaring node.
 *
 * The player is asked a question and the answer goes nowhere — which is a wasted prompt on
 * a budget AID's own guidance puts at about ten before players start abandoning scenarios.
 *
 * **Subtree-scoped, and the scope is the whole check.** A root-level placeholder used on
 * one branch of three is normal and correct, so an unscoped version would fire constantly
 * on well-formed projects (§6.4). The signal is only in the subtree where the declaration
 * is actually in effect: declared at the root and used nowhere at all, or declared on a
 * branch and used nowhere beneath it.
 *
 * A reference inside another placeholder's question counts as use. The nesting is expanded
 * into the emitted file (§12.2), so the inner question does reach the player — through the
 * outer prompt rather than on its own.
 *
 * WARN, and an opinion rather than a fact: an author mid-draft may declare a question
 * before writing the text that uses it, and that is not a broken build.
 */
function reportUnusedPlaceholders(declarations, usage, { diagnostics, file } = {}) {
  if (!diagnostics) return [];
  const unused = [];

  for (const { path: declPath, label, keys } of declarations) {
    for (const key of keys) {
      const paths = usage.get(key);
      const usedInSubtree = paths && [...paths].some((used) => (
        declPath === '' || used === declPath || used.startsWith(`${declPath}/`)
      ));
      if (usedInSubtree) continue;

      unused.push(key);
      diagnostics.warn(
        CODES.PLACEHOLDER_UNUSED,
        `placeholder "${key}" is declared ${label} but no text beneath it references `
        + `"%${key}%" — the player is asked the question and the answer goes nowhere.`,
        { file: file == null ? undefined : String(file) },
        {
          hint: declPath === ''
            ? 'Declared at the project root, so this counts every branch.'
            : `Scoped to "${declPath}" and everything under it; a sibling branch using it `
              + 'does not count, because the declaration does not reach there.',
        },
      );
    }
  }
  return unused;
}

/**
 * §12.3 check 4: two keys asking the player the same question.
 *
 * **This reads declarations and never use sites.** Two *keys* declaring one question string
 * is the finding; one key referenced from twenty places is the feature working as intended
 * and draws nothing.
 *
 * AID collapses identical question strings into a single prompt, so two such keys are asked
 * once and both receive that one answer. An author who believed they had two independently
 * answerable fields has one, and nothing in the source says so — which is why the message
 * states the consequence rather than the rule.
 *
 * Compared on the *expanded* question, because two keys can differ in source and agree once
 * `{%variables}` and nesting resolve (§12.2). What AID sees is the expanded form, so that is
 * what has to match for the collapse to happen.
 *
 * Collected per node against the merged table — which is the set of keys visible together,
 * and therefore the set that can collide — then reported once per distinct pair, since a
 * duplicate declared at the root is otherwise re-found at every node beneath it.
 */
function collectDuplicateQuestions(expandedTable, duplicates, where) {
  if (!duplicates) return;

  const byQuestion = new Map();
  for (const [key, question] of Object.entries(expandedTable)) {
    if (question == null) continue;
    const normalized = String(question).trim();
    if (!normalized) continue;
    if (!byQuestion.has(normalized)) byQuestion.set(normalized, []);
    byQuestion.get(normalized).push(key);
  }

  for (const [question, keys] of byQuestion) {
    if (keys.length < 2) continue;
    const signature = `${[...keys].sort().join('\u0000')}\u0000${question}`;
    if (duplicates.has(signature)) continue;
    duplicates.set(signature, { keys: [...keys].sort(), question, where });
  }
}

/** Report what `collectDuplicateQuestions` gathered, once per distinct pair. */
function reportDuplicateQuestions(duplicates, { diagnostics, file } = {}) {
  if (!diagnostics || !duplicates) return [];
  for (const { keys, question } of duplicates.values()) {
    diagnostics.warn(
      CODES.PLACEHOLDER_DUPLICATE_QUESTION,
      `placeholders ${keys.map((k) => `"${k}"`).join(' and ')} ask the same question `
      + `("${question}"). AID treats identical question text as one placeholder, so the `
      + 'player is prompted once and every one of these keys receives that single answer.',
      { file: file == null ? undefined : String(file) },
      {
        hint: 'If they are meant to be answered separately, give them different question '
          + 'text. If they are meant to share an answer, one key does it with no duplicate '
          + 'prompt to explain.',
      },
    );
  }
  return [...duplicates.values()];
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
function writeNodePlaceholders(nodeDir, node, mergedTable, variables, { onWarn, file, diagnostics, usage, usagePath, duplicates } = {}) {
  const keys = localKeysOf(node);
  const outPath = path.join(nodeDir, FILENAME);

  if (keys.length === 0) {
    if (fs.existsSync(outPath)) fs.rmSync(outPath);
    return null;
  }

  // Usage is read off the *raw* questions, before expansion, and this ordering is the whole
  // of it: expansion replaces `%liName%` with the inner question text, so by the time the
  // emitted value exists the reference that proves the key was used has been substituted
  // away. Scanning the expanded form would report every nested-only placeholder as unused.
  //
  // Local declarations only. An inherited question referencing another key was already
  // recorded at the node that declared it, and counting it again here would credit the use
  // to a subtree that did not write it.
  if (usage) {
    const local = (node && node.placeholders) || {};
    for (const key of keys) {
      String(local[key] == null ? '' : local[key]).replace(PLACEHOLDER_RE, (match, name) => {
        if (Object.prototype.hasOwnProperty.call(mergedTable, name)) {
          recordUsage(usage, name, usagePath);
        }
        return match;
      });
    }
  }

  // Expanded against the *merged* table: a local question may nest a key declared at an
  // ancestor, and the emitted value has to carry that ancestor's question inline because
  // VL will not resolve the reference itself.
  const expanded = expandQuestions(mergedTable, variables, { onWarn, file });

  // Against the merged table rather than the emitted subset: a branch key colliding with an
  // inherited one is the interesting case, and the inherited key is not in what this node
  // writes.
  collectDuplicateQuestions(expanded, duplicates, usagePath || '');

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
  checkPlaceholderContext,
  reportUnusedPlaceholders,
  collectDuplicateQuestions,
  reportDuplicateQuestions,
  findAllPlaceholders,
  findNativePlaceholders,
  expandQuestions,
  localKeysOf,
  writeNodePlaceholders,
};
