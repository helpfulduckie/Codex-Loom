'use strict';

/**
 * The example → documentation direction of the doc binding.
 *
 * `doc-examples.test.js` runs the other way: a chapter block declares `from=` and the test
 * checks the example it cites still exists and still says what the chapter claims. This file
 * checks that the example projects' own pointers back into `documentation/` resolve — the
 * failure that direction cannot see, because a chapter reorganized or a heading reworded
 * leaves the chapter's own blocks untouched and silently orphans every comment pointing at
 * them.
 *
 * ── The convention ────────────────────────────────────────────────────────────
 *
 * A construct site in an example carries a comment naming the chapter that explains it, and
 * optionally the heading within it:
 *
 *     # doc: 05-branches-and-variants.md
 *     # doc: 10-field-declarations.md#tiering-a-shorter-rendering-per-branch
 *
 * Anchors are GitHub-style slugs of a heading's text. They are checked because an unchecked
 * anchor is worse than none: **a broken anchor never displays as broken** — the link opens
 * the chapter at the top and the reader never learns they were sent to the wrong place. That
 * silence is the whole reason this test exists rather than a lint rule nobody runs.
 *
 * ── What is deliberately not asserted yet ─────────────────────────────────────
 *
 * **Per-chapter completeness — every chapter referenced by at least one example — is not
 * here.** Only `showcase` exists so far, and a chapter covering a construct it does not use
 * would fail for the honest reason that the example is not written yet. That assertion lands
 * once the three concept projects do, and turning it on is the step that makes a doc reorg
 * fail loudly rather than quietly. Until then the floor below keeps the convention from
 * dying unnoticed.
 */

const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '../../documentation');
const EXAMPLES = path.join(__dirname, '../../examples');

/** Source files in an example project — never its compiled output or reports. */
function exampleSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'output' && entry.name !== 'Review') exampleSources(abs, out);
      continue;
    }
    if (/\.(ya?ml|template|md)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

/**
 * GitHub's heading slug: lowercased, punctuation dropped, spaces hyphenated. Backticks and
 * the `§` sign both appear in these chapters' headings and both vanish under this rule, so
 * `## \`templateFor\` — Selecting Lists Per Branch` slugs to
 * `templatefor--selecting-lists-per-branch`.
 */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

function headingSlugs(file) {
  return fs.readFileSync(path.join(DOCS, file), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => slug(line.replace(/^#{1,6}\s+/, '')));
}

/** Every `# doc:` pointer in every example source, with where it was written. */
function collectRefs() {
  const refs = [];
  for (const abs of exampleSources(EXAMPLES)) {
    const rel = path.relative(EXAMPLES, abs).replace(/\\/g, '/');
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = line.match(/#\s*doc:\s*([\w.-]+\.md)(?:#([\w-]+))?/);
      if (m) {
        refs.push({
          where: `examples/${rel}:${i + 1}`, chapter: m[1], anchor: m[2] || null,
        });
      }
    });
  }
  return refs;
}

const refs = collectRefs();

describe('example projects point at documentation that exists', () => {
  test('the convention is in use', () => {
    // A floor, not a target. Without it a refactor that dropped every comment would leave
    // this file green and asserting nothing.
    expect(refs.length).toBeGreaterThanOrEqual(4);
  });

  test.each(refs.map((r) => [`${r.where} → ${r.chapter}${r.anchor ? `#${r.anchor}` : ''}`, r]))(
    '%s',
    (_label, ref) => {
      if (!fs.existsSync(path.join(DOCS, ref.chapter))) {
        throw new Error(
          `${ref.where} points at documentation/${ref.chapter}, which does not exist.\n`
          + `Chapters present: ${fs.readdirSync(DOCS).filter((f) => /^\d\d-/.test(f)).join(', ')}`,
        );
      }
      if (!ref.anchor) return;

      const slugs = headingSlugs(ref.chapter);
      if (!slugs.includes(ref.anchor)) {
        throw new Error(
          `${ref.where} points at documentation/${ref.chapter}#${ref.anchor}, which no heading matches.\n`
          + `A reworded heading breaks this silently — the link still opens the chapter.\n`
          + `Headings there: ${slugs.join(', ')}`,
        );
      }
    },
  );
});

describe('the documentation pointed at is the documentation that ships', () => {
  test('every referenced chapter is a numbered chapter, not the spec or the dev guide', () => {
    // design-spec.md and dev-guide.md are internal — an example is a user-facing artifact and
    // must send a reader somewhere written for them.
    const offenders = refs.filter((r) => !/^\d\d-/.test(r.chapter))
      .map((r) => `${r.where} → ${r.chapter}`);
    expect(offenders).toEqual([]);
  });
});
