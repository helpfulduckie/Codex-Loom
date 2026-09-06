'use strict';


const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const { sectionsForBranch, WRAP } = require('../model/component');
const { applyWrapper } = require('../template');
const { applyTokenPass } = require('../model/pronouns');
const {
  resolveVariables, checkUnexpandedVariables, checkUnresolvedFieldTokens, checkMechanicalArtifacts,
} = require('../util');

const SLOTTED_COMPONENTS = Object.freeze([
  {
    key: 'plotEssential',
    label: 'Plot Essentials',
    file: 'Plot Essentials.md',
    dir: 'Components',
    verboseLabel: 'PlotEssentials',
    defaultHeadingLevel: 0,
  },
  {
    key: 'summary',
    label: 'Summary',
    file: 'Summary.md',
    dir: 'Components',
    verboseLabel: 'Summary',
    defaultHeadingLevel: 0,
  },
  {
    key: 'aiInstructions',
    label: 'AI Instructions',
    file: 'AI Instructions.md',
    dir: 'Components',
    verboseLabel: 'AIInstructions',
    defaultHeadingLevel: 2,
  },
  {
    key: 'authorsNote',
    label: "Author's Note",
    file: 'Author Notes.md',
    dir: 'Components',
    verboseLabel: 'AuthorsNote',
    defaultHeadingLevel: 2,
  },
  {
    key: 'adventureDescription',
    label: 'Adventure Description',
    file: 'Description.md',
    dir: null,
    verboseLabel: 'AdventureDescription',
    inlineProse: false,
    defaultHeadingLevel: 0,
    frontmatter: true,
  },
  {
    key: 'opening',
    label: 'Opening',
    file: 'Opening.md',
    dir: 'Components',
    verboseLabel: 'Opening',
    defaultHeadingLevel: 0,
    inlineProse: true,
    limitKey: 'opening',
  },
]);

const DESCRIPTION_DESCRIPTOR = Object.freeze({
  key: 'description',
  label: 'Description',
  file: 'Description.md',
  dir: null,
  verboseLabel: 'Description',
  defaultHeadingLevel: 0,
  frontmatter: true,
});

const FRAMING_DESCRIPTOR = Object.freeze({
  key: 'branchFraming',
  label: 'Branch framing',
  file: 'Opening.md',
  dir: 'Components',
  verboseLabel: 'BranchFraming',
  defaultHeadingLevel: 0,
  inlineProse: true,
  limitKey: 'opening',
});

const PASSTHROUGH_EXTENSIONS = new Set(['.md', '.txt']);

function isPassthrough(spec) {
  return typeof spec === 'string' && PASSTHROUGH_EXTENSIONS.has(path.extname(spec).toLowerCase());
}

function readPassthrough(spec) {
  return fs.readFileSync(spec, 'utf8').trimEnd() || null;
}


const BLOCK_GAP = '\n\n';
const LINE_GAP = '\n';

function headingText(section, defaultHeadingLevel) {
  if (!section.heading) return null;
  const level = section.headingLevel === undefined ? defaultHeadingLevel : section.headingLevel;
  return level > 0 ? `${'#'.repeat(level)} ${section.heading}` : section.heading;
}

function textLines(section, options) {
  const { variables = {}, registry, branchProtagonist, roles, onWarn, onRoleUsed, diagnostics, file } = options;
  const prefix = section.bullet ? '- ' : '';
  const resolve = (value) => {
    const withVars = resolveVariables(String(value), variables, { diagnostics, file });
    return prefix + applyTokenPass(
      withVars, { item: {}, registry, branchProtagonist, roles, onWarn, onRoleUsed },
    ).trim();
  };

  const text = section.text;
  if (typeof text === 'string') return text.trim() ? [resolve(text)] : [];
  if (text && typeof text === 'object') {
    return Object.values(text).filter((v) => v !== null && v !== undefined).map(resolve);
  }
  return [];
}

function renderSection(section, occupants, options) {
  const { defaultHeadingLevel = 0 } = options;
  const heading = headingText(section, defaultHeadingLevel);

  if (section.isSlot) {
    const bodies = occupants.map((o) => o.text).filter((t) => t && t.trim());
    if (bodies.length === 0) return null;

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

function sortOccupants(placed) {
  return (placed || []).slice().sort(
    (a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)),
  );
}

function renderSectionedComponent(component, branchPath, occupants, options = {}) {
  if (!component) return { text: null, segments: [] };

  const applicable = sectionsForBranch(component, branchPath, options.onWarn);
  if (applicable === null) return { text: null, segments: [], excluded: true };

  const segments = [];
  for (const { section } of applicable) {
    const placed = section.isSlot ? sortOccupants(occupants.get(section.name.toLowerCase())) : [];
    const text = renderSection(section, placed, options);
    if (text && text.trim()) segments.push({ key: `section:${section.name}`, text });
  }

  return {
    text: segments.length > 0 ? segments.map((s) => s.text).join(BLOCK_GAP) : null,
    segments,
  };
}

function writeSectionedComponent(outputDir, descriptor, content, sink, metadata = null) {
  if (!content) return null;
  const dir = descriptor.dir ? path.join(outputDir, descriptor.dir) : outputDir;
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, descriptor.file);
  const label = `component ${descriptor.file}`;
  checkUnexpandedVariables(content, label, sink);
  checkUnresolvedFieldTokens(content, label, sink);
  checkMechanicalArtifacts(content, label, sink);
  fs.writeFileSync(outPath, `${renderFrontmatter(metadata)}${content}\n`, 'utf8');
  return outPath;
}

function renderFrontmatter(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  if (Object.keys(metadata).length === 0) return '';
  return `---\n${YAML.stringify(metadata).trimEnd()}\n---\n\n`;
}

module.exports = {
  SLOTTED_COMPONENTS,
  DESCRIPTION_DESCRIPTOR,
  FRAMING_DESCRIPTOR,
  isPassthrough,
  readPassthrough,
  renderSection,
  sortOccupants,
  renderSectionedComponent,
  writeSectionedComponent,
  renderFrontmatter,
};
