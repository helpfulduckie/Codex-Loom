'use strict';


const fs = require('fs');
const path = require('path');

const YAML = require('yaml');
const { applyLintLevel, Diagnostics, CODES } = require('../diag');
const { resolveVariables } = require('../util');
const { validate, TYPES } = require('../schema');
const { parseNotesBlock, parseSettingsBlock } = require('../emit/vl');
const { resolveField } = require('../render/eval');

const BUNDLED_DIR = path.join(__dirname, '..', '..', 'packs');


function loadPack(name, entry, { baseDir, variables = {}, diagnostics, loc = {} } = {}) {
  const source = entry && typeof entry === 'object' ? entry.source : null;

  let filePath;
  if (source) {
    const expanded = resolveVariables(String(source), variables, { diagnostics, ...loc });
    filePath = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir || '.', expanded);
  } else {
    filePath = path.join(BUNDLED_DIR, `${name}.cl.yaml`);
  }

  const fail = (why) => {
    diagnostics.error(
      CODES.PACK_MALFORMED,
      `Convention pack "${name}" ${why}, so its rules are unavailable; provide a readable pack with the required shape.`,
      { file: filePath, ...loc },
      {
        hint: source
          ? `Declared as lint.packs.${name} with source: ${source}`
          : `A bundled pack is resolved by name against ${BUNDLED_DIR}.`,
      },
    );
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
    diagnostics.error(
      CODES.PACK_NAME_MISMATCH,
      `Convention pack loaded as "${name}" declares name: "${doc.name}". `
      + 'The pack is unavailable until the config key and name match; this keeps diagnostic codes and suppressions portable.',
      { file: filePath, ...loc },
    );
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
      over: rule.over === 'body' ? 'body' : rule.over === 'meta' ? 'meta' : 'notes',
      requireCard: rule.requireCard || null,
      budget: rule.budget || null,
      count: rule.count || null,
      mutexHint: rule.mutexHint || null,
      message: rule.message || `pack "${name}" rule ${id}`,
    });
  }

  return { name, rules: normalized };
}


function toRegExp(spec) {
  if (spec instanceof RegExp) return spec;
  return new RegExp(String(spec));
}

function findInvalidPredicateRegex(pred) {
  if (!pred || typeof pred !== 'object') return null;

  for (const keyword of ['notesMatch', 'bodyMatch', 'match', 'titleMatch']) {
    if (pred[keyword] !== undefined) {
      try {
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

function plainObjOrEmpty(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

function evalPredicate(pred, view) {
  if (pred === null || pred === undefined) return true;
  if (typeof pred !== 'object') return false;

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
  if (pred.match !== undefined) {
    const re = toRegExp(pred.match);
    if (!re.test(view.notesText) && !re.test(view.body)) return false;
  }
  if (pred.titleMatch !== undefined) {
    if (!toRegExp(pred.titleMatch).test(view.title || '')) return false;
  }

  return true;
}


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
      meta: plainObjOrEmpty(card.meta && card.meta.meta),
    };

    for (const rule of pack.rules) {
      if (!evalPredicate(rule.appliesTo, view)) continue;

      const emit = (f) => findings.push({
        severity: f.severity,
        code: f.code,
        card: card.title,
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


function collectionSize(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return null;
}

function checkCountField(rule, pack, where, label, fieldPath, value, bounds, findings) {
  if (!bounds || typeof bounds !== 'object') return;
  const push = (msg) => findings.push({
    severity: rule.severity,
    code: rule.code,
    leaf: where.leaf,
    file: where.file,
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
      where.file = item && item._source;
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
            file: where.file,
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
};
