'use strict';

/**
 * v3 Plot Essentials to v4 sections and slots (§7.2, §14.2).
 *
 * This is the half of the migration Phase 3 deferred. `v3.js` handles the config break and
 * the item-level key removals, all of which are local rewrites; this one is not local. A v3
 * Plot Essentials file *resolves items*, and v4's does not — so every block in it has to be
 * split into a slot on the component and a render target on the item it named, in a
 * different file.
 *
 * ── Why runs of blocks can collapse into one slot ───────────────────────────
 *
 * The naive conversion is one slot per v3 block, which preserves output and produces a
 * component with five near-identical single-occupant slots. It can do better, and the
 * reason is a property of the emitter rather than a guess: `renderSectionedComponent` joins
 * sections with `BLOCK_GAP`, and a `wrap: each` slot joins its occupants with the same
 * `BLOCK_GAP`. So N headingless blocks sharing a wrapper produce byte-identical output
 * whether they are N slots of one occupant or one slot of N.
 *
 * Consecutive blocks sharing a render signature therefore merge into a single slot. What
 * this cannot do is name the result the way an author would: The Institute's five blocks
 * become one slot rather than the three semantic slots a human chose. The output is
 * identical, and the derived names are reported for renaming.
 *
 * ── What is derived and what is reported ────────────────────────────────────
 *
 * Section names have no source in v3, because blocks are anonymous. They are derived from a
 * heading, a sole occupant's id, or position, and every derived name is reported so the
 * author renames before committing. Migration is a supervised one-time run, so a good guess
 * that is printed beats a safe guess that must be edited everywhere.
 */

/** v3's default block position, matching `render.position`'s own default. */
const DEFAULT_POSITION = 5;

// ── block reading ────────────────────────────────────────────────────────────

/**
 * One v3 block, normalized to the fields the conversion reads.
 *
 * `kind` separates the two things a block can be: `inline` defines an item inside the Plot
 * Essentials file, and `import` points at one defined elsewhere. They migrate to different
 * places — an inline block becomes a new item file, an import block becomes a render target
 * added to an existing entry — so the distinction is carried rather than rediscovered.
 */
function readBlock(raw, index) {
  const render = raw.render || {};
  return {
    index,
    kind: raw.import ? 'import' : 'inline',
    id: raw.import || raw.id || (typeof raw.name === 'string' ? raw.name : null),
    raw,
    render,
    style: typeof render.style === 'string' ? render.style.toLowerCase() : null,
    isPlayer: render.isPlayer === true,
    position: typeof render.position === 'number' ? render.position : DEFAULT_POSITION,
    declaredWrapper: render.wrapper || null,
    template: render.template || null,
  };
}

/**
 * A v3 file's blocks as ordered units, with `blocks:` groups kept whole.
 *
 * A group is one unit because its children share a single wrapper and heading — the
 * behavior `wrap: all` exists to preserve — so it can never merge with a neighbour.
 */
function readUnits(blocks) {
  const units = [];
  blocks.forEach((raw, index) => {
    const render = raw.render || {};
    const common = {
      index,
      heading: raw.heading != null ? raw.heading : null,
      headingLevel: raw.headingLevel != null ? raw.headingLevel : null,
      compact: render.compact === true,
      position: typeof render.position === 'number' ? render.position : DEFAULT_POSITION,
      raw,
    };

    if (Array.isArray(raw.blocks)) {
      units.push({
        ...common,
        group: true,
        wrapper: render.wrapper || null,
        members: raw.blocks.map((child, i) => readBlock(child, i)),
      });
      return;
    }

    const block = readBlock(raw, index);
    units.push({ ...common, group: false, wrapper: block.declaredWrapper, members: [block] });
  });
  return units;
}

// ── item lookup ──────────────────────────────────────────────────────────────

/**
 * Id to definition, with a project `import:` override layered over the canon item.
 *
 * The compiler's own `mergeRegistries` cannot serve here, because it deliberately refuses
 * an id present in both canon and project — which is exactly the shape every `- import:`
 * entry has. What this needs is the opposite: the canon definition as the base, with the
 * project's override on top, since that is what the block resolved against. Only `render:`
 * and `aid:` are merged, because wrapper and template are the only questions asked.
 */
