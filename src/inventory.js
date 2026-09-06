'use strict';


const fs = require('fs');
const path = require('path');
const { sortOccupants } = require('./emit/components');


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

function describeBranches(selected, allLeaves) {
  if (selected.length === allLeaves.length) return `all ${allLeaves.length}`;
  const pattern = branchPattern(selected, allLeaves);
  const labels = selected.map((l) => l.label);
  return pattern
    ? `${selected.length} — \`${pattern}\``
    : `${selected.length} — ${labels.join(', ')}`;
}

function occupancyKey(slot) {
  if (!slot) return '(not declared)';
  if (slot.gated) return '(gated off this branch)';
  if (slot.occupants.length === 0) return '(empty)';
  return slot.occupants.map((o) => o.id).join(', ');
}

function collectSlots(leaves) {
  const slots = new Map();
  for (const leaf of leaves) {
    for (const component of leaf.components) {
      for (const slot of component.slots) {
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
  return { written: [outPath] };
}

module.exports = {
  captureLeafInventory,
  runInventoryMode,
  occupancyKey,
  describeBranches,
  collectSlots,
};
