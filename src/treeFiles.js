'use strict';

const fs = require('fs');
const { busWarner, CODES: DIAG_CODES } = require('./diag');
const {
  DESCRIPTION_DESCRIPTOR, isPassthrough, readPassthrough,
  renderSectionedComponent, writeSectionedComponent,
} = require('./emit/components');
const { checkUndeclaredPlaceholders, checkPlaceholderContext } = require('./emit/placeholders');
const {
  resolveComponentSpec, writeFramingRecursive, writeLabelsRecursive, writePlaceholdersRecursive,
} = require('./treeWrite');

/**
 * Phase 8a — the recursive tree writers. `opening:` is written by the leaf loop as an
 * ordinary inherited component; what is left for the tree visitor is framing, labels and
 * placeholder questions, each of which belongs to interior nodes the leaf loop never
 * visits. Root-level `branchFraming` and the root `Label` land in these walkers' root
 * visits now (Phase 11 Step 0), not a hand-rolled rung.
 */
function writeTreeFiles({
  config, configPath, verbose, diagnostics,
  placeholderState, componentLoader, registry, roleState,
}) {
  writeFramingRecursive(
    config, config._resolvedOutput, config._base, configPath,
    config._variables || config.variables || {},
    verbose, diagnostics, placeholderState.usage,
    componentLoader.load, registry, roleState.onUsed,
  );

  writeLabelsRecursive(
    config, config._resolvedOutput, config._variables || config.variables || {}, config.variables || {},
    verbose, diagnostics, configPath, placeholderState.usage,
  );

  writePlaceholdersRecursive(
    config, config._resolvedOutput,
    config._variables || config.variables || {}, configPath, diagnostics, verbose,
    placeholderState.usage, placeholderState.declarations, placeholderState.duplicates,
  );
}

/**
 * Phase 8b — the scenario blurb (§7.7), written once to the output root alongside
 * `Branches/`. An ordinary component document since Phase 6: `body:` is a section with
 * `file:` and `script:` is one with `from: {script:, extract: scriptBanner}`. It renders
 * through `renderSectionedComponent` with an empty occupant map — the same render path
 * called with nothing to place, because a scenario has one blurb and items are
 * branch-scoped. Gaps and the unbranched-root key collision are recorded on the buses
 * passed in.
 */
function writeScenarioBlurb({
  config, configPath, verbose, diagnostics,
  rootVariables, registry, placeholderState, roleState, componentLoader, gaps, descriptionLeaves,
}) {
  const descRequested = config.components && config.components.description != null;
  const descSpec = descRequested
    ? resolveComponentSpec(config.components.description, config._base, config._variables || config.variables || null)
    : null;
  if (descRequested && !(descSpec && typeof descSpec === 'string' && fs.existsSync(descSpec))) {
    gaps.record('(project)', 'Description', descSpec, 'source not found');
  } else if (descSpec && typeof descSpec === 'string' && fs.existsSync(descSpec)) {
    let combined = null;
    let descMetadata = null;

    if (isPassthrough(descSpec)) {
      combined = readPassthrough(descSpec);
    } else {
      const descComponent = componentLoader.load(descSpec, DESCRIPTION_DESCRIPTOR);
      if (descComponent) {
        descMetadata = descComponent.metadata;
        // `branchProtagonist` stays null: the blurb belongs to the project, not to any
        // branch, so there is no chain to take a protagonist from (Phase 10 Step 4).
        // `roles` still reaches the render, gated the same way the leaf loop gates it
        // (Decision — `buildCompileContext`'s `chain.rolesDeclared ? chain.roles : null`),
        // so a `{$role}` token in the root description resolves instead of reading as an
        // undeclared placeholder, and `onRoleUsed` marks it used so `CL0545` agrees.
        const rootRolesDeclared = !!(config.roles && Object.keys(config.roles).length);
        ({ text: combined } = renderSectionedComponent(
          descComponent, [], new Map(),
          {
            defaultHeadingLevel: DESCRIPTION_DESCRIPTOR.defaultHeadingLevel,
            variables: rootVariables || {}, registry, branchProtagonist: null,
            roles: rootRolesDeclared ? config.roles : null, onRoleUsed: roleState.onUsed,
            onWarn: busWarner(diagnostics, { file: String(descSpec) }),
          },
        ));
      }
    }

    // Checked against the root table, and that stays correct where the plan warned it might
    // not: the blurb belongs to the project, and it is `adventureDescription:` — a different
    // key, resolved inside the leaf loop against the branch-merged table — that carries the
    // per-node case §7.7 asked for.
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
      if (verbose) console.log(`  OK: Description → ${descPath}`);
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

module.exports = { writeTreeFiles, writeScenarioBlurb };
