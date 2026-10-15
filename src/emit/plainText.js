'use strict';

/**
 * Markdown to plain text, for the Description frontmatter field that Velvet Lattice shows
 * where markdown does not render. Line structure survives (one newline stays one newline,
 * a blank line stays a paragraph break); only the markup characters go.
 */

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}#{1,6}(?:\s+|$)/;
const QUOTE = /^\s*(?:>\s?)+/;
const LIST = /^\s*(?:[-*+]|\d+[.)])\s+/;

// Emphasis markers must hug their text, and underscore forms must sit at a word edge, so
// `5 * 3` and `snake_case_name` come through untouched.
const INLINE = [
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/`+([^`]*)`+/g, '$1'],
  [/(?<![\w*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\w*])/g, '$1'],
  [/(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, '$1'],
  [/(?<![\w*])\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?![\w*])/g, '$1'],
  [/(?<![\w_])_(?=[^\s_])([^_]+?)(?<=[^\s_])_(?![\w_])/g, '$1'],
  [/~~(?=\S)(.+?)(?<=\S)~~/g, '$1'],
];

function stripMarkdown(text) {
  if (typeof text !== 'string') return '';
  const withoutHtml = text
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[A-Za-z][^>\n]*>/g, '');

  const out = [];
  let inFence = false;
  for (const raw of withoutHtml.split('\n')) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      out.push('');
    } else if (inFence) {
      out.push(raw.trim());
    } else if (RULE.test(raw)) {
      out.push('');
    } else {
      let line = raw.replace(HEADING, '').replace(QUOTE, '').replace(LIST, '');
      for (const [pattern, replacement] of INLINE) line = line.replace(pattern, replacement);
      out.push(line.trim());
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { stripMarkdown };
