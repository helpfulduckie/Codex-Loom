'use strict';

/**
 * Named transforms for a section's `from:` source (v4 spec §7.7).
 *
 * A section may take its text from a file rather than from `text:`, and `from: {script:,
 * extract:}` names *which part* of that file becomes the text. v3 had one such transform
 * and it was not named: `description.yaml`'s `script:` key both located the file and
 * implied the comment-block reading, which is why a second transform would have needed a
 * second config key and a second loader. Here the reading is a table row.
 *
 * The table is the extension point. Adding a transform is a row plus a function; nothing
 * about the schema, the loader or the emitter changes, and an unknown name is CL0618
 * naming the roster rather than a source that silently produces nothing.
 */

const fs = require('fs');

/**
 * The leading comment block of a JavaScript file, cleaned up for prose.
 *
 * Rules, applied after stripping the `//` prefix and trimming:
 *   - Pure separator lines (all `=`)  → group boundary
 *   - Banner title lines (`=`-padded) → `=== title ===`
 *   - Empty lines                     → dropped
 *   - Everything else                 → kept as written
 *
 * ── The trailing group is always dropped, and that is a decision ────────────
 *
 * v3 put this behind `stripTrailingInstructions:`, a config flag tuning a heuristic. §7.7
 * deletes the flag and asks the extractor to pick one behavior against the real banners,
 * and the corpus answers it: both projects that use a script banner set the flag `true`
 * and none sets it `false`. What it removes is the install note — Baseline's banner ends
 * "Paste this ONLY into the library tab in AI Dungeon scripting", which is addressed to
 * whoever installs the mod and has no business in a store listing.
 *
 * The heuristic is narrow enough to be safe unattended: it fires only when an *earlier*
 * group carried list items and the final one does not, so a banner that is entirely prose
 * keeps all of it, and a banner whose last group is itself a list keeps that too.
 *
 * Returns the extracted text, or '' when the file opens with no comment block.
 */
function scriptBanner(source) {
  const rawLines = source.split(/\r?\n/);

  // Contiguous `//` lines from the top of the file, leading blanks skipped.
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

/** The roster CL0618 names. Keyed by the spelling an author writes in `extract:`. */
const EXTRACTORS = Object.freeze({
  scriptBanner,
});

/**
 * Run one named extractor over a file's contents.
 *
 * Returns `{ text }` on success and `{ error }` on an unknown name, rather than throwing:
 * the caller holds the source map and the component label, so it is the only place that
 * can say *which* section named the transform.
 */
function runExtractor(name, source) {
  const fn = EXTRACTORS[name];
  if (!fn) {
    return { error: `unknown extract: "${name}" — the transforms available are ${Object.keys(EXTRACTORS).map((k) => `"${k}"`).join(', ')}.` };
  }
  return { text: fn(source) };
}

/** Read a file for an extractor. Separate so the extractors themselves stay pure. */
function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

module.exports = { EXTRACTORS, runExtractor, readSource, scriptBanner };
