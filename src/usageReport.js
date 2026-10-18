'use strict';

const fs = require('fs');
const path = require('path');

const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

function groupUsage(records) {
  const bindings = new Map();
  for (const { leaf, kind, id, uses } of records) {
    for (const [plural, names] of Object.entries(uses || {})) {
      const bindingKind = plural === 'variables' ? 'variable' : 'role';
      for (const name of names) {
        const key = JSON.stringify([bindingKind, name]);
        if (!bindings.has(key)) bindings.set(key, { kind: bindingKind, name, leaves: new Map() });
        const binding = bindings.get(key);
        if (!binding.leaves.has(leaf)) binding.leaves.set(leaf, new Set());
        binding.leaves.get(leaf).add(JSON.stringify([kind, id]));
      }
    }
  }
  const rows = [];
  for (const binding of [...bindings.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
    const groups = new Map();
    for (const [leaf, readers] of binding.leaves) {
      const sorted = [...readers].sort();
      const key = JSON.stringify(sorted);
      if (!groups.has(key)) groups.set(key, { branches: [], readers: sorted.map(JSON.parse) });
      groups.get(key).branches.push(leaf);
    }
    for (const group of groups.values()) {
      rows.push({ kind: binding.kind, name: binding.name, branches: group.branches.sort(), readers: group.readers });
    }
  }
  return rows;
}

function runUsageMode(records, outputDir, identity) {
  const lines = [
    `# ${identity.label} — resolution usage`, '',
    'This report lists observed variable and role reads during resolution on each branch. Branches with identical readers for a binding share a row.', '',
    'Item interpolation can read fields that no output template uses. Cross-item dependencies and variables in internal component import/file paths are not fully traced. An absent read does not establish that a binding is unused or safe to delete.', '',
    '| Binding kind | Binding name | Branches | Readers (kind: identity) |',
    '| --- | --- | --- | --- |',
  ];
  const rows = groupUsage(records);
  for (const row of rows) {
    lines.push(`| ${cell(row.kind)} | ${cell(row.name)} | ${row.branches.map(cell).join(', ')} | ${row.readers.map(([kind, id]) => cell(`${kind}: ${id}`)).join('; ')} |`);
  }
  if (!rows.length) lines.push('| — | No observed reads | — | — |');
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `${identity.stem}.usage.md`);
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  return { written: [outPath], outPath };
}

module.exports = { groupUsage, runUsageMode };
