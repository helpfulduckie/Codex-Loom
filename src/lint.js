'use strict';

const fs   = require('fs');
const path = require('path');

const {
  FIELD_TOKEN_RE, VAR_TOKEN_RE, TEMPLATE_FN_RE, TEMPLATE_TAG_RE,
  VERB_MARKER_RE, SUSPECT_VERB_MARKER_RE, JS_ARTIFACT_RE, JS_WORD_RE,
  maskFencedRegions,
} = require('./util');
const { parseCards } = require('./emit/vl');
const {
  CODES: DIAG_CODES, Diagnostics, SEVERITY, SEVERITY_LABEL,
} = require('./diag');
const {
  loadPack, evaluatePack, evaluatePackExistence, clampFinding,
} = require('./lint/packs');
const { buildTree, leafNodes, collectMdFiles } = require('./compiledTree');
const { NULL_LOG } = require('./log');

// ── mechanical syntax checks ────────────────────────────────────────────────
//
// Every pattern here is a compile-time artifact that should never survive into
// rendered output — a resolver miss, a template tag that didn't get consumed,
// or a JS interpolation failure. Patterns are imported from util.js, the same
// catalog the automatic per-write compile-time warnings use, so this offline
// scanner can never drift out of sync with them (or be guessed independently,
// which is how the wrong-token-syntax bug happened in the first place).
//
// **§12.5's compiler/lint split is a property of the code, not a column in this table.**
// The split is about what a check *claims* — a leaked `{$she}` is a fact about the output,
// `[does]` is a guess about prose — and not about which half of the tool runs it. So the six
// ERROR checks stay here rather than leaving: deleting the facts from this table would have
// made `--lint` useless on a tree someone else compiled, which is the one job an offline
// scanner has. Which of them `lint.level` can reach is answered by `diag.js`'s `isOpinion`,
// off the `layer: 'opinion'` tag in `REGISTRY` — this table used to restate that per entry
// and the two could disagree. That is the same shape as `CL0535`/`CL0536`, which are opinions
// computed inside the compile because they need the branch-merged placeholder table.

const CHECKS = [
  {
    severity: SEVERITY.ERROR,
    code: DIAG_CODES.LEAKED_FIELD_TOKEN,
    re: FIELD_TOKEN_RE,
    hint: 'pronoun/character-ID/field-ref token ({$she}, {$Aria}, {$Aria.she}, {$body.Field}) left unresolved',
  },
  {
    severity: SEVERITY.ERROR,
    code: DIAG_CODES.LEAKED_VARIABLE,
    re: VAR_TOKEN_RE,
    hint: 'compile.yaml variable token ({%key}) left unexpanded',
  },
  {
    severity: SEVERITY.ERROR,
    code: DIAG_CODES.LEAKED_RENDER_FUNCTION,
    re: TEMPLATE_FN_RE,
    hint: 'render function ({join}, {list}, {and}, {prose}, {block}, {keys}, {inline}) leaked into output',
  },
  {
    severity: SEVERITY.ERROR,
    code: DIAG_CODES.LEAKED_TEMPLATE_TAG,
    re: TEMPLATE_TAG_RE,
    hint: 'template control tag ({if}/{/if}, {wrapper}/{/wrapper}, {preserve}/{/preserve}, {include}) leaked into output',
  },
  {
    severity: SEVERITY.ERROR,
    code: DIAG_CODES.LEAKED_VERB_MARKER,
    re: VERB_MARKER_RE,
    hint: 'verb conjugation marker ([s]/[es]/[is]/[was]/[has]) left unresolved — needs a preceding {$Id} or {$Id.pronoun} scope',
  },
  {
    severity: SEVERITY.WARN,
    code: DIAG_CODES.SUSPECT_VERB_MARKER,
    re: SUSPECT_VERB_MARKER_RE,
    hint: "bracketed lowercase word that isn't a recognized verb-conjugation marker ([s]/[es]/[is]/[was]/[has]) or the [e] marker — likely a typo (e.g. [does] instead of [s]/[is])",
  },
  {
    severity: SEVERITY.ERROR,
    code: DIAG_CODES.LEAKED_JS_ARTIFACT,
    re: JS_ARTIFACT_RE,
    hint: 'JS interpolation failure artifact',
  },
  {
    severity: SEVERITY.WARN,
    code: DIAG_CODES.SUSPECT_JS_WORD,
    re: JS_WORD_RE,
    hint: 'bare "undefined"/"NaN" — usually a JS interpolation failure, but verify it is not intentional prose',
  },
];

