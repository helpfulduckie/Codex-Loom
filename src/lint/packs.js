'use strict';

/**
 * Convention packs (v4 spec §8.2.2).
 *
 * A pack is declarative data — never code — that the opinion layer runs over a leaf's
 * compiled story cards. It carries an `appliesTo` selector, an optional `schema:` subset
 * over the card's `notes:` structure, and a small predicate vocabulary (key presence,
 * value equality, substring/regex over the notes text and the body). §8.2.2's three-tier
 * ladder starts here: tier 1 is a bundled pack resolved by bare name against `packs/`;
 * tier 2 is a project- or canon-hosted file named by `source:`.
 *
 * Two entry points reach this module:
 *
 *   - the inline pass in `compile.js`, which resolves each leaf's branch-merged
 *     `lint.packs` and feeds findings to the compile bus — so a pack ERROR fails the
 *     build, which §12.5 says is the whole reason the per-pack `level:` dial exists;
 *   - the offline `--lint` report (`src/lint.js`), which has only a compiled tree and no
 *     branch context, so it runs the project-root `lint.packs` against every file.
 *
 * ── Why a pack re-parses `notes:` itself ────────────────────────────────────
 *
 * §8.2.2 says a pack receives `notes:` "already parsed into its mapping form." It does
 * not: `emit/vl.js` emits `notes:` as a flat string by design (§4.5) and `parseCards`
 * hands it back with `String(meta.notes)`. Mod config is authored as YAML key/value
 * lines, though, so the structure is recoverable — `parseNotesBlock` (in `emit/vl.js`)
 * runs a YAML parse over the block and returns a mapping, or `{}` for a scalar like
 * `'[e]'`, which the predicate layer reads as "no keys."
 *
 * ── Diagnostic codes ───────────────────────────────────────────────────────
 *
 * A pack finding is coded `CL-<pack>/NNNN` (`CL-wtg/0001`), outside the numeric `CLxxxx`
 * bands, so it never collides with a core code and suppresses independently. `diag.js`'s
 * `isOpinion` recognizes the `CL-` prefix, which is what puts pack findings under
 * `lint.level`'s reach — every opinion-layer ERROR comes from a pack (§12.5).
 *
 * The pack loader's own two diagnostics are core codes in the loading band, declared
 * here rather than in `diag.js`'s registry the way `loader.js` keeps `CL041x` local:
 */
const CODES = Object.freeze({
  /** A pack file is missing, unparseable, or not shaped like a pack (§8.2.2). */
  PACK_MALFORMED: 'CL0117',
  /** The config key does not match the pack's declared `name:` (§8.2.2). */
  PACK_NAME_MISMATCH: 'CL0119',
});

const fs = require('fs');
const path = require('path');

const YAML = require('yaml');
const { applyLintLevel, Diagnostics } = require('../diag');
const { expandTokens } = require('../tokens');
const { validate, TYPES, CODES: SCHEMA_CODES } = require('../schema');
const { parseNotesBlock, parseSettingsBlock } = require('../emit/vl');
const { resolveField } = require('../render/eval');

/** Bundled packs live at the repo root, beside `src/`. */
const BUNDLED_DIR = path.join(__dirname, '..', '..', 'packs');

// ── loading ──────────────────────────────────────────────────────────────────

/**
 * Load one pack, named by the key it was declared under in `lint.packs`.
 *
 * `entry` is that key's value: `{}` for a bundled pack, `{ source: <path> }` for a
 * hosted one, either optionally carrying `level:`. A `source:` is `{%tok}`-expanded
 * against `variables` and resolved relative to `baseDir` (the config's directory).
 *
 * Returns a normalized pack `{ name, rules: [...] }`, or `null` after raising a
 * `CL0117` ERROR that names the pack — never a throw, never a silent skip (§8.2.2).
 */
