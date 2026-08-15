'use strict';

const fs   = require('fs');
const path = require('path');

const {
  FIELD_TOKEN_RE, VAR_TOKEN_RE, TEMPLATE_FN_RE, TEMPLATE_TAG_RE,
  VERB_MARKER_RE, SUSPECT_VERB_MARKER_RE, JS_ARTIFACT_RE, JS_WORD_RE,
  maskFencedRegions,
} = require('./util');
const { parseCards } = require('./emit/vl');

// ── mechanical syntax checks ────────────────────────────────────────────────
//
// Every pattern here is a compile-time artifact that should never survive into
// rendered output — a resolver miss, a template tag that didn't get consumed,
// or a JS interpolation failure. Patterns are imported from util.js, the same
// catalog the automatic per-write compile-time warnings use, so this offline
// scanner can never drift out of sync with them (or be guessed independently,
// which is how the wrong-token-syntax bug happened in the first place).

const CHECKS = [
  {
    category: 'unresolved-field-token',
    severity: 'ERROR',
    re: FIELD_TOKEN_RE,
    hint: 'pronoun/character-ID/field-ref token ({$she}, {$Aria}, {$Aria.she}, {$body.Field}) left unresolved',
  },
  {
    category: 'unexpanded-variable',
    severity: 'ERROR',
    re: VAR_TOKEN_RE,
    hint: 'compile.yaml variable token ({%key}) left unexpanded',
  },
  {
    category: 'template-function',
    severity: 'ERROR',
    re: TEMPLATE_FN_RE,
    hint: 'render function ({join}, {list}, {and}, {prose}, {block}, {keys}, {inline}) leaked into output',
  },
  {
    category: 'template-tag',
    severity: 'ERROR',
    re: TEMPLATE_TAG_RE,
    hint: 'template control tag ({if}/{/if}, {wrapper}/{/wrapper}, {preserve}/{/preserve}, {include}) leaked into output',
  },
  {
    category: 'verb-conjugation-marker',
    severity: 'ERROR',
    re: VERB_MARKER_RE,
    hint: 'verb conjugation marker ([s]/[es]/[is]/[was]/[has]) left unresolved — needs a preceding {$Id} or {$Id.pronoun} scope',
  },
  {
    category: 'suspect-verb-marker',
    severity: 'WARN',
    re: SUSPECT_VERB_MARKER_RE,
    hint: "bracketed lowercase word that isn't a recognized verb-conjugation marker ([s]/[es]/[is]/[was]/[has]) or the [e] marker — likely a typo (e.g. [does] instead of [s]/[is])",
  },
  {
    category: 'js-interpolation-artifact',
    severity: 'ERROR',
    re: JS_ARTIFACT_RE,
    hint: 'JS interpolation failure artifact',
  },
  {
    category: 'js-interpolation-word',
    severity: 'WARN',
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
  if (!fs.existsSync(dir)) return results;
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const parts = full.split(path.sep);
        if (parts.includes('Story Cards') || parts.includes('Components')) {
          results.push(full);
        }
      }
    }
  }
  walk(dir);
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
 * Run every mechanical CHECKS pattern against text. Occurrences of the same
 * (category, matched string) are grouped, recording every line they appear on.
 * Returns an array of { category, severity, hint, match, lines }.
 */
function scanText(text) {
  const findings = [];
  const maskedText = maskFencedRegions(text);
  for (const { category, severity, re, hint } of CHECKS) {
    // suspect-verb-marker ignores the triggers:/encapsulate: fence — a
    // single-word trigger like `triggers: [door]` is a real trigger, not a
    // mistyped conjugation marker.
    const scanTarget = category === 'suspect-verb-marker' ? maskedText : text;
    const grouped = new Map(); // match string -> lines[]
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(scanTarget)) !== null) {
      const key = m[0];
      const line = lineAt(text, m.index);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(line);
      if (m[0].length === 0) re.lastIndex++; // guard against zero-width matches
    }
    for (const [match, lines] of grouped) {
      findings.push({ category, severity, hint, match, lines });
    }
  }
  return findings;
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