// ── file discovery ───────────────────────────────────────────────────────────

/**
 * Recursively collect .md files under dir whose path includes a "Story Cards"
 * or "Components" segment — i.e. actual compiled output, not QA report
 * folders (Overview, leaf-review, seed-map, card-sizes, diff, annotate).
 */
function findLintableFiles(dir) {
  const results = [];
  for (const full of collectMdFiles(dir)) {
    const parts = full.split(path.sep);
    if (parts.includes('Story Cards') || parts.includes('Components')) {
      results.push(full);
    }
  }
  return results;
}

// ── line numbers ─────────────────────────────────────────────────────────────

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

// ── raw-text scan ────────────────────────────────────────────────────────────

/**
 * Run every mechanical CHECKS pattern against text, raising one diagnostic per occurrence
 * onto `diagnostics`.
 *
 * One per occurrence rather than one per distinct match with a line list: `Diagnostic.line`
 * is scalar, and one-per-occurrence is what every other check in the compiler does. It costs
 * a longer report on a file with a repeated leak, which is the right trade — a leak on six
 * lines is six things to fix.
 *
 * Raised through `diagnostics.add` and never by constructing a `Diagnostic` for the caller
 * to merge: `add` is where the `lint.level` ceiling is applied (`diag.js`), and `merge` does
 * no filtering. Building them outside the bus would silence nothing and no fixture would say
 * so — the committed lint baselines carry one finding between them.
 */
function scanText(text, { diagnostics, file = null } = {}) {
  const maskedText = maskFencedRegions(text);
  for (const { severity, code, re, hint } of CHECKS) {
    // The suspect-verb-marker check ignores the triggers:/encapsulate: fence — a
    // single-word trigger like `triggers: [door]` is a real trigger, not a
    // mistyped conjugation marker.
    const scanTarget = code === DIAG_CODES.SUSPECT_VERB_MARKER ? maskedText : text;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(scanTarget)) !== null) {
      diagnostics.add(severity, code, `\`${m[0]}\` — ${hint}`, { file, line: lineAt(text, m.index) });
      if (m[0].length === 0) re.lastIndex++; // guard against zero-width matches
    }
  }
}

// ── the ${...} confusability check (§12.4) ───────────────────────────────────
//
// `${What is your name?}` is AID's native placeholder and entirely legitimate. `{$she}` is
// a Codex Loom token. They are one transposition apart, and a mistyped `${she}` reaches the
// player as a prompt asking them to type the word "she" — which is why the check exists.
//
// §12.4 describes it as a WARN on *every* `${...}`, and that version is unusable. Measured
// against the live corpus before this was written: three projects author native
// placeholders on purpose — World Time Generator has eleven, Lab Rat and Shared Perspective
// one each — so a blanket check opens with thirteen false positives, which is how an author
// learns to skip a category of message.
//
// **The shape of the content separates them.** A Codex Loom token holds an identifier:
// `{$she}`, `{$Aria}`, `{$Aria.she}`, `{$body.Field}` — no spaces, no punctuation beyond
// dots. An AID placeholder holds a *question* written for a human: spaces, usually a `?` or
// a `:`. So the check fires only on identifier-shaped content, which catches the
// transposition and stays silent on every intentional placeholder in the corpus.
//
// The exception is Latitude's premade specials, which are identifier-shaped by
// construction and all `character.`-prefixed: `${character.name}`, `${character.gender}`,
// and the five `${character.pronoun.*}` forms that follow the gender answer. They have no
// `%key%` equivalent — Velvet Lattice's substitution produces a question from a declared
// key and cannot produce a special — so every project that wants them writes them raw,
// permanently. Warning about them would be permanent noise. The exemption is the
// `character.` prefix only: a bare `${they}` is still flagged, because that is exactly the
// mistyped `{$they}` this check exists to catch.

