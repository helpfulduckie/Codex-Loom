'use strict';


const { CODES } = require('./diag');
const { PLACEHOLDER_RE } = require('./util');

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
  notes: Object.freeze({
    cap: 10000,
    warnAt: 9000,
    subject: 'Notes',
    over: CODES.NOTES_OVER_LIMIT,
    near: CODES.NOTES_NEAR_LIMIT,
  }),
});

function expandPlaceholders(text, questions) {
  let out = String(text === undefined || text === null ? '' : text);
  if (!questions) return out;
  for (const [key, question] of Object.entries(questions)) {
    if (question === null || question === undefined) continue;
    out = out.split(`%${key}%`).join(`\${${question}}`);
  }
  return out;
}

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

const n = (value) => Number(value).toLocaleString('en-US');

function checkLimit(text, questions, limit, { diagnostics, loc = {}, label = null }) {
  const result = measure(text, questions);

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
          + 'shows up during play. Shorten the content or reduce its placeholder expansion.',
      },
    );
  } else if (result.expanded >= limit.warnAt) {
    diagnostics.warn(
      limit.near,
      `${subject} is ${n(result.expanded)} characters on upload, `
      + `within ${n(limit.cap - result.expanded)} of the ${n(limit.cap)} limit.${detail}`,
      loc,
      { hint: 'Shorten the content or reduce its placeholder expansion.' },
    );
  }

  return result;
}

module.exports = { LIMITS, expandPlaceholders, measure, checkLimit };
