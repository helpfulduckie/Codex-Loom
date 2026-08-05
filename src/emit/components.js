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

/** Components handled by their own pipelines, listed so the table is the whole picture. */
const OTHER_COMPONENTS = Object.freeze([
  { key: 'plotEssential', label: 'Plot Essentials', declaration: DECLARATION.INHERITED, note: 'own pipeline — block list, suppression, diff capture' },
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

module.exports = {
  DECLARATION,
  DOCUMENT_COMPONENTS,
  OTHER_COMPONENTS,
  emitDocumentComponent,
};
