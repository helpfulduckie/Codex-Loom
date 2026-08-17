'use strict';

/**
 * `--inventory` — a slot x branch x occupants report (v4 spec §7.9, §7.10).
 *
 * §7.2 moved membership onto the item: a component declares a slot and says nothing about
 * who fills it, and an item declares a `render:` target and says nothing about what else
 * is beside it. §7.9 accepts the discoverability cost of that trade deliberately. This is
 * the convenience it names — the one place that puts the two ends back together.
 *
 * What it answers that a diagnostic cannot. `CL0611` fires when a target names a slot no
 * component declares and `CL0614` fires when a declared slot ends up empty, so the two
 * typo classes are already loud. Neither says what a *filled* slot contains, and a slot
 * holding the wrong four items is well-formed by every check the compiler runs. Answering
 * that from the output tree means reading every leaf, which for The Institute is 32 files
 * whose Plot Essentials are mostly identical.
 *
 * ── Why rows collapse ───────────────────────────────────────────────────────
 *
 * A slot x branch grid is the natural shape and the wrong one at this scale: 32 columns
 * does not render, and 32 near-identical rows hide the two that differ. So branches are
 * grouped by what the slot actually holds, which turns the common case into one row
 * reading "all 32" and leaves each divergence as its own row. That makes the report's
 * length proportional to how much a project *varies* rather than to how big it is, which
 * is the same trade `Shared.md` makes in `diff.js`.
 *
 * ── Why gating is its own occupancy state ───────────────────────────────────
 *
 * A slot has three ways to hold nothing, and §7.4 treats them differently, so flattening
 * them here would throw away the distinction the report exists to show. A slot may be
 * *empty* (declared, placeable, nobody targeted it — `CL0614`'s WARN), *gated* (the
 * component's own `branches:` excluded the section on this branch, which §7.4's third and
 * fifth rows keep legitimate), or absent because the component is a `.md` passthrough and
 * declares no sections at all.
 */

const fs = require('fs');
const path = require('path');
const { sortOccupants } = require('./emit/components');

// ── capture ──────────────────────────────────────────────────────────────────

/**
 * One leaf's slot occupancy, read from the same two structures the emitter uses.
 *
 * `slotIndex` says what this branch may place into and `occupants` says what it did, and
 * both are already in hand at the call site — this adds a traversal, not a resolve. Taking
 * the occupant list through `sortOccupants` rather than reading it raw is what makes the
 * report name items in the order the file lists them (§7.4).
 *
 * @returns {{label: string, components: Array}}
 */
function captureLeafInventory(label, branchPath, sectionedForLeaf, slotIndex, occupants) {
  const components = [];

  for (const { descriptor, component, passthrough } of sectionedForLeaf) {
    const known = slotIndex.get(descriptor.key);
    if (!known) continue;                       // failed to load; the gap report owns it

    if (passthrough !== null && passthrough !== undefined) {
      components.push({ key: descriptor.key, label: descriptor.label, passthrough: true, slots: [] });
      continue;
    }

    const filled = occupants.get(descriptor.key) || new Map();
    const slots = [];
    for (const section of component.sections) {
      if (!section.isSlot) continue;
      const lower = section.name.toLowerCase();
      slots.push({
        name: section.name,
        heading: section.heading || null,
        gated: !known.slots.has(lower),
        occupants: sortOccupants(filled.get(lower)).map((o) => ({ id: o.id, order: o.order })),
      });
    }
    components.push({ key: descriptor.key, label: descriptor.label, passthrough: false, slots });
  }

  return { label, branchPath: branchPath || [], components };
}

// ── rendering ────────────────────────────────────────────────────────────────

/**
 * A set of leaves as a branch-path pattern, when one describes it exactly.
 *
 * The Institute is 32 leaves over four axes, and a row covering half of them is almost
 * always half by *one* axis — the 16 branches where `you` is Aness, not an arbitrary 16.
 * Listing them spends sixteen fully-qualified paths saying what one wildcard pattern says
 * once (star, Aness, star, star), and buries the axis that actually decided the row.
 *
 * Per segment: the values this set takes there, or `*` when the set takes every value that
 * position offers. The result is then **checked against the leaves it matches** and thrown
 * away unless it selects exactly this set — a pattern that over-matches would be a report
 * asserting a placement that did not happen, which is worse than a long cell. Returns null
 * when no pattern is exact, and the caller lists instead.
 */
function branchPattern(selected, allLeaves) {
  const depth = allLeaves[0].branchPath.length;
  if (depth === 0) return null;
  if (allLeaves.some((l) => l.branchPath.length !== depth)) return null; // ragged tree

  const segments = [];
  for (let i = 0; i < depth; i++) {
    const mine = [...new Set(selected.map((l) => l.branchPath[i]))];
    const every = new Set(allLeaves.map((l) => l.branchPath[i]));
    segments.push(mine.length === every.size ? '*' : mine.sort().join('|'));
  }

  const matches = allLeaves.filter((leaf) => segments.every(
    (seg, i) => seg === '*' || seg.split('|').includes(leaf.branchPath[i]),
  ));
  if (matches.length !== selected.length) return null;   // over-matches; not this set

  return segments.join('/');
}

/** A cell's worth of branches — "all N", else a path pattern, else the list. */
function describeBranches(selected, allLeaves) {
  if (selected.length === allLeaves.length) return `all ${allLeaves.length}`;
  const pattern = branchPattern(selected, allLeaves);
  const labels = selected.map((l) => l.label);
  return pattern
    ? `${selected.length} — \`${pattern}\``
    : `${selected.length} — ${labels.join(', ')}`;
}