const TOKEN_SHAPED = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

/** Latitude's premade placeholders. Identifier-shaped, legitimate, and unavoidable. */
const AID_SPECIAL_PREFIX = 'character.';

/**
 * Find `${...}` occurrences whose content looks like a Codex Loom token.
 *
 * Brace-balanced rather than a regex: Codex Loom emits nested placeholders (§12.2), and a
 * non-greedy `[^}]*` reads `${What is ${Their name?} like?}` as one truncated match plus a
 * stray tail — which would then be judged on the wrong content.
 */
function scanNativePlaceholders(text, { diagnostics, file = null } = {}) {
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] !== '$' || text[i + 1] !== '{') continue;
    let depth = 0;
    let j = i;
    for (; j < text.length; j += 1) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') {
        depth -= 1;
        if (depth === 0) { j += 1; break; }
      }
    }
    const whole = text.slice(i, j);
    const inner = whole.slice(2, -1);
    i = j - 1;

    if (!TOKEN_SHAPED.test(inner)) continue;
    if (inner.toLowerCase().startsWith(AID_SPECIAL_PREFIX)) continue;

    // The message says what the author wrote and what it will do; the hint says what to
    // write instead. That is the split `Diagnostic.hint` exists for, and this check is the
    // one in this file with a genuine fix to name.
    diagnostics.add(
      SEVERITY.WARN, DIAG_CODES.NATIVE_PLACEHOLDER_SHAPE,
      `\`${whole}\` reads as an AID placeholder that would prompt the player to type "${inner}".`,
      { file, line: lineAt(text, i) },
      { hint: `If a Codex Loom token was meant, it is written {$${inner}} — the brace and the dollar the other way round.` },
    );
  }
}

// ── story-card structural checks ─────────────────────────────────────────────
//
// One check, and the reason there is only one is worth stating.
//
// v3 lint also carried `missing-encapsulate`, `e-marker-conflict` and
// `missing-discovery-marker`. The first is gone because `encapsulate` is no longer
// author-controlled (§8.2.1): the emitter writes `encapsulate: false` on every card, so
// the check fired on all 2,442 of them and told the author about a decision they no
// longer make. The other two encode one mod's convention — `[e]` for background
// knowledge, `/]` for a discovery marker — and fire wrongly for every project that does
// not use it. Rules of that shape belong in a convention pack (§8.2.2), which needs
// `notes:` parsed into structured form first.
//
// What is left is a fact about the platform rather than an opinion about content: a card
// with no triggers can never be pulled into context.

function scanStoryCardStructure(content, { diagnostics, file = null } = {}) {
  // The shared parser (§8.6). Fenceless sections are still skipped: a heading with no
  // fence beneath it is prose in a component file, not a malformed story card, and
  // reporting it would fire this check on every AI Instructions section.
  //
  // **`kind: reference` is exempt, and this is the check §4.8 wrote the field for.** A mod
  // control card or a swappable-instructions card is trigger-less on purpose; flagging it
  // is telling the author about a decision they made deliberately, every compile, forever.
  // The exemption reads the fence rather than inferring reference-ness from the empty
  // trigger list, because inference would disable the check entirely: a narrative card that
  // *lost* its triggers is the thing this exists to catch, and under inference it looks
  // identical to a reference card (Phase 5 plan, Decision 2).
  for (const card of parseCards(content).filter((c) => c.hasFence)) {
    if (card.kind === 'reference') continue;
    if (card.triggers.length === 0) {
      // `(untitled)` rather than the parser's `null`: the card name is part of the message
      // now, and a null in it would print the word "null" as the card's name.
      diagnostics.add(
        SEVERITY.WARN, DIAG_CODES.CARD_NO_TRIGGERS,
        `card "${card.title || '(untitled)'}" has an empty or missing trigger list`,
        { file },
      );
    }
  }
}

