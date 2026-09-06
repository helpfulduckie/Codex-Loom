'use strict';


const YAML = require('yaml');
const { CODES } = require('../diag');
const { LIMITS, checkLimit } = require('../limits');

const FENCE = '~~~';

const YAML_11_NON_STRING = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|y|Y|n|N)$/;

const YAML_NUMERIC = /^[-+]?(?:0b[01_]+|0x[0-9a-fA-F_]+|0o?[0-7_]+|(?:\d[\d_]*)(?:\.[\d_]*)?(?:[eE][-+]?\d+)?|\.[\d_]+(?:[eE][-+]?\d+)?|\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

const YAML_INDICATORS = '-?:,[]{}#&*!|>\'"%@`';

function decodeTriggerPadding(raw) {
  const text = String(raw);
  const lead = text.length - text.replace(/^_+/, '').length;
  const trail = text.length - text.replace(/_+$/, '').length;
  if (lead + trail >= text.length) return ' '.repeat(text.length);
  const core = text.slice(lead, text.length - trail);
  return ' '.repeat(lead) + core + ' '.repeat(trail);
}

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

function writeScalar(value, { flow = false } = {}) {
  const text = String(value);
  if (isPlainSafe(text, { flow })) return text;
  if (!text.includes("'") && !/[\n\r\t]/.test(text)) return `'${text}'`;
  return JSON.stringify(text);
}

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

function parseNotesBlock(notesString) {
  const text = stripBlockquote(
    String(notesString === undefined || notesString === null ? '' : notesString),
  );
  if (text.trim() === '') return {};
  let parsed;
  try {
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

function metaLines(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  if (Object.keys(meta).length === 0) return null;
  const dumped = YAML.stringify(meta, { indent: 2 }).replace(/\n+$/, '').split('\n');
  return ['meta:', ...dumped.map((line) => `  ${line}`)];
}

function notesLines(text) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.trim() === '') return null;
  if (!value.includes('\n')) return [`notes: ${writeScalar(value)}`];
  const body = value.replace(/\n+$/, '').split('\n').map((line) => `  ${line}`);
  return ['notes: |-', ...body];
}

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

function renderCard({ item, bodyText = '', notesText, diagnostics, loc = {}, questions = null }) {
  const diags = diagnostics;
  const lines = [`## ${cardTitle(item)}`, FENCE];

  const triggers = triggerLine(item, diags, loc);
  if (triggers) lines.push(triggers);

  lines.push('encapsulate: false');

  if (item && item.kind === 'reference') lines.push('kind: reference');

  const meta = metaLines(item && item.meta);
  if (meta) lines.push(...meta);

  const notesText_ = notesText !== undefined ? notesText : defaultNotesText(item && item.notes);
  const notes = notesLines(notesText_);
  if (notes) lines.push(...notes);

  lines.push(FENCE);
  const body = String(bodyText === undefined || bodyText === null ? '' : bodyText);

  checkLimit(body, questions, LIMITS.cardBody, {
    diagnostics: diags, loc, label: `"${cardTitle(item) || (item && item.id) || '?'}"`,
  });

  checkLimit(notesText_, questions, LIMITS.notes, {
    diagnostics: diags, loc, label: `"${cardTitle(item) || (item && item.id) || '?'}"`,
  });

  return { text: `${lines.join('\n')}\n${body}`, diagnostics: diags };
}

function fenceBlockRe({ global = false } = {}) {
  return new RegExp('^~~~[ \\t]*$[\\s\\S]*?^~~~[ \\t]*$', global ? 'gm' : 'm');
}

function maskFences(text) {
  if (typeof text !== 'string') return text;
  return text.replace(fenceBlockRe({ global: true }), (block) => block.replace(/[^\n]/g, ' '));
}

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
      const inner = fence[0].replace(/^~~~[ \t]*\r?\n?/, '').replace(/\r?\n?~~~[ \t]*$/, '');
      try {
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
      hasFence: Boolean(fence),
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
