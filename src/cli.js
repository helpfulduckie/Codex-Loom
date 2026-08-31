#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Diagnostics, LINT_LEVELS } = require('./diag');
const { loadCompileConfig } = require('./config/load');
const { syncLibrary } = require('./snapshot');
const { findConfigEntry } = require('./loader/registry');
const { CONFIG_BASENAMES } = require('./util');
const { compile } = require('./compile');

/**
 * Resolve configPath, scenarioRoot, and outputDir from a CLI positional argument.
 * Accepts a folder (searched for a config entry point, §4.6), a config-file path, or
 * undefined (searches cwd).
 *
 * The directory search goes through `findConfigEntry`, so all four `CONFIG_BASENAMES`
 * spellings are found — including the `compile.cl.yaml` that `--migrate --rename-cl`
 * leaves behind — and a directory holding two configs throws rather than silently
 * compiling one and ignoring the other.
 *
 * @param {string|undefined} positional
 * @returns {{ configPath: string|null, scenarioRoot: string|null, outputDir: string|null, hasConfig: boolean }}
 */
function resolveArgs(positional) {
  let cfgPath = null;

  if (positional && /\.ya?ml$/i.test(positional)) {
    cfgPath = path.resolve(positional);
  } else {
    const dir = positional ? path.resolve(positional) : process.cwd();
    cfgPath = findConfigEntry(dir, CONFIG_BASENAMES);
  }

  if (cfgPath) {
    const cfg = loadCompileConfig(cfgPath);
    return {
      configPath:   cfgPath,
      scenarioRoot: cfg._resolvedOutput,
      outputDir:    cfg._resolvedReports || path.join(cfg._resolvedOutput, 'Overview'),
      hasConfig:    true,
      // The report modes get `lint.level` from here rather than loading the config a second
      // time. This function already reads it for the output and reports paths, so the value
      // is in hand; without passing it out, `--lint` would answer differently from the
      // compile that wrote the tree it is reading, on the same project's own setting.
      configLintLevel: (cfg.lint && cfg.lint.level) || null,
    };
  }

  if (!positional) {
    return {
      configPath: null, scenarioRoot: null, outputDir: null, hasConfig: false,
      configLintLevel: null,
    };
  }

  return {
    configPath:   null,
    scenarioRoot: path.resolve(positional),
    outputDir:    path.resolve('overview'),
    hasConfig:    false,
    // No config to read one from. `--lint` on a bare output tree has only the CLI flag,
    // which is the honest answer rather than a gap.
    configLintLevel: null,
  };
}

/**
 * Resolve `--migrate`'s config path by directory search alone (§14.2, §4.6, Decision 4).
 *
 * Deliberately not `resolveArgs`: that function calls `loadCompileConfig`, and the schema
 * requires `version: 4` with no compatibility mode — a v3 project has no such key by
 * definition, so routing `--migrate` through the shared resolver would reject exactly the
 * input it exists to accept. This does only the filename search half — the same
 * `CONFIG_BASENAMES` search `resolveArgs` runs via `findConfigEntry`, minus the config
 * load — and it tolerates a directory with two configs (a half-finished migration) rather
 * than throwing on it.
 */
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