function loadPack(name, entry, { baseDir, variables = {}, diagnostics, loc = {} } = {}) {
  const source = entry && typeof entry === 'object' ? entry.source : null;

  let filePath;
  if (source) {
    const expanded = expandTokens(String(source), { variables });
    filePath = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir || '.', expanded);
  } else {
    filePath = path.join(BUNDLED_DIR, `${name}.cl.yaml`);
  }

  const fail = (why) => {
    if (diagnostics) {
      diagnostics.error(
        CODES.PACK_MALFORMED,
        `Convention pack "${name}" ${why}.`,
        { file: filePath, ...loc },
        {
          hint: source
            ? `Declared as lint.packs.${name} with source: ${source}`
            : `A bundled pack is resolved by name against ${BUNDLED_DIR}.`,
        },
      );
    }
    return null;
  };

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return fail(source ? `could not be read at ${filePath}` : 'is not a bundled pack');
  }

  let doc;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    return fail(`is not valid YAML — ${err.message.split('\n')[0]}`);
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return fail('is not a mapping of pack keys');
  }
  if (doc.name !== undefined && String(doc.name) !== name) {
    if (diagnostics) {
      diagnostics.error(
        CODES.PACK_NAME_MISMATCH,
        `Convention pack loaded as "${name}" declares name: "${doc.name}". `
        + 'The config key must match the pack\'s own name so diagnostic codes and '
        + 'suppressions stay portable (§8.2.2).',
        { file: filePath, ...loc },
      );
    }
    return null;
  }
  const rules = Array.isArray(doc.rules) ? doc.rules : null;
  if (!rules) return fail('declares no rules: list');

  const normalized = [];
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    if (!rule || typeof rule !== 'object') return fail(`rule ${i + 1} is not a mapping`);
    const id = rule.id !== undefined ? String(rule.id) : String(i + 1);

    for (const predicate of [rule.appliesTo, rule.forbid, rule.require, rule.requireCard]) {
      const bad = findInvalidPredicateRegex(predicate);
      if (bad) {
        return fail(
          `rule ${id} has an invalid ${bad.keyword} regex "${bad.spec}" — `
          + `${bad.error.message.split('\n')[0]}`,
        );
      }
    }

    if (rule.severity !== undefined && rule.severity !== 'warn' && rule.severity !== 'error') {
      return fail(
        `rule ${id} has an unrecognized severity: "${rule.severity}" — expected `
        + '"warn" or "error"',
      );
    }
    const severity = rule.severity === 'warn' ? 'warn' : 'error';
    normalized.push({
      id,
      code: `CL-${name}/${id.padStart(4, '0')}`,
      severity,
      appliesTo: rule.appliesTo || null,
      forbid: rule.forbid || null,
      require: rule.require || null,
      schema: rule.schema || null,
      // `over:` routes a rule's `schema:` away from the default `notes:` mapping:
      // `body` parses the card entry with `parseSettingsBlock` (§8.2.2, Phase 15); `meta`
      // reads `card.meta[<packName>]`, the pack's own annotation sub-namespace (Phase 16).
      // Anything else, including absent, is `notes`.
      over: rule.over === 'body' ? 'body' : rule.over === 'meta' ? 'meta' : 'notes',
      // `requireCard: <predicate>` — a per-leaf existence check run by
      // `evaluatePackExistence`, not by the per-card loop below.
      requireCard: rule.requireCard || null,
      // Phase 16 primitives. `budget` (role→char-cap map) runs per card in `evaluatePack`,
      // so it rides the offline arm. `count` (field→bounds) and `mutexHint` (a field-set
      // co-occurrence ceiling) run per resolved item in `evaluatePackItemRules`, which is
      // inline-only — the offline arm has no structured item (Decision 5).
      budget: rule.budget || null,
      count: rule.count || null,
      mutexHint: rule.mutexHint || null,
      message: rule.message || `pack "${name}" rule ${id}`,
    });
  }

  return { name, rules: normalized };
}

// ── the predicate vocabulary ─────────────────────────────────────────────────
//
// §8.2.2 names three primitives beyond the schema check: field presence, value
// equality, and substring/regex over the notes text and the body. `all` / `any` / `not`
// compose them. A predicate reads a card view `{ title, body, notesText, notes }` where
// `notes` is `parseNotesBlock`'s mapping.

