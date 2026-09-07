#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { Diagnostics, LINT_LEVELS, SEVERITY } = require('./diag');
const { loadCompileConfig } = require('./config/load');
const { syncLibrary } = require('./snapshot');
const { findConfigEntry } = require('./loader/registry');
const { CONFIG_BASENAMES } = require('./util');
const { compile } = require('./compile');

function printDiagnostics(bus) {
  for (const diag of bus.all) {
    if (diag.severity === SEVERITY.ERROR) console.error(diag.format());
    else console.warn(diag.format());
  }
}

function resolveArgs(positional) {
  let cfgPath = null;

  if (positional && /\.ya?ml$/i.test(positional)) {
    cfgPath = path.resolve(positional);
  } else {
    const dir = positional ? path.resolve(positional) : process.cwd();
    cfgPath = findConfigEntry(dir, CONFIG_BASENAMES);
  }

  if (cfgPath) {
    const resolveDiagnostics = new Diagnostics();
    const cfg = loadCompileConfig(cfgPath, { diagnostics: resolveDiagnostics });
    printDiagnostics(resolveDiagnostics);
    if (resolveDiagnostics.hasErrors()) {
      const count = resolveDiagnostics.errors.length;
      throw new Error(`Configuration has ${count} error${count === 1 ? '' : 's'}; nothing was compiled.`);
    }
    return {
      configPath:   cfgPath,
      scenarioRoot: cfg._resolvedOutput,
      outputDir:    cfg._resolvedReports || path.join(cfg._resolvedOutput, 'Overview'),
      hasConfig:    true,
      configLintLevel: (cfg.lint && cfg.lint.level) || null,
      config: cfg,
    };
  }

  if (!positional) {
    return {
      configPath: null, scenarioRoot: null, outputDir: null, hasConfig: false,
      configLintLevel: null, config: null,
    };
  }

  return {
    configPath:   null,
    scenarioRoot: path.resolve(positional),
    outputDir:    path.resolve('overview'),
    hasConfig:    false,
    configLintLevel: null,
    config: null,
  };
}

