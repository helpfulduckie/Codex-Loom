'use strict';

const fs = require('fs');
const path = require('path');
const {
  resolveVariables, checkUnexpandedVariables, checkUnresolvedFieldTokens, checkMechanicalArtifacts,
} = require('./util');
const { busWarner, severityOf, CODES: DIAG_CODES } = require('./diag');
const { walkBranchTree, mergePlaceholders, mergeUnbindable } = require('./model/branches');
const { FRAMING_DESCRIPTOR, isPassthrough, renderSectionedComponent } = require('./emit/components');
const { applyTokenPass } = require('./model/pronouns');
const {
  checkUndeclaredPlaceholders, checkPlaceholderContext, writeNodePlaceholders, localKeysOf,
  expandQuestions,
} = require('./emit/placeholders');
const { LIMITS, checkLimit } = require('./limits');

/**
 * Resolve opening content: file path → read file; otherwise use as inline text.
 *
 * `sink` (`{ diagnostics, file }`), when passed, routes an undeclared `{%var}` or a cycle
 * onto the bus — the literal arm of this function is one of the surfaces where such a token
 * would otherwise only reach `console.warn`.
 */
function resolveOpeningContent(opening, base, variables, sink) {
  const expandedSpec = variables ? resolveVariables(String(opening), variables, sink) : String(opening);
  const resolved = path.resolve(base, expandedSpec);
  let content;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    content = fs.readFileSync(resolved, 'utf8').trimEnd();
  } else {
    content = expandedSpec.trimEnd();
  }
  return variables ? resolveVariables(content, variables, sink) : content;
}

/**
 * Resolve a component spec (a file path, or literal text) against branch-merged variables.
 *
 * Returns null for an absent spec, an absolute path when the spec names a file that
 * exists, and otherwise the literal string — `opening:` and `branchFraming:` are often a
 * sentence rather than a path, and that fallback is what lets one key carry both.
 *
 * **The literal arm returns the *expanded* string, not the raw one.** An inline spec is
 * content, and content has its variables expanded like any other text — returning the raw
 * spec left `opening: 'You wake in {%place}.'` carrying a live token past this point, where
 * the caller's unresolved-reference check reads any surviving `{` as a path that failed to
 * expand and records a component gap. A token that genuinely does not resolve still survives
 * `resolveVariables` and still reaches that check, so the reporting is unchanged for the case
 * it was written for.
 */
function resolveComponentSpec(spec, base, variables, sink) {
  if (spec == null) return null;
  let resolved = spec;
  if (typeof resolved === 'string') {
    resolved = resolveVariables(resolved, variables, sink);
  }
  // Try resolving as file or directory path
  const filePath = path.resolve(base, String(resolved));
  if (fs.existsSync(filePath)) return filePath;
  return resolved;
}

/**
 * The placeholder table as Velvet Lattice will hold it at this node, for §8.5's caps.
 *
 * VL substitutes `%key%` with the *question*, so measuring the stored length needs the
 * questions and needs them already nested — which is what `expandQuestions` produces and
 * what `Placeholders.yaml` therefore contains (§12.2). Expanding the merged table here
 * gives the same values a leaf's inherited chain of those files would.
 *
 * Deliberately given no `onWarn`: `writePlaceholdersRecursive` runs the same expansion
 * with the bus attached, so passing one here would report every cycle and every undeclared
 * nested reference a second time. This call wants the strings, not the findings.
 */
function questionsForMeasurement(table, variables) {
  if (!table || Object.keys(table).length === 0) return null;
  return expandQuestions(table, variables);
}

/**
 * Copy scripts directory to target branch Scripts/ folder.
 */
function copyScripts(srcDir, targetDir) {
  if (!srcDir || !fs.existsSync(srcDir)) return;
  const dest = path.join(targetDir, 'Scripts');
  fs.cpSync(srcDir, dest, { recursive: true });
}

/**
 * Write Opening.md or Opening Choice.md to a branch node's Components folder.
 */
function writeComponentFile(outputDir, filename, content, sink) {
  const dir = path.join(outputDir, 'Components');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, filename);
  checkUnexpandedVariables(content, `component ${filename}`, sink);
  checkUnresolvedFieldTokens(content, `component ${filename}`, sink);
  checkMechanicalArtifacts(content, `component ${filename}`, sink);
  fs.writeFileSync(outPath, content + '\n', 'utf8');
  return outPath;
}

