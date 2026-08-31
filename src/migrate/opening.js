'use strict';

/**
 * v3 `opening.yaml` → a v4 component document (v4 spec §7.1, §7.2, §14.2).
 *
 * §7.1 counts four syntaxes for "an ordered collection of content with per-branch dispatch",
 * and the Opening was the fourth. `src/opening.js` held an anonymous ordered block list with
 * a `variants:` vocabulary of its own — a block's variant was `{text:}` and nothing else,
 * its dispatch took the *first* name and discarded the rest where `sectionsForBranch` stacks
 * them all, and a missing variant was an uncoded `console.warn`. All of it is gone; an
 * opening is an ordinary component now.
 *
 * ── Two things this conversion has to decide, and how ───────────────────────
 *
 * **Blocks have no names and sections must.** A name is what §7.2 makes load-bearing: an
 * anonymous block cannot be overridden, repositioned or deleted with `~` by an importing
 * project. Names are taken from the comment above a block where the author left one, and are
 * otherwise `block1`, `block2` — generated names an author can rename freely, since nothing
 * imports them yet at migration time.
 *
 * **`text:` was overloaded and stops being.** `resolveBlockText` decided whether a block's
 * `text:` was prose or a path by testing whether the string resolved to a file on disk, so a
 * block whose text happened to look like a path was silently read as one. The sections
 * grammar has `text:` and `file:` as separate keys, so the question gets asked once here
 * rather than on every compile.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const { walkBranchTree } = require('../model/branches');

const NL = '\n';
const SPLIT_LINES = /\r?\n/;

/** A comment line reads as a block name when it is short and not a divider. */
function nameFromComment(line) {
  const stripped = String(line).replace(/^#+\s*/, '').replace(/[─―—=-]+/g, ' ').trim();
  if (!stripped || stripped.length > 40) return null;
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return null;
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('')
    .replace(/[^A-Za-z0-9]/g, '');
}

/**
 * The name for each block, read from the comment lines that precede it in the source.
 *
 * Source text rather than the parsed document, because `yaml`'s parse drops the comments
 * that carry the author's own names for these blocks — `# ── Awakening ──` above a block is
 * the closest thing to a name the v3 format ever had, and throwing it away would mean
 * generating `block1` for a file that already said what its blocks were.
 */
function namesFromSource(source, blockCount) {
  const names = [];
  let pending = null;

  for (const line of source.split(SPLIT_LINES)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      const candidate = nameFromComment(trimmed);
      if (candidate) pending = candidate;
      continue;
    }
    if (/^-\s/.test(trimmed)) {
      names.push(pending);
      pending = null;
    }
  }

  const used = new Set();
  const out = [];
  for (let i = 0; i < blockCount; i += 1) {
    let name = names[i] || `block${i + 1}`;
    while (used.has(name.toLowerCase())) name = `${name}_`;
    used.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** True when a block's `text:` names a file rather than holding prose. */
function looksLikeFile(textSpec, base) {
  if (typeof textSpec !== 'string') return false;
  if (/\r?\n/.test(textSpec)) return false;
  // The same test `resolveBlockText` made at compile time, made once here instead. A
  // `{%variable}` cannot be resolved without the variable table, so a path-shaped string
  // carrying one is treated as a file on its shape alone.
  if (/\{%/.test(textSpec)) return /\.(md|txt)$/i.test(textSpec.trim());
  const resolved = path.resolve(base, textSpec.trim());
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
}

/**
 * Convert a parsed v3 opening block list into the v4 `sections:` record.
 *
 * Returns `{ sections, notes }`, or `null` when the document is not a v3 block list.
 */
function convertOpening(blocks, source, base) {
  if (!Array.isArray(blocks)) return null;

  const names = namesFromSource(source, blocks.length);
  const sections = {};
  const notes = [];

  blocks.forEach((block, index) => {
    if (!block || typeof block !== 'object') return;
    const name = names[index];
    const section = {};

    if (looksLikeFile(block.text, base)) section.file = String(block.text).trim();
    else if (block.text != null) section.text = block.text;

    if (block.branches != null) section.branches = block.branches;

    if (block.variants && typeof block.variants === 'object') {
      // A v3 opening variant was `{text: …}` and nothing else, which is a valid section
      // delta as written — so the vocabulary widens rather than changing, and no variant
      // needs rewriting. What changes is that a dispatch naming two of them now applies
      // both, where v3 applied the first and dropped the rest.
      section.variants = block.variants;
      if (Object.keys(block.variants).length > 1) {
        notes.push(
          `opening section "${name}" has ${Object.keys(block.variants).length} variants. v3 `
          + 'applied only the first name a branch dispatched to and silently discarded the '
          + 'rest; sections apply all of them in order. Check any branch that dispatches to '
          + 'more than one.',
        );
      }
    }

    sections[name] = section;
  });

  const generated = names.filter((n) => /^block\d+_*$/.test(n)).length;
  if (generated > 0) {
    notes.push(
      `${generated} opening block(s) had no comment to take a name from and became `
      + '"blockN". Sections are named so an importing project can override, reposition or '
      + 'delete one (§7.2), so rename them to something meaningful before sharing the file.',
    );
  }

  return { sections, notes };
}

/**
 * Migrate the opening document one project's config points at.
 *
 * A `.md` or inline opening needs no migration and reports so: prose was always prose, and
 * the passthrough path carries it into v4 untouched. Only the YAML block list converts.
 */
function migrateOpeningFiles(configPath, options = {}) {
  const { loadCompileConfig } = require('../config/load');
  const { buildCompileContext } = require('../compile');

  const saved = { log: console.log, warn: console.warn, error: console.error };
  let config;
  try {
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    config = loadCompileConfig(configPath);
  } finally {
    Object.assign(console, saved);
  }

  // Every node that declares one, not just the root: v3 projects routinely give a branch its
  // own opening, and a converter that only looked at the root would leave those behind to
  // fail at compile time with a sequence error.
  const specs = new Set();
  const collect = (components) => {
    if (!components || typeof components !== 'object') return;
    if (typeof components.opening === 'string') specs.add(components.opening);
  };
  // One walk over the config itself rather than root-then-branches rungs (Phase 11 Step
  // 0): the walker visits the project root as a node, and `config.components` reads out
  // of it exactly the way `node.components` reads out of any branch node.
  walkBranchTree(config, ({ node }) => collect(node.components));

  const ctx = buildCompileContext(config, []);
  const notes = [];
  const touched = [];

  for (const rawSpec of specs) {
    const resolved = ctx.componentRefs.opening && String(rawSpec) === String(config.components?.opening)
      ? ctx.componentRefs.opening
      : path.resolve(config._base, String(rawSpec));
    if (!fs.existsSync(String(resolved)) || !/\.ya?ml$/i.test(String(resolved))) continue;

    const source = fs.readFileSync(String(resolved), 'utf8');
    const converted = convertOpening(YAML.parse(source), source, config._base);
    if (!converted) continue;

    const banner = source.split(SPLIT_LINES)
      .filter((line) => line.trim().startsWith('#') && !nameFromComment(line))
      .join(NL);
    const text = (banner ? banner + NL : '')
      + YAML.stringify({ sections: converted.sections }, { lineWidth: 0 });
    if (!options.dryRun) fs.writeFileSync(String(resolved), text, 'utf8');

    touched.push(String(resolved));
    notes.push(
      `${path.basename(String(resolved))}: ${Object.keys(converted.sections).length} opening `
      + 'block(s) became named sections.',
      ...converted.notes,
    );
  }

  if (touched.length === 0) return { notes: ['no block-list opening to migrate.'], touched: [] };
  return { notes, touched };
}

module.exports = { convertOpening, migrateOpeningFiles, namesFromSource };
