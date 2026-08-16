'use strict';

/**
 * The component descriptor table (v4 spec §7.3, §3.3).
 *
 * §3.3 asks for components to be table-driven so that adding one is a table row rather
 * than another bespoke block in `compile()`. This is the Phase 1 slice of that: the
 * wiring becomes a table, the behavior and the emitted bytes do not change. The item/slot
 * model (§7.2) is Phase 3.
 *
 * ── The table describes declaration, not file locations ─────────────────────
 *
 * §7.3 gives each component an "Inherits down the tree?" column, which reads as a
 * property of the component. It is not — it is a property of Codex Loom's emitter.
 * Velvet Lattice inherits components, scripts, placeholders and story cards down the
 * branch tree by itself (`velvet_lattice/scenario.py`), local entries overriding parent
 * ones by key. Codex Loom writes a copy into every leaf because that was simpler when
 * branches were first built, and the cost is large: 90% of The Institute's compiled
 * output is byte-identical duplication.
 *
 * So `declaration` below says how a component *merges down the branch chain*, which is a
 * real and permanent property, and where the bytes land is the emit strategy's business.
 * Today there is one strategy — duplicate to every leaf, exactly as v3 did. Adopting
 * VL-native inheritance later is a strategy swap and a re-baseline, not a table rewrite.
 * See the vault note "VL inheritance and output duplication".
 */

const fs = require('fs');
const path = require('path');

const { loadAINConfig, compileAIN, writeAIN } = require('../ain');
const { loadANConfig, compileAN, writeAN } = require('../an');
const { sectionsForBranch, WRAP } = require('../model/component');
const { applyWrapper } = require('../template');
const { applyTokenPass } = require('../model/pronouns');
const {
  resolveVariables, warnUnexpandedVariables, warnUnresolvedFieldTokens, warnMechanicalArtifacts,
} = require('../util');

/**
 * How a component's spec merges down the branch chain.
 *
 *   INHERITED  a child inherits the parent's value unless it declares its own
 *   NODE       belongs to the declaring node alone; never inherited
 *   PROJECT    declared once at the root; there is nothing to merge
 */
const DECLARATION = Object.freeze({
  INHERITED: 'inherited',
  NODE: 'node',
  PROJECT: 'project',
});

/**
 * Components that are one document: a spec resolving either to prose passed through
 * verbatim (`.md`/`.txt`) or to a YAML document that is loaded and compiled.
 *
 * AI Instructions and Author's Note were two near-identical twenty-line blocks in
 * `compile()`, differing only in loader, compiler, writer and label. They are now two
 * rows. `summary:` (§7.3) becomes a third when Phase 6 lands.
 */
const DOCUMENT_COMPONENTS = Object.freeze([
  {
    key: 'aiInstructions',
    label: 'AI Instructions',
    verboseLabel: 'AIInstructions',
    declaration: DECLARATION.INHERITED,
    load: loadAINConfig,
    // compileAIN also returns a storyCard; only the document half is written here.
    compile: (doc, registry, context) => compileAIN(doc, registry, context).ain,
    write: writeAIN,
  },
  {
    key: 'authorsNote',
    label: "Author's Note",
    verboseLabel: 'AuthorsNote',
    declaration: DECLARATION.INHERITED,
    load: loadANConfig,
    compile: compileAN,
    write: writeAN,
  },
]);

/**
 * Components built from `sections:`, some of which are slots items route into (§7.2).
 *
 * Plot Essentials is the first row and, until step 8, the only one. `defaultHeadingLevel`
 * is a column rather than a constant because v3's two formats disagree about what a bare
 * `heading:` means — Plot Essentials reads it as level 0 and AI Instructions as level 2 —
 * and both are right for their own output. `model/component.js` therefore carries
 * `headingLevel` through unset, and the default is applied here, where the component is
 * known.
 */