function buildItemLookup(canonRegistry, projectItems) {
  const lookup = new Map();
  for (const [id, item] of canonRegistry) lookup.set(id, item);

  for (const def of projectItems) {
    if (def.include) continue;
    const rawId = def.id || def.import || (typeof def.name === 'string' ? def.name : null);
    if (!rawId) continue;
    const id = String(rawId).toLowerCase();
    const base = lookup.get(id) || {};
    lookup.set(id, {
      ...base,
      ...def,
      render: { ...(base.render || {}), ...(def.render || {}) },
      aid: { ...(base.aid || {}), ...(def.aid || {}) },
    });
  }
  return lookup;
}

/**
 * The wrapper a v3 block actually rendered with.
 *
 * A block with no `render.wrapper` inherited the resolved item's own, which is why this
 * needs the registry rather than the block alone — Baseline's protagonist block declares no
 * wrapper and ships curly, because canon Aness declares curly. Reading the block alone
 * would silently drop the braces from every such block.
 */
function effectiveWrapper(block, registry) {
  if (block.declaredWrapper) return block.declaredWrapper;
  const item = block.id ? registry.get(String(block.id).toLowerCase()) : null;
  return (item && item.render && item.render.wrapper) || null;
}

/** The template a block resolved to, before `style:` and `isPlayer:` modify it. */
function baseTemplate(block, registry) {
  if (block.template) return block.template;
  const item = block.id ? registry.get(String(block.id).toLowerCase()) : null;
  if (!item) return null;
  if (item.render && item.render.template) return item.render.template;
  if (item.aid && item.aid.type) return item.aid.type;
  return null;
}

/**
 * The per-target `template:` a block needs, or null when the item's own default suffices.
 *
 * `style: hint` and `isPlayer: true` both mean "use a sibling of the normal template", and
 * both are conditional on that sibling existing. v3 fell back to the full template with a
 * WARN when a `.hint` was missing, and `isPlayer` was never a compiler key at all — it did
 * something only because two of the project's own templates tested it. A missing sibling is
 * therefore a silent no-op in v3, and reproducing that exactly is what keeps output
 * identical rather than merely plausible.
 */
function targetTemplate(block, registry, templateNames, notes) {
  const base = baseTemplate(block, registry);
  if (!base) return block.template || null;

  const sibling = (suffix, why) => {
    const name = base + '.' + suffix;
    if (templateNames.has(name.toLowerCase())) return name;
    notes.push(
      'block "' + block.id + '" used ' + why + ' but no "' + name + '.template" exists — v3 '
      + 'fell back to "' + base + '", so the target keeps it and the ' + why + ' is dropped.',
    );
    return null;
  };

  if (block.style === 'hint') {
    const hint = sibling('hint', 'style: hint');
    if (hint) return hint;
  }
  if (block.isPlayer) {
    const you = sibling('you', 'render.isPlayer');
    if (you) return you;
  }
  return block.template || null;
}

// ── grouping and naming ──────────────────────────────────────────────────────

/** Two units share a slot only when every layout key agrees. */
function signature(unit, wrapper) {
  return JSON.stringify([
    unit.group, wrapper || '', unit.heading || '', unit.headingLevel, unit.compact, unit.position,
  ]);
}

/**
 * Units in output order, merged into runs.
 *
 * Ordered by `position` then document index, which is v3's own ordering, so a run is always
 * a contiguous stretch of the rendered sequence. Merging non-adjacent units would reorder
 * output; merging adjacent ones with an identical signature cannot.
 */
function groupIntoRuns(units, wrapperOf) {
  const ordered = [...units].sort((a, b) => (a.position - b.position) || (a.index - b.index));
  const runs = [];
  for (const unit of ordered) {
    const wrapper = wrapperOf(unit);
    const sig = signature(unit, wrapper);
    const last = runs[runs.length - 1];
    // A group wraps its whole collection, so it neither absorbs a neighbour nor is absorbed
    // — `wrap: all` and `wrap: each` are different renderings of the same occupants.
    if (last && !unit.group && !last.group && last.signature === sig) {
      last.units.push(unit);
      continue;
    }
    runs.push({ signature: sig, wrapper, units: [unit], group: unit.group });
  }
  return runs;
}