/**
 * Render `--migrate`'s review queue and notes as `migration-report.md` (§9.5, §14.2).
 *
 * Written beside the config rather than into `structure.reports` — Decision 4 — because
 * the migrator creates that key during the same run (renaming `structure.overview`), so a
 * path read from the config would depend on a key the invocation is midway through writing.
 */
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

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const rawArgs = process.argv.slice(2);

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

  // `--lint-level` is a value flag, so it is parsed apart from the boolean table above and
  // in both spellings: `--lint-level=warn` and `--lint-level warn`. It is deliberately not
  // folded into `--verbose` (§12.5) — verbosity is about compile progress, this is about
  // which diagnostics an author wants to hear, and the two answer different questions.
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
        process.exit(1);
      }
    }
  }

  const positional = rawArgs.filter((_, i) => !flagIdxs.has(i));

  // --with-diff / --with-annotate need data captured during compilation (the on-disk markdown is
  // lossy), so they are compile *options* — they force a compile rather than reading the
  // output dir like the post-hoc report modes (--leafReview/--overview/--seed-map/--card-sizes).
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
    process.exit(1);
  }

  // ── Migrate (§14.2, Decision 4) ──
  //
  // Resolves its own config path (by filename search alone, per util.js's CONFIG_BASENAMES)
  // rather than through resolveArgs below: that function loads the config it finds, and the
  // v4 schema requires `version: 4` with no compatibility mode. A v3 project — the only
  // input `--migrate` exists to accept — has no such key, so routing through resolveArgs
  // rejects it before the migrator ever runs. Handled and exited before resolveArgs is
  // called at all, not merely before its result is used.
  if (flags.migrate) {
    const migrateConfigPath = resolveMigrateConfigPath(positional[0]);
    if (!migrateConfigPath) {
      console.error(`No v3 compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
      process.exit(1);
    }
    try {
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
      process.exit(1);
    }
    process.exit(0);
  }

  let resolved;
  try {
    resolved = resolveArgs(positional[0]);
  } catch (err) {
    // findConfigEntry throws when a directory holds more than one config entry point.
    console.error(`\nFatal: ${err.message}`);
    process.exit(1);
  }
  const { configPath, scenarioRoot, outputDir, hasConfig, configLintLevel } = resolved;

  // The flag is what someone typed for this run; the config is what the project says every
  // run. Same precedence the compile applies internally, stated once here so the report
  // modes and the compile cannot disagree about it.
  const effectiveLintLevel = lintLevel || configLintLevel;

  // ── Compile ──
  if (doCompile) {
    if (!hasConfig) {
      if (!scenarioRoot) {
        console.error('No compile.yaml in current directory and no path given.');
        process.exit(1);
      }
      if (doLeafReview || doOverview) {
        console.warn('Warning: compile.yaml not found; skipping compile.');
      } else {
        console.error(`No compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
        process.exit(1);
      }
    } else {
      try {
        compile(configPath, {
          clean: flags.clean, verbose: flags.verbose,
          diff: flags.diff, annotate: flags.annotate, inventory: flags.inventory,
          schemaTables: flags.schemaTables,
          lintLevel, live: flags.live,
        });
      } catch (err) {
        console.error(`\nFatal: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // ── Snapshot (Phase 7's freeze: sync structure.input.library + out-of-base templates) ──
  if (doSnapshot) {
    if (!hasConfig) {
      console.error(`No compile.yaml found at ${path.resolve(positional[0] || '.')}.`);
      process.exit(1);
    } else {
      try {
        const snapshotDiagnostics = new Diagnostics();
        const config = loadCompileConfig(configPath, { diagnostics: snapshotDiagnostics, live: true });
        if (!config) {
          for (const diag of snapshotDiagnostics.all) console.error(diag.format());
          process.exit(1);
        }
        if (!config._resolvedSnapshot) {
          console.error('structure.input.snapshot is not set in compile.yaml; nothing to sync.');
          process.exit(1);
        }
        const result = syncLibrary(config, { verbose: flags.verbose, diagnostics: snapshotDiagnostics });
        for (const diag of snapshotDiagnostics.all) {
          if (diag.severity === 'error') console.error(diag.format());
          else console.warn(diag.format());
        }
        console.log(
          `\nSynced ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'} `
          + `(${result.filesWritten} file(s)) to:\n  ${config._resolvedSnapshot}\n`
          + `Manifest: ${result.manifestPath}\n`
        );
        // The manifest and copied files are still written above — sync itself succeeded —
        // but a `requiresRoles` refusal (Decision 2, Phase 8) means the run is not clean.
        if (snapshotDiagnostics.hasErrors()) process.exit(1);
      } catch (err) {
        console.error(`\nFatal: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // ── Reports (leaf-review, overview, seed-map, card-sizes, lint) ──
  if (doLeafReview || doOverview || doSeedMap || doCardSizes || doLint) {
    if (!scenarioRoot) {
      console.error('No compile.yaml in current directory and no path given.');
      process.exit(1);
    }
    if (!fs.existsSync(scenarioRoot)) {
      console.error(`Scenario root not found: ${scenarioRoot}`);
      process.exit(1);
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

      if (doLeafReview) {
        const { runLeafReviewMode } = require('./overview');
        const dir = path.join(outputDir, 'leaf-review');
        fs.mkdirSync(dir, { recursive: true });
        const written = runLeafReviewMode(scenarioRoot, dir, flags.verbose);
        summaryParts.push(`${written.length} leaf review file(s)`);
      }

      if (doSeedMap) {
        const { runSeedMapMode } = require('./seedmap');
        const dir = path.join(outputDir, 'seed-map');
        fs.mkdirSync(dir, { recursive: true });
        const result = runSeedMapMode(scenarioRoot, dir, flags.verbose);
        if (result) summaryParts.push('2 seed map files');
      }

      if (doOverview) {
        const { runOverviewMode } = require('./overview');
        const dir = path.join(outputDir, 'overview');
        fs.mkdirSync(dir, { recursive: true });
        runOverviewMode(scenarioRoot, dir, flags.verbose);
        summaryParts.push('an overview file');
      }

      if (doCardSizes) {
        const { runBodySizeMode } = require('./bodysize');
        const dir = path.join(outputDir, 'card-sizes');
        fs.mkdirSync(dir, { recursive: true });
        const result = runBodySizeMode(scenarioRoot, dir, flags.verbose);
        if (result) summaryParts.push('2 card size files');
      }

      if (doLint) {
        const { runLintMode } = require('./lint');
        const dir = path.join(outputDir, 'lint');
        fs.mkdirSync(dir, { recursive: true });
        // A compiled tree carries no branch context, so `--lint` runs the project-root
        // `lint.packs` against every file (§8.2.2). With no `compile.yaml` to find, it has
        // no packs to run — the same honest gap `--lint` already has for `lint.level`.
        let lintConfig = null;
        if (configPath) {
          try { lintConfig = loadCompileConfig(configPath); } catch (err) { lintConfig = null; }
        }
        const result = runLintMode(scenarioRoot, dir, flags.verbose, {
          lintLevel: effectiveLintLevel, config: lintConfig, configPath,
        });
        if (result) summaryParts.push(`a lint report (${result.errorCount} error(s), ${result.warnCount} warning(s))`);
      }

      if (summaryParts.length > 0) {
        const joined = summaryParts.length === 1
          ? summaryParts[0]
          : summaryParts.slice(0, -1).join(', ') + ', and ' + summaryParts.at(-1);
        console.log(`\nWrote ${joined} to:\n  ${outputDir}\n`);
      }
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      process.exit(1);
    }
  }
}
