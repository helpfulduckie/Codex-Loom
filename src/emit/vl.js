'use strict';

/**
 * The Velvet Lattice emitter (v4 spec §8).
 *
 * Every VL-ism lives here and nowhere else: the `## Title` line, the `~~~` fence, the
 * three fence keys, trigger quoting, and the `encapsulate: false` that §8.4 makes
 * unconditional. v3 spread that knowledge across every template in every project, plus
 * three independent regex re-implementations in `lint.js`, `seedmap.js` and `util.js` —
 * which is why the §4.2 trigger fix would otherwise have had to land in every template
 * of every project rather than in one function.
 *
 * This module is pure: no `fs`, no `console`. It renders a string and collects
 * diagnostics, exactly as `model/` does (§3.3).
 *
 * ── What VL actually does with what we write ────────────────────────────────
 *
 * Read against `velvet_lattice/loader.py` and `types.py` rather than inferred, because
 * three of the rules below are only justified by what the consumer does:
 *
 *   1. The fence is parsed with `yaml.safe_load` — plain YAML, no custom syntax. PyYAML
 *      is **YAML 1.1**, where `no`, `yes`, `on` and `off` are booleans. An unquoted
 *      trigger `no` therefore reaches AID as the string "False", via `str(t)`. Quoting
 *      is decided against 1.1's resolver, not 1.2's.
 *   2. `triggers` is flattened with `",".join(...)` into AID's `keys` field. A comma
 *      inside a trigger is therefore **unrepresentable** — it silently becomes two
 *      triggers with nothing downstream able to tell. That is an ERROR here, at the only
 *      stage that can still see the difference.
 *   3. `notes` is typed `str` and assigned straight to AID's `description`. If we wrote
 *      it as a YAML mapping, VL would hand AID a Python dict where a string is declared.
 *      So `notes:` is always emitted as a **string** — a scalar, or a literal block
 *      scalar when it spans lines — never as nested keys. §4.5's mapping form is
 *      rendered to text before it reaches the fence.
 *
 * ── Quoting is minimal, and that is a review decision ───────────────────────
 *
 * A value is quoted only when a plain scalar would not survive the round trip. Quoting
 * everything would be simpler to write and much worse to review: it would rewrite all
 * 610 distinct trigger values in the fixture corpus, burying the handful that genuinely
 * change inside a diff nobody can read. Minimal quoting means the Phase 2 re-baseline
 * shows the values that were actually broken and nothing else.
 *
 * Quote style follows the same principle — single quotes unless the value contains one,
 * because that is what the v3 templates already emitted for `notes: '[e]'` and matching
 * it keeps those lines out of the diff entirely.
 */

const YAML = require('yaml');
const { CODES, Diagnostics } = require('../diag');

/** The fence delimiter. VL matches it anchored at line start (`loader.py:7`). */
const FENCE = '~~~';

/**
 * YAML 1.1 plain scalars that resolve to something other than a string.
 *
 * PyYAML's resolver, which is the one that reads what we write. The 1.2 core schema is
 * narrower — it would let `yes` through unquoted — so using it here would produce output
 * that is correct by the spec and wrong in practice.
 */
const YAML_11_NON_STRING = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|y|Y|n|N)$/;

