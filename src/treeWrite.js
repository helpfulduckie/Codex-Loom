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

function resolveComponentSpec(spec, base, variables, sink) {
  if (spec == null) return null;
  let resolved = spec;
  if (typeof resolved === 'string') {
    resolved = resolveVariables(resolved, variables, sink);
  }
  const filePath = path.resolve(base, String(resolved));
  if (fs.existsSync(filePath)) return filePath;
  return resolved;
}

function questionsForMeasurement(table, variables, {
  registry, roles, branchProtagonist, onRoleUsed,
} = {}) {
  if (!table || Object.keys(table).length === 0) return null;
  return expandQuestions(table, variables, {
    registry, roles, branchProtagonist, onRoleUsed,
  });
}

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

function nodeVisitPrologue(name, node, isRoot, state) {
  const outputBase = isRoot ? state.outputBase : path.join(state.outputBase, 'Branches', name);
  const variables = (node && node.variables)
    ? Object.assign({}, state.variables, node.variables)
    : state.variables;
  const table = mergePlaceholders(state.table, node);
  const rolesDeclared = state.rolesDeclared || !!(node && node.roles);
  const roles = mergeUnbindable(state.roles, node && node.roles, {
    code: DIAG_CODES.ROLE_UNBIND_UNKNOWN, kind: 'role', onWarn: null,
  });
  return {
    outputBase, variables, table, roles, rolesDeclared,
  };
}