function scanStoryCardStructure(content) {
  const findings = [];
  // The shared parser (§8.6). Fenceless sections are still skipped: a heading with no
  // fence beneath it is prose in a component file, not a malformed story card, and
  // reporting it would fire this check on every AI Instructions section.
  for (const { title, triggers } of parseCards(content).filter((c) => c.hasFence)) {
    if (triggers.length === 0) {
      findings.push({
        category: 'empty-triggers', severity: 'WARN', card: title,
        hint: 'card has an empty or missing trigger list',
      });
    }
  }
  return findings;
}

// ── report formatting ────────────────────────────────────────────────────────

function formatLines(lines) {
  const shown = lines.slice(0, 5).join(', ');
  return lines.length > 5 ? `${shown}, +${lines.length - 5} more` : shown;
}

function formatReport(rootDirName, fileResults) {
  const out = [`# Codex Loom Syntax Lint — ${rootDirName}`, ''];
  let errorCount = 0, warnCount = 0;

  for (const { relPath, findings } of fileResults) {
    if (findings.length === 0) continue;
    out.push(`## ${relPath}`, '');
    for (const f of findings) {
      if (f.severity === 'ERROR') errorCount++; else warnCount++;
      if (f.card) {
        out.push(`- [${f.severity}] (${f.category}) card "${f.card}": ${f.hint}`);
      } else {
        out.push(`- [${f.severity}] (${f.category}) \`${f.match}\` at line ${formatLines(f.lines)} — ${f.hint}`);
      }
    }
    out.push('');
  }

  out.unshift(`<!-- ${errorCount} error(s), ${warnCount} warning(s) -->`);
  return { text: out.join('\n').trimEnd() + '\n', errorCount, warnCount };
}

// ── runner ────────────────────────────────────────────────────────────────────

/**
 * Run syntax-lint mode on a scenario output root: scans every compiled
 * Story Cards/Components .md file for unresolved template artifacts and
 * VL structural errors. Writes a `<root>.lint.md` report to outputDir and
 * echoes findings to the console. Returns { reportPath, errorCount, warnCount }
 * or null if no lintable files were found.
 */
function runLintMode(scenarioRoot, outputDir, verbose = false) {
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const files        = findLintableFiles(rootAbs);

  if (files.length === 0) {
    console.warn('  WARN: No Story Cards/Components .md files found — nothing to lint.');
    return null;
  }

  const fileResults = [];
  for (const file of files) {
    const content  = fs.readFileSync(file, 'utf8');
    const relPath  = path.relative(rootAbs, file);
    const findings = scanText(content);
    if (path.dirname(file).split(path.sep).includes('Story Cards')) {
      findings.push(...scanStoryCardStructure(content));
    }
    fileResults.push({ relPath, findings });
    if (verbose && findings.length > 0) {
      console.log(`  linted: ${relPath} (${findings.length} finding(s))`);
    }
  }

  const { text, errorCount, warnCount } = formatReport(rootDirName, fileResults);
  const reportPath = path.join(outputDir, `${rootDirName}.lint.md`);
  fs.writeFileSync(reportPath, text, 'utf8');

  for (const { relPath, findings } of fileResults) {
    for (const f of findings) {
      const loc = f.card ? `card "${f.card}" in ${relPath}` : `${relPath}:${f.lines[0]}`;
      console.warn(`  ${f.severity} [${f.category}]: ${loc} — ${f.hint}`);
    }
  }

  console.log(`\nLint: ${errorCount} error(s), ${warnCount} warning(s) across ${files.length} file(s).`);

  return { reportPath, errorCount, warnCount };
}

module.exports = { runLintMode, findLintableFiles, scanText, scanStoryCardStructure, CHECKS };
