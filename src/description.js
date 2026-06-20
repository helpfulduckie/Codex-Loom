'use strict';

const fs = require('fs');
const path = require('path');
const { loadYaml } = require('./loader');
const { resolveVariables } = require('./util');

/**
 * Load a description YAML config file.
 * Returns { bodyPath, scriptPath, stripTrailingInstructions } with body/script
 * paths resolved relative to configBase (the compile.yaml directory), matching
 * how include: paths are resolved.
 *
 * {%variable} and {@Key} tokens in body/script values are expanded before
 * path resolution, using the same maps available to compile.yaml.
 *
 * @param {string} specPath          - absolute path to the description .yaml file
 * @param {string} configBase        - compile.yaml directory (config._base)
 * @param {object} resolvedComponents - config._resolvedComponents (for {@Key} expansion)
 * @param {object} variables          - config.variables (for {%var} expansion)
 */
function loadDescConfig(specPath, configBase, resolvedComponents, variables) {
  if (!specPath) return {};
  if (!fs.existsSync(specPath)) {
    console.warn(`  WARN: description config not found: ${specPath}`);
    return {};
  }
  const raw = loadYaml(specPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Description config must be a YAML mapping: ${specPath}`);
  }
  const base = configBase || path.dirname(specPath);

  function expandValue(val) {
    if (!val || typeof val !== 'string') return val;
    let result = val;
    if (variables) result = resolveVariables(result, variables);
    if (resolvedComponents) {
      result = result.replace(/\{@([^}]+)\}/g, (match, key) => {
        const name = key.trim();
        for (const [, dirMap] of Object.entries(resolvedComponents)) {
          const actualKey = [...dirMap.keys()].find(k => k.toLowerCase() === name.toLowerCase());
          if (actualKey !== undefined) return dirMap.get(actualKey);
        }
        return match;
      });
    }
    return result;
  }

  return {
    bodyPath:                raw.body   ? path.resolve(base, expandValue(raw.body))   : null,
    scriptPath:              raw.script ? path.resolve(base, expandValue(raw.script)) : null,
    stripTrailingInstructions: raw.stripTrailingInstructions === true,
  };
}

/**
 * Extract and clean the top comment block from a JavaScript file.
 *
 * Rules (applied after stripping `//` prefix and trimming each line):
 *   - Pure separator lines (all `=` chars)  → skip
 *   - Banner title lines (`=`-padded text)   → emit `=== title ===`
 *   - Empty lines                            → skip
 *   - Everything else                        → emit as-is
 *
 * When opts.stripTrailingInstructions is true: if the final group (content
 * between the last separator block and end of comment) has no list-item lines
 * (lines starting with `-` or `*`) but at least one earlier group did, that
 * final group is dropped.
 *
 * Returns a string beginning with `\n` (blank-line separator from preceding body).
 */
function extractScriptBanner(scriptPath, opts = {}) {
  const { stripTrailingInstructions = false } = opts;
  const source = fs.readFileSync(scriptPath, 'utf8');
  const rawLines = source.split(/\r?\n/);

  // Collect contiguous // lines from the start of the file
  const commentLines = [];
  let inComment = false;
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!inComment && trimmed === '') continue; // skip leading blank lines
    if (!trimmed.startsWith('//')) break;       // stop at first non-comment line
    inComment = true;
    commentLines.push(trimmed);
  }

  const isSeparator  = s => /^=+$/.test(s);
  const isBannerTitle = s => /^=+\s+.+\s+=+$/.test(s);
  const isListItem   = s => /^[-*]/.test(s);
  const extractTitle = s => s.replace(/^=+\s+/, '').replace(/\s+=+$/, '').trim();

  // Group lines by separator boundaries; transform title lines
  const groups = [];
  let current = [];

  for (const raw of commentLines) {
    // Strip `// ` or `//` prefix
    const stripped = raw.replace(/^\/\/\s?/, '').trim();

    if (isSeparator(stripped)) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
    } else if (isBannerTitle(stripped)) {
      current.push(`=== ${extractTitle(stripped)} ===`);
    } else if (stripped !== '') {
      current.push(stripped);
    }
    // empty stripped lines are skipped
  }
  if (current.length > 0) groups.push(current);

  // Optionally drop trailing instruction block
  if (stripTrailingInstructions && groups.length > 1) {
    const last = groups[groups.length - 1];
    const lastHasList = last.some(isListItem);
    const earlierHaveList = groups.slice(0, -1).some(g => g.some(isListItem));
    if (!lastHasList && earlierHaveList) {
      groups.pop();
    }
  }

  const lines = groups.flat();
  return lines.length > 0 ? '\n' + lines.join('\n') : '';
}

/**
 * Write Description.md directly into outputDir (not into Components/).
 * Returns the written path, or null if content is empty.
 */
function writeDescription(outputDir, content) {
  if (!content) return null;
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, 'Description.md');
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

module.exports = { loadDescConfig, extractScriptBanner, writeDescription };