/**
 * Write branch framing across the branch tree (§7.3).
 *
 * Framing is the only component that belongs to a *non-leaf* node — AID reads it as what
 * is shown while the player chooses among the children below it — which is why this uses
 * the tree visitor while every other component is written by the leaf loop. It lands in
 * `Opening.md`, the name a leaf's `opening:` uses, because Velvet Lattice reads a node's
 * prompt from that filename at every level.
 *
 * Per-node `roles`/`branchProtagonist` merge into the visitor's `state` the same way
 * `branchVars`/`table` do, via `mergeUnbindable` — the same key-wise `~`-deleting merge
 * `walkBranchChain` (`model/branches.js`) uses for roles, reused rather than reimplemented
 * so the two cannot disagree. `onRoleUsed` arrives as a parameter rather than a closure
 * because this is a top-level function with no closure over `compile()`'s scope.
 */
function writeFramingRecursive(rootNode, outputBase, configBase, configPath, variables, verbose = false, diagnostics = null, usage = null, loadSectioned = null, registry = null, onRoleUsed = null) {
  // The walker visits the project root as a node (Phase 11 Step 0), so an unbranched
  // project still receives its root visit — that is where the "no branches" warn lands.
  if (!rootNode || typeof rootNode !== 'object') return;

  const framingSink = { diagnostics, file: configPath };
  const renderFraming = (spec, nodePath, vars, table, name, roles, branchProtagonist) => {
    const resolvedSpec = resolveComponentSpec(spec, configBase, vars, framingSink);
    const isFile = typeof resolvedSpec === 'string' && fs.existsSync(resolvedSpec)
      && fs.statSync(resolvedSpec).isFile();

    // Three shapes, the same three an opening has: a component document, a prose file, and
    // a literal sentence. Framing is a question far more often than it is a path, which is
    // why the literal arm is the common one here.
    if (isFile && !isPassthrough(resolvedSpec)) {
      const component = loadSectioned
        ? loadSectioned(resolvedSpec, FRAMING_DESCRIPTOR)
        : null;
      if (!component) return null;
      // An empty occupant map: framing sits at an interior node, and items are resolved per
      // leaf, so there is no cast here to route into it. Same call the scenario blurb makes.
      const { text } = renderSectionedComponent(component, nodePath, new Map(), {
        defaultHeadingLevel: FRAMING_DESCRIPTOR.defaultHeadingLevel,
        variables: vars, registry, branchProtagonist,
        roles, onRoleUsed,
        onWarn: busWarner(diagnostics, { file: String(resolvedSpec) }),
        diagnostics, file: String(resolvedSpec),
      });
      return text;
    }
    // Framing written as a sentence or a prose `.md` still resolves role and pronoun
    // tokens — the same pass the sectioned arm above runs — so `{$LI}` in a one-line
    // `branchFraming:` works like it does in a `sections:` document. Interior nodes and the
    // project root alike: the root visit reaches here with the project's own roles table
    // and protagonist already merged in, exactly as it does for a sectioned root framing.
    const literal = resolveOpeningContent(spec, configBase, vars, framingSink);
    return applyTokenPass(literal, {
      item: {}, registry, branchProtagonist, roles, onRoleUsed,
      onWarn: busWarner(diagnostics, { file: configPath }),
    });
  };

  walkBranchTree(rootNode, ({ name, node, path: nodePath, isLeaf, isRoot, state }) => {
    const nodeOutput = isRoot ? state.outputBase : path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    const framing = node && node.components && node.components.branchFraming !== undefined
      ? node.components.branchFraming
      : null;

    const table = mergePlaceholders(state.table, node);

    // Roles merge the same way `walkBranchChain` merges them for the leaf loop — key-wise,
    // `~` deleting, `rolesDeclared` sticky once any ancestor (including the project root)
    // declares a `roles:` key at all, even if every binding it declared unbinds to nothing
    // (§9.3's CL0540 gating cares about that distinction, not just whether the merged table
    // is non-empty). No `onWarn` here, matching `mergePlaceholders` two lines above: this
    // walker has never surfaced per-node unbind warnings and Step 4 does not start now.
    const rolesDeclared = state.rolesDeclared || !!(node && node.roles);
    const roles = mergeUnbindable(state.roles, node && node.roles, {
      code: DIAG_CODES.ROLE_UNBIND_UNKNOWN, kind: 'role', onWarn: null,
    });
    // Same derivation the leaf loop uses (`chain.roles.protagonist`, resolved and
    // lowercased against the branch's own variables) — reading the merged table directly
    // rather than gating on `rolesDeclared` first, because an inherited protagonist is a
    // real binding whether or not *this* node is the one that declared `roles:`.
    const inheritedProtagonist = roles.protagonist || '';
    // No bus, matching the leaf loop's resolve of the same string: a per-node walker, and an
    // undeclared name here is one config mistake rather than one per branch.
    const branchProtagonist = resolveVariables(inheritedProtagonist, branchVars).toLowerCase() || null;

    if (framing != null) {
      if (isLeaf) {
        // The same rule at both levels: nothing below this node means nothing to frame.
        // The walker's root visit reaches the project rung here (Phase 11 Step 0), and
        // the message is the one the old root rung wrote.
        diagnostics.warn(
          DIAG_CODES.BRANCH_FRAMING_IGNORED,
          isRoot
            ? 'root branchFraming with no branches — ignoring'
            : `branchFraming on leaf branch "${name}" — ignoring`,
          { file: configPath },
        );
      } else {
        // Phase 11 Step 1: the root renders through the same sectioned path an interior
        // node uses, rather than the literal/`{%variable}`-only `resolveOpeningContent`
        // the old hand-rolled rung called. That gains `sections:`, roles, `_variables`
        // (library names folded in, since `branchVars` descends from the seed the root
        // visit merged) and the undeclared-placeholder check, none of which the root ever
        // had before.
        const framingText = renderFraming(
          framing, nodePath, branchVars, table, name,
          rolesDeclared ? roles : null, branchProtagonist,
        );
        if (framingText) {
          checkUndeclaredPlaceholders(framingText, table, {
            diagnostics, where: isRoot ? 'the project root (framing)' : `the branch framing on "${name}"`,
            usage, usagePath: nodePath.join('/'),
          });
          // Framing lands in the same `Opening.md` filename at an interior node, and VL caps
          // the file rather than the chain — components merge per filename, so a leaf's
          // opening replaces this rather than adding to it (§8.5).
          checkLimit(framingText, questionsForMeasurement(table, branchVars), LIMITS.opening, {
            diagnostics, label: isRoot ? 'the project root (framing)' : `branch "${name}" (framing)`,
          });
          const outPath = writeComponentFile(nodeOutput, 'Opening.md', framingText, { diagnostics });
          if (verbose) console.log(isRoot ? `    OK: Root OpeningChoice → ${outPath}` : `    OK: BranchFraming → ${outPath}`);
        }
      }
    }

    return {
      outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
    };
  }, {
    // Seeded empty: the walker visits the project root first, and the root's own
    // `placeholders:` and `roles:` establish these through the same merges any branch
    // node uses. `variables` is the exception — the root visit merges the declared set,
    // so the effective set (`_variables`, library names folded in) has to arrive already
    // seeded (Step 1's root framing resolves against it); `_variables` ⊇ `variables`,
    // so the root's merge leaves it untouched.
    outputBase, variables, table: {}, roles: {}, rolesDeclared: false,
  });
}