function toRegExp(spec) {
  if (spec instanceof RegExp) return spec;
  return new RegExp(String(spec));
}

/**
 * Walk a predicate tree looking for a regex spec (`notesMatch` / `bodyMatch` / `match` /
 * `titleMatch`) that `new RegExp` rejects. Descends into `all` (array), `any` (array),
 * `not` (single) and the scoped `notes` form. Returns `{ keyword, spec, error }` for the
 * first invalid one found, or `null` if the whole tree is clean.
 */
function findInvalidPredicateRegex(pred) {
  if (!pred || typeof pred !== 'object') return null;

  for (const keyword of ['notesMatch', 'bodyMatch', 'match', 'titleMatch']) {
    if (pred[keyword] !== undefined) {
      try {
        // eslint-disable-next-line no-new
        new RegExp(String(pred[keyword]));
      } catch (error) {
        return { keyword, spec: pred[keyword], error };
      }
    }
  }

  if (Array.isArray(pred.all)) {
    for (const p of pred.all) {
      const bad = findInvalidPredicateRegex(p);
      if (bad) return bad;
    }
  }
  if (Array.isArray(pred.any)) {
    for (const p of pred.any) {
      const bad = findInvalidPredicateRegex(p);
      if (bad) return bad;
    }
  }
  if (pred.not !== undefined) {
    const bad = findInvalidPredicateRegex(pred.not);
    if (bad) return bad;
  }
  if (pred.notes && typeof pred.notes === 'object') {
    const bad = findInvalidPredicateRegex(pred.notes);
    if (bad) return bad;
  }

  return null;
}

/** A value if it is a plain (non-array) object, else `{}`. */
function plainObjOrEmpty(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

function evalPredicate(pred, view) {
  if (pred === null || pred === undefined) return true;
  if (typeof pred !== 'object') return false;

  // `{ notes: {...} }` scopes the nested predicate to the notes mapping (spec example
  // `appliesTo: {notes: {hasKey: statTracker}}`).
  if (pred.notes && typeof pred.notes === 'object') {
    if (!evalPredicate(pred.notes, { ...view, _scope: 'notes' })) return false;
  }

  if (Array.isArray(pred.all)) {
    if (!pred.all.every((p) => evalPredicate(p, view))) return false;
  }
  if (Array.isArray(pred.any)) {
    if (!pred.any.some((p) => evalPredicate(p, view))) return false;
  }
  if (pred.not !== undefined) {
    if (evalPredicate(pred.not, view)) return false;
  }

  if (pred.hasKey !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(view.notes, String(pred.hasKey))) return false;
  }
  if (pred.equals && typeof pred.equals === 'object') {
    const { key, value } = pred.equals;
    if (String(view.notes[key]) !== String(value)) return false;
  }
  if (pred.notesMatch !== undefined) {
    if (!toRegExp(pred.notesMatch).test(view.notesText)) return false;
  }
  if (pred.bodyMatch !== undefined) {
    if (!toRegExp(pred.bodyMatch).test(view.body)) return false;
  }
  // `match` scans notes text and body together — the shape `wtg`'s marker rule needs,
  // since WTG normalizes marker position across Notes and Entry.
  if (pred.match !== undefined) {
    const re = toRegExp(pred.match);
    if (!re.test(view.notesText) && !re.test(view.body)) return false;
  }
  if (pred.titleMatch !== undefined) {
    if (!toRegExp(pred.titleMatch).test(view.title || '')) return false;
  }

  return true;
}

// ── the schema check ─────────────────────────────────────────────────────────
//
// A rule's `schema:` block is a `src/schema.js` descriptor tree over the parsed `notes:`
// mapping — closed value sets, types, required keys, and the numeric `min`/`max` Phase 14
// adds. `validate` emits core `CL02xx` codes into a throwaway bus; each is re-coded to
// the rule's `CL-<pack>/NNNN` so a pack's findings suppress as one unit and show their
// origin.

