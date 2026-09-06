'use strict';


const { resolveBranchSpec } = require('./branches');
const { applyFieldOp } = require('./fieldops');
const { findKey, setCI } = require('../util');
const { CODES } = require('../diag');

const WRAP = Object.freeze({
  EACH: 'each',
  ALL: 'all',
});

const DEFAULT_POSITION = 5;

function normalizeComponent(doc, options = {}) {
  const { onWarn = () => {} } = options;

  const rawSections = (doc && doc.sections) || {};
  const sections = Object.entries(rawSections)
    .filter(([, def]) => def !== null && def !== undefined)
    .map(([name, def], index) => normalizeSection(name, def, index, onWarn));

  sections.sort((a, b) => (a.position - b.position) || (a.index - b.index));

  const slots = new Map();
  for (const section of sections) {
    if (section.isSlot) slots.set(section.name, section);
  }

  return {
    sections,
    slots,
    branches: (doc && doc.branches) || null,
    render: (doc && doc.render) || null,
    metadata: (doc && doc.metadata) || null,
  };
}

function normalizeSection(name, def, index, onWarn) {
  const raw = (def && typeof def === 'object' && !Array.isArray(def)) ? def : {};
  const render = (raw.render && typeof raw.render === 'object') ? raw.render : {};

  const isSlot = raw.slot === true;
  const hasSource = (typeof raw.file === 'string' && raw.file !== '')
    || (raw.from && typeof raw.from === 'object' && !Array.isArray(raw.from));
  const hasText = (raw.text !== undefined && raw.text !== null && raw.text !== '') || hasSource;
  const hasHeading = typeof raw.heading === 'string' && raw.heading !== '';

  if (isSlot && hasText) {
    onWarn(CODES.SECTION_TEXT_AND_SLOT,
      `section "${name}" declares both "text:" and "slot: true" — a section is one or the other. `
      + 'Move the text into its own section positioned ahead of the slot.');
  }

  if (!isSlot && !hasText && !hasHeading) {
    const importedFrom = typeof raw.__importedFrom === 'string' ? raw.__importedFrom : null;
    onWarn(CODES.SECTION_RENDERS_NOTHING,
      `section "${name}" has no text, no heading and is not a slot, so it renders nothing.`
      + (importedFrom
        ? ` (inherited from ${importedFrom}, which already reports this for its own copy of `
          + 'the section — fix it there; this is the same section, merged.)'
        : ''));
  }

  let wrap = render.wrap === undefined ? WRAP.EACH : String(render.wrap).toLowerCase();
  if (wrap !== WRAP.EACH && wrap !== WRAP.ALL) {
    onWarn(CODES.SECTION_WRAP_UNKNOWN,
      `section "${name}" sets wrap: "${render.wrap}", which is neither "each" nor "all" — using "each".`);
    wrap = WRAP.EACH;
  }

  return {
    name,
    index,
    isSlot,
    text: raw.text === undefined ? null : raw.text,
    heading: hasHeading ? raw.heading : null,
    headingLevel: raw.headingLevel,
    position: typeof render.position === 'number' ? render.position : DEFAULT_POSITION,
    wrapper: render.wrapper || 'none',
    wrap,
    compact: render.compact === true,
    bullet: render.bullet === true,
    branches: raw.branches || null,
    variants: raw.variants || null,
  };
}

function applySectionVariant(section, delta) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return section;
  const result = { ...section };

  if (delta.text !== undefined) {
    if (delta.text === null) {
      result.text = null;
    } else if (typeof delta.text === 'string') {
      const next = applyFieldOp(result.text, delta.text);
      result.text = next === '__DELETE__' ? null : next;
    } else if (typeof delta.text === 'object') {
      const base = (result.text && typeof result.text === 'object' && !Array.isArray(result.text))
        ? { ...result.text } : {};
      for (const [key, op] of Object.entries(delta.text)) {
        if (op === null) { delete base[key]; continue; }
        const next = applyFieldOp(base[key], op);
        if (next === '__DELETE__') delete base[key]; else base[key] = next;
      }
      result.text = base;
    }
  }

  if (delta.heading !== undefined) result.heading = delta.heading;
  if (delta.headingLevel !== undefined) result.headingLevel = delta.headingLevel;

  const render = (delta.render && typeof delta.render === 'object') ? delta.render : null;
  if (render) {
    if (render.position !== undefined) result.position = render.position;
    if (render.wrapper !== undefined) result.wrapper = render.wrapper;
    if (render.wrap !== undefined) result.wrap = String(render.wrap).toLowerCase();
    if (render.compact !== undefined) result.compact = render.compact === true;
    if (render.bullet !== undefined) result.bullet = render.bullet === true;
  }

  return result;
}


const CONTENT_KEYS = ['text', 'file', 'from'];

