'use strict';


const { render } = require('../template');
const { FUNCTION_NAMES, entryName } = require('./parse');

function wrapChars(wrap) {
  const w = String(wrap);
  if (w === '[]') return ['[', ']'];
  if (w === '{}') return ['{', '}'];
  if (w === '()') return ['(', ')'];
  if (w.length === 2) return [w[0], w[1]];
  return [w, w];
}

function bodyRef(pathOrName, root) {
  const p = String(pathOrName);
  return p.startsWith('$') ? p : `$${root || 'body'}.${p}`;
}

function expandList(list, table) {
  const out = [];
  const pushEntry = (entry, allowGroup) => {
    if (entry && typeof entry === 'object' && (entry.include !== undefined || entry.raw !== undefined)) {
      out.push({ name: null, decl: { __passthrough: entry.include !== undefined ? `{include ${entry.include}}` : String(entry.raw) } });
      return;
    }
    if (entry && typeof entry === 'object' && entry.allowExtra !== undefined
      && entry.field === undefined && entry.name === undefined) {
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
      const name = entryName(entry);
      const base = (name && table.fields && table.fields[name]) || {};
      const { field: _f, name: _n, ...override } = entry;
      out.push({ name, decl: { ...base, ...override } });
    }
  };
  for (const entry of list || []) pushEntry(entry, true);
  return out;
}

function isRefEntry(entry) {
  return typeof entry === 'string' && entry.startsWith('$');
}

function inlineGuard(refs, body) {
  if (!refs || refs.length === 0) return body;
  const [first, ...rest] = refs;
  if (rest.length === 0) return `{if ${first}}${body}{/if}`;
  return `{if ${first}}${body}{else}${inlineGuard(rest, body)}{/if}`;
}

function buildPartNode(entry, refRoot) {
  if (isRefEntry(entry)) {
    return { kind: 'ref', source: `{${entry}}`, refs: [entry] };
  }
  if (typeof entry === 'string') {
    return { kind: 'literal', text: entry };
  }
  if (entry && typeof entry === 'object') {
    const { body, refs } = declBody(undefined, entry, refRoot);
    const source = (entry.always || refs.length === 0) ? body : inlineGuard(refs, body);
    return { kind: 'decl', source, refs };
  }
  return { kind: 'literal', text: '' };
}

function assembleParts(nodes) {
  const pieces = nodes.map((node, i) => {
    if (node.kind !== 'literal') return node.source;
    let text = node.text;
    const left = i > 0 ? nodes[i - 1] : null;
    const right = i < nodes.length - 1 ? nodes[i + 1] : null;
    if (left && left.kind !== 'literal') text = inlineGuard(left.refs, text);
    if (right && right.kind !== 'literal') text = inlineGuard(right.refs, text);
    return text;
  });
  const refs = nodes.filter((n) => n.kind !== 'literal').flatMap((n) => n.refs);
  return { source: pieces.join(''), refs };
}

function buildParts(list, refRoot) {
  const nodes = (list || []).map((e) => buildPartNode(e, refRoot));
  return assembleParts(nodes);
}

function buildTryNode(entry, decl, refRoot) {
  if (entry && typeof entry === 'object') {
    return declBody(undefined, entry, refRoot); // { body, refs }
  }
  const refs = [bodyRef(entry, refRoot)];
  return { body: valueExpr(decl, refs), refs };
}

function tryChain(nodes) {
  if (nodes.length === 0) return '';
  const build = (i) => {
    const { body, refs } = nodes[i];
    if (i === nodes.length - 1 || refs.length === 0) return body;
    const fallback = build(i + 1);
    const orGuard = (rs) => {
      const [first, ...rest] = rs;
      if (rest.length === 0) return `{if ${first}}${body}{else}${fallback}{/if}`;
      return `{if ${first}}${body}{else}${orGuard(rest)}{/if}`;
    };
    return orGuard(refs);
  };
  return build(0);
}

function buildTry(list, decl, refRoot) {
  const nodes = (list || []).map((entry) => buildTryNode(entry, decl, refRoot));
  return { source: tryChain(nodes), refs: nodes.flatMap((n) => n.refs) };
}

function litNode(text) {
  return { kind: 'literal', text };
}

function valueNode(source, refs) {
  return { kind: 'ref', source, refs };
}

function concatParts(nodes) {
  return nodes.map((n) => (n.kind === 'literal' ? n.text : n.source)).join('');
}

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

function labelExpr(decl, refRoot) {
  if (decl.labelWhen && typeof decl.labelWhen === 'object') {
    const [whenKey, altLabel] = Object.entries(decl.labelWhen)[0] || [];
    if (whenKey) {
      return `{if ${bodyRef(whenKey, refRoot)}}${altLabel}{else}${decl.label || ''}{/if}`;
    }
  }
  return decl.label !== undefined && decl.label !== null ? String(decl.label) : null;
}

function sugarPartsList(decl, label, value) {
  const bodyNodes = label === null
    ? [value]
    : decl.block
      ? [litNode(label), litNode(':\n'), value]
      : [litNode(label), litNode(': '), value];
  if (!decl.wrap) return bodyNodes;
  const [l, r] = wrapChars(decl.wrap);
  if (decl.wrapLabel || label === null) return [litNode(l), ...bodyNodes, litNode(r)];
  if (decl.block) return [litNode(label), litNode(':\n'), litNode(l), value, litNode(r)];
  return [litNode(label), litNode(': '), litNode(l), value, litNode(r)];
}

function declBody(name, decl, refRoot) {
  let refs;
  let value;
  if (decl.try !== undefined) {
    const built = buildTry(decl.try, decl, refRoot);
    refs = built.refs;
    value = built.source;
  } else if (decl.parts !== undefined) {
    const built = buildParts(decl.parts, refRoot);
    refs = built.refs;
    value = built.source;
  } else {
    const fromPaths = decl.from !== undefined
      ? (Array.isArray(decl.from) ? decl.from : [decl.from])
      : (name !== undefined ? [name] : []);
    refs = fromPaths.map((p) => bodyRef(p, refRoot));
    value = refs.length ? valueExpr(decl, refs) : '';
  }
  const label = labelExpr(decl, refRoot);

  const body = concatParts(sugarPartsList(decl, label, valueNode(value, refs)));

  return { body, refs };
}

function stanzaSource({ name, decl }, refRoot) {
  if (decl && decl.__passthrough !== undefined) return decl.__passthrough;
  const { body, refs } = declBody(name, decl, refRoot);
  if (decl.always || refs.length === 0) return body;
  return guardedStanza(refs, body);
}

function guardedStanza(refs, body) {
  if (refs.length <= 1) return `{if ${refs[0]}}\n${body}\n{/if}`;
  return `{if ${refs[0]}}\n${body}\n{else}${guardedStanza(refs.slice(1), body)}{/if}`;
}

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
