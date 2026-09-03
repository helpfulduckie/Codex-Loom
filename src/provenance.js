'use strict';

/**
 * §17.2's provenance report — every resolved item with its library set and source file.
 *
 * The registry already stamps `_canonSource` (the library set name) and `_source` (the file
 * path) at load time. This report reads those stamps rather than re-deriving them, and it
 * keeps the three provenance answers separate:
 *
 *   - uniquely resolved items (`registry` plain keys)
 *   - ambiguous items (`registry.ambiguous`, one row per rival)
 *   - imported items (`import:` on a project def, whose local id may differ from the library id)
 *
 * A project item that shadows a library id is an ERROR at merge time, so it never reaches
 * this report. A rename-on-import is shown in the `via` column so the row still answers
 * "where did this come from" even when the local id has moved.
 */

const fs = require('fs');
const path = require('path');

function csvCell(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function sourceLabel(item) {
  if (item._canonSource) return `library:${item._canonSource}`;
  return 'project';
}

function viaLabel(item) {
  if (!item.import) return '';
  return typeof item.import === 'string' ? item.import : '';
}

/**
 * The source file as the report should show it: relative to the project directory, with
 * forward slashes.
 *
 * `_source` is stamped absolute at load time, which made every row machine-specific — a
 * report a user shared carried their home directory, and a baseline compiled in a temp
 * directory could never match one committed from a working tree. Relativizing fixes both,
 * and a library set outside the project resolves to a readable `../library/core/...` rather
 * than an absolute path. Separators are normalized because the committed baseline is
 * compared byte-for-byte across platforms.
 *
 * `baseDir` is optional: with none, the stamp is passed through unchanged.
 */
function sourceFile(item, baseDir) {
  const raw = item._source || '';
  if (!raw || !baseDir) return raw;
  return path.relative(baseDir, raw).replace(/\\/g, '/');
}

/**
 * Collect one row per registry entry.
 *
 * Ambiguous items are *not* in the plain `registry` keys (§17.3), so iterating both covers
 * every item without duplication. Rows sort by id, then source, so the output is stable.
 */
function collectRows(registry, baseDir) {
  const rows = [];

  for (const [id, item] of registry) {
    rows.push({
      id,
      source: sourceLabel(item),
      file: sourceFile(item, baseDir),
      via: viaLabel(item),
      status: 'resolved',
    });
  }

  for (const [id, rivals] of registry.ambiguous) {
    for (const item of rivals) {
      rows.push({
        id,
        source: sourceLabel(item),
        file: sourceFile(item, baseDir),
        via: viaLabel(item),
        status: 'ambiguous',
      });
    }
  }

  rows.sort((a, b) => (
    a.id.localeCompare(b.id)
    || a.source.localeCompare(b.source)
    || a.file.localeCompare(b.file)
  ));

  return rows;
}

function formatProvenanceMd(rootDirName, rows) {
  const lines = [
    `# Item Provenance — ${rootDirName}`,
    '',
    '| ID | Source | File | Via | Status |',
    '|---|---|---|---|---|',
  ];

  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${row.source} | ${row.file} | ${row.via || '—'} | ${row.status} |`
    );
  }

  if (rows.length === 0) {
    lines.push('_No items in registry._');
  }

  return lines.join('\n');
}

function formatProvenanceCsv(rows) {
  const lines = ['ID,Source,File,Via,Status'];
  for (const row of rows) {
    lines.push([
      csvCell(row.id),
      csvCell(row.source),
      csvCell(row.file),
      csvCell(row.via),
      csvCell(row.status),
    ].join(','));
  }
  return lines.join('\n');
}

/**
 * Write the provenance report to reportBase.
 *
 * `baseDir` is the project directory every source path is reported relative to — see
 * `sourceFile`. Omitting it passes the absolute stamps through, which is what the unit
 * tests do when the path is not what they are asserting on.
 *
 * Returns an array of written file paths.
 */
function runProvenanceMode(registry, reportBase, rootDirName, baseDir) {
  fs.mkdirSync(reportBase, { recursive: true });
  const rows = collectRows(registry, baseDir);

  const mdPath = path.join(reportBase, `${rootDirName}.provenance.md`);
  const csvPath = path.join(reportBase, `${rootDirName}.provenance.csv`);

  fs.writeFileSync(mdPath, formatProvenanceMd(rootDirName, rows) + '\n', 'utf8');
  fs.writeFileSync(csvPath, formatProvenanceCsv(rows) + '\n', 'utf8');

  return [mdPath, csvPath];
}

module.exports = {
  runProvenanceMode,
  collectRows,
  formatProvenanceMd,
  formatProvenanceCsv,
};