function layerSectionDef(base, over) {
  const from = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
  const raw = (over && typeof over === 'object' && !Array.isArray(over)) ? over : {};
  const result = { ...from };

  const overridesContent = CONTENT_KEYS.filter((k) => k in raw);
  if (overridesContent.length > 0) {
    for (const key of CONTENT_KEYS) {
      if (!overridesContent.includes(key)) delete result[key];
    }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'text') {
      if (value === null) { result.text = null; continue; }
      const next = applyFieldOp(from.text, value);
      result.text = next === '__DELETE__' ? null : next;
    } else if (key === 'render') {
      result.render = Object.assign({}, from.render || {}, value || {});
    } else if (key === 'variants') {
      const merged = { ...(from.variants || {}) };
      for (const [name, delta] of Object.entries(value || {})) {
        const existing = findKey(merged, name);
        if (existing !== null) merged[existing] = delta; else setCI(merged, name, delta);
      }
      result.variants = merged;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function mergeSectionRecords(base, over, onWarn = () => {}) {
  const merged = {};
  const keyOf = new Map();
  for (const [name, def] of Object.entries(base || {})) {
    merged[name] = def;
    keyOf.set(name.toLowerCase(), name);
  }

  for (const [name, def] of Object.entries(over || {})) {
    const existing = keyOf.get(name.toLowerCase());

    if (def === null || def === undefined) {
      if (existing === undefined) {
        onWarn(CODES.IMPORT_DELETE_UNKNOWN,
          `section "${name}" is deleted with ~ but no import provided it — nothing was `
          + `removed. A bare "${name}:" with no body also parses as ~, which is usually `
          + 'the cause.');
      } else {
        delete merged[existing];
        keyOf.delete(name.toLowerCase());
      }
      continue;
    }

    if (existing !== undefined) {
      merged[existing] = layerSectionDef(merged[existing], def);
    } else {
      merged[name] = def;
      keyOf.set(name.toLowerCase(), name);
    }
  }

  return merged;
}

function applySectionSelector(sections, name) {
  const result = {};
  let matched = 0;

  for (const [sectionName, def] of Object.entries(sections || {})) {
    const variants = def && typeof def === 'object' ? def.variants : null;
    const key = variants
      ? Object.keys(variants).find((k) => k.toLowerCase() === String(name).toLowerCase())
      : undefined;
    if (key === undefined) {
      result[sectionName] = def;
      continue;
    }
    matched += 1;
    result[sectionName] = layerSectionDef(def, variants[key]);
  }

  return { sections: result, matched };
}

function findSectionVariant(section, name) {
  if (!section.variants) return undefined;
  return Object.keys(section.variants)
    .find((k) => k.toLowerCase() === String(name).toLowerCase());
}

function sectionsForBranch(component, branchPath, onWarn = () => {}) {
  const fanned = resolveBranchSpec(component.branches, branchPath, onWarn);
  if (fanned === null) return null; // component-level ~ — excluded from this branch

  for (const name of fanned) {
    const matched = component.sections.filter((s) => findSectionVariant(s, name) !== undefined);
    if (matched.length > 0) continue;
    onWarn(CODES.COMPONENT_DISPATCH_MATCHED_NOTHING,
      `the component dispatches to variant "${name}" on this branch, and none of its `
      + `${component.sections.length} sections define it. A component-level dispatch names `
      + 'every section (§7.6.2a), so it is silent on the ones that do not define the name — '
      + 'which makes this the only report a misspelling produces.');
  }

  const applicable = [];
  for (const section of component.sections) {
    const variants = section.branches ? resolveBranchSpec(section.branches, branchPath, onWarn) : [];
    if (variants === null) continue;

    let resolved = section;

    for (const name of fanned) {
      const key = findSectionVariant(section, name);
      if (key === undefined) continue;
      resolved = applySectionVariant(resolved, section.variants[key]);
    }

    for (const name of variants) {
      const key = findSectionVariant(section, name);
      if (key === undefined) {
        onWarn(CODES.SECTION_VARIANT_NOT_FOUND,
          `section "${section.name}" dispatches to variant "${name}", which it does not define.`);
        continue;
      }
      resolved = applySectionVariant(resolved, section.variants[key]);
    }
    applicable.push({ section: resolved, variants: [...fanned, ...variants] });
  }
  applicable.sort((a, b) => (a.section.position - b.section.position)
    || (a.section.index - b.section.index));
  return applicable;
}

function slotsForBranch(component, branchPath) {
  const slots = new Map();
  for (const { section } of sectionsForBranch(component, branchPath) || []) {
    if (section.isSlot) slots.set(section.name, section);
  }
  return slots;
}

module.exports = {
  normalizeComponent,
  applySectionVariant,
  layerSectionDef,
  mergeSectionRecords,
  applySectionSelector,
  sectionsForBranch,
  slotsForBranch,
  WRAP,
  DEFAULT_POSITION,
};
