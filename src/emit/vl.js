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
const { LIMITS, checkLimit } = require('../limits');

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

/**
 * Recover the mapping form of a `notes:` block from the flat string `parseCards` returns.
 *
 * The inverse of `defaultNotesText`: mod config is authored as YAML key/value lines and
 * emitted verbatim inside a `|-` block (§4.5), so a re-parse gets the structure back. A
 * convention pack (§8.2.2) keyed on `hasKey` runs against this. Anything that is not a
 * mapping — a scalar like `'[e]'`, a bare sentence of prose, a parse failure — returns
 * `{}`, which the predicate layer reads as "carries no config."
 *
 * A uniform Markdown blockquote prefix is stripped first: WTG's "Configure WTG" settings
 * card is authored as `> Setting Name: value`, one per line, and its README makes the
 * `> ` mandatory. A `>`-led line is a YAML folded scalar, so without this the whole
 * block parses to a string and a pack's `schema:` check silently no-ops. The strip only
 * fires when *every* non-blank line carries the marker — a partial match is real YAML
 * and is left alone.
 */
function parseNotesBlock(notesString) {
  const text = stripBlockquote(
    String(notesString === undefined || notesString === null ? '' : notesString),
  );
  if (text.trim() === '') return {};
  let parsed;
  try {
    // YAML 1.1 to match `parseCards` and PyYAML — the same resolver that read the fence.
    parsed = YAML.parse(text, { version: '1.1' });
  } catch (err) {
    return {};
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function stripBlockquote(text) {
  const lines = text.split('\n');
  const nonBlank = lines.filter((line) => line.trim() !== '');
  if (nonBlank.length === 0 || !nonBlank.every((line) => /^\s*>\s?/.test(line))) return text;
  return lines.map((line) => line.replace(/^\s*>\s?/, '')).join('\n');
}

/**
 * Parse a `Key: Value` block the way WTG's own reader does — a line parser, not a YAML
 * re-parse.
 *
 * `parseNotesBlock` re-parses its block as YAML because a convention pack keyed on
 * `hasKey` wants real types back. WTG's "WTG Time Config" card is different: WTG reads it
 * with `content.match(/Starting Date:\s*([^\n]+)/i)` per field (`library.js:1671`) and by
 * iterating `DEFAULT_SETTINGS` entry names — plain string extraction, tolerant of an
 * optional `>` prefix and of arbitrary content after the first colon. A pack rule with
 * `over: body` validates against *this* shape, so the parser has to match it: no YAML
 * coercion of `true` / `24h` / a bare number, first occurrence of a key wins, a line with
 * no colon is skipped. Returns `{}` for empty, all-blank, or no-colon input.
 */
function parseSettingsBlock(text) {
  const source = String(text === undefined || text === null ? '' : text);
  const out = {};
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/^\s*>\s?/, '');
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key === '' || key in out) continue;
    out[key] = line.slice(colon + 1).trim();
  }
  return out;
}

/**
 * Render the `meta:` fence block, or null when there is nothing to write (§8.2.2, Phase 16).
 *
 * `meta:` is a tooling annotation channel — a convention pack reads `meta.<packName>.<key>`
 * off `parseCards` output, in both the inline and the offline `--lint` arms. It is emitted
 * only for a non-empty plain object, so every card that carries no `meta:` renders exactly
 * as before. VL parks it in `StoryCard.metadata` and forwards it to AID nowhere
 * (`loader.py:78`), the same path `kind: reference` relies on.
 *
 * Written as nested YAML rather than a string: unlike `notes:` (typed `str` by VL, so a
 * mapping would reach AID as a Python dict), `meta:` is read by no consumer that types it,
 * and `parseCards` round-trips the nested form. `YAML.stringify` of a plain object emits no
 * `---` marker; its trailing newline is dropped here and the closing fence is pushed
 * separately.
 */
function metaLines(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  if (Object.keys(meta).length === 0) return null;
  const dumped = YAML.stringify(meta, { indent: 2 }).replace(/\n+$/, '').split('\n');
  return ['meta:', ...dumped.map((line) => `  ${line}`)];
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
 * @param {object}      [args.questions]   merged, expanded placeholder table (§8.5)
 * @returns {{ text: string, diagnostics: Diagnostics }}
 */
function renderCard({ item, bodyText = '', notesText, diagnostics, loc = {}, questions = null }) {
  const diags = diagnostics || new Diagnostics();
  const lines = [`## ${cardTitle(item)}`, FENCE];

  const triggers = triggerLine(item, diags, loc);
  if (triggers) lines.push(triggers);

  // §8.4: unconditional, because all four sites in the VL source default it to true.
  lines.push('encapsulate: false');

  // §4.8. Written only for `reference`, because `story` is the default and emitting it
  // would move every existing byte to say nothing. VL parks unknown fence keys in
  // `StoryCard.metadata` (`loader.py:78`) and `to_latitude_dict` forwards only title,
  // type, keys, value and description — so this reaches AID nowhere and costs nothing
  // downstream. It is here rather than inferred from an empty trigger list because the
  // two are not the same claim: a narrative card that *lost* its triggers is the bug the
  // `empty-triggers` lint exists to find, and inference would make it indistinguishable
  // from a reference card, retiring that check by accident.
  if (item && item.kind === 'reference') lines.push('kind: reference');

  // §8.2.2 (Phase 16): a convention-pack annotation channel, emitted only when the item
  // carries a non-empty `meta:` mapping — so every existing card renders byte-identically.
  const meta = metaLines(item && item.meta);
  if (meta) lines.push(...meta);

  // `description:` never reaches here — `model/item.js` collapses it into `notes:` at
  // resolution (§4.5), so the emitter knows exactly one spelling.
  const notesText_ = notesText !== undefined ? notesText : defaultNotesText(item && item.notes);
  const notes = notesLines(notesText_);
  if (notes) lines.push(...notes);

  lines.push(FENCE);
  const body = String(bodyText === undefined || bodyText === null ? '' : bodyText);

  // §8.5's cap, measured here because here is the only place the final string exists. The
  // body arrives already wrapped — §8.4 applies `render.wrapper` compile-side — and the
  // envelope above is outside the cap, since VL's `entry` is the fence-stripped body and
  // `encapsulate: false` means AID's `value` is exactly that. Applies to `kind: reference`
  // items like any other: a field cap is a platform constraint, not an opinion (§4.8).
  checkLimit(body, questions, LIMITS.cardBody, {
    diagnostics: diags, loc, label: `"${cardTitle(item) || (item && item.id) || '?'}"`,
  });

  // `notes:` is assigned straight to AID's `description` (`scenario.py:124`), which caps at
  // 10,000 characters after the same placeholder substitution as everywhere else in §8.5.
  // Measured against the pre-fence string rather than the YAML-escaped `notesLines()` output,
  // since escaping is a formatting concern and not part of what AID stores.
  checkLimit(notesText_, questions, LIMITS.notes, {
    diagnostics: diags, loc, label: `"${cardTitle(item) || (item && item.id) || '?'}"`,
  });

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
      // §4.8, and §8.6's reason for putting it on the parsed model rather than leaving
      // consumers to read `meta`: reports and convention packs consume this shape, not the
      // file format, so `kind` has to survive a change of emitter the way `triggers` does.
      // Anything other than `reference` is `story`, including absent — the schema has
      // already rejected a third value by the time a card is written.
      kind: meta.kind === 'reference' ? 'reference' : 'story',
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
  parseNotesBlock,
  parseSettingsBlock,
  writeScalar,
};