/** Numbers, including the forms YAML 1.1 recognizes that JSON does not. */
const YAML_NUMERIC = /^[-+]?(?:0b[01_]+|0x[0-9a-fA-F_]+|0o?[0-7_]+|(?:\d[\d_]*)(?:\.[\d_]*)?(?:[eE][-+]?\d+)?|\.[\d_]+(?:[eE][-+]?\d+)?|\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

/** Characters that may not open a plain scalar. */
const YAML_INDICATORS = '-?:,[]{}#&*!|>\'"%@`';

/**
 * Decode §4.2's padding convention: a `_` at the first or last character is a space.
 *
 * Significant only at the edges — interior underscores are literal — and multiple edge
 * underscores map 1:1, so `__Aria` is two leading spaces. The convention exists only in
 * Codex Loom: VL never learns it, because this function runs before the value is
 * written and what VL reads is an ordinary quoted string.
 */
function decodeTriggerPadding(raw) {
  const text = String(raw);
  const lead = text.length - text.replace(/^_+/, '').length;
  const trail = text.length - text.replace(/_+$/, '').length;
  // An all-underscore value would have its run counted from both ends.
  if (lead + trail >= text.length) return ' '.repeat(text.length);
  const core = text.slice(lead, text.length - trail);
  return ' '.repeat(lead) + core + ' '.repeat(trail);
}

/**
 * Would this string survive as a plain (unquoted) YAML scalar?
 *
 * `flow` tightens the test for values written inside `[...]`, where `,`, `[`, `]`, `{`
 * and `}` terminate the scalar.
 */
function isPlainSafe(value, { flow }) {
  if (value === '') return false;
  if (value !== value.trim()) return false;              // padding would be stripped
  if (/[\n\r\t]/.test(value)) return false;
  if (YAML_INDICATORS.includes(value[0])) return false;
  if (value.includes(': ') || value.endsWith(':')) return false;
  if (value.includes(' #')) return false;
  if (YAML_11_NON_STRING.test(value)) return false;
  if (YAML_NUMERIC.test(value)) return false;
  if (flow && /[,[\]{}]/.test(value)) return false;
  return true;
}

/**
 * Write a string as YAML, quoting only when a plain scalar would not round-trip.
 *
 * Single quotes are preferred because they need no escaping for anything but themselves,
 * and because they are what v3 emitted — matching the existing bytes keeps unchanged
 * values out of the re-baseline diff.
 */
function writeScalar(value, { flow = false } = {}) {
  const text = String(value);
  if (isPlainSafe(text, { flow })) return text;
  if (!text.includes("'") && !/[\n\r\t]/.test(text)) return `'${text}'`;
  // JSON's escaping is a valid YAML double-quoted scalar for everything we emit.
  return JSON.stringify(text);
}

/**
 * The card's heading, which becomes AID's card name (`loader.py` splits on `^##\s+`).
 *
 * The ladder mirrors §7.4's template resolution: the most specific declaration wins and
 * `id` is the floor. Checked against the corpus before it was written — of 294 items
 * carrying a title or a name, `aid.title` and `name.full` never disagree, so this
 * reproduces what the v3 templates emitted rather than quietly renaming cards.
 */
function cardTitle(item) {
  const name = item && item.name;
  const candidates = [
    item && item.aid && item.aid.title,
    typeof name === 'string' ? name : name && name.full,
    name && name.display,
    item && item.id,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') {
      return String(candidate);
    }
  }
  return '';
}

/**
 * §4.5's default rendering of `notes:` when no `render.notesTemplate` is declared:
 * a scalar passes through verbatim, a mapping becomes `key: value` lines.
 *
 * The result is text, not structure — see the module header on why VL cannot receive a
 * mapping here.
 */
function defaultNotesText(notes) {
  if (notes === undefined || notes === null) return '';
  if (Array.isArray(notes)) return notes.map((entry) => String(entry)).join('\n');
  if (typeof notes === 'object') {
    return Object.entries(notes)
      .map(([key, value]) => `${key}: ${value === null || value === undefined ? '' : String(value)}`)
      .join('\n');
  }
  return String(notes);
}

/** Render the `notes:` fence line(s), or null when there is nothing to write. */
function notesLines(text) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.trim() === '') return null;
  if (!value.includes('\n')) return [`notes: ${writeScalar(value)}`];
  // A literal block scalar, chomped, so the string VL reads is exactly what we rendered.
  const body = value.replace(/\n+$/, '').split('\n').map((line) => `  ${line}`);
  return ['notes: |-', ...body];
}

/**
 * Render the `triggers:` fence line, decoding §4.2 padding and quoting minimally.
 *
 * Returns null when there are no triggers, which omits the key — an item may legitimately
 * have none (`kind: reference`, §4.8), and writing `triggers: []` would be noise.
 */
function triggerLine(item, diagnostics, loc) {
  const raw = item && item.aid && item.aid.triggers;
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) return null;

  const written = [];
  for (const entry of list) {
    const value = decodeTriggerPadding(entry);
    if (value.includes(',')) {
      diagnostics.error(
        CODES.TRIGGER_CONTAINS_COMMA,
        `Trigger ${JSON.stringify(value)} contains a comma.`,
        loc,
        {
          hint: 'Velvet Lattice joins triggers with commas into one AID keys string '
            + '(loader.py:72), so a comma inside a trigger becomes two triggers. Split it '
            + 'into separate entries, or remove the comma.',
        },
      );
    } else if (value.trim() === '') {
      diagnostics.warn(
        CODES.TRIGGER_EMPTY,
        'Trigger is empty and will reach AID as an empty key.',
        loc,
      );
    }
    written.push(writeScalar(value, { flow: true }));
  }
  return `triggers: [${written.join(', ')}]`;
}

/**
 * Render one story card: the envelope, plus the body text a template produced.
 *
 * `bodyText` arrives already wrapped. §8.4 applies `render.wrapper` compile-side, so the
 * emitted `.md` is exactly what AID receives with no upload-time transformation to
 * reverse-engineer — which is also what lets Phase 5 measure platform limits here,
 * against the final string.
 *
 * @param {object}      args.item          the resolved item
 * @param {string}      args.bodyText      rendered, wrapped body
 * @param {string}      [args.notesText]   pre-rendered notes; defaults to §4.5's rule
 * @param {Diagnostics} [args.diagnostics] collector; one is created if omitted
 * @param {object}      [args.loc]         `{ file, line, col }` for diagnostics
 * @returns {{ text: string, diagnostics: Diagnostics }}
 */
