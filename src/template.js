'use strict';

/**
 * Template engine for Codex Loom v3.
 *
 * Interpolation syntax:
 *   {$field}                     - top-level card field
 *   {$body.FieldName}            - body field (case-insensitive)
 *   {$body.FieldName.subfield}   - nested body subfield
 *   {$otherid.body.FieldName}    - cross-card reference (second-pass, left as-is here)
 *   {%variable}                  - branch variable (pre-expanded before render)
 *   {@ComponentKey}              - component key ref (pre-expanded before render)
 *
 * Render functions:
 *   {inline($name)}              - space-join all subfields of a mapping
 *   {join("sep", $f1, $f2)}      - join present values with separator
 *   {list($body.items)}          - "- item" lines
 *   {and($body.keywords)}        - "a, b, and c"
 *   {prose($body.section)}       - each element as a sentence (capitalize + period)
 *   {block($body.section)}       - one item per line, no prefix
 *   {keys($body.mapping)}        - "key: value" lines
 *
 * Block syntax:
 *   {wrapper}...{/wrapper}       - wraps content per card's render.wrapper
 *   {if $body.field}...{/if}     - conditional
 *   {include PartialName}        - partial inclusion
 *
 * Literal escapes:
 *   {{ → {    }} → }    [[ → [    ]] → ]
 */

// Sentinel strings used during processing to protect escaped sequences
const S_LBRACE = '\x00LBRACE\x00';
const S_RBRACE = '\x00RBRACE\x00';
const S_LBRACKET = '\x00LBRACKET\x00';
const S_RBRACKET = '\x00RBRACKET\x00';

/**
 * Case-insensitive deep field resolver.
 * Resolves paths like "body.Physical Traits.gender" against card data.
 *
 * Returns the value or null. Arrays and objects are returned as-is for render functions.
 * Plain scalars are returned as trimmed strings.
 */
function resolveField(ref, data) {
  const path = ref.startsWith('$') ? ref.slice(1) : ref;
  const parts = path.split('.');

  let value = data;
  for (const part of parts) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') return null;

    const lower = part.toLowerCase();
    const actualKey = Object.keys(value).find(k => k.toLowerCase() === lower);
    if (actualKey === undefined) return null;
    value = value[actualKey];
  }

  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // Return arrays and objects as-is so render functions can work with them
  if (Array.isArray(value)) return value.length > 0 ? value : null;
  if (typeof value === 'object') return value;

  const str = String(value).trim();
  return str === '' ? null : str;
}

/**
 * Evaluate boolean truthiness of a field reference.
 */
function isTruthy(ref, data) {
  const val = resolveField(ref, data);
  if (val === null) return false;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object') return Object.keys(val).length > 0;
  if (String(val).toLowerCase() === 'false') return false;
  if (val === '0') return false;
  return true;
}

/**
 * Render a value as a string for inline output.
 * Arrays → elements joined with "; ".
 * Objects → not directly renderable, returns "".
 */
function renderScalar(val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return val.join('; ');
  if (typeof val === 'object') return '';
  return String(val);
}

// ── Render functions ──────────────────────────────────────────────────────────

