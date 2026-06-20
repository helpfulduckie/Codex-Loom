'use strict';

const fs = require('fs');
const path = require('path');
const { loadYaml, resolveVariables } = require('./util');
const { resolveBranchSpec } = require('./resolver');

/**
 * Load and validate a YAML block-opening file.
 * Must be a YAML sequence; throws if not.
 */
function loadOpeningConfig(filePath) {
  const doc = loadYaml(filePath);
  if (!Array.isArray(doc)) {
    throw new Error(`opening config must be a YAML sequence: ${filePath}`);
  }
  return doc;
}

/**
 * Resolve a block's text spec: if it points to an existing file, read it;
 * otherwise treat as inline text. Variable expansion applied to path and content.
 * Base path is config._base (compile.yaml directory) — consistent with other components.
 */
function resolveBlockText(textSpec, base, variables) {
  const expanded = variables ? resolveVariables(String(textSpec), variables) : String(textSpec);
  const resolved = path.resolve(base, expanded);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    const content = fs.readFileSync(resolved, 'utf8').trimEnd();
    return variables ? resolveVariables(content, variables) : content;
  }
  return expanded.trimEnd();
}

/**
 * Compile an opening.yaml block sequence for a given branch leaf.
 *
 * Each block can have:
 *   text:      string | file path   (required)
 *   branches:  branch dispatch map  (optional; same syntax as PE blocks)
 *   variants:  { name: { text: ... } }  (optional named text deltas)
 *
 * Branch dispatch semantics (via resolveBranchSpec):
 *   - No branches: key → block included in all leaves
 *   - null returned → block excluded from this leaf
 *   - string[] returned → included; first non-'*' entry is the variant name to apply
 *
 * Included blocks are resolved and joined with '\n\n'.
 * Returns null when no blocks are included (caller skips writing Opening.md).
 *
 * @param {object[]} blocks - parsed block sequence from opening.yaml
 * @param {string[]} branchPath - leaf branch path e.g. ['subject', 'mage']
 * @param {object} variables - merged branch variables for {%var} expansion
 * @param {string} base - config._base for resolving relative file paths in text:
 */
function compileOpening(blocks, branchPath, variables, base) {
  const paragraphs = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;

    // Branch dispatch — same semantics as PE blocks
    if (block.branches != null) {
      const dispatch = resolveBranchSpec(block.branches, branchPath);
      if (dispatch === null) continue; // explicitly excluded

      // Find the first real variant name ('*' means include with base text)
      const variantName = dispatch.find(v => v && v !== '*') || null;

      let textSpec = block.text;
      if (variantName != null) {
        const variant = block.variants && block.variants[variantName];
        if (variant && variant.text != null) {
          textSpec = variant.text;
        } else {
          console.warn(`  WARN [Opening]: block variant "${variantName}" not found — using base text`);
        }
      }

      if (textSpec == null) continue;
      const text = resolveBlockText(textSpec, base, variables);
      if (text && text.trim()) paragraphs.push(text);
    } else {
      // No branches: key — included in all leaves
      if (block.text == null) continue;
      const text = resolveBlockText(block.text, base, variables);
      if (text && text.trim()) paragraphs.push(text);
    }
  }

  return paragraphs.length > 0 ? paragraphs.join('\n\n') : null;
}

module.exports = { loadOpeningConfig, compileOpening };
