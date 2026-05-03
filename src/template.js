'use strict';

/**
 * Template engine for AID card compiler.
 *
 * Supported syntax:
 *   {$field}                         - interpolate top-level card field
 *   {$fields.Field Name}             - interpolate field value (case-insensitive)
 *   {$fields.Field Name.subfield}    - interpolate subfield value (case-insensitive)
 *   {join("sep", $f1, $f2, ...)}     - join present values with separator
 *   {if $field}...{else}...{/if}     - conditional block (else optional)
 *   {$she} {$her~} etc.              - pronoun tokens (resolved before template render)
 *   {{  }}                           - literal braces
 */

// Pronoun tokens that should NOT be processed by field interpolation.
// These are handled by the pronoun pass instead.
const PRONOUN_TOKENS = new Set([
  'she', 'he', 'they',
  'her', 'him', 'them',
  'her~', 'his~', 'their~',
  'herself', 'himself', 'themselves',
  "she's", "he's", "they're",
]);

/**
 * Case-insensitive deep field resolver.
 * Resolves paths like "fields.Physical Traits.gender" against card data.
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
  if (typeof value === 'object') return null;

  const str = String(value).trim();
  return str === '' ? null : str;
}

/**
 * Evaluate boolean truthiness of a field reference.
 */
function isTruthy(ref, data) {
  const val = resolveField(ref, data);
  if (val === null) return false;
  if (val.toLowerCase() === 'false') return false;
  if (val === '0') return false;
  return true;
}

/**
 * Evaluate a {join("sep", $f1, $f2, ...)} call.
 */
function evaluateJoin(inner, data) {
  const sepMatch = inner.match(/^join\(\s*"([^"]*)"\s*,(.+)\)$/s);
  if (!sepMatch) throw new Error('Malformed join(): ' + inner);

  const separator = sepMatch[1];
  const argsPart = sepMatch[2];
  const refs = argsPart.split(',').map(s => s.trim()).filter(Boolean);

  const values = refs
    .map(ref => resolveField(ref, data))
    .filter(v => v !== null);

  return values.join(separator);
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
 * Process field interpolation in card field values.
 * Handles {$fields.Field Name} references within field text.
 * Skips pronoun tokens — those are handled by the pronoun pass.
 */
function processFieldInterpolation(value, card) {
  if (typeof value !== 'string') return value;

  return value.replace(/\{(\$[^{}]+)\}/g, function(match, ref) {
    ref = ref.trim();
    if (!ref.startsWith('$')) return match;

    // Skip pronoun tokens
    const bare = ref.slice(1).toLowerCase();
    if (PRONOUN_TOKENS.has(bare)) return match;

    const context = {
      name: card.name,
      type: card.type,
      template: card.template,
      pronouns: card.pronouns,
      protagonist: card.protagonist,
      encapsulate: card.encapsulate,
      known: card.known,
      triggers: card.triggers,
      fields: card.fields || {},
    };

    const resolved = resolveField(ref, context);
    return resolved !== null ? resolved : '';
  });
}

/**
 * Apply field interpolation to all string values in card.fields recursively.
 */
function applyFieldInterpolation(card) {
  if (!card.fields) return;
  applyInterpolationRecursive(card.fields, card);
}

function applyInterpolationRecursive(obj, card) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      obj[key] = processFieldInterpolation(val, card);
    } else if (typeof val === 'object' && val !== null) {
      applyInterpolationRecursive(val, card);
    }
  }
}

/**
 * Process all inline {$field} and {join(...)} expressions in template rendering.
 */
function processInline(template, data) {
  return template.replace(/\{([^{}]+)\}/g, function(match, inner) {
    inner = inner.trim();

    if (inner.startsWith('join(')) {
      try {
        return evaluateJoin(inner, data);
      } catch (e) {
        console.warn('  WARN: ' + e.message);
        return '';
      }
    }

    if (inner.startsWith('$')) {
      const val = resolveField(inner, data);
      return val === null ? '' : val;
    }

    return match;
  });
}

/**
 * Remove all blank lines from a string.
 */
function removeBlankLines(str) {
  return str
    .split('\n')
    .filter(function(line) { return line.trim() !== ''; })
    .join('\n');
}

/**
 * Render a template string with the given card data.
 */
function render(template, data) {
  let result = template
    .replace(/\{\{/g, '\x00LBRACE\x00')
    .replace(/\}\}/g, '\x00RBRACE\x00');

  result = processConditionals(result, data);
  result = processInline(result, data);

  result = result
    .replace(/\x00LBRACE\x00/g, '{')
    .replace(/\x00RBRACE\x00/g, '}');

  result = removeBlankLines(result);

  return result;
}

module.exports = { render, resolveField, applyFieldInterpolation };
