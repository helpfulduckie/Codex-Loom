'use strict';

/**
 * `assertTierWellFormed` — the label-membership guard (v4 spec §13.4, Phase 13 Decision 2).
 *
 * Byte-identity cannot guard tier output, because a terse tier *shortens on purpose*. What
 * must hold instead: a terse list only omits fields or swaps one for a same-label sibling —
 * it never renders a kept field differently and never invents a label. This helper compiles
 * a tier project and, for every card the tiered branch produces, compares it against the
 * same card on the full branch and asserts:
 *
 *   (a) every label the terse render emits also appears in the full render — nothing invented;
 *   (b) the labels the terse render keeps are an in-order subsequence of the full render's —
 *       catches a reordering the set check in (a) would pass;
 *   (c) every terse label whose body differs from the full render's is backed by a
 *       substitution the terse list actually declares — a `{ field, label }` entry, or a
 *       bare field name whose declared label already matches. Anything else fails.
 *
 * A failure here is a tier-correctness bug, not fixture drift.
 */

const assert = require('assert');
const { compile, buildCompileContext } = require('../../src/compile');
const { loadCompileConfig } = require('../../src/config/load');
const { loadTemplates } = require('../../src/loader');
const { readCards } = require('./tier-fixture');

/** Compiled card text → `Map(cardName → [{ label, body }])`, stanzas in order. */
function parseCards(text) {
  const cards = new Map();
  const chunks = text.split(/^## /m).slice(1);
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const name = lines.shift().trim();
    let body = lines.join('\n');
    // Drop the leading VL frontmatter fence.
    body = body.replace(/^~~~\n[\s\S]*?\n~~~\n?/, '');
    const stanzas = [];
    for (const line of body.split('\n')) {
      const m = /^([^:\n]+):[ \t]*(.*)$/.exec(line);
      if (m) stanzas.push({ label: m[1].trim(), body: m[2] });
    }
    // Last write wins only matters for a repeated name; tier fixtures do not repeat.
    cards.set(name, stanzas);
  }
  return cards;
}

/** Is `sub` an in-order subsequence of `full`? */
function isSubsequence(sub, full) {
  let i = 0;
  for (const x of full) {
    if (i < sub.length && sub[i] === x) i += 1;
  }
  return i === sub.length;
}

/** The labels a terse list entry can sanction, given the field table. */
function sanctionedLabels(list, fieldTable) {
  const out = new Set();
  const fields = (fieldTable && fieldTable.fields) || {};
  for (const entry of list || []) {
    if (typeof entry === 'string') {
      const decl = fields[entry];
      if (decl && decl.label != null) out.add(String(decl.label));
    } else if (entry && typeof entry === 'object' && (entry.field || entry.name)) {
      if (entry.label != null) out.add(String(entry.label));
      else {
        const decl = fields[entry.field || entry.name];
        if (decl && decl.label != null) out.add(String(decl.label));
      }
    }
  }
  return out;
}

/**
 * @param {string} dir            tier project root (from `writeTierProject`)
 * @param {string} tierBranch     the tiered branch's leaf name (e.g. 'lowContext')
 * @param {object} [opts]
 * @param {string} [opts.fullBranch='full']  a branch that applies no tier
 * @param {string[]} [opts.types=['Character']]  card types the tier redefines
 */
function assertTierWellFormed(dir, tierBranch, opts = {}) {
  const { fullBranch = 'full', types = ['Character'] } = opts;
  compile(`${dir}/compile.cl.yaml`);

  const config = loadCompileConfig(`${dir}/compile.cl.yaml`);
  const { fieldTable } = loadTemplates(config._resolvedTemplates || []);
  const tierCtx = buildCompileContext(config, [tierBranch]);
  const tierMap = (tierCtx.templateFor && tierCtx.templateFor.base) || {};

  for (const type of types) {
    const terseCards = parseCards(readCards(dir, [tierBranch], type));
    const fullCards = parseCards(readCards(dir, [fullBranch], type));

    for (const [name, terseStanzas] of terseCards) {
      const fullStanzas = fullCards.get(name);
      assert.ok(fullStanzas, `card "${name}" (${type}) is on ${tierBranch} but not on ${fullBranch}`);

      // A card that rendered identically on both branches (an untierred type, or a Pattern 2
      // opt-back-in) has nothing to check.
      if (JSON.stringify(terseStanzas) === JSON.stringify(fullStanzas)) continue;

      const fullLabels = fullStanzas.map((s) => s.label);
      const terseLabels = terseStanzas.map((s) => s.label);

      // (a) nothing invented.
      for (const l of terseLabels) {
        assert.ok(fullLabels.includes(l),
          `tier card "${name}" emits label "${l}" the full render does not — a tier invents nothing`);
      }

      // (b) kept labels are an in-order subsequence.
      const kept = terseLabels.filter((l) => fullLabels.includes(l));
      assert.ok(isSubsequence(kept, fullLabels),
        `tier card "${name}" reorders kept labels: [${kept}] is not a subsequence of [${fullLabels}]`);

      // (c) a differing body is a declared substitution.
      const fullByLabel = new Map(fullStanzas.map((s) => [s.label, s.body]));
      const sanctioned = sanctionedLabels(tierMap[type], fieldTable);
      for (const s of terseStanzas) {
        if (fullByLabel.get(s.label) !== s.body) {
          assert.ok(sanctioned.has(s.label),
            `tier card "${name}" changes the body under "${s.label}" but the terse list for `
            + `${type} declares no same-label substitution for it`);
        }
      }
    }
  }
}

module.exports = { assertTierWellFormed, parseCards, isSubsequence };
