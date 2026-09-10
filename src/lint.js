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


function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}


function scanText(text, { diagnostics, file = null } = {}) {
  const maskedText = maskFencedRegions(text);
  for (const { severity, code, re, hint } of CHECKS) {
    const scanTarget = code === DIAG_CODES.SUSPECT_VERB_MARKER ? maskedText : text;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(scanTarget)) !== null) {
      diagnostics.add(severity, code, `\`${m[0]}\` — ${hint}`, { file, line: lineAt(text, m.index) });
      if (m[0].length === 0) re.lastIndex++; // guard against zero-width matches
    }
  }
}


const TOKEN_SHAPED = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

const AID_SPECIAL_PREFIX = 'character.';

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

    diagnostics.add(
      SEVERITY.WARN, DIAG_CODES.NATIVE_PLACEHOLDER_SHAPE,
      `\`${whole}\` reads as an AID placeholder that would prompt the player to type "${inner}".`,
      { file, line: lineAt(text, i) },
      { hint: `If a Codex Loom token was meant, it is written {$${inner}} — the brace and the dollar the other way round.` },
    );
  }
}


function scanStoryCardStructure(content, { diagnostics, file = null } = {}) {
  for (const card of parseCards(content).filter((c) => c.hasFence)) {
    if (card.kind === 'reference') continue;
    if (card.triggers.length === 0) {
      diagnostics.add(
        SEVERITY.WARN, DIAG_CODES.CARD_NO_TRIGGERS,
        `card "${card.title || '(untitled)'}" has an empty or missing trigger list, so AID cannot pull it into context. Add triggers or use kind: reference.`,
        { file },
      );
    }
  }
}


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


function runLintMode(scenarioRoot, outputDir, options = {}) {
  const { log = NULL_LOG } = options;
  const rootAbs     = path.resolve(scenarioRoot);
  const rootDirName = path.basename(rootAbs);
  const files        = fs.existsSync(rootAbs) ? findLintableFiles(rootAbs) : [];
  const bus = options.diagnostics || new Diagnostics();

  if (files.length === 0 && bus.isEmpty()) {
    return { written: [], reportPath: null, errorCount: 0, warnCount: 0, fileCount: 0 };
  }

  if (options.lintLevel) bus.setLintLevel(options.lintLevel);
  const loadedPacks = options.scan !== false && options.config
    ? loadDeclaredPacks(options.config, options.configPath || null, bus)
    : [];

  for (const file of options.scan === false ? [] : files) {
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

  if (options.scan !== false
      && loadedPacks.some(({ pack }) => (pack.rules || []).some((r) => r.requireCard))) {
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
  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `${rootDirName}.lint.md`);
  fs.writeFileSync(reportPath, text, 'utf8');

  return { written: [reportPath], reportPath, errorCount, warnCount, fileCount: files.length };
}

module.exports = {
  runLintMode, findLintableFiles, scanText, scanStoryCardStructure,
  scanNativePlaceholders,
};
