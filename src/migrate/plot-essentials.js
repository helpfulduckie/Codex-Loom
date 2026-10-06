'use strict';


const { DEFAULT_POSITION } = require('../model/component');


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

function effectiveWrapper(block, registry) {
  if (block.declaredWrapper) return block.declaredWrapper;
  const item = block.id ? registry.get(String(block.id).toLowerCase()) : null;
  return (item && item.render && item.render.wrapper) || null;
}

function baseTemplate(block, registry) {
  if (block.template) return block.template;
  const item = block.id ? registry.get(String(block.id).toLowerCase()) : null;
  if (!item) return null;
  if (item.render && item.render.template) return item.render.template;
  if (item.aid && item.aid.type) return item.aid.type;
  return null;
}

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


function signature(unit, wrapper) {
  return JSON.stringify([
    unit.group, wrapper || '', unit.heading || '', unit.headingLevel, unit.compact, unit.position,
  ]);
}

function groupIntoRuns(units, wrapperOf) {
  const ordered = [...units].sort((a, b) => (a.position - b.position) || (a.index - b.index));
  const runs = [];
  for (const unit of ordered) {
    const wrapper = wrapperOf(unit);
    const sig = signature(unit, wrapper);
    const last = runs[runs.length - 1];
    if (last && !unit.group && !last.group && last.signature === sig) {
      last.units.push(unit);
      continue;
    }
    runs.push({ signature: sig, wrapper, units: [unit], group: unit.group });
  }
  return runs;
}

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
          suppressStoryCard: block.kind === 'import' && block.style !== 'hint',
        });
      }
    }
  });

  return { sections, placements, notes };
}

module.exports = {
  DEFAULT_POSITION,
  readUnits,
  effectiveWrapper,
  baseTemplate,
  targetTemplate,
  buildItemLookup,
  groupIntoRuns,
  deriveSectionName,
  convertPlotEssentials,
};