const SLOTTED_COMPONENTS = Object.freeze([
  {
    key: 'plotEssential',
    label: 'Plot Essentials',
    file: 'Plot Essentials.md',
    declaration: DECLARATION.INHERITED,
    verboseLabel: 'PlotEssentials',
    defaultHeadingLevel: 0,
  },
]);

/** Components handled by their own pipelines, listed so the table is the whole picture. */
const OTHER_COMPONENTS = Object.freeze([
  { key: 'description', label: 'Description', declaration: DECLARATION.PROJECT, note: 'own pipeline — project-level, three source shapes' },
  { key: 'opening', label: 'Opening', declaration: DECLARATION.INHERITED, note: 'written at leaves; inherits down the tree' },
  { key: 'branchFraming', label: 'Branch framing', declaration: DECLARATION.NODE, note: 'written at non-leaf nodes; v3 spelling openingChoice' },
  { key: 'scripts', label: 'Scripts', declaration: DECLARATION.INHERITED, note: 'file copy, not a rendered document (§6.3)' },
]);

const PASSTHROUGH_EXTENSIONS = new Set(['.md', '.txt']);

/**
 * Emit one document component for one branch leaf.
 *
 * Returns `{ content, written, gap }` — `gap` is a reason string when the component was
 * requested and produced nothing, which is what the caller reports.
 */
function emitDocumentComponent(descriptor, spec, options) {
  const { outputDir, registry, compileContext, verbose = false } = options;

  if (!spec) return { content: null, written: null, gap: null };
  if (typeof spec !== 'string' || !fs.existsSync(spec)) {
    return { content: null, written: null, gap: 'source not found' };
  }

  const extension = path.extname(spec).toLowerCase();
  const content = PASSTHROUGH_EXTENSIONS.has(extension)
    ? (fs.readFileSync(spec, 'utf8').trimEnd() || null)
    : descriptor.compile(descriptor.load(spec), registry, compileContext);

  const written = descriptor.write(outputDir, content);
  if (written && verbose) console.log(`    OK: ${descriptor.verboseLabel} → ${written}`);

  return {
    content,
    written: written || null,
    gap: written ? null : 'compiled to empty content',
  };
}

// ── Sectioned components (§7.2, §7.4) ────────────────────────────────────────

/**
 * Blocks that stand on their own are separated by a blank line; lines sharing one wrapper
 * are not. That single rule produces both of v3's behaviors without a special case:
 * `wrap: each` emits several wrapped blocks and joins them with `BLOCK_GAP`, `wrap: all`
 * emits one wrapper around occupants joined with `LINE_GAP`, and sections join with
 * `BLOCK_GAP` because a section is a block.
 */
const BLOCK_GAP = '\n\n';
const LINE_GAP = '\n';

/** `heading` as it is written into the output, or null when the section has none. */
function headingText(section, defaultHeadingLevel) {
  if (!section.heading) return null;
  const level = section.headingLevel === undefined ? defaultHeadingLevel : section.headingLevel;
  return level > 0 ? `${'#'.repeat(level)} ${section.heading}` : section.heading;
}

/** The lines of a text section's own content, variables and tokens resolved. */
function textLines(section, options) {
  const { variables = {}, registry, branchProtagonist } = options;
  const prefix = section.bullet ? '- ' : '';
  const resolve = (value) => {
    const withVars = resolveVariables(String(value), variables);
    return prefix + applyTokenPass(withVars, { item: {}, registry, branchProtagonist }).trim();
  };

  const text = section.text;
  if (typeof text === 'string') return text.trim() ? [resolve(text)] : [];
  if (text && typeof text === 'object') {
    return Object.values(text).filter((v) => v !== null && v !== undefined).map(resolve);
  }
  return [];
}

/**
 * One section's contribution to the output, or null when it contributes nothing.
 *
 * A slot with no occupants returns null rather than an empty wrapper — an empty cast on
 * one branch is legitimate (§7.4 makes it a WARN, raised in step 7), and shipping `[\n\n]`
 * for it would be worse than shipping nothing.
 */
