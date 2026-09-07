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
 * ── Per-chapter completeness ──────────────────────────────────────────────────
 *
 * **Every numbered chapter is pointed at by at least one example `# doc:` site**, unless it
 * is in EXEMPT with a reason. This is what makes a chapter rename or a heading reword fail
 * loudly instead of silently orphaning every pointer that named it. It was held off until
 * all four example projects existed, since a chapter for a construct no example used yet
 * would have failed for an honest reason. EXEMPT is deliberately small: an entry there is a
 * chapter no compiling example *can* point at, not one nobody got to.
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

describe('every numbered chapter has a worked example pointing back at it', () => {
  // A chapter no compiling example can point at, with why. Not "nobody wrote one yet" — that
  // failure is the point of this check. Removing an entry is how a new example that finally
  // covers the chapter proves it did.
  const EXEMPT = {
    '12-snapshot.md':
      '`--snapshot` writes an absolute source: path and a wall-clock syncedAt into a '
      + 'committed manifest, so no example can carry a byte baseline for it until those are '
      + 'made project-relative (its own compiler session — see Example Projects plan, Watch).',
    '15-migrating-from-v3.md':
      'v3 migration coverage retires with goldenFixtures/ (Example Projects plan, "Decisions '
      + 'already taken"); no committed v3-shaped example is built for it.',
  };

  const chapters = fs.readdirSync(DOCS).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
  const referenced = new Set(refs.map((r) => r.chapter));

  test.each(chapters.map((c) => [c, c]))('%s', (_label, chapter) => {
    if (referenced.has(chapter)) return;
    if (chapter in EXEMPT) return;
    throw new Error(
      `documentation/${chapter} has no example '# doc:' pointer.\n`
      + 'Add one at a construct site in an example project, or — only if no compiling example '
      + `can point at it — add it to EXEMPT in ${path.basename(__filename)} with the reason.`,
    );
  });

  test('every EXEMPT entry names a real chapter that is still unreferenced', () => {
    // A renamed chapter must not leave a dead exemption behind, and an exemption that a new
    // example has made unnecessary must be deleted rather than left masking a real gap.
    const stale = Object.keys(EXEMPT).filter(
      (c) => !chapters.includes(c) || referenced.has(c),
    );
    expect(stale).toEqual([]);
  });
});