function runSchemaCheck(rule, notes, view, emit) {
  const bus = new Diagnostics();
  validate(notes, buildDescriptor(rule.schema), { diagnostics: bus, context: `card "${view.title}"` });
  for (const d of bus.all) {
    emit({
      severity: d.severity === 'error' ? rule.severity : 'warn',
      code: rule.code,
      message: `${d.message}${d.hint ? ` ${d.hint}` : ''}`,
    });
  }
}

/**
 * Turn a pack's `schema:` shorthand into a `src/schema.js` descriptor.
 *
 * A pack author writes `{ type: map, keys: { Clock Format: { values: [12h, 24h] } } }`
 * or nests `keys`/`of`; the strings map straight onto `TYPES`. Left mostly pass-through
 * on purpose — the engine already understands `type`, `keys`, `of`, `required`,
 * `values`, `min`, `max` — so this only resolves the `type:` name to its `TYPES` value.
 */
function buildDescriptor(node) {
  if (!node || typeof node !== 'object') return { type: TYPES.ANY };
  const out = { ...node };
  if (typeof node.type === 'string') {
    const key = node.type.toUpperCase();
    out.type = TYPES[key] || node.type;
  }
  if (node.keys && typeof node.keys === 'object') {
    out.keys = {};
    for (const [k, child] of Object.entries(node.keys)) out.keys[k] = buildDescriptor(child);
  }
  if (node.of && typeof node.of === 'object') out.of = buildDescriptor(node.of);
  return out;
}

// ── evaluation ───────────────────────────────────────────────────────────────

/**
 * Run one loaded pack over a leaf's parsed story cards.
 *
 * `cards` is `emit/vl.js:parseCards` output. For each card, every rule whose `appliesTo`
 * matches contributes findings: a `forbid` predicate that matches, a `require` predicate
 * that does not, and every violation the `schema:` check raises. Returns a flat list of
 * `{ severity, code, message, card }` — the caller applies the per-pack, per-branch and
 * global `level:` ceilings and routes them onto a bus or into a report.
 */