// ── convention packs (§8.2.2), the offline arm ──────────────────────────────
//
// The inline pass in `compile.js` resolves each leaf's branch-merged `lint.packs` and
// feeds the compile bus. Here there is only a compiled tree and no branch context, so
// the project-root `lint.packs` runs against every Story Cards file — the same honest
// limit `--lint` already has for `lint.level` when it cannot find a `compile.yaml`.

/**
 * Load every root-declared pack once. Returns `[{ name, pack, packLevel }]`, skipping a
 * pack whose entry is `level: off` and one that failed to load (the loader raised the
 * ERROR onto `diagnostics`).
 */
function loadDeclaredPacks(config, configPath, diagnostics) {
  const entries = (config && config.lint && config.lint.packs) || {};
  const baseDir = (config && config._base) || (configPath ? path.dirname(configPath) : '.');
  const variables = (config && (config._variables || config.variables)) || {};
  const out = [];
  for (const [name, entry] of Object.entries(entries)) {
    const packLevel = (entry && typeof entry === 'object' && entry.level) || null;
    if (packLevel === 'off') continue;
    const pack = loadPack(name, entry, { baseDir, variables, diagnostics, loc: { file: configPath } });
    if (pack) out.push({ name, pack, packLevel });
  }
  return out;
}

/**
 * Run each loaded pack over one compiled Story Cards file, raising onto the same bus every
 * other check uses. A pack code is `CL-<pack>/NNNN`, which `diag.js`'s `isOpinion` recognizes
 * by its prefix rather than by a registry entry, so the bus applies the `lint.level` ceiling
 * to these without their needing to be declared. Per-pack `level:` is applied here first —
 * the two ceilings compose, narrowest last.
 */
function scanPacks(content, type, loadedPacks, { diagnostics, file = null } = {}) {
  if (!loadedPacks || loadedPacks.length === 0) return;
  const cards = parseCards(content, { type });
  for (const { pack, packLevel } of loadedPacks) {
    for (const f of evaluatePack(pack, cards)) {
      const severity = clampFinding(f.severity, packLevel, null);
      if (severity === null) continue;
      diagnostics.add(severity, f.code, `card "${f.card}": ${f.detail}`, { file });
    }
  }
}

// ── report formatting ────────────────────────────────────────────────────────
//
// The written report and the CLI's terminal output are two renderings of one bus. There is
// no `applyLevel` here any more: `Diagnostics.add` applies the §12.5 ceiling at add time via
// `isOpinion`, so a silenced diagnostic is never on the bus to be filtered out twice — which
// is also why the exit code can be `bus.errors.length` rather than a count assembled while
// the report is written and then adjusted by hand for the pack loader's errors.

/** The heading for diagnostics with no file — the per-leaf `requireCard` existence pass. */
const NO_FILE_GROUP = '(convention packs)';