/**
 * Write Label.md at every node in the branch tree, the project root included
 * (Phase 11 Step 0).
 *
 * Node-level, not leaf-level, which is why it uses the tree visitor rather than the
 * leaf loop: a branch label belongs to the node the player is choosing.
 */
function writeLabelsRecursive(rootNode, outputBase, variables, rootVariables, verbose = false, diagnostics = null, configPath = null, usage = null) {
  walkBranchTree(rootNode, ({ name, node, path: path_, isRoot, state }) => {
    const nodeOutput = isRoot ? state.outputBase : path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    const table = mergePlaceholders(state.table, node);

    if (isRoot) {
      // The scenario title, written once at the project root. Two things stay different
      // from a branch label here, both deliberately: it expands against `rootVariables`
      // — the variables the author declared, not `_variables` with library names folded
      // in, exactly as the old rung did — and it gets the "AID never substitutes a
      // scenario title" warn where a branch title only half-works.
      if (node.title == null) {
        return { outputBase: nodeOutput, variables: branchVars, table };
      }
      const rootLabel = resolveVariables(String(node.title), rootVariables, { diagnostics, file: configPath });
      const labelPath = path.join(nodeOutput, 'Label.md');
      checkUndeclaredPlaceholders(rootLabel, table, {
        diagnostics, file: configPath, where: 'the project title',
        usage, usagePath: '',
      });
      checkPlaceholderContext(rootLabel, {
        diagnostics,
        file: configPath,
        where: 'the scenario title',
        severity: 'warn',
        reason: 'AID never fills a placeholder in the scenario title. The title names the '
          + 'scenario in listings, before any adventure exists to answer a prompt, so the '
          + 'raw text is what readers see. Legal to write, and occasionally meant as a '
          + 'joke, but never substituted.',
      });
      fs.writeFileSync(labelPath, rootLabel + '\n', 'utf8');
      if (verbose) console.log(`  OK: Label → ${labelPath}`);
      return { outputBase: nodeOutput, variables: branchVars, table };
    }

    const rawTitle = (node && node.title) || name;
    fs.mkdirSync(nodeOutput, { recursive: true });
    const outPath = path.join(nodeOutput, 'Label.md');
    const labelText = resolveVariables(rawTitle, branchVars, { diagnostics, file: configPath });
    // A branch title is the one destination where a placeholder half-works: AID fills
    // the prompt correctly, then keeps the raw text in the saved adventure's title.
    // Undeclared is still simply broken, so it errors here like anywhere else; the
    // half-working case is Step 4's WARN.
    checkUndeclaredPlaceholders(labelText, table, {
      diagnostics, file: configPath, where: `the title of branch "${name}"`,
      usage, usagePath: path_.join('/'),
    });
    checkPlaceholderContext(labelText, {
      diagnostics,
      file: configPath,
      where: `the title of branch "${name}"`,
      severity: 'warn',
      reason: 'a branch title half-works. AID fills the prompt and shows the answer while '
        + 'the player is choosing, then keeps the raw placeholder text in the saved '
        + 'adventure’s title. Deliberate is possible; usually it is not.',
    });
    // Velvet Lattice reads `Label.md` from the node's own directory and falls back to the
    // directory name when the file is absent (`scenario.py:37`, `self._load_file("Label.md")
    // or self.name`). A label that renders to its own branch key is therefore written for
    // nothing — 60 of The Institute's 61 label files are exactly that. Write only where the
    // rendered label differs from the segment VL would default to (Phase 11 Step 3,
    // Decision 2). The diagnostics above still run either way: a broken placeholder in a
    // title the author wrote is reportable whether or not the file lands.
    if (labelText !== name) {
      fs.writeFileSync(outPath, labelText + '\n', 'utf8');
      if (verbose) console.log(`    OK: Label → ${outPath}`);
    } else if (fs.existsSync(outPath)) {
      // A prior compile of a since-shortened title left one behind. Harmless to VL, which
      // would read it and get the same string it now defaults to, but noise in the tree
      // and in any diff — the pre-build clean only archives whole stale nodes, not a live
      // node whose label collapsed into its key.
      fs.rmSync(outPath);
    }

    return { outputBase: nodeOutput, variables: branchVars, table };
  }, { outputBase, variables, table: {} });
}

