'use strict';

/**
 * The read-convert-write core shared by the description and opening migration stages
 * (v4 spec §7.1, §7.7, §14.2).
 *
 * `migrateDescriptionFiles` and `migrateOpeningFiles` differ in how they find and walk
 * their specs — description resolves one, opening walks the branch tree for many — but
 * once a stage has a resolved path in hand, both read it, parse it, hand the parsed
 * document (and the raw source, for a converter that needs comments the parse drops) to a
 * `convert` function, and write back `sections:` unless the converter declined or the run
 * is a dry one. This module is that shared tail.
 */

const fs = require('fs');
const YAML = require('yaml');

const NL = '\n';
const SPLIT_LINES = /\r?\n/;

/**
 * Read `resolvedPath`, parse it as YAML, and hand `(parsed, source)` to `convert`.
 *
 * Returns `null` when `convert` declines (already migrated, or not the shape being
 * converted) — the caller's cue to report "nothing to migrate" rather than write anything.
 * Otherwise returns `{ sections, notes }` from the converter, having already written the
 * `sections:` document to `resolvedPath` (unless `options.dryRun`).
 *
 * `options.bannerFilter(line) → boolean` selects which of the source's leading `#` lines
 * survive into the rewritten file — description keeps every one, opening excludes the
 * lines it already read as a section name.
 */
function migrateComponentDoc(resolvedPath, convert, options = {}) {
  const { dryRun, bannerFilter } = options;
  const source = fs.readFileSync(String(resolvedPath), 'utf8');
  const converted = convert(YAML.parse(source), source);
  if (!converted) return null;

  const banner = source.split(SPLIT_LINES).filter(bannerFilter).join(NL);
  const text = (banner ? banner + NL : '')
    + YAML.stringify({ sections: converted.sections }, { lineWidth: 0 });
  if (!dryRun) fs.writeFileSync(String(resolvedPath), text, 'utf8');

  return converted;
}

module.exports = { migrateComponentDoc };
