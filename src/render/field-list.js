'use strict';

/**
 * The declaration-driven emitter (v4 spec §13.2–§13.3, Phase 12 Step 1).
 *
 * A field-list template is an ordered list of field and group names (§13.3). This module
 * turns that list, plus the field declarations it names, into rendered body text.
 *
 * ── How it renders ──────────────────────────────────────────────────────────
 *
 * It does not re-implement conditionals, render functions, `{wrapper}` or whitespace
 * normalization. It *generates* the `.template` source each declaration is shorthand for —
 * `{if $body.x}\nLabel: {join("; ", $body.x)}\n{/if}` — concatenates the stanzas, and hands
 * the result to `render()`. So a field list and the hand-written `.template` it replaces go
 * through one identical code path, which is what makes byte-identity between the two a real
 * property rather than a coincidence of two emitters agreeing (Verified claim 10: the
 * renderer already normalizes indentation and blank lines, so the emitter only has to
 * produce the un-normalized equivalent, not imitate a partial's exact formatting).
 */

const { render } = require('../template');
const { FUNCTION_NAMES } = require('./parse');

/** Bracket pairs `wrap:` understands. A two-character string is taken as open+close. */
function wrapChars(wrap) {
  const w = String(wrap);
  if (w === '[]') return ['[', ']'];
  if (w === '{}') return ['{', '}'];
  if (w === '()') return ['(', ')'];
  if (w.length === 2) return [w[0], w[1]];
  return [w, w];
}

/**
 * A `from:` path (relative to the ref root) or the field's own name → a `$root.…` reference.
 * The root is `body` for a story-card body template and `notes` for a `templateFor.notes`
 * list, matching §4.5's rule that a notes template reads `$notes` rather than `$body`.
 */
function bodyRef(pathOrName, root) {
  const p = String(pathOrName);
  return p.startsWith('$') ? p : `$${root || 'body'}.${p}`;
}

/**
 * Expand a template list into a flat sequence of `{ name, decl }`, resolving group names
 * to their members and merging inline overrides over the base declaration (§13.3).
 *
 * Groups do not nest (§13.3); a group named inside a group is expanded one level and no
 * further, matching the settled non-nesting of item `include:`.
 */
function expandList(list, table) {
  const out = [];
  const pushEntry = (entry, allowGroup) => {
    // Escape hatches for the parts §13.6 keeps as text: `{ include: name }` drops an
    // `{include}` for a partial (the un-declarable name line, the cardHeader/cardFooter
    // wrapper), and `{ raw: "…" }` drops a literal fragment. Both interleave with field
    // names so a mostly-declared template can still carry its one irregular line.
    if (entry && typeof entry === 'object' && (entry.include !== undefined || entry.raw !== undefined)) {
      out.push({ name: null, decl: { __passthrough: entry.include !== undefined ? `{include ${entry.include}}` : String(entry.raw) } });
      return;
    }
    if (typeof entry === 'string') {
      if (allowGroup && table.groups && Array.isArray(table.groups[entry])) {
        for (const member of table.groups[entry]) pushEntry(member, false);
        return;
      }
      out.push({ name: entry, decl: (table.fields && table.fields[entry]) || {} });
      return;
    }
    if (entry && typeof entry === 'object') {
      const name = entry.field || entry.name;
      const base = (name && table.fields && table.fields[name]) || {};
      const { field: _f, name: _n, ...override } = entry;
      out.push({ name, decl: { ...base, ...override } });
    }
  };
  for (const entry of list || []) pushEntry(entry, true);
  return out;
}

/** The render-function expression for one field's value, e.g. `{join("; ", $body.magic)}`. */
function valueExpr(decl, refs) {
  let fn = decl.render;
  if (fn === 'bare') fn = undefined;
  if (!fn && decl.join !== undefined) fn = 'join';
  if (fn === 'join') {
    const sep = decl.join !== undefined ? String(decl.join) : '; ';
    return `{join("${sep}", ${refs.join(', ')})}`;
  }
  if (fn && FUNCTION_NAMES.includes(fn)) {
    return `{${fn}(${refs[0]})}`;
  }
  return `{${refs[0]}}`;
}

/** The label fragment — a plain string, or a `labelWhen` conditional (§13.2). */
function labelExpr(decl, refRoot) {
  if (decl.labelWhen && typeof decl.labelWhen === 'object') {
    const [whenKey, altLabel] = Object.entries(decl.labelWhen)[0] || [];
    if (whenKey) {
      return `{if ${bodyRef(whenKey, refRoot)}}${altLabel}{else}${decl.label || ''}{/if}`;
    }
  }
  return decl.label !== undefined && decl.label !== null ? String(decl.label) : null;
}

/** One field declaration → the `.template` stanza it is shorthand for. */
function stanzaSource({ name, decl }, refRoot) {
  if (decl && decl.__passthrough !== undefined) return decl.__passthrough;
  const fromPaths = decl.from !== undefined
    ? (Array.isArray(decl.from) ? decl.from : [decl.from])
    : [name];
  const refs = fromPaths.map((p) => bodyRef(p, refRoot));
  const value = valueExpr(decl, refs);
  const label = labelExpr(decl, refRoot);

  let body;
  if (label === null) {
    body = value;
  } else if (decl.block) {
    body = `${label}:\n${value}`;
  } else {
    body = `${label}: ${value}`;
  }

  if (decl.wrap) {
    const [l, r] = wrapChars(decl.wrap);
    if (decl.wrapLabel || label === null) {
      body = `${l}${body}${r}`;
    } else if (decl.block) {
      body = `${label}:\n${l}${value}${r}`;
    } else {
      body = `${label}: ${l}${value}${r}`;
    }
  }

  if (decl.always) return body;
  return `{if ${refs[0]}}\n${body}\n{/if}`;
}

/**
 * Render a field-list template.
 *
 * @param {Array}  list      the ordered field/group list (a `templates:` entry, §13.3)
 * @param {object} table     the merged field table (`{ fields, groups }`)
 * @param {object} context   the item render context (`util.itemContext`)
 * @param {object} [options] `{ diagnostics, file, name, partials, variables, refRoot }` —
 *   the first five pass through to `render()`; `refRoot` ('body' by default, 'notes' for a
 *   `templateFor.notes` list) picks which namespace the field paths read.
 * @returns {string}
 */
function renderFieldList(list, table, context, options = {}) {
  const stanzas = expandList(list, table).map((f) => stanzaSource(f, options.refRoot));
  const source = stanzas.join('\n\n');
  return render(source, context, options.partials, options.variables, {
    diagnostics: options.diagnostics,
    file: options.file,
    name: options.name,
  });
}

module.exports = { renderFieldList, expandList, stanzaSource };
