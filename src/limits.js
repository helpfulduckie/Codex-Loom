'use strict';

/**
 * AID's platform field caps (v4 spec §8.5).
 *
 * AID truncates rather than refusing: a card over the cap does not fail to upload, it
 * arrives shortened, and the author finds out during play rather than during authoring.
 * The compiler is the right place to catch that because it is the only stage holding the
 * final string — after templates, after §8.4's wrapping, and with the placeholder table
 * in hand.
 *
 * ## Why the measurement is not `text.length`
 *
 * **Velvet Lattice substitutes placeholders on the way to AID, and they grow.**
 * `utils.py`'s `process_placeholders` replaces every `%key%` with `${question}`, so a
 * 10-character `%heroName%` becomes a 32-character `${What is your character's name?}`.
 * The stored value is the substituted one. A check against the rendered length therefore
 * passes content that overflows after upload — the exact failure §8.5 names, and the
 * reason platform limits could not ship before placeholders (§15).
 *
 * Codex Loom is uniquely able to get this right: it holds both the rendered text and the
 * placeholder table at the same moment, so the post-substitution length is computable
 * rather than estimable. `expandPlaceholders` below performs VL's substitution rather than
 * doing the arithmetic, so the two cannot drift — it is the same single pass over the same
 * declared keys, and an undeclared `%key%` is left alone by both (that is CL0532's to
 * report, not this module's).
 *
 * ## What each cap measures
 *
 * Read against `velvet_lattice/loader.py` and `types.py` rather than assumed, because both
 * measure less than the file they live in:
 *
 *   - **A card body** is VL's `entry` — the section with its `~~~` fence removed and
 *     stripped (`loader.py:60`) — assigned to AID's `value` through `get_final_entry()`.
 *     Codex Loom always emits `encapsulate: false`, so no braces are added downstream and
 *     `value` is exactly the trimmed body. The `## Title` line, the fence and `notes:` are
 *     outside the cap.
 *   - **An `Opening.md`** is capped per file, not per branch chain. `scenario.py:30`
 *     merges components as `{**parent, **local}` keyed by *filename*, so a leaf's opening
 *     replaces an ancestor's rather than extending it. §8.5's "including `branchFraming`"
 *     means the framing file is subject to the same cap, not that framing adds to a leaf's
 *     total.
 *
 * ## Why a WARN band exists
 *
 * A hard failure at the cap with no prior signal means finding out when the card is
 * already too big to trim comfortably. The band is 90% of each cap and is a soft heuristic
 * in every sense except one: §4.8 puts hard limits on `kind: reference` items too, and the
 * band is part of the same fact. A card the platform will truncate is malformed whatever
 * the card exists for.
 *
 * Pure by contract (§3.3): no `fs`, no `console`. It measures and reports; callers decide
 * where the text came from.
 */

const { CODES } = require('./diag');

/**
 * The confirmed caps. Only these two — §8.5 lists no guessed limits, and adding one when
 * it is confirmed is a row here plus a call site, not a redesign.
 *
 * `warnAt` is 90% of `cap` in both rows, written out rather than computed so the table
 * reads as data and a future cap with a different band needs no new mechanism.
 */
const LIMITS = Object.freeze({
  cardBody: Object.freeze({
    cap: 2000,
    warnAt: 1800,
    subject: 'Story card body',
    over: CODES.CARD_BODY_OVER_LIMIT,
    near: CODES.CARD_BODY_NEAR_LIMIT,
  }),
  opening: Object.freeze({
    cap: 4000,
    warnAt: 3600,
    subject: 'Opening',
    over: CODES.OPENING_OVER_LIMIT,
    near: CODES.OPENING_NEAR_LIMIT,
  }),
});

/** VL's own pattern, so what we count cannot drift from what it will substitute. */
const PLACEHOLDER_RE = /%(\w+)%/g;