/**
 * Write `Placeholders.yaml` across the branch tree (§12.2).
 *
 * Node-level, like `Label.md` and for the same reason: Velvet Lattice reads one file per
 * scenario node and merges them down itself, so the leaf loop is the wrong shape — it
 * would emit a leaf's accumulated table and never write the interior nodes at all.
 *
 * Each node emits only the keys it declares. What it emits are those keys' *expanded*
 * questions, resolved against the merged table so a local question nesting an inherited
 * key carries that key's question inline — see `emit/placeholders.js` for why the nesting
 * cannot be left to VL.
 */
function writePlaceholdersRecursive(rootNode, outputBase, variables, configPath, diagnostics, verbose = false, usage = null, declarations = null, duplicates = null) {
  const onWarn = (code, message, file) => diagnostics.add(
    severityOf(code), code, message, { file: file || configPath },
  );

  // The walker's root visit replaces the old hand-rolled root rung (Phase 11 Step 0):
  // the root's own `placeholders:` live on the root node itself, the merged table starts
  // empty and gains them at the root exactly the way a branch node gains its own, and
  // the declarations entry keeps the root's `at the project root` label and its
  // unconditional-on-`placeholders` push.
  walkBranchTree(rootNode, ({ name, node, path: path_, isRoot, state }) => {
    const nodeOutput = isRoot ? state.outputBase : path.join(state.outputBase, 'Branches', name);
    const branchVars = (node && node.variables)
      ? Object.assign({}, state.variables, node.variables)
      : state.variables;

    // The merged table at this node, by the same rules `walkBranchChain` applies along a
    // path: local keys override inherited ones, `~` deletes. Accumulated here rather than
    // looked up because the tree walk already has the chain in hand as `state`.
    const table = mergePlaceholders(state.table, node);

    if (declarations) {
      const keys = localKeysOf(node);
      if (keys.length) {
        declarations.push(isRoot
          ? { path: '', label: 'at the project root', keys }
          : { path: path_.join('/'), label: `on branch "${path_.join('/')}"`, keys });
      }
    }

    const outPath = writeNodePlaceholders(nodeOutput, node, table, branchVars, {
      onWarn, file: configPath, diagnostics, usage, usagePath: path_.join('/'), duplicates,
    });
    if (outPath && verbose) console.log(`    OK: Placeholders → ${outPath}`);

    return { outputBase: nodeOutput, variables: branchVars, table };
  }, { outputBase, variables, table: {} });
}

/**
 * Write content to Components/Opening.md inside outputDir.
 * Exposed for unit testing.
 */
function writeOpening(outputDir, content) {
  return writeComponentFile(outputDir, 'Opening.md', content);
}

module.exports = {
  resolveOpeningContent,
  resolveComponentSpec,
  questionsForMeasurement,
  copyScripts,
  writeComponentFile,
  writeFramingRecursive,
  writeLabelsRecursive,
  writePlaceholdersRecursive,
  writeOpening,
};
