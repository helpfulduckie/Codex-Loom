'use strict';


const fs = require('fs');
const path = require('path');
const { csvCell } = require('./report');

function sourceLabel(item) {
  if (item._canonSource) return `library:${item._canonSource}`;
  return 'project';
}

function sourceFile(item, baseDir) {
  const raw = item._source || '';
  if (!raw || !baseDir) return raw;
  return path.relative(baseDir, raw).replace(/\\/g, '/');
}

function collectRows(registry, baseDir) {
  const rows = [];

  for (const [id, item] of registry) {
    rows.push({
      id,
      source: sourceLabel(item),
      file: sourceFile(item, baseDir),
      via: typeof item.import === 'string' ? item.import : '',
      status: 'resolved',
    });
  }

  for (const [id, rivals] of registry.ambiguous) {
    for (const item of rivals) {
      rows.push({
        id,
        source: sourceLabel(item),
        file: sourceFile(item, baseDir),
        via: typeof item.import === 'string' ? item.import : '',
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

function runProvenanceMode(registry, reportBase, rootDirName, baseDir) {
  fs.mkdirSync(reportBase, { recursive: true });
  const rows = collectRows(registry, baseDir);

  const mdPath = path.join(reportBase, `${rootDirName}.provenance.md`);
  const csvPath = path.join(reportBase, `${rootDirName}.provenance.csv`);

  fs.writeFileSync(mdPath, formatProvenanceMd(rootDirName, rows) + '\n', 'utf8');
  fs.writeFileSync(csvPath, formatProvenanceCsv(rows) + '\n', 'utf8');

  return { written: [mdPath, csvPath] };
}

module.exports = {
  runProvenanceMode,
  collectRows,
  formatProvenanceMd,
  formatProvenanceCsv,
};
