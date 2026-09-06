'use strict';


const fs = require('fs');
const YAML = require('yaml');

const NL = '\n';
const SPLIT_LINES = /\r?\n/;

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
