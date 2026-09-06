'use strict';


const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { CODES } = require('../diag');
const { resolveVariables, checkUnexpandedVariables, PLACEHOLDER_RE } = require('../util');
const { applyTokenPass } = require('../model/pronouns');

const FILENAME = 'Placeholders.yaml';

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

function findAllPlaceholders(text) {
  const found = [];
  String(text || '').replace(PLACEHOLDER_RE, (match) => { found.push(match); return match; });
  return found.concat(findNativePlaceholders(text));
}

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

function expandQuestions(table, variables, {
  onWarn, file, diagnostics, registry, roles, branchProtagonist, onRoleUsed,
} = {}) {
  const keys = Object.keys(table).filter((k) => table[k] !== null && table[k] !== undefined);

  const base = {};
  for (const key of keys) {
    base[key] = resolveVariables(String(table[key]), variables || {}, { diagnostics, file });
  }

  const refsOf = (text) => {
    const out = [];
    String(text).replace(PLACEHOLDER_RE, (match, name) => {
      if (Object.prototype.hasOwnProperty.call(base, name)) out.push(name);
      return match;
    });
    return out;
  };

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

  if (registry) {
    for (const key of keys) {
      expanded[key] = applyTokenPass(expanded[key], {
        item: {}, registry, branchProtagonist, roles, onRoleUsed, onWarn,
      });
    }
  }

  return expanded;
}

function checkUndeclaredPlaceholders(text, table, { diagnostics, file, where, branch, skip, usage, usagePath } = {}) {
  if (!text || !diagnostics) return [];

  const declared = table || {};
  const seen = new Set();
  const undeclared = [];
  String(text).replace(PLACEHOLDER_RE, (match, name) => {
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

function recordUsage(usage, name, usagePath) {
  if (!usage) return;
  if (!usage.has(name)) usage.set(name, new Set());
  usage.get(name).add(usagePath || '');
}

function reportUnusedPlaceholders(declarations, usage, { diagnostics, file } = {}) {
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

function reportDuplicateQuestions(duplicates, { diagnostics, file }) {
  if (!duplicates) return [];
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

function localKeysOf(node) {
  const local = node && node.placeholders;
  if (!local || typeof local !== 'object') return [];
  return Object.keys(local).filter((k) => local[k] !== null && local[k] !== undefined);
}

function writeNodePlaceholders(nodeDir, node, mergedTable, variables, {
  onWarn, file, diagnostics, usage, usagePath, duplicates,
  registry, roles, branchProtagonist, onRoleUsed,
} = {}) {
  const keys = localKeysOf(node);
  const outPath = path.join(nodeDir, FILENAME);

  if (keys.length === 0) {
    if (fs.existsSync(outPath)) fs.rmSync(outPath);
    return null;
  }

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

  const expanded = expandQuestions(mergedTable, variables, {
    onWarn, file, diagnostics, registry, roles, branchProtagonist, onRoleUsed,
  });

  collectDuplicateQuestions(expanded, duplicates, usagePath || '');

  const emitted = {};
  for (const key of keys) {
    if (expanded[key] !== undefined && expanded[key] !== null) emitted[key] = expanded[key];
  }
  if (Object.keys(emitted).length === 0) {
    if (fs.existsSync(outPath)) fs.rmSync(outPath);
    return null;
  }

  for (const [key, question] of Object.entries(emitted)) {
    const where = `the question text for placeholder "${key}"`;
    checkUndeclaredPlaceholders(question, mergedTable, { diagnostics, file, where });
    checkUnexpandedVariables(question, where, { diagnostics, file });
  }

  fs.mkdirSync(nodeDir, { recursive: true });
  fs.writeFileSync(outPath, YAML.stringify(emitted), 'utf8');
  return outPath;
}

module.exports = {
  FILENAME,
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
