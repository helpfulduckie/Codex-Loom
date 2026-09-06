'use strict';


function scriptBanner(source) {
  const rawLines = source.split(/\r?\n/);

  const commentLines = [];
  let inComment = false;
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!inComment && trimmed === '') continue;
    if (!trimmed.startsWith('//')) break;
    inComment = true;
    commentLines.push(trimmed);
  }

  const isSeparator   = (s) => /^=+$/.test(s);
  const isBannerTitle = (s) => /^=+\s+.+\s+=+$/.test(s);
  const isListItem    = (s) => /^[-*]/.test(s);
  const extractTitle  = (s) => s.replace(/^=+\s+/, '').replace(/\s+=+$/, '').trim();

  const groups = [];
  let current = [];

  for (const raw of commentLines) {
    const stripped = raw.replace(/^\/\/\s?/, '').trim();

    if (isSeparator(stripped)) {
      if (current.length > 0) { groups.push(current); current = []; }
    } else if (isBannerTitle(stripped)) {
      current.push(`=== ${extractTitle(stripped)} ===`);
    } else if (stripped !== '') {
      current.push(stripped);
    }
  }
  if (current.length > 0) groups.push(current);

  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    const earlierHaveList = groups.slice(0, -1).some((g) => g.some(isListItem));
    if (earlierHaveList && !last.some(isListItem)) groups.pop();
  }

  return groups.flat().join('\n');
}

const EXTRACTORS = Object.freeze({
  scriptBanner,
});

function runExtractor(name, source) {
  const fn = EXTRACTORS[name];
  if (!fn) {
    return { error: `unknown extract: "${name}" — the transforms available are ${Object.keys(EXTRACTORS).map((k) => `"${k}"`).join(', ')}.` };
  }
  return { text: fn(source) };
}

module.exports = { EXTRACTORS, runExtractor, scriptBanner };
