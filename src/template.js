'use strict';

const {
  resolveVariables, walkItemTextFields, walkTextRecursive, transformStringValues, itemContext,
} = require('./util');
const { CODES } = require('./diag');
const { tokenize, parse, FUNCTION_NAMES } = require('./render/parse');
const evalMod = require('./render/eval');
const {
  resolveField, isTruthy, renderScalar, applyWrapper,
  FUNCTIONS,
  renderProgram,
} = evalMod;


function normalizeWhitespace(str, preserved) {
  let working = str;

  if (preserved === undefined) {
    preserved = [];
    working = str.replace(/\{preserve\}([\s\S]*?)\{\/preserve\}/g, (match, content) => {
      const idx = preserved.length;
      preserved.push(content.replace(/^\n/, '').replace(/\n$/, ''));
      return `\x00PRESERVE_${idx}\x00`;
    });
  }

  working = working.replace(/\t/g, '');

  working = working.split('\n').map(line => line.trim()).join('\n');

  working = working.replace(/ {2,}/g, ' ');

  working = working.replace(/\n{2,}/g, '\n');

  working = working.trim();

  working = working.replace(/\x00PRESERVE_(\d+)\x00/g, (_, idx) => preserved[Number(idx)]);

  return working;
}

function applyFieldInterpolation(card) {
  const context = itemContext(card);

  walkItemTextFields(card, s => processFieldInterpolation(s, context));
}

function processFieldInterpolation(value, context) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{(\$(body|v|var|vars|variable|variables|aid|render|name)\.[^{}]+)\}/gi, function(match, ref) {
    const resolved = resolveField(ref.trim(), context);
    if (resolved === null) return '';
    return renderScalar(resolved);
  });
}

function applyFieldRenderFunctions(card, itemMap, options) {
  if (!card.body) return;

  const context = itemContext(card, itemMap ? { itemMap } : undefined);

  walkTextRecursive(card.body, (s) => processFieldRenderFunctions(s, context, options || {}));
}

function applyVariableInterpolation(card, variables, sink) {
  if (!variables) return;
  for (const key of ['id', 'name', 'body', 'aid', 'render', 'v', 'notes', 'meta', 'pronouns']) {
    if (card[key] !== undefined) {
      card[key] = transformStringValues(card[key], (value) => resolveVariables(value, variables, sink));
    }
  }
}

const RENDER_FN_DISPATCH = FUNCTION_NAMES.map((n) => [n + '(', FUNCTIONS[n]]);

function processFieldRenderFunctions(value, context, options) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{([^{}]+)\}/g, function(match, inner) {
    inner = inner.trim();
    for (const [prefix, fn] of RENDER_FN_DISPATCH) {
      if (inner.startsWith(prefix)) {
        try {
          return fn(inner, context);
        } catch (e) {
          options.diagnostics.error(
            CODES.TEMPLATE_PARSE_FAILED,
            `render function in field value: ${e.message}`,
            { file: options.file },
          );
          return match;
        }
      }
    }
    return match;
  });
}

function render(template, data, partials, variables, options) {
  if (!partials) partials = new Map();
  const { diagnostics, file, name } = options || {};

  let source = template;
  if (variables) source = resolveVariables(source, variables, { diagnostics, file });

  const report = diagnostics
    ? (code, message, span) => {
        const loc = { file };
        if (span && typeof span.line === 'number') loc.line = span.line;
        if (span && typeof span.column === 'number') loc.col = span.column;
        diagnostics.error(code, message, loc);
      }
    : () => {};

  source = expandIncludes(source, partials, report, variables, diagnostics, file);

  const preserved = [];
  const flags = { wrapperUsed: false };
  const ctx = { report, preserved, flags, name };

  const doc = parse(tokenize(source), report);
  let result = renderProgram(doc, data, ctx);

  result = normalizeWhitespace(result, preserved);

  if (!flags.wrapperUsed && data.render && data.render.wrapper && data.render.wrapper !== 'none') {
    result = applyWrapper(result, data.render.wrapper);
  }

  return result;
}

function expandIncludes(source, partials, report, variables, diagnostics, file, stack) {
  stack = stack || [];
  return source.replace(/\{include\s+(\S+)\}/g, function(match, includeName, offset, whole) {
    const key = includeName.toLowerCase();
    const line = whole.slice(0, offset).split('\n').length;
    if (stack.includes(key)) {
      report(CODES.PARTIAL_CYCLE, `Circular partial include: ${[...stack, key].join(' → ')}`, { line });
      return '';
    }
    const partial = partials.get(key);
    if (!partial) {
      report(CODES.PARTIAL_NOT_FOUND, `Unknown partial "${includeName}" (no .partial file found).`, { line });
      return '';
    }
    const partialSource = variables
      ? resolveVariables(partial.content, variables, { diagnostics, file: partial._source || file })
      : partial.content;
    return expandIncludes(partialSource, partials, report, variables, diagnostics, partial._source || file, [...stack, key]);
  });
}

module.exports = {
  render,
  resolveField,
  applyFieldInterpolation,
  applyVariableInterpolation,
  applyFieldRenderFunctions,
  normalizeWhitespace,
  applyWrapper,
  isTruthy,
};