function evaluatePack(pack, cards, { branchLabel = null } = {}) {
  const findings = [];
  const where = branchLabel ? ` on branch "${branchLabel}"` : '';

  for (const card of cards) {
    const notes = parseNotesBlock(card.notes);
    const view = {
      title: card.title,
      body: card.body || '',
      notesText: String(card.notes || ''),
      notes,
      // Phase 16: the card's `meta:` annotation channel, so `over: meta` and the `budget`
      // role lookup can read `meta[pack.name]`. `parseCards` returns the whole fence
      // mapping as `card.meta`, and the channel is its `meta:` key — hence `card.meta.meta`.
      // Absent → `{}`.
      meta: plainObjOrEmpty(card.meta && card.meta.meta),
    };

    for (const rule of pack.rules) {
      if (!evalPredicate(rule.appliesTo, view)) continue;

      const emit = (f) => findings.push({
        severity: f.severity,
        code: f.code,
        card: card.title,
        // `detail` is the rule's own words; `message` prefixes them with the pack, card
        // and branch for a bus that has no other context. The offline report formatter
        // already prints `card "…"`, so it uses `detail`.
        detail: f.message,
        message: `[${pack.name}] card "${card.title}"${where}: ${f.message}`,
      });

      if (rule.forbid && evalPredicate(rule.forbid, view)) {
        emit({ severity: rule.severity, code: rule.code, message: rule.message });
      }
      if (rule.require && !evalPredicate(rule.require, view)) {
        emit({ severity: rule.severity, code: rule.code, message: rule.message });
      }
      if (rule.schema) {
        const input = rule.over === 'meta'
          ? ((view.meta && view.meta[pack.name]) || {})
          : rule.over === 'body' ? parseSettingsBlock(card.body) : notes;
        runSchemaCheck(rule, input, view, emit);
      }
      if (rule.budget) {
        // An absent role is `standard`; so is an unrecognized one — a typo in `role`
        // (`minr`) is the role rule's to flag, and it must not also suppress the budget
        // check by resolving to a cap-less key. `standard` may itself be absent from a
        // pack's map, in which case `cap` is `undefined` and the check simply skips.
        const rawRole = String((view.meta[pack.name] || {}).role || 'standard');
        const role = Object.prototype.hasOwnProperty.call(rule.budget, rawRole)
          ? rawRole : 'standard';
        const cap = rule.budget[role];
        if (typeof cap === 'number' && view.body.length > cap) {
          emit({
            severity: rule.severity,
            code: rule.code,
            message: `${rule.message} — role "${role}" targets ${cap} characters, this `
              + `card's body is ${view.body.length}.`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * The existence half of a pack, kept separate from `evaluatePack` so the two never
 * double-run — `evaluatePack` is called per card (per file, offline), and a `requireCard`
 * check asked once per card would fire once per card that is *not* the required one.
 *
 * For each rule carrying `requireCard: <predicate>`, if no card in `cards` satisfies the
 * predicate, returns one finding at the rule's severity. `cards` is a whole leaf's
 * resolved card set (inline: every rendered card across `leaf.grouped`; offline:
 * `compiledTree`'s per-leaf `resolved.cards`), so "no card matches" is a real per-leaf
 * fact and the finding names the branch — the same cadence as `CL0118` (Decision 1). The
 * author suppresses it on a WTG-free branch by unbinding the pack there; Codex Loom
 * cannot detect where a mod is active.
 */
function evaluatePackExistence(pack, cards, { branchLabel = null } = {}) {
  const findings = [];
  const where = branchLabel && branchLabel !== '(root)' ? ` on branch "${branchLabel}"` : '';

  for (const rule of pack.rules) {
    if (!rule.requireCard) continue;

    const satisfied = cards.some((card) => evalPredicate(rule.requireCard, {
      title: card.title,
      body: card.body || '',
      notesText: String(card.notes || ''),
      notes: parseNotesBlock(card.notes),
      meta: plainObjOrEmpty(card.meta && card.meta.meta),
    }));
    if (satisfied) continue;

    findings.push({
      severity: rule.severity,
      code: rule.code,
      leaf: branchLabel || '(root)',
      detail: rule.message,
      message: `[${pack.name}]${where}: ${rule.message}`,
    });
  }
  return findings;
}

// ── the per-item rules ───────────────────────────────────────────────────────
//
// `count` and `mutexHint` (§8.2.2, Phase 16) read the *structured* resolved item — where
// `item.body.vibe` is a real array and `item.body.overview` is a detectable key — which
// `parseCards` output cannot give back (`overview` renders with no label, and a rendered
// `Vibe: [a; b; c]` line does not distinguish an authored list from an authored string).
// So this is a third sibling to `evaluatePack` / `evaluatePackExistence`, called ONLY from
// `compile.js:runPackChecks`, once per leaf — never from the offline `--lint` arm
// (Decision 5). Field paths resolve through `render/eval.js:resolveField`, the same
// case-insensitive dotted-path walk the render layer uses.

/** Non-empty list or map → its length; anything else (string, scalar, empty, null) → null. */
function collectionSize(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return null;
}

/**
 * Check one `count` field against its bounds and push a finding per violation.
 *
 * `bounds` is `{ min?, max? }` for a list/map length, or `{ words: { min?, max? } }` for a
 * whitespace-token count on a string. A multi-value field authored as a bare `,`/`;`
 * string is NOT split — `count` sees one value and skips it (Beth's call: no field-name
 * list baked into the compiler). Write multi-value fields as YAML lists for the check to
 * see them.
 */
function checkCountField(rule, pack, where, label, fieldPath, value, bounds, findings) {
  if (!bounds || typeof bounds !== 'object') return;
  const push = (msg) => findings.push({
    severity: rule.severity,
    code: rule.code,
    leaf: where.leaf,
    detail: msg,
    message: `[${pack.name}]${where.suffix} — item "${label}", ${fieldPath}: ${msg}`,
  });

  if (bounds.words && typeof bounds.words === 'object') {
    if (typeof value !== 'string') return;
    const n = value.split(/\s+/).filter(Boolean).length;
    const { min, max } = bounds.words;
    if (typeof min === 'number' && n < min) push(`${n} word${n === 1 ? '' : 's'}, expected at least ${min}.`);
    else if (typeof max === 'number' && n > max) push(`${n} word${n === 1 ? '' : 's'}, expected at most ${max}.`);
    return;
  }

  const n = collectionSize(value);
  if (n === null) return; // a string or scalar — count cannot see multiplicity
  const { min, max } = bounds;
  if (typeof min === 'number' && n < min) push(`${n} item${n === 1 ? '' : 's'}, expected at least ${min}.`);
  else if (typeof max === 'number' && n > max) push(`${n} item${n === 1 ? '' : 's'}, expected at most ${max}.`);
}

/**
 * Run a pack's `count` / `mutexHint` rules over a leaf's resolved item objects.
 *
 * `items` is `resolveBranchItems` output for one leaf. Returns findings shaped like
 * `evaluatePackExistence`'s — `{ severity, code, leaf, detail, message }` — and names the
 * branch the same way, with the `(root)` special-case.
 */
function evaluatePackItemRules(pack, items, { branchLabel = null } = {}) {
  const findings = [];
  const list = Array.isArray(items) ? items : [];
  const where = {
    leaf: branchLabel || '(root)',
    suffix: branchLabel && branchLabel !== '(root)' ? ` on branch "${branchLabel}"` : '',
  };

  for (const rule of pack.rules) {
    if (!rule.count && !rule.mutexHint) continue;

    for (const item of list) {
      const data = { body: (item && item.body) || {} };
      const label = (item && (item.id || (item.name && (item.name.full || item.name.display)))) || '(item)';

      if (rule.count) {
        const fields = (rule.count.fields && typeof rule.count.fields === 'object')
          ? rule.count.fields : {};
        const def = rule.count.default || null;
        const named = new Set(Object.keys(fields).map((k) => k.toLowerCase()));

        for (const [fieldPath, bounds] of Object.entries(fields)) {
          const value = resolveField(`$body.${fieldPath}`, data);
          checkCountField(rule, pack, where, label, fieldPath, value, bounds, findings);
        }

        // `default` applies to every top-level body field that resolves to a non-empty
        // list or map and was not named above. A bare-string field is skipped — the
        // compiler does not guess which strings are lists.
        if (def) {
          for (const key of Object.keys(data.body)) {
            if (named.has(key.toLowerCase())) continue;
            const value = resolveField(`$body.${key}`, data);
            if (collectionSize(value) === null) continue;
            checkCountField(rule, pack, where, label, key, value, def, findings);
          }
        }
      }

      if (rule.mutexHint) {
        const mh = rule.mutexHint;
        const names = Array.isArray(mh.fields) ? mh.fields : [];
        const max = typeof mh.max === 'number' ? mh.max : 3;
        const present = names.filter((f) => resolveField(`$body.${f}`, data) !== null);
        if (present.length > max) {
          const msg = mh.message || rule.message;
          findings.push({
            severity: rule.severity,
            code: rule.code,
            leaf: where.leaf,
            detail: msg,
            message: `[${pack.name}]${where.suffix} — item "${label}": ${msg} `
              + `(${present.length} of ${names.length} present: ${present.join(', ')})`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Clamp a finding's severity through the per-pack then per-branch `level:` ceilings.
 *
 * The global `lint.level` is applied separately — the compile bus does it at `add` time
 * for any `CL-` code, and the offline report does it in `applyLevel`. Returns the
 * severity the finding reaches the author at, or `null` if a ceiling dropped it.
 */
function clampFinding(severity, packLevel, branchLevel) {
  let sev = applyLintLevel(severity, packLevel || null);
  if (sev === null) return null;
  sev = applyLintLevel(sev, branchLevel || null);
  return sev;
}

module.exports = {
  loadPack,
  evaluatePack,
  evaluatePackExistence,
  evaluatePackItemRules,
  clampFinding,
  CODES,
  SCHEMA_CODES,
};