function writeFramingRecursive(rootNode, outputBase, opts = {}) {
  const {
    configBase, configPath, variables, log, diagnostics, usage = null, loadSectioned = null,
    registry = null, onRoleUsed = null, roleStateByPath = null,
  } = opts;
  if (!rootNode || typeof rootNode !== 'object') return;

  const framingSink = { diagnostics, file: configPath };
  const renderFraming = (spec, nodePath, vars, table, name, roles, branchProtagonist) => {
    const resolvedSpec = resolveComponentSpec(spec, configBase, vars, framingSink);
    const isFile = typeof resolvedSpec === 'string' && fs.existsSync(resolvedSpec)
      && fs.statSync(resolvedSpec).isFile();

    if (isFile && !isPassthrough(resolvedSpec)) {
      const component = loadSectioned
        ? loadSectioned(resolvedSpec, FRAMING_DESCRIPTOR)
        : null;
      if (!component) return null;
      const { text } = renderSectionedComponent(component, nodePath, new Map(), {
        defaultHeadingLevel: FRAMING_DESCRIPTOR.defaultHeadingLevel,
        variables: vars, registry, branchProtagonist,
        roles, onRoleUsed,
        onWarn: busWarner(diagnostics, { file: String(resolvedSpec) }),
        diagnostics, file: String(resolvedSpec),
      });
      return text;
    }
    const literal = isFile
      ? resolveVariables(fs.readFileSync(resolvedSpec, 'utf8').trimEnd(), vars, framingSink)
      : String(resolvedSpec).trimEnd();
    return applyTokenPass(literal, {
      item: {}, registry, branchProtagonist, roles, onRoleUsed,
      onWarn: busWarner(diagnostics, { file: configPath }),
    });
  };

  walkBranchTree(rootNode, ({ name, node, path: nodePath, isLeaf, isRoot, state }) => {
    let {
      outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
    } = nodeVisitPrologue(name, node, isRoot, state);
    const roleInfo = roleStateByPath ? roleStateByPath.get(nodePath.join('/')) : null;
    if (roleInfo) {
      roles = roleInfo.resolved;
      rolesDeclared = roleInfo.declared;
    }

    const framing = node && node.components && node.components.branchFraming !== undefined
      ? node.components.branchFraming
      : null;

    const branchProtagonist = roleInfo ? roleInfo.protagonist : null;

    if (framing != null) {
      if (isLeaf) {
        diagnostics.warn(
          DIAG_CODES.BRANCH_FRAMING_IGNORED,
          isRoot
            ? 'root branchFraming with no branches — ignoring'
            : `branchFraming on leaf branch "${name}" — ignoring`,
          { file: configPath },
        );
      } else {
        const framingText = renderFraming(
          framing, nodePath, branchVars, table, name,
          rolesDeclared ? roles : null, branchProtagonist,
        );
        if (framingText) {
          checkUndeclaredPlaceholders(framingText, table, {
            diagnostics, where: isRoot ? 'the project root (framing)' : `the branch framing on "${name}"`,
            usage, usagePath: nodePath.join('/'),
          });
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
    outputBase, variables, table: {}, roles: {}, rolesDeclared: false,
  });
}

function writeLabelsRecursive(rootNode, outputBase, opts = {}) {
  const {
    variables, rootVariables, log, diagnostics, configPath = null, usage = null,
    registry = null, onRoleUsed = null, roleStateByPath = null,
  } = opts;
  walkBranchTree(rootNode, ({ name, node, path: path_, isRoot, state }) => {
    let {
      outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
    } = nodeVisitPrologue(name, node, isRoot, state);
    const roleInfo = roleStateByPath ? roleStateByPath.get(path_.join('/')) : null;
    if (roleInfo) {
      roles = roleInfo.resolved;
      rolesDeclared = roleInfo.declared;
    }
    const branchProtagonist = roleInfo ? roleInfo.protagonist : null;

    if (isRoot) {
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
    if (labelText !== name) {
      fs.writeFileSync(outPath, labelText + '\n', 'utf8');
      log.verbose(`    OK: Label → ${outPath}`);
    } else if (fs.existsSync(outPath)) {
      fs.rmSync(outPath);
    }

    return {
      outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
    };
  }, {
    outputBase, variables, table: {}, roles: {}, rolesDeclared: false,
  });
}

function writePlaceholdersRecursive(rootNode, outputBase, opts = {}) {
  const {
    variables, configPath, diagnostics, log, usage = null, declarations = null, duplicates = null,
    registry = null, onRoleUsed = null, roleStateByPath = null,
  } = opts;
  const onWarn = (code, message, file) => diagnostics.add(
    severityOf(code), code, message, { file: file || configPath },
  );

  walkBranchTree(rootNode, ({ name, node, path: path_, isRoot, state }) => {
    let {
      outputBase: nodeOutput, variables: branchVars, table, roles, rolesDeclared,
    } = nodeVisitPrologue(name, node, isRoot, state);
    const roleInfo = roleStateByPath ? roleStateByPath.get(path_.join('/')) : null;
    if (roleInfo) {
      roles = roleInfo.resolved;
      rolesDeclared = roleInfo.declared;
    }
    const branchProtagonist = roleInfo ? roleInfo.protagonist : null;

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

function writeTreeFiles({
  config, configPath, log, diagnostics,
  placeholderState, componentLoader, registry, roleState, roleStateByPath,
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
    roleStateByPath,
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
    roleStateByPath,
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
    roleStateByPath,
  });
}

function writeScenarioBlurb({
  config, configPath, log, diagnostics,
  rootVariables, registry, placeholderState, roleState, roleStateByPath, componentLoader, gaps, descriptionLeaves,
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
    const rootRoleInfo = roleStateByPath ? roleStateByPath.get('') : null;
    const rootRoles = rootRoleInfo ? rootRoleInfo.resolved : config.roles;
    const rootRolesDeclared = rootRoleInfo ? rootRoleInfo.declared : !!(config.roles && Object.keys(config.roles).length);

    if (isPassthrough(descSpec)) {
      const raw = readPassthrough(descSpec);
      if (raw === null) {
        combined = null;
      } else {
        combined = applyTokenPass(raw, {
          item: {}, registry, branchProtagonist: null,
          roles: rootRolesDeclared ? rootRoles : null, onRoleUsed: roleState.onUsed,
          onWarn: busWarner(diagnostics, { file: String(descSpec) }),
        }) || null;
      }
    } else {
      const descComponent = componentLoader.load(descSpec, DESCRIPTION_DESCRIPTOR);
      if (descComponent) {
        descMetadata = descComponent.metadata;
        ({ text: combined } = renderSectionedComponent(
          descComponent, [], new Map(),
          {
            defaultHeadingLevel: DESCRIPTION_DESCRIPTOR.defaultHeadingLevel,
            variables: rootVariables || {}, registry, branchProtagonist: null,
            roles: rootRolesDeclared ? rootRoles : null, onRoleUsed: roleState.onUsed,
            onWarn: busWarner(diagnostics, { file: String(descSpec) }),
            diagnostics, file: String(descSpec),
          },
        ));
      }
    }

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