function resolveMigrateConfigPath(positional) {
  if (positional && /\.ya?ml$/i.test(positional)) {
    const resolved = path.resolve(positional);
    return fs.existsSync(resolved) ? resolved : null;
  }
  const dir = path.resolve(positional || '.');
  for (const base of CONFIG_BASENAMES) {
    const candidate = path.join(dir, base);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function migrateVersion(configPath) {
  const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  return typeof config?.version === 'number' ? config.version : null;
}

function renderMigrationReport(result) {
  const lines = [`# Migration report — ${result.configPath}`, ''];

  lines.push('## What changed', '');
  if (result.notes.length === 0) {
    lines.push('Nothing to report.');
  } else {
    for (const note of result.notes) lines.push(`- ${note}`);
  }
  lines.push('');

  lines.push(
    '## Review queue', '',
    'Every prose fragment that now carries a converted role token beside a hardcoded '
    + 'gendered pronoun (§9.5). The migrator cannot convert the pronoun — only a person can '
    + 'decide whether it should become a role reference too.', '',
  );
  if (!result.reviewQueue || result.reviewQueue.length === 0) {
    lines.push('None found.');
  } else {
    for (const entry of result.reviewQueue) {
      const at = entry.line ? `${entry.file}:${entry.line}` : entry.file;
      lines.push(`- **${at}** — ${entry.text}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}


function main(rawArgs) {
  const knownFlags = [
    ['compile',    ['--compile',    '-C']],
    ['leafReview', ['--leafReview', '-l']],
    ['overview',   ['--overview',   '-o']],
    ['seedMap',    ['--seed-map',   '-s']],
    ['cardSizes',  ['--card-sizes', '-b']],
    ['lint',       ['--lint',       '-L']],
    ['snapshot',   ['--snapshot']],
    ['migrate',    ['--migrate']],
    ['renameToCl', ['--rename-cl']],
    ['diff',       ['--with-diff',     '--diff',     '-d']],
    ['annotate',   ['--with-annotate', '--annotate', '-a']],
    ['inventory',  ['--with-inventory', '--inventory', '-i']],
    ['schemaTables', ['--schema-tables']],
    ['clean',      ['--clean',      '-c']],
    ['verbose',    ['--verbose',    '-v']],
    ['live',       ['--live']],
  ];

  const flags = {};
  const flagIdxs = new Set();
  for (const [key, aliases] of knownFlags) {
    const idx = rawArgs.findIndex(a => aliases.includes(a));
    flags[key] = idx !== -1;
    if (idx !== -1) flagIdxs.add(idx);
  }

  const log = {
    info: (line) => console.log(line),
    verbose: flags.verbose ? (line) => console.log(line) : () => {},
  };

  let lintLevel = null;
  {
    const idx = rawArgs.findIndex(a => a === '--lint-level' || a.startsWith('--lint-level='));
    if (idx !== -1) {
      const arg = rawArgs[idx];
      flagIdxs.add(idx);
      if (arg.includes('=')) {
        lintLevel = arg.slice(arg.indexOf('=') + 1);
      } else {
        lintLevel = rawArgs[idx + 1];
        if (lintLevel !== undefined) flagIdxs.add(idx + 1);
      }
      if (!LINT_LEVELS.includes(lintLevel)) {
        console.error(
          `--lint-level takes one of ${LINT_LEVELS.join(', ')}; got ${JSON.stringify(lintLevel || '')}.`
        );
        return 1;
      }
    }
  }

  const positional = rawArgs.filter((_, i) => !flagIdxs.has(i));

  const doCompile    = flags.compile || flags.diff || flags.annotate || flags.inventory ||
    flags.schemaTables ||
    (!flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes && !flags.lint &&
      !flags.snapshot && !flags.migrate);
  const doLeafReview = flags.leafReview;
  const doOverview   = flags.overview;
  const doSeedMap    = flags.seedMap;
  const doCardSizes  = flags.cardSizes;
  const doLint       = flags.lint;
  const doSnapshot   = flags.snapshot;

  if (positional.length === 0 && !flags.compile && !flags.diff && !flags.annotate &&
      !flags.inventory && !flags.schemaTables &&
      !flags.leafReview && !flags.overview && !flags.seedMap && !flags.cardSizes && !flags.lint &&
      !flags.snapshot && !flags.migrate) {
    console.error(
      'Usage: codex-loom [mode flags] [compile options] [<folder | compile.yaml>]\n' +
      '  Modes (what runs):     --compile|-C  --leafReview|-l  --overview|-o  --seed-map|-s  --card-sizes|-b  --lint|-L  --snapshot  --migrate\n' +
      '  Compile options:       --with-diff|-d  --with-annotate|-a  --with-inventory|-i  --schema-tables  --clean|-c  --verbose|-v  --live\n' +
      '  Migrate options:       --rename-cl  (§4.6: also rename compile.yaml to compile.cl.yaml)\n' +
      '  Diagnostics:           --lint-level=off|error|warn  (overrides lint.level; reaches the opinion layer only)\n' +
      '  No mode flag compiles. Report modes read the existing output tree; compile options force a compile.\n' +
      '  --migrate converts a v3 project in place and does not compile — run it again once migrated.'
    );
    return 1;
  }

  if (flags.migrate) {
    const migrateConfigPath = resolveMigrateConfigPath(positional[0]);
    if (!migrateConfigPath) {
      console.error(`No v3 compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
      return 1;
    }
    try {
      const version = migrateVersion(migrateConfigPath);
      if (version !== null && version >= 4) {
        throw new Error(`Cannot migrate ${migrateConfigPath}: it already declares version: ${version}.`);
      }
      const { migrateProjectFully } = require('./migrate');
      const result = migrateProjectFully(migrateConfigPath, { renameToCl: flags.renameToCl });
      const reportPath = path.join(path.dirname(result.configPath), 'migration-report.md');
      fs.writeFileSync(reportPath, renderMigrationReport(result), 'utf8');
      const queueCount = result.reviewQueue.length;
      console.log(`Migrated ${migrateConfigPath}`);
      console.log(
        `Touched ${result.touched.length} file(s). Review queue: ${queueCount} `
        + `entr${queueCount === 1 ? 'y' : 'ies'}.`
      );
      console.log(`Wrote ${reportPath}`);
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      return 1;
    }
    return 0;
  }

  let resolved;
  try {
    resolved = resolveArgs(positional[0]);
  } catch (err) {
    console.error(`\nFatal: ${err.message}`);
    return 1;
  }
  const { configPath, scenarioRoot, outputDir, hasConfig, configLintLevel, config: projectConfig } = resolved;

  const effectiveLintLevel = lintLevel || configLintLevel;

  if (doCompile) {
    if (!hasConfig) {
      if (!scenarioRoot) {
        console.error('No compile.yaml in current directory and no path given.');
        return 1;
      }
      if (doLeafReview || doOverview) {
        console.warn('Warning: compile.yaml not found; skipping compile.');
      } else {
        console.error(`No compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
        return 1;
      }
    } else {
      const compileDiagnostics = new Diagnostics();
      let failure = null;
      try {
        compile(configPath, {
          clean: flags.clean, log,
          diff: flags.diff, annotate: flags.annotate, inventory: flags.inventory,
          schemaTables: flags.schemaTables,
          lintLevel, live: flags.live,
          diagnostics: compileDiagnostics,
        });
      } catch (err) {
        failure = err;
      }
      printDiagnostics(compileDiagnostics);
      if (failure) {
        console.error(`\nFatal: ${failure.message}`);
        return 1;
      }
    }
  }

  if (doSnapshot) {
    if (!hasConfig) {
      console.error(`No compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
      return 1;
    } else {
      try {
        const snapshotDiagnostics = new Diagnostics();
        const config = loadCompileConfig(configPath, { diagnostics: snapshotDiagnostics, live: true });
        if (!config) {
          printDiagnostics(snapshotDiagnostics);
          return 1;
        }
        if (!config._resolvedSnapshot) {
          console.error('structure.input.snapshot is not set in compile.yaml; nothing to sync.');
          return 1;
        }
        const result = syncLibrary(config, { log, diagnostics: snapshotDiagnostics });
        printDiagnostics(snapshotDiagnostics);
        console.log(
          `\nSynced ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'} `
          + `(${result.filesWritten} file(s)) to:\n  ${config._resolvedSnapshot}\n`
          + `Manifest: ${result.manifestPath}\n`
        );
        if (snapshotDiagnostics.hasErrors()) return 1;
      } catch (err) {
        console.error(`\nFatal: ${err.message}`);
        return 1;
      }
    }
  }

  if (doLeafReview || doOverview || doSeedMap || doCardSizes || doLint) {
    if (!scenarioRoot) {
      console.error('No compile.yaml in current directory and no path given.');
      return 1;
    }
    if (!fs.existsSync(scenarioRoot)) {
      console.error(`Scenario root not found: ${scenarioRoot}`);
      return 1;
    }

    if (flags.verbose) {
      const modeLabel = [
        doLeafReview && 'leaf-review',
        doOverview   && 'overview',
        doSeedMap    && 'seed-map',
        doCardSizes  && 'card-sizes',
        doLint       && 'lint',
      ].filter(Boolean).join(' + ');
      console.log(`\n${modeLabel} mode\nScenario root : ${scenarioRoot}\nOutput dir    : ${outputDir}\n`);
    }

    try {
      const summaryParts = [];
      const files = (n, what) => `${n} ${what} file${n === 1 ? '' : 's'}`;
      let lintErrors = 0;

      if (doLeafReview) {
        const { runLeafReviewMode } = require('./overview');
        const dir = path.join(outputDir, 'leaf-review');
        fs.mkdirSync(dir, { recursive: true });
        const result = runLeafReviewMode(scenarioRoot, dir, { log });
        if (result.written.length > 0) summaryParts.push(files(result.written.length, 'leaf review'));
        else console.warn('No branch leaves found — nothing to review.');
      }

      if (doSeedMap) {
        const { runSeedMapMode } = require('./seedmap');
        const dir = path.join(outputDir, 'seed-map');
        fs.mkdirSync(dir, { recursive: true });
        const result = runSeedMapMode(scenarioRoot, dir, { log });
        if (result.written.length > 0) summaryParts.push(files(result.written.length, 'seed map'));
        else console.warn('No branch leaves found — nothing to map.');
      }

      if (doOverview) {
        const { runOverviewMode } = require('./overview');
        const dir = path.join(outputDir, 'overview');
        fs.mkdirSync(dir, { recursive: true });
        const result = runOverviewMode(scenarioRoot, dir, { log });
        if (result.written.length > 0) summaryParts.push(files(result.written.length, 'overview'));
      }

      if (doCardSizes) {
        const { runBodySizeMode } = require('./bodysize');
        const dir = path.join(outputDir, 'card-sizes');
        fs.mkdirSync(dir, { recursive: true });
        const result = runBodySizeMode(scenarioRoot, dir, { log });
        if (result.written.length > 0) summaryParts.push(files(result.written.length, 'card size'));
        else console.warn('No cards or Openings found — nothing to size.');
      }

      if (doLint) {
        const { runLintMode } = require('./lint');
        const dir = path.join(outputDir, 'lint');
        fs.mkdirSync(dir, { recursive: true });
        const lintConfig = projectConfig;
        const lintDiagnostics = new Diagnostics();
        const result = runLintMode(scenarioRoot, dir, {
          log, lintLevel: effectiveLintLevel, config: lintConfig, configPath,
          diagnostics: lintDiagnostics,
        });
        printDiagnostics(lintDiagnostics);
        if (result.written.length > 0) {
          lintErrors = result.errorCount;
          summaryParts.push(`a lint report (${result.errorCount} error(s), ${result.warnCount} warning(s))`);
          console.log(`\nLint: ${result.errorCount} error(s), ${result.warnCount} warning(s) across ${result.fileCount} file(s).`);
        } else {
          console.warn('No Story Cards/Components .md files found — nothing to lint.');
        }
      }

      if (summaryParts.length > 0) {
        const joined = summaryParts.length === 1
          ? summaryParts[0]
          : summaryParts.slice(0, -1).join(', ') + ', and ' + summaryParts.at(-1);
        console.log(`\nWrote ${joined} to:\n  ${outputDir}\n`);
      }
      if (lintErrors > 0) return 1;
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      return 1;
    }
  }

  return 0;
}

module.exports = { main };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