function renderSection(section, occupants, options) {
  const { defaultHeadingLevel = 0 } = options;
  const heading = headingText(section, defaultHeadingLevel);

  if (section.isSlot) {
    const bodies = occupants.map((o) => o.text).filter((t) => t && t.trim());
    if (bodies.length === 0) return null;

    // The slot owns the wrapping and the item's own `render.wrapper` is ignored (§7.4);
    // `wrap` decides only whether that wrapper encloses each occupant or the collection.
    if (section.wrap === WRAP.ALL) {
      const lines = [];
      if (heading) {
        lines.push(heading);
        if (!section.compact) lines.push('');
      }
      lines.push(bodies.join(LINE_GAP));
      return applyWrapper(lines.join(LINE_GAP), section.wrapper);
    }

    const blocks = bodies.map((body) => applyWrapper(body, section.wrapper));
    if (!heading) return blocks.join(BLOCK_GAP);
    // The heading sits outside the wrappers here, because there is no single wrapper for
    // it to sit inside — that is the whole difference `wrap: all` expresses.
    return [heading, blocks.join(BLOCK_GAP)].join(section.compact ? LINE_GAP : BLOCK_GAP);
  }

  const lines = textLines(section, options);
  if (!heading && lines.length === 0) return null;

  const parts = [];
  if (heading) {
    parts.push(heading);
    if (lines.length > 0 && !section.compact) parts.push('');
  }
  parts.push(...lines);
  return applyWrapper(parts.join(LINE_GAP), section.wrapper);
}

/**
 * Render a whole sectioned component for one branch leaf.
 *
 * Returns `{ text, segments }`. `segments` is the same content un-joined and keyed by
 * section name, which is what the cross-branch reports compare — §7.2's naming made
 * load-bearing a second time: v3 could only diff Plot Essentials as one opaque blob for
 * exactly the reason it could never make a component importable, namely that its blocks
 * had no names.
 *
 * `occupants` is a Map keyed by lowercased slot name. Sorting happens here rather than at
 * the call site so that `order:` then item id (§7.4) is stated once — filesystem traversal
 * order must never reach the output, and the only way to be sure of that is for the sort
 * to have no other input.
 */
function renderSectionedComponent(component, branchPath, occupants, options = {}) {
  if (!component) return { text: null, segments: [] };

  const segments = [];
  for (const { section } of sectionsForBranch(component, branchPath)) {
    const placed = section.isSlot
      ? (occupants.get(section.name.toLowerCase()) || []).slice().sort(
        (a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)),
      )
      : [];
    const text = renderSection(section, placed, options);
    if (text && text.trim()) segments.push({ key: `section:${section.name}`, text });
  }

  return {
    text: segments.length > 0 ? segments.map((s) => s.text).join(BLOCK_GAP) : null,
    segments,
  };
}

/**
 * Write a sectioned component's output file, or return null when there is nothing to say.
 *
 * The three unexpanded-token checks run here rather than at the section level because they
 * report per file, and a `{%var}` that survived is equally wrong wherever in the document
 * it sits.
 */
function writeSectionedComponent(outputDir, descriptor, content) {
  if (!content) return null;
  const dir = path.join(outputDir, 'Components');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, descriptor.file);
  const label = `component ${descriptor.file}`;
  warnUnexpandedVariables(content, label);
  warnUnresolvedFieldTokens(content, label);
  warnMechanicalArtifacts(content, label);
  fs.writeFileSync(outPath, `${content}\n`, 'utf8');
  return outPath;
}

module.exports = {
  DECLARATION,
  DOCUMENT_COMPONENTS,
  SLOTTED_COMPONENTS,
  OTHER_COMPONENTS,
  emitDocumentComponent,
  renderSection,
  renderSectionedComponent,
  writeSectionedComponent,
};
