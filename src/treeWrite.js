'use strict';

const fs = require('fs');
const path = require('path');
const {
  resolveVariables, checkUnexpandedVariables, checkUnresolvedFieldTokens, checkMechanicalArtifacts,
} = require('./util');
const { busWarner, severityOf, CODES: DIAG_CODES } = require('./diag');
const { walkBranchTree, mergePlaceholders, mergeUnbindable } = require('./model/branches');
const {
  FRAMING_DESCRIPTOR, DESCRIPTION_DESCRIPTOR, isPassthrough, readPassthrough,
  renderSectionedComponent, writeSectionedComponent,
} = require('./emit/components');
const { applyTokenPass } = require('./model/pronouns');
const {
  checkUndeclaredPlaceholders, checkPlaceholderContext, writeNodePlaceholders, localKeysOf,
  expandQuestions,
} = require('./emit/placeholders');
const { LIMITS, checkLimit } = require('./limits');

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
function questionsForMeasurement(table, variables, {
  registry, roles, branchProtagonist, onRoleUsed,
} = {}) {
  if (!table || Object.keys(table).length === 0) return null;
  return expandQuestions(table, variables, {
    registry, roles, branchProtagonist, onRoleUsed,
  });
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
 * The five computations every `walkBranchTree` visitor in this file opens with: the
 * node's output directory, its variables merged over the parent's, its placeholder table
 * merged over the parent's, and its role table (with the `rolesDeclared` sticky flag)
 * merged over the parent's. All three walkers use exactly these five.
 */
function nodeVisitPrologue(name, node, isRoot, state) {
  const outputBase = isRoot ? state.outputBase : path.join(state.outputBase, 'Branches', name);
  const variables = (node && node.variables)
    ? Object.assign({}, state.variables, node.variables)
    : state.variables;
  const table = mergePlaceholders(state.table, node);
  // Key-wise, `~`-deleting merge, the same one `walkBranchChain` uses for roles in the leaf
  // loop, reused rather than reimplemented so the two cannot disagree. `rolesDeclared` is
  // sticky once any ancestor (including the project root) declares a `roles:` key at all,
  // even if every binding it declared unbinds to nothing (§9.3's CL0540 gating cares about
  // that distinction, not just whether the merged table is non-empty). No `onWarn`: these
  // walkers have never surfaced per-node unbind warnings.
  const rolesDeclared = state.rolesDeclared || !!(node && node.roles);
  const roles = mergeUnbindable(state.roles, node && node.roles, {
    code: DIAG_CODES.ROLE_UNBIND_UNKNOWN, kind: 'role', onWarn: null,
  });
  return {
    outputBase, variables, table, roles, rolesDeclared,
  };
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
 * Per-node `roles` merge into the visitor's `state` the same way `branchVars`/`table` do,
 * via `mergeUnbindable` — the same key-wise `~`-deleting merge `walkBranchChain`
 * (`model/branches.js`) uses for roles, reused rather than reimplemented so the two cannot
 * disagree. `branchProtagonist` arrives already resolved per node in `protagonistByPath`
 * (`resolveProtagonists` in compile.js), keyed by `path.join('/')`, so the `{%var}` expand
 * — and its `CL0510` — happens once where the answer can change rather than at every node.
 * `onRoleUsed` arrives as a parameter rather than a closure because this is a top-level
 * function with no closure over `compile()`'s scope.
 */
function writeFramingRecursive(rootNode, outputBase, opts = {}) {
  const {
    configBase, configPath, variables, log, diagnostics, usage = null, loadSectioned = null,
    registry = null, onRoleUsed = null, protagonistByPath = null,
  } = opts;
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
    // `resolvedSpec` already carries the expanded literal, so only a prose file's content
    // still needs its variables resolved. Expanding the literal a second time would report
    // the same undeclared token once per pass — the bus does not dedupe.
    const literal = isFile
      ? resolveVariables(fs.readFileSync(resolvedSpec, 'utf8').trimEnd(), vars, framingSink)
      : String(resolvedSpec).trimEnd();
    return applyTokenPass(literal, {
      item: {}, registry, branchProtagonist, roles, onRoleUsed,
      onWarn: busWarner(diagnostics, { file: configPath }),
    });
  };

  walkBranchTree(rootNode, ({ name, node, path: nodePath, isLeaf, isRoot, state }) => {
    const {
      outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
    } = nodeVisitPrologue(name, node, isRoot, state);

    const framing = node && node.components && node.components.branchFraming !== undefined
      ? node.components.branchFraming
      : null;

    // The same value the leaf loop reads for this node: an inherited protagonist is a real
    // binding whether or not *this* node is the one that declared `roles:`, which is why the
    // map is read directly rather than gated on `rolesDeclared`.
    const branchProtagonist = protagonistByPath
      ? (protagonistByPath.get(nodePath.join('/')) || null)
      : null;

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
        // node uses, rather than the literal/`{%variable}`-only path the old root rung
        // used. That gains `sections:`, roles, `_variables`
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
          checkLimit(framingText, questionsForMeasurement(table, branchVars, {
            registry, roles: rolesDeclared ? roles : null, branchProtagonist, onRoleUsed,
          }), LIMITS.opening, {
            diagnostics, label: isRoot ? 'the project root (framing)' : `branch "${name}" (framing)`,
          });
          const outPath = writeComponentFile(nodeOutput, 'Opening.md', framingText, { diagnostics });
          log.verbose(isRoot ? `    OK: Root OpeningChoice → ${outPath}` : `    OK: BranchFraming → ${outPath}`);
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
 * Write Label.md at every node in the branch tree, the project root included.
 *
 * Node-level, not leaf-level, which is why it uses the tree visitor rather than the
 * leaf loop: a branch label belongs to the node the player is choosing.
 */
function writeLabelsRecursive(rootNode, outputBase, opts = {}) {
  const {
    variables, rootVariables, log, diagnostics, configPath = null, usage = null,
    registry = null, onRoleUsed = null, protagonistByPath = null,
  } = opts;
  walkBranchTree(rootNode, ({ name, node, path: path_, isRoot, state }) => {
    const {
      outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
    } = nodeVisitPrologue(name, node, isRoot, state);
    const branchProtagonist = protagonistByPath
      ? (protagonistByPath.get(path_.join('/')) || null)
      : null;

    if (isRoot) {
      // The scenario title, written once at the project root. Two things stay different
      // from a branch label here, both deliberately: it expands against `rootVariables`
      // — the variables the author declared, not `_variables` with library names folded
      // in, exactly as the old rung did — and it gets the "AID never substitutes a
      // scenario title" warn where a branch title only half-works.
      if (node.title == null) {
        return {
          outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
        };
      }
      const rootLabel = applyTokenPass(
        resolveVariables(String(node.title), rootVariables, { diagnostics, file: configPath }),
        {
          item: {}, registry, branchProtagonist,
          roles: rolesDeclared ? roles : null,
          onRoleUsed,
          onWarn: busWarner(diagnostics, { file: configPath }),
        },
      );
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
      log.verbose(`  OK: Label → ${labelPath}`);
      return {
        outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
      };
    }

    const rawTitle = (node && node.title) || name;
    fs.mkdirSync(nodeOutput, { recursive: true });
    const outPath = path.join(nodeOutput, 'Label.md');
    const labelText = applyTokenPass(
      resolveVariables(rawTitle, branchVars, { diagnostics, file: configPath }),
      {
        item: {}, registry, branchProtagonist,
        roles: rolesDeclared ? roles : null,
        onRoleUsed,
        onWarn: busWarner(diagnostics, { file: configPath }),
      },
    );
    // A branch title is the one destination where a placeholder half-works: AID fills
    // the prompt correctly, then keeps the raw text in the saved adventure's title.
    // Undeclared is still simply broken, so it errors here like anywhere else; the
    // half-working case is a WARN, below.
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
    // rendered label differs from the segment VL would default to. The diagnostics above
    // still run either way: a broken placeholder in a title the author wrote is reportable
    // whether or not the file lands.
    if (labelText !== name) {
      fs.writeFileSync(outPath, labelText + '\n', 'utf8');
      log.verbose(`    OK: Label → ${outPath}`);
    } else if (fs.existsSync(outPath)) {
      // A prior compile of a since-shortened title left one behind. Harmless to VL, which
      // would read it and get the same string it now defaults to, but noise in the tree
      // and in any diff — the pre-build clean only archives whole stale nodes, not a live
      // node whose label collapsed into its key.
      fs.rmSync(outPath);
    }

    return {
      outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
    };
  }, {
    outputBase, variables, table: {}, roles: {}, rolesDeclared: false,
  });
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
function writePlaceholdersRecursive(rootNode, outputBase, opts = {}) {
  const {
    variables, configPath, diagnostics, log, usage = null, declarations = null, duplicates = null,
    registry = null, onRoleUsed = null, protagonistByPath = null,
  } = opts;
  const onWarn = (code, message, file) => diagnostics.add(
    severityOf(code), code, message, { file: file || configPath },
  );

  // The walker's root visit covers the project root itself: the root's own `placeholders:`
  // live on the root node, the merged table starts empty and gains them at the root exactly
  // the way a branch node gains its own, and the declarations entry keeps the root's `at
  // the project root` label and its unconditional-on-`placeholders` push.
  walkBranchTree(rootNode, ({ name, node, path: path_, isRoot, state }) => {
    const {
      outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
    } = nodeVisitPrologue(name, node, isRoot, state);
    const branchProtagonist = protagonistByPath
      ? (protagonistByPath.get(path_.join('/')) || null)
      : null;

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
      registry, roles: rolesDeclared ? roles : null, branchProtagonist, onRoleUsed,
    });
    if (outPath) log.verbose(`    OK: Placeholders → ${outPath}`);

    return {
      outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
    };
  }, {
    outputBase, variables, table: {}, roles: {}, rolesDeclared: false,
  });
}

/**
 * The recursive tree writers. `opening:` is written by the leaf loop as an ordinary
 * inherited component; what is left for the tree visitor is framing, labels and
 * placeholder questions, each of which belongs to interior nodes the leaf loop never
 * visits. Root-level `branchFraming` and the root `Label` land in these walkers' own
 * root visits.
 */
function writeTreeFiles({
  config, configPath, log, diagnostics,
  placeholderState, componentLoader, registry, roleState, protagonistByPath,
}) {
  writeFramingRecursive(config, config._resolvedOutput, {
    configBase: config._base,
    configPath,
    variables: config._variables || config.variables || {},
    log,
    diagnostics,
    usage: placeholderState.usage,
    loadSectioned: componentLoader.load,
    registry,
    onRoleUsed: roleState.onUsed,
    protagonistByPath,
  });

  writeLabelsRecursive(config, config._resolvedOutput, {
    variables: config._variables || config.variables || {},
    rootVariables: config.variables || {},
    log,
    diagnostics,
    configPath,
    usage: placeholderState.usage,
    registry,
    onRoleUsed: roleState.onUsed,
    protagonistByPath,
  });

  writePlaceholdersRecursive(config, config._resolvedOutput, {
    variables: config._variables || config.variables || {},
    configPath,
    diagnostics,
    log,
    usage: placeholderState.usage,
    declarations: placeholderState.declarations,
    duplicates: placeholderState.duplicates,
    registry,
    onRoleUsed: roleState.onUsed,
    protagonistByPath,
  });
}

/**
 * The scenario blurb, written once to the output root alongside `Branches/`. An ordinary
 * component document: `body:` is a section with `file:` and `script:` is one with
 * `from: {script:, extract: scriptBanner}`. It renders through `renderSectionedComponent`
 * with an empty occupant map — the same render path called with nothing to place, because
 * a scenario has one blurb and items are branch-scoped. Gaps and the unbranched-root key
 * collision are recorded on the buses passed in.
 */
function writeScenarioBlurb({
  config, configPath, log, diagnostics,
  rootVariables, registry, placeholderState, roleState, componentLoader, gaps, descriptionLeaves,
}) {
  const descRequested = config.components && config.components.description != null;
  const descSpec = descRequested
    ? resolveComponentSpec(
        config.components.description, config._base,
        config._variables || config.variables || null, { diagnostics, file: configPath },
      )
    : null;
  if (descRequested && !(descSpec && typeof descSpec === 'string' && fs.existsSync(descSpec))) {
    gaps.record('(project)', 'Description', descSpec, 'source not found');
  } else if (descSpec && typeof descSpec === 'string' && fs.existsSync(descSpec)) {
    let combined = null;
    let descMetadata = null;
    const rootRolesDeclared = !!(config.roles && Object.keys(config.roles).length);

    if (isPassthrough(descSpec)) {
      // A prose `.md`/`.txt` blurb still resolves role and pronoun tokens, matching the
      // `sections:` arm below and the leaf loop. `branchProtagonist` stays null — the blurb
      // belongs to the project, not any branch — and `roles` is gated the same way that arm
      // gates it: passed only when some node declared `roles:`, so `CL0540` treats a project
      // that never mentions roles as role-unaware rather than one with zero bindings.
      const raw = readPassthrough(descSpec);
      if (raw === null) {
        combined = null;
      } else {
        combined = applyTokenPass(raw, {
          item: {}, registry, branchProtagonist: null,
          roles: rootRolesDeclared ? config.roles : null, onRoleUsed: roleState.onUsed,
          onWarn: busWarner(diagnostics, { file: String(descSpec) }),
        }) || null;
      }
    } else {
      const descComponent = componentLoader.load(descSpec, DESCRIPTION_DESCRIPTOR);
      if (descComponent) {
        descMetadata = descComponent.metadata;
        // `branchProtagonist` stays null: the blurb belongs to the project, not to any
        // branch, so there is no chain to take a protagonist from. `roles` still reaches
        // the render, gated the same way the leaf loop gates it (pass the table only when
        // some node declared `roles:`), so a `{$role}` token in the root description
        // resolves instead of reading as an undeclared placeholder, and `onRoleUsed` marks
        // it used so `CL0545` agrees.
        ({ text: combined } = renderSectionedComponent(
          descComponent, [], new Map(),
          {
            defaultHeadingLevel: DESCRIPTION_DESCRIPTOR.defaultHeadingLevel,
            variables: rootVariables || {}, registry, branchProtagonist: null,
            roles: rootRolesDeclared ? config.roles : null, onRoleUsed: roleState.onUsed,
            onWarn: busWarner(diagnostics, { file: String(descSpec) }),
            diagnostics, file: String(descSpec),
          },
        ));
      }
    }

    // Checked against the root placeholder table: the blurb belongs to the project. The
    // per-node case is carried by `adventureDescription:` — a different key, resolved
    // inside the leaf loop against the branch-merged table.
    checkUndeclaredPlaceholders(combined, config.placeholders, {
      diagnostics, file: descSpec, where: 'the Description',
      usage: placeholderState.usage, usagePath: '',
    });
    checkPlaceholderContext(combined, {
      diagnostics,
      file: descSpec,
      where: 'the Description',
      reason: 'AID does not fill placeholders in the Description. It is shown before any '
        + 'adventure exists to answer them, so the raw text is what a reader sees.',
    });
    const descPath = writeSectionedComponent(
      config._resolvedOutput, DESCRIPTION_DESCRIPTOR, combined,
      { diagnostics }, descMetadata,
    );
    if (descPath) {
      log.verbose(`  OK: Description → ${descPath}`);
      // Both description keys write `Description.md`, and at an unbranched root they write
      // the same one — the root is its own leaf there, so the leaf loop has already been
      // through. Reported rather than silently resolved, because which of the two an author
      // meant to survive is not recoverable from the file that is left.
      if (descriptionLeaves.has('(root)')) {
        diagnostics.warn(
          DIAG_CODES.DESCRIPTION_KEYS_COLLIDE,
          'this project declares both description: and adventureDescription: and has no '
          + 'branches, so the root is its own leaf and both write the same Description.md. '
          + 'The scenario blurb is what survives. Drop one, or add the branch the '
          + 'adventure description was written for.',
          { file: configPath },
        );
      }
    } else gaps.record('(project)', 'Description', descSpec, 'compiled to empty content');
  }
}

module.exports = {
  resolveComponentSpec,
  questionsForMeasurement,
  writeFramingRecursive,
  writeLabelsRecursive,
  writePlaceholdersRecursive,
  writeTreeFiles,
  writeScenarioBlurb,
};