function evaluateInline(inner, data) {
  const refMatch = inner.match(/^inline\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed inline(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  if (typeof val === 'object' && !Array.isArray(val)) {
    return Object.values(val).filter(v => v != null).join(' ');
  }
  if (Array.isArray(val)) return val.join(' ');
  return String(val);
}

function evaluateJoin(inner, data) {
  const sepMatch = inner.match(/^join\(\s*"([^"]*)"\s*,(.+)\)$/s);
  if (!sepMatch) throw new Error('Malformed join(): ' + inner);
  const separator = sepMatch[1];
  const refs = sepMatch[2].split(',').map(s => s.trim()).filter(Boolean);
  const values = refs
    .map(ref => resolveField(ref, data))
    .filter(v => v !== null)
    .flatMap(v => Array.isArray(v) ? v : [v]);
  return values.join(separator);
}

function evaluateList(inner, data) {
  const refMatch = inner.match(/^list\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed list(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  if (Array.isArray(val)) return val.map(item => '- ' + item).join('\n');
  return renderScalar(val);
}

function evaluateAnd(inner, data) {
  const refMatch = inner.match(/^and\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed and(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  const arr = Array.isArray(val) ? val : [String(val)];
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return arr[0] + ' and ' + arr[1];
  return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
}

function evaluateProse(inner, data) {
  const refMatch = inner.match(/^prose\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed prose(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  const arr = Array.isArray(val) ? val : [String(val)];
  return arr.map(item => {
    let s = String(item).trim();
    if (!s) return '';
    s = s[0].toUpperCase() + s.slice(1);
    // Remove trailing punctuation then add period
    s = s.replace(/[.!?]+$/, '') + '.';
    return s;
  }).filter(Boolean).join(' ');
}

function evaluateBlock(inner, data) {
  const refMatch = inner.match(/^block\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed block(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  if (Array.isArray(val)) return val.join('\n');
  return renderScalar(val);
}

function evaluateKeys(inner, data) {
  const refMatch = inner.match(/^keys\(\s*(\$[^)]+?)\s*\)$/s);
  if (!refMatch) throw new Error('Malformed keys(): ' + inner);
  const val = resolveField(refMatch[1].trim(), data);
  if (val === null) return '';
  if (typeof val === 'object' && !Array.isArray(val)) {
    return Object.entries(val)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
  }
  return renderScalar(val);
}

// ── Processing stages ─────────────────────────────────────────────────────────

/**
 * Expand {include partialName} directives depth-first.
 */
function processIncludes(template, partials, stack) {
  if (!stack) stack = [];
  return template.replace(/\{include\s+(\S+)\}/g, function(match, name) {
    const key = name.toLowerCase();
    if (stack.includes(key)) {
      throw new Error(`Circular partial include: ${[...stack, key].join(' → ')}`);
    }
    const partial = partials.get(key);
    if (!partial) {
      throw new Error(`Unknown partial "${name}" (no .partial file found)`);
    }
    const expanded = processIncludes(partial.content, partials, [...stack, key]);
    // Protect escaped sequences within included content
    return expanded
      .replace(/\{\{/g, S_LBRACE)
      .replace(/\}\}/g, S_RBRACE)
      .replace(/\[\[/g, S_LBRACKET)
      .replace(/\]\]/g, S_RBRACKET);
  });
}

/**
 * Process {if $field}...{else}...{/if} blocks, innermost first.
 */
function processConditionals(template, data) {
  let result = template;
  let changed = true;
  while (changed) {
    changed = false;
    result = result.replace(
      /\{if ([^}]+)\}((?:(?!\{if )[\s\S])*?)\{\/if\}/g,
      function(match, condition, body) {
        changed = true;
        const truthy = isTruthy(condition.trim(), data);
        const parts = body.split(/\{else\}/);
        if (parts.length === 1) return truthy ? body : '';
        return truthy ? parts[0] : parts[1];
      }
    );
  }
  return result;
}

/**
 * Process {wrapper}...{/wrapper} blocks.
 * Reads data.render.wrapper (curly | square | none) and wraps the block content.
 */
function processWrapperBlocks(template, data) {
  const wrapper = (data.render && data.render.wrapper) || 'none';
  return template.replace(/\{wrapper\}([\s\S]*?)\{\/wrapper\}/g, function(match, content) {
    return applyWrapper(content.trim(), wrapper);
  });
}

/**
 * Apply wrapper to a string of content.
 */
function applyWrapper(text, wrapper) {
  const w = (wrapper || 'none').toLowerCase();
  if (w === 'square') return `[\n${text}\n]`;
  if (w === 'curly')  return `{\n${text}\n}`;
  return text;
}

/**
 * Process all inline expressions: render functions and field refs.
 */
function processInline(template, data) {
  return template.replace(/\{([^{}]+)\}/g, function(match, inner) {
    inner = inner.trim();

    // Skip sentinels already embedded
    if (inner.startsWith('\x00')) return match;

    // Render functions
    const fnDispatchers = [
      ['inline(', evaluateInline],
      ['join(',   evaluateJoin],
      ['list(',   evaluateList],
      ['and(',    evaluateAnd],
      ['prose(',  evaluateProse],
      ['block(',  evaluateBlock],
      ['keys(',   evaluateKeys],
    ];
    for (const [prefix, fn] of fnDispatchers) {
      if (inner.startsWith(prefix)) {
        try {
          return fn(inner, data);
        } catch (e) {
          console.warn('  WARN: ' + e.message);
          return '';
        }
      }
    }

    // Field reference
    if (inner.startsWith('$')) {
      const val = resolveField(inner, data);
      if (val === null) return '';
      // For name mapping fields, default to first value
      if (typeof val === 'object' && !Array.isArray(val)) {
        return Object.values(val)[0] || '';
      }
      return renderScalar(val);
    }

    // Unknown — leave as-is
    return match;
  });
}

/**
 * Normalize whitespace in rendered output.
 *
 * Steps (in order):
 * 1. Identify [preserve blocks] — single brackets, NOT [[escaped]] ones
 * 2. Strip tabs outside preserved blocks
 * 3. Collapse runs of whitespace-only lines → single blank line
 * 4. Collapse 3+ consecutive newlines → \n\n
 * 5. Deduplicate consecutive spaces within lines (outside preserved)
 * 6. Trim leading/trailing whitespace from whole document
 * 7. Restore preserved blocks
 */
function normalizeWhitespace(str) {
  // Step 1: Mark [preserve blocks] for protection
  // A single [ that is NOT preceded by another [ (which would be a sentinel or escaped bracket)
  // We use a simple approach: find [...]  that don't start with sentinel
  const preserved = [];
  let working = str.replace(/\[([^\[\]]*)\]/g, (match, content) => {
    // Only preserve if not an already-sentineled bracket
    const idx = preserved.length;
    preserved.push(match);
    return `\x00PRESERVE_${idx}\x00`;
  });

  // Step 2: Strip tabs
  working = working.replace(/\t/g, '');

  // Step 3: Collapse runs of whitespace-only lines to a single blank line
  working = working.replace(/(\n[ \t]*){2,}\n/g, '\n\n');

  // Step 4: Collapse 3+ consecutive newlines to \n\n (redundant after step 3, but belt-and-suspenders)
  working = working.replace(/\n{3,}/g, '\n\n');

  // Step 5: Deduplicate consecutive spaces within lines
  working = working.split('\n').map(line => {
    // Don't collapse inside preserve markers (they'll be restored later)
    return line.replace(/  +/g, ' ');
  }).join('\n');

  // Step 6: Trim leading/trailing whitespace
  working = working.trim();

  // Step 7: Restore preserved blocks
  working = working.replace(/\x00PRESERVE_(\d+)\x00/g, (_, idx) => preserved[Number(idx)]);

  return working;
}

/**
 * Apply field interpolation to all string values in card.body recursively.
 * Handles {$body.X} references within field values.
 */
function applyFieldInterpolation(card) {
  if (!card.body) return;

  const context = {
    body: card.body,
    name: card.name,
    pronouns: card.pronouns,
    aid: card.aid || {},
    render: card.render || {},
    id: card.id,
  };

  applyInterpolationRecursive(card.body, context);
}

function applyInterpolationRecursive(obj, context) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      obj[key] = processFieldInterpolation(val, context);
    } else if (Array.isArray(val)) {
      obj[key] = val.map(item => typeof item === 'string' ? processFieldInterpolation(item, context) : item);
    } else if (typeof val === 'object' && val !== null) {
      applyInterpolationRecursive(val, context);
    }
  }
}

function processFieldInterpolation(value, context) {
  if (typeof value !== 'string') return value;
  // Only expand {$body.X} style refs within field values
  // Pronoun tokens ({$she} etc.) and {$Id} refs are left for the pronoun pass
  return value.replace(/\{(\$body\.[^{}]+)\}/g, function(match, ref) {
    const resolved = resolveField(ref.trim(), context);
    if (resolved === null) return '';
    return renderScalar(resolved);
  });
}

/**
 * Look up a template name. For style:'hint', tries templateName.hint first.
 */
function resolveTemplateName(templateName, style) {
  if (style === 'hint') return templateName + '.hint';
  return templateName;
}

/**
 * Render a template string with the given card data.
 *
 * Pipeline:
 *   1. Escape {{ }} [[ ]] → sentinels
 *   2. Expand {include ...} partials
 *   3. processConditionals
 *   4. processWrapperBlocks
 *   5. processInline
 *   6. Restore sentinels → literal { } [ ]
 *   7. normalizeWhitespace
 *
 * @param {string} template
 * @param {object} data - card data; body fields accessed via {$body.X}
 * @param {Map} partials
 */
function render(template, data, partials) {
  if (!partials) partials = new Map();

  // Step 1: Escape literal delimiters
  let result = template
    .replace(/\{\{/g, S_LBRACE)
    .replace(/\}\}/g, S_RBRACE)
    .replace(/\[\[/g, S_LBRACKET)
    .replace(/\]\]/g, S_RBRACKET);

  // Step 2: Expand partials
  result = processIncludes(result, partials);

  // Step 3: Conditionals
  result = processConditionals(result, data);

  // Step 4: Wrapper blocks
  result = processWrapperBlocks(result, data);

  // Step 5: Inline expressions
  result = processInline(result, data);

  // Step 6: Restore sentinels
  result = result
    .replace(new RegExp(S_LBRACE.replace(/\x00/g, '\\x00'), 'g'), '{')
    .replace(new RegExp(S_RBRACE.replace(/\x00/g, '\\x00'), 'g'), '}')
    .replace(new RegExp(S_LBRACKET.replace(/\x00/g, '\\x00'), 'g'), '[')
    .replace(new RegExp(S_RBRACKET.replace(/\x00/g, '\\x00'), 'g'), ']');

  // Step 7: Whitespace normalization
  result = normalizeWhitespace(result);

  // Post-render: if card has render.wrapper and template didn't use {wrapper} block, wrap entire output
  if (data.render && data.render.wrapper && data.render.wrapper !== 'none') {
    // Only wrap if the content doesn't already start with the wrapper bracket
    const w = data.render.wrapper.toLowerCase();
    const alreadyWrapped =
      (w === 'square' && result.startsWith('[') && result.endsWith(']')) ||
      (w === 'curly'  && result.startsWith('{') && result.endsWith('}'));
    if (!alreadyWrapped) {
      result = applyWrapper(result, data.render.wrapper);
    }
  }

  return result;
}

module.exports = {
  render,
  resolveField,
  applyFieldInterpolation,
  processConditionals,
  processInline,
  processIncludes,
  processWrapperBlocks,
  normalizeWhitespace,
  applyWrapper,
  resolveTemplateName,
  isTruthy,
  evaluateJoin,
  evaluateList,
  evaluateAnd,
  evaluateProse,
  evaluateBlock,
  evaluateKeys,
  evaluateInline,
};