/** The occupancy of one slot on one branch, as the string rows are grouped by. */
function occupancyKey(slot) {
  if (!slot) return '(not declared)';
  if (slot.gated) return '(gated off this branch)';
  if (slot.occupants.length === 0) return '(empty)';
  return slot.occupants.map((o) => o.id).join(', ');
}

/**
 * Every slot any branch declares, keyed `component slot`.
 *
 * Built across all leaves rather than from the first, because a slot can be gated off on
 * the branch that happens to come first and a report that omitted it would be answering a
 * different question than the one asked.
 */
function collectSlots(leaves) {
  const slots = new Map();
  for (const leaf of leaves) {
    for (const component of leaf.components) {
      for (const slot of component.slots) {
        // JSON rather than a delimiter: slot names are free-form strings (§7.4), so any
        // separator picked here is one a slot name may legitimately contain.
        const key = JSON.stringify([component.key, slot.name.toLowerCase()]);
        if (!slots.has(key)) {
          slots.set(key, {
            componentKey: component.key,
            componentLabel: component.label,
            name: slot.name,
            heading: slot.heading,
          });
        }
      }
    }
  }
  return slots;
}

function renderSlotSections(leaves) {
  const parts = [];
  const slots = collectSlots(leaves);
  const byComponent = new Map();
  for (const slot of slots.values()) {
    if (!byComponent.has(slot.componentLabel)) byComponent.set(slot.componentLabel, []);
    byComponent.get(slot.componentLabel).push(slot);
  }

  for (const [componentLabel, componentSlots] of byComponent) {
    parts.push(`## ${componentLabel}`);

    for (const slot of componentSlots) {
      const title = slot.heading ? `\`${slot.name}\` — ${slot.heading}` : `\`${slot.name}\``;
      parts.push(`### ${title}`);

      const rows = new Map();                   // occupancy string -> leaves
      for (const leaf of leaves) {
        const component = leaf.components.find((c) => c.key === slot.componentKey);
        const found = component
          ? component.slots.find((s) => s.name.toLowerCase() === slot.name.toLowerCase())
          : null;
        const key = occupancyKey(found);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(leaf);
      }

      // Most-common occupancy first: the report is read to find the exceptions, and they
      // are easiest to see against the rule stated immediately above them.
      const ordered = [...rows.entries()].sort((a, b) => b[1].length - a[1].length);
      parts.push([
        '| Occupants | Branches |',
        '|---|---|',
        ...ordered.map(([key, rowLeaves]) => `| ${key} | ${describeBranches(rowLeaves, leaves)} |`),
      ].join('\n'));
    }
  }

  return parts;
}

/**
 * The same placements read from the item's end — "did this item land where it said".
 *
 * This is the direction §7.9's discoverability cost actually runs in. A slot's contents
 * can be checked against the output file if you are willing to open it; an item's targets
 * are spread across every branch it resolves on, and nothing else gathers them.
 */
function renderItemSection(leaves) {
  const placements = new Map();                 // [item, component, slot] -> leaves
  const meta = new Map();

  for (const leaf of leaves) {
    for (const component of leaf.components) {
      for (const slot of component.slots) {
        for (const occupant of slot.occupants) {
          const key = JSON.stringify([occupant.id, component.label, slot.name]);
          if (!placements.has(key)) {
            placements.set(key, []);
            meta.set(key, { id: occupant.id, component: component.label, slot: slot.name });
          }
          placements.get(key).push(leaf);
        }
      }
    }
  }

  if (placements.size === 0) return [];

  const rows = [...placements.keys()]
    .sort((a, b) => {
      const x = meta.get(a);
      const y = meta.get(b);
      return String(x.id).localeCompare(String(y.id))
        || x.component.localeCompare(y.component)
        || x.slot.localeCompare(y.slot);
    })
    .map((key) => {
      const { id, component, slot } = meta.get(key);
      return `| ${id} | ${component} / \`${slot}\` | ${describeBranches(placements.get(key), leaves)} |`;
    });

  return [
    '## Items',
    '_Every item with a component target, and where it landed._',
    `| Item | Target | Branches |\n|---|---|---|\n${rows.join('\n')}`,
  ];
}

function renderHeader(leaves) {
  const slots = collectSlots(leaves);
  let placements = 0;
  // Counted by component key, not per leaf: one shared `.md` across 32 branches is one
  // passthrough component, and reporting it as 32 would read as 32 distinct files.
  const passthroughs = new Set();
  for (const leaf of leaves) {
    for (const component of leaf.components) {
      if (component.passthrough) passthroughs.add(component.key);
      for (const slot of component.slots) placements += slot.occupants.length;
    }
  }
  const components = new Set([...slots.values()].map((s) => s.componentKey));

  return [
    '# Slot Inventory',
    '_Which items landed in which slot, on which branch._',
    `${components.size} component(s) with slots · ${slots.size} slot(s) · `
    + `${leaves.length} branch(es) · ${placements} placement(s)`
    + (passthroughs.size > 0
      ? ` · ${passthroughs.size} passthrough component(s), which declare no slots`
      : ''),
  ];
}

/** Write `Inventory.md`. Returns the written paths, matching the other report modes. */
function runInventoryMode(leaves, outputDir) {
  const parts = renderHeader(leaves);
  if (leaves.length === 0 || collectSlots(leaves).size === 0) {
    parts.push('_No component declares a slot, so nothing routes into one._');
  } else {
    parts.push(...renderSlotSections(leaves));
    parts.push(...renderItemSection(leaves));
  }

  const outPath = path.join(outputDir, 'Inventory.md');
  fs.writeFileSync(outPath, `${parts.join('\n\n')}\n`, 'utf8');
  return [outPath];
}

module.exports = {
  captureLeafInventory,
  runInventoryMode,
  // exported for tests
  occupancyKey,
  describeBranches,
  collectSlots,
};