function renderCard({ item, bodyText = '', notesText, diagnostics, loc = {} }) {
  const diags = diagnostics || new Diagnostics();
  const lines = [`## ${cardTitle(item)}`, FENCE];

  const triggers = triggerLine(item, diags, loc);
  if (triggers) lines.push(triggers);

  // §8.4: unconditional, because all four sites in the VL source default it to true.
  lines.push('encapsulate: false');

  const notes = notesLines(
    notesText !== undefined
      ? notesText
      : defaultNotesText(item && (item.notes !== undefined ? item.notes : item.description)),
  );
  if (notes) lines.push(...notes);

  lines.push(FENCE);
  const body = String(bodyText === undefined || bodyText === null ? '' : bodyText);
  return { text: `${lines.join('\n')}\n${body}`, diagnostics: diags };
}

/**
 * A fence block, anchored at line start exactly as VL anchors it (`loader.py:7`).
 *
 * Built fresh on each call rather than shared: a `g` regex carries `lastIndex` between
 * uses, and the three consumers of this module run over the same text in sequence.
 */
function fenceBlockRe({ global = false } = {}) {
  return new RegExp('^~~~[ \\t]*$[\\s\\S]*?^~~~[ \\t]*$', global ? 'gm' : 'm');
}

/**
 * Blank the contents of every fence, preserving newlines so line numbers stay aligned.
 *
 * `lint.js` needs this because a single-word trigger (`triggers: [door]`) has the same
 * shape as a mistyped verb-conjugation marker, and the heuristic that hunts for those
 * must never see the fence. It lives here rather than in `util.js` for the reason §8.6
 * gives: what counts as a fence is the emitter's business, and a second definition of it
 * elsewhere is exactly the drift this module exists to end.
 */
function maskFences(text) {
  if (typeof text !== 'string') return text;
  return text.replace(fenceBlockRe({ global: true }), (block) => block.replace(/[^\n]/g, ' '));
}

/**
 * Parse a compiled story-card file back into the structured model.
 *
 * §8.6 names this the contract to preserve: reports and convention packs consume the
 * parsed model rather than the file format, so replacing VL later means satisfying this
 * shape rather than rewriting every consumer. It deliberately mirrors `loader.py` —
 * same fence regex, same header split, same YAML version — so what a report sees is what
 * AID will get.
 *
 * `type` is not recoverable from the text: VL takes it from the containing directory
 * name (`f.parent.name`), so callers that know the directory pass it in.
 *
 * @returns {Array<{title, type, triggers: string[], notes: string, body: string, meta: object}>}
 */
function parseCards(markdown, { type = null, fallbackTitle = null } = {}) {
  const text = String(markdown === undefined || markdown === null ? '' : markdown);
  const sections = [];

  const headerRe = /^##[ \t]+(.*)$/gm;
  let match;
  const heads = [];
  while ((match = headerRe.exec(text)) !== null) {
    heads.push({ title: match[1].trim(), start: match.index, bodyStart: headerRe.lastIndex });
  }

  if (heads.length === 0) {
    // VL's headerless path: the whole file is one card named for the file stem.
    if (text.trim() === '') return [];
    sections.push({ title: fallbackTitle, body: text });
  } else {
    heads.forEach((head, index) => {
      const end = index + 1 < heads.length ? heads[index + 1].start : text.length;
      sections.push({ title: head.title, body: text.slice(head.bodyStart, end) });
    });
  }

  return sections.map((section) => {
    const fence = fenceBlockRe().exec(section.body);
    let meta = {};
    let body = section.body;

    if (fence) {
      // Strip the delimiter lines to get the YAML the fence carries.
      const inner = fence[0].replace(/^~~~[ \t]*\r?\n?/, '').replace(/\r?\n?~~~[ \t]*$/, '');
      try {
        // YAML 1.1 to match PyYAML: `no` is a boolean to VL, so it must be one here too.
        meta = YAML.parse(inner, { version: '1.1' }) || {};
      } catch (err) {
        meta = {};
      }
      body = section.body.replace(fence[0], '');
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};

    const rawTriggers = meta.triggers;
    const triggers = rawTriggers === undefined || rawTriggers === null
      ? []
      : (Array.isArray(rawTriggers) ? rawTriggers : [rawTriggers]).map((t) => String(t));

    return {
      title: section.title,
      type,
      // Whether a fence was present at all. `meta` cannot answer this — an absent fence
      // and an empty one both parse to `{}` — and consumers do distinguish them: a
      // headed section with no fence is prose, not a malformed card.
      hasFence: Boolean(fence),
      triggers,
      notes: meta.notes === undefined || meta.notes === null ? '' : String(meta.notes),
      body: body.trim(),
      meta,
    };
  });
}

module.exports = {
  renderCard,
  parseCards,
  maskFences,
  cardTitle,
  decodeTriggerPadding,
  defaultNotesText,
  writeScalar,
  FENCE,
};