/**
 * Perform Velvet Lattice's placeholder substitution.
 *
 * `utils.py:22` is one `text.replace()` per declared key in mapping order, with no
 * re-substitution pass — and this mirrors it exactly rather than approximating it with
 * arithmetic. `questions` must be the table as VL will hold it: merged down the branch
 * chain, with nested questions already expanded (`emit/placeholders.js` does that
 * expansion, because VL only nests correctly by declaration-order accident).
 *
 * A `%key%` with no declared question is left as written, which is what VL does and what
 * AID would then receive verbatim. It is CL0532's job to report that, not this module's —
 * measuring it as zero-growth is the honest reading of what would ship.
 */
function expandPlaceholders(text, questions) {
  let out = String(text === undefined || text === null ? '' : text);
  if (!questions) return out;
  for (const [key, question] of Object.entries(questions)) {
    if (question === null || question === undefined) continue;
    out = out.split(`%${key}%`).join(`\${${question}}`);
  }
  return out;
}

/**
 * Measure a string as AID will store it.
 *
 * Returns rendered and expanded lengths separately because the diagnostic shows both when
 * they differ: "4,118 on upload; 3,902 compiled" tells an author where to cut in a way that
 * either number alone does not.
 *
 * The keys keep this codebase's word — `rendered` is what Codex Loom emitted, the same sense
 * `compile.js`'s `rendered` and `emit/vl.js`'s "rendered, wrapped body" carry. Author-facing
 * text says **compiled** and **on upload** instead, because a report reader does not have
 * that vocabulary and "rendered" reads to them as what AID displays — which is a third
 * length, after the player answers the prompt, that no cap applies to.
 *
 * `refs` counts only *declared* references, since those are the ones that grow. It is what
 * lets the message say "the 6 placeholder references add 216 characters" rather than
 * leaving the author to work out where the difference came from.
 */
function measure(text, questions) {
  const rendered = String(text === undefined || text === null ? '' : text).trim();
  const expanded = expandPlaceholders(rendered, questions).trim();

  let refs = 0;
  if (questions) {
    rendered.replace(PLACEHOLDER_RE, (match, key) => {
      if (Object.prototype.hasOwnProperty.call(questions, key)
        && questions[key] !== null && questions[key] !== undefined) refs += 1;
      return match;
    });
  }

  return {
    rendered: rendered.length,
    expanded: expanded.length,
    added: expanded.length - rendered.length,
    refs,
  };
}

/** Thousands separators, because these numbers are read against a four-digit cap. */
const n = (value) => Number(value).toLocaleString('en-US');

/**
 * Check one string against one cap, reporting at most one diagnostic.
 *
 * At most one, deliberately: a body over the cap is also over the band, and reporting both
 * would say the same thing twice at two severities. The cap wins.
 *
 * Returns the measurement either way, so a caller that wants the numbers for a report does
 * not measure twice.
 */
function checkLimit(text, questions, limit, { diagnostics, loc = {}, label = null } = {}) {
  const result = measure(text, questions);
  if (!diagnostics) return result;

  const subject = label ? `${limit.subject} for ${label}` : limit.subject;
  const detail = result.added > 0
    ? `\nCompiled length is ${n(result.rendered)}; ${result.refs} placeholder `
      + `${result.refs === 1 ? 'reference adds' : 'references add'} ${n(result.added)} `
      + 'characters when Velvet Lattice expands them to their question text on upload.'
    : '';

  if (result.expanded > limit.cap) {
    diagnostics.error(
      limit.over,
      `${subject} is ${n(result.expanded)} characters on upload `
      + `(limit ${n(limit.cap)}).${detail}`,
      loc,
      {
        hint: 'AID truncates rather than refusing, so this ships shortened and the loss '
          + 'shows up during play.',
      },
    );
  } else if (result.expanded >= limit.warnAt) {
    diagnostics.warn(
      limit.near,
      `${subject} is ${n(result.expanded)} characters on upload, `
      + `within ${n(limit.cap - result.expanded)} of the ${n(limit.cap)} limit.${detail}`,
      loc,
    );
  }

  return result;
}

module.exports = { LIMITS, expandPlaceholders, measure, checkLimit };