function formatReport(rootDirName, diagnostics) {
  const out = [`# Codex Loom Syntax Lint — ${rootDirName}`, ''];

  const groups = new Map();
  for (const d of diagnostics.all) {
    const key = d.file || NO_FILE_GROUP;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  for (const [heading, items] of groups) {
    out.push(`## ${heading}`, '');
    for (const d of items) {
      const where = [
        d.line !== null ? `line ${d.line}` : null,
        d.branch ? `leaf "${d.branch}"` : null,
      ].filter(Boolean).join(' ');
      out.push(`- [${SEVERITY_LABEL[d.severity]}] ${d.code}${where ? ` ${where}` : ''}: ${d.message}`);
      if (d.hint) out.push(`  ${d.hint}`);
    }
    out.push('');
  }

  const errorCount = diagnostics.errors.length;
  const warnCount = diagnostics.warnings.length;
  out.unshift(`<!-- ${errorCount} error(s), ${warnCount} warning(s) -->`);
  return { text: out.join('\n').trimEnd() + '\n', errorCount, warnCount };
}

// ── runner ────────────────────────────────────────────────────────────────────

/**
 * Run syntax-lint mode on a scenario output root: scans every compiled
 * Story Cards/Components .md file for unresolved template artifacts and
 * VL structural errors. Writes a `<root>.lint.md` report to outputDir. Prints nothing —
 * every finding is raised onto the diagnostic bus, which the caller already holds and can
 * print, so nothing is handed back for the caller to re-render.
 * Returns { written, reportPath, errorCount, warnCount, fileCount }, with `written: []`,
 * `reportPath: null` and the counts zeroed when no lintable files were found.
 */
function runLintMode(scenarioRoot, outputDir, options = {}) {
  const { log = NULL_LOG } = options;
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const files        = findLintableFiles(rootAbs);

  if (files.length === 0) {
    return { written: [], reportPath: null, errorCount: 0, warnCount: 0, fileCount: 0 };
  }

  // §8.2.2 — project-root convention packs, loaded once. A malformed pack raises a
  // `CL0117` here; it lands on the bus, not swallowed. It is a load failure rather than a
  // finding, but it is an ERROR on the same bus, so it reaches the exit code by the same
  // route everything else does instead of being counted separately and added on at the end.
  const bus = options.diagnostics || new Diagnostics();
  if (options.lintLevel) bus.setLintLevel(options.lintLevel);
  const loadedPacks = options.config
    ? loadDeclaredPacks(options.config, options.configPath || null, bus)
    : [];

  for (const file of files) {
    const content  = fs.readFileSync(file, 'utf8');
    const relPath  = path.relative(rootAbs, file);
    const segs = relPath.split(path.sep);
    const scIdx = segs.indexOf('Story Cards');
    const cardType = scIdx >= 0 && segs[scIdx + 1] ? segs[scIdx + 1] : null;
    const before = bus.length;
    const ctx = { diagnostics: bus, file: relPath };
    scanText(content, ctx);
    scanNativePlaceholders(content, ctx);
    if (path.dirname(file).split(path.sep).includes('Story Cards')) {
      scanStoryCardStructure(content, ctx);
      scanPacks(content, cardType, loadedPacks, ctx);
    }
    const raised = bus.length - before;
    if (raised > 0) log.verbose(`  linted: ${relPath} (${raised} finding(s))`);
  }

  // §8.2.2 — a `requireCard` rule is a per-leaf existence check, not a per-file one: a
  // compiled directory does not hold the cards a leaf *inherits*, so scanning files would
  // false-positive on every non-owning node. Resolve each leaf's full card set from the
  // compiled tree, which folds VL's own card inheritance (`compiledTree.resolved.cards`).
  // Offline still applies the root `lint.packs` to every leaf — it does not walk
  // `config.branches`, so a branch that unbound the pack still gets the finding. The
  // inline compile pass is branch-merge-aware and authoritative (see `## Watch`).
  //
  // These carry a `branch` and no `file`, which is what puts them under the report's
  // `(convention packs)` heading rather than under a path.
  if (loadedPacks.some(({ pack }) => (pack.rules || []).some((r) => r.requireCard))) {
    for (const leaf of leafNodes(buildTree(rootAbs))) {
      const label = leaf.branchNames.join('/') || '(root)';
      for (const { pack, packLevel } of loadedPacks) {
        for (const f of evaluatePackExistence(pack, leaf.resolved.cards, { branchLabel: label })) {
          const severity = clampFinding(f.severity, packLevel, null);
          if (severity === null) continue;
          bus.add(severity, f.code, f.detail, { branch: f.leaf });
        }
      }
    }
  }

  const { text, errorCount, warnCount } = formatReport(rootDirName, bus);
  const reportPath = path.join(outputDir, `${rootDirName}.lint.md`);
  fs.writeFileSync(reportPath, text, 'utf8');

  return { written: [reportPath], reportPath, errorCount, warnCount, fileCount: files.length };
}

module.exports = {
  runLintMode, findLintableFiles, scanText, scanStoryCardStructure,
  scanNativePlaceholders,
};