/** A slot name from whatever the run offers: a heading, a sole occupant, or its position. */
function deriveSectionName(run, ordinal, taken) {
  const slug = (text) => String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .join('-');

  const members = run.units.flatMap((u) => u.members);
  let base = '';
  if (run.units[0].heading) base = slug(run.units[0].heading);
  else if (members.length === 1 && members[0].id) base = slug(members[0].id);
  if (!base) base = 'section-' + (ordinal + 1);

  let name = base;
  let n = 2;
  while (taken.has(name)) { name = base + '-' + n; n += 1; }
  taken.add(name);
  return name;
}

// ── conversion ───────────────────────────────────────────────────────────────

/**
 * Convert a parsed v3 Plot Essentials file into a v4 component plus a placement per member.
 *
 * Returns `{ sections, placements, notes }`. This reads the registry and writes nothing —
 * `placements` is the instruction list the caller applies to item files, so deciding what to
 * convert stays separable from the file surgery that follows.
 */
function convertPlotEssentials(blocks, registry, templateNames) {
  const notes = [];
  const units = readUnits(blocks);
  const wrapperOf = (unit) => (unit.group
    ? unit.wrapper
    : effectiveWrapper(unit.members[0], registry));

  const runs = groupIntoRuns(units, wrapperOf);
  const sections = {};
  const placements = [];
  const taken = new Set();

  runs.forEach((run, ordinal) => {
    const name = deriveSectionName(run, ordinal, taken);
    const first = run.units[0];
    // Reported unconditionally, not only for the positional fallback. A name derived from a
    // heading looks deliberate and is still a guess — `coinflip-company` for a party
    // directory is exactly the kind of plausible-but-wrong name that survives review if
    // nothing draws attention to it.
    notes.push(
      'slot "' + name + '" was named by the migrator from '
      + (first.heading ? 'its heading'
        : (run.units.length === 1 && run.units[0].members.length === 1 && run.units[0].members[0].id
          ? 'its only occupant'
          : 'its position'))
      + ' — v3 blocks are anonymous, so rename it to whatever the slot means.',
    );

    const section = { slot: true };
    if (first.heading != null) section.heading = first.heading;
    if (first.headingLevel != null) section.headingLevel = first.headingLevel;

    const render = { position: ordinal + 1 };
    if (run.wrapper) render.wrapper = run.wrapper;
    // A group wrapped its joined children once; a standalone block wrapped itself. §7.4's
    // `wrap` is the key that preserves both, and `each` is the default so it stays unwritten.
    if (run.group) render.wrap = 'all';
    if (first.compact) render.compact = true;
    section.render = render;
    sections[name] = section;

    let order = 0;
    for (const unit of run.units) {
      for (const block of unit.members) {
        if (block.style === 'skip') {
          notes.push(
            'block "' + block.id + '" had style: skip and is dropped — v4 expresses that by '
            + 'declaring no target.',
          );
          continue;
        }
        order += 1;
        const target = { slot: name, order };
        const template = targetTemplate(block, registry, templateNames, notes);
        if (template) target.template = template;
        placements.push({
          block,
          section: name,
          target,
          // v3 suppressed the story card of any full-style import, through the
          // `emittedFullImportIds` side channel. `style: hint` did not, which is the whole
          // reason the party members keep their cards and the protagonists do not.
          suppressStoryCard: block.kind === 'import' && block.style !== 'hint',
        });
      }
    }
  });

  return { sections, placements, notes };
}

module.exports = {
  DEFAULT_POSITION,
  readBlock,
  readUnits,
  effectiveWrapper,
  baseTemplate,
  targetTemplate,
  buildItemLookup,
  signature,
  groupIntoRuns,
  deriveSectionName,
  convertPlotEssentials,
};
