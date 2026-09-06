#!/usr/bin/env node
'use strict';


const fs = require('fs');
const path = require('path');

const { compile } = require('../src/compile');
const { listFilesRelative } = require('../src/util');
const { classifyDiff, OPAQUE } = require('../__tests__/helpers/diffShape');

const {
  DEFAULT_REPORT_MODES, prepareTempTree, resolvedReportsDir, collectCompileReports,
} = require('../__tests__/helpers/baselineHarness');

const SETS = {
  examples: { dir: path.resolve(__dirname, '..', 'examples'), manifest: 'projects.js' },
  golden: { dir: path.resolve(__dirname, '..', 'goldenFixtures'), manifest: 'projects.js' },
};

function loadSet(name) {
  const set = SETS[name];
  if (!set) throw new Error(`Unknown --set "${name}". Known: ${Object.keys(SETS).join(', ')}`);

  if (!fs.existsSync(path.join(set.dir, set.manifest))) {
    if (name === 'golden') {
      console.error('rebaseline: goldenFixtures/ is not present, so there is no baseline to regenerate.');
      console.error('The fixtures are a separate private repo. Clone it into goldenFixtures/ first:');
      console.error('  git clone https://github.com/helpfulduckie/Codex-Loom-Fixtures.git goldenFixtures');
      process.exit(1);
    }
    throw new Error(`rebaseline: ${name} set has no manifest at ${path.join(set.dir, set.manifest)}`);
  }

  const manifest = require(path.join(set.dir, set.manifest));
  return {
    root: set.dir,
    PROJECTS: manifest.PROJECTS,
    OUTPUT_SUBDIR: manifest.OUTPUT_SUBDIR,
    BASELINE_SUBDIR: manifest.BASELINE_SUBDIR,
    REPORTS_SUBDIR: manifest.REPORTS_SUBDIR,
    SOURCE_SUBDIR: manifest.SOURCE_SUBDIR || '',
    CONFIG_NAME: manifest.CONFIG_NAME || 'compile.yaml',
    REPORT_MODES: manifest.REPORT_MODES || DEFAULT_REPORT_MODES,
    REPORTS_IN_PLACE: manifest.REPORTS_IN_PLACE || false,
    COMPILE_REPORT_LAYOUT: manifest.COMPILE_REPORT_LAYOUT || {},
  };
}


function parseArgs(argv) {
  const allowed = new Set(['fence']);
  const only = [];
  const names = [];
  let write = false;
  let setName = 'examples';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') write = true;
    else if (arg === '--allow') allowed.add(argv[++i]);
    else if (arg === '--only') only.push(argv[++i]);
    else if (arg === '--set') setName = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`Unknown flag ${arg}`);
    else names.push(arg);
  }

  const set = loadSet(setName);
  const projects = names.length === 0
    ? set.PROJECTS
    : names.map((name) => {
      const found = set.PROJECTS.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!found) throw new Error(`Unknown fixture "${name}". Known: ${set.PROJECTS.map((p) => p.name).join(', ')}`);
      return found;
    });

  return {
    write, allowed, only, projects, set, setName,
  };
}


function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}


function buildTempTree(projects, set) {
  const {
    OUTPUT_SUBDIR, REPORTS_SUBDIR, SOURCE_SUBDIR, CONFIG_NAME, REPORT_MODES, REPORTS_IN_PLACE,
  } = set;
  const tmpDir = prepareTempTree(set, 'codex-loom-rebaseline-');

  for (const project of projects) {
    process.stdout.write(`compiling ${project.name}… `);
    const configPath = path.join(tmpDir, project.dir, SOURCE_SUBDIR, CONFIG_NAME);
    const compileOptions = { live: true };
    for (const mode of project.compileReports || []) compileOptions[mode] = true;
    compile(configPath, compileOptions);

    const reportBase = REPORTS_IN_PLACE
      ? resolvedReportsDir(configPath)
      : path.join(tmpDir, project.dir, REPORTS_SUBDIR);

    const scenarioRoot = path.join(tmpDir, project.dir, OUTPUT_SUBDIR);
    for (const mode of project.reports) {
      const dir = path.join(reportBase, mode);
      fs.mkdirSync(dir, { recursive: true });
      REPORT_MODES[mode]()(scenarioRoot, dir);
    }

    if (!REPORTS_IN_PLACE) collectCompileReports(project, configPath, tmpDir, set);
    process.stdout.write('done\n');
  }

  return tmpDir;
}


function diffTree(actualDir, expectedDir, { markdownOnly }) {
  const actual = new Set(listFilesRelative(actualDir));
  const expected = new Set(listFilesRelative(expectedDir));
  const report = {
    changed: [], added: [], removed: [], relocated: [], derived: [], classes: new Set(),
  };

  for (const rel of expected) if (!actual.has(rel)) report.removed.push(rel);
  for (const rel of actual) if (!expected.has(rel)) report.added.push(rel);

  if (markdownOnly) {
    const underScripts = (rel) => !rel.endsWith('.md') && rel.split('/').includes('Scripts');
    const tail = (rel) => rel.slice(rel.indexOf('Scripts/'));
    const bytesAt = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')));
    const removedScripts = report.removed.filter(underScripts);
    const addedScripts = report.added.filter(underScripts);
    const matchedRemoved = new Set();
    const matchedAdded = new Set();

    for (const added of addedScripts) {
      const addedBytes = bytesAt(actualDir, added);
      const moved = removedScripts.filter(
        (r) => tail(r) === tail(added) && bytesAt(expectedDir, r).equals(addedBytes),
      );
      if (moved.length === 0) continue;
      matchedAdded.add(added);
      for (const r of moved) matchedRemoved.add(r);
      report.relocated.push({ to: added, from: moved });
    }

    const strayScripts = [...removedScripts, ...addedScripts]
      .filter((rel) => !matchedRemoved.has(rel) && !matchedAdded.has(rel));
    report.removed = report.removed.filter((rel) => !matchedRemoved.has(rel) && !strayScripts.includes(rel));
    report.added = report.added.filter((rel) => !matchedAdded.has(rel) && !strayScripts.includes(rel));
    for (const rel of strayScripts) {
      report.changed.push({
        rel, classes: [OPAQUE], summary: `${rel} — script content differs, no byte-identical counterpart`,
      });
      report.classes.add(OPAQUE);
    }
  }

  const isDerivedOutput = (rel) => path.basename(rel) === 'Placeholders.yaml';
  if (markdownOnly) {
    for (const rel of report.added.filter(isDerivedOutput)) report.derived.push({ rel, kind: 'write' });
    for (const rel of report.removed.filter(isDerivedOutput)) report.derived.push({ rel, kind: 'remove' });
    report.added = report.added.filter((rel) => !isDerivedOutput(rel));
    report.removed = report.removed.filter((rel) => !isDerivedOutput(rel));
  }

  for (const rel of [...actual].sort()) {
    if (!expected.has(rel)) continue;
    if (path.basename(rel) === 'library-dependencies.json') continue; // never re-baselined

    const actualPath = path.join(actualDir, ...rel.split('/'));
    const expectedPath = path.join(expectedDir, ...rel.split('/'));
    if (fs.readFileSync(actualPath).equals(fs.readFileSync(expectedPath))) continue;

    if (markdownOnly && isDerivedOutput(rel)) {
      report.derived.push({ rel, kind: 'write' });
      continue;
    }

    if (markdownOnly && !rel.endsWith('.md')) {
      report.changed.push({ rel, classes: [OPAQUE], summary: `${rel} — non-markdown output differs` });
      report.classes.add(OPAQUE);
      continue;
    }

    const diff = rel.endsWith('.md')
      ? classifyDiff(fs.readFileSync(expectedPath, 'utf8'), fs.readFileSync(actualPath, 'utf8'))
      : { classes: ['derived'], changedLines: 0, samples: [] };
    for (const cls of diff.classes) report.classes.add(cls);
    report.changed.push({
      rel,
      classes: diff.classes,
      summary: `${rel} — ${diff.classes.join('+')} (${diff.changedLines} lines)`,
      samples: diff.samples,
    });
  }

  return report;
}

function printReport(label, report, { verbose }) {
  const reloc = report.relocated || [];
  const derived = report.derived || [];
  const counts = `${report.changed.length} changed, ${report.added.length} added, ${report.removed.length} removed`
    + (reloc.length ? `, ${reloc.length} relocated` : '')
    + (derived.length ? `, ${derived.length} derived` : '');
  console.log(`\n  ${label}: ${counts}`);
  for (const rel of report.added) console.log(`    + ${rel}`);
  for (const rel of report.removed) console.log(`    - ${rel}`);
  for (const move of reloc) console.log(`    ⇄ ${move.to}  (was ${move.from.length}× under Branches/)`);
  for (const d of derived) console.log(`    ${d.kind === 'remove' ? '−' : '~'} ${d.rel}  (derived output, regenerated)`);

  const byClass = new Map();
  for (const change of report.changed) {
    const key = change.classes.join('+');
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(change);
  }
  for (const [key, changes] of byClass) {
    console.log(`    ${key}: ${changes.length} file(s)`);
    const shown = verbose ? changes : changes.slice(0, 3);
    for (const change of shown) {
      console.log(`      ${change.rel}`);
      for (const sample of (change.samples || []).slice(0, 2)) console.log(`        ${sample}`);
    }
    if (shown.length < changes.length) console.log(`      … ${changes.length - shown.length} more`);
  }
}


function reportUnits(project, set, tmpDir) {
  const {
    root, REPORTS_SUBDIR, REPORTS_IN_PLACE,
  } = set;
  const actual = path.join(tmpDir, project.dir, REPORTS_SUBDIR);
  const expected = path.join(root, project.dir, REPORTS_SUBDIR);
  if (REPORTS_IN_PLACE) return [{ label: 'reports', from: actual, to: expected }];
  return [...project.reports, ...(project.compileReports || [])].map((mode) => ({
    label: mode,
    from: path.join(actual, mode),
    to: path.join(expected, mode),
  }));
}

function main() {
  const {
    write, allowed, only, projects, set, setName,
  } = parseArgs(process.argv.slice(2));
  const { root, OUTPUT_SUBDIR, BASELINE_SUBDIR } = set;
  console.log(`set: ${setName}`);
  console.log(`allowed diff shape: ${[...allowed].join(', ')}`);
  if (only.length > 0) console.log(`allowed only in: ${only.join(', ')}`);

  if (write) {
    const unseeded = projects.filter((project) => {
      const dir = path.join(root, project.dir, BASELINE_SUBDIR);
      return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
    });
    if (unseeded.length > 0) {
      console.error(`\nrebaseline: no committed baseline yet for: ${unseeded.map((p) => p.name).join(', ')}`);
      console.error('--write regenerates an existing baseline; it cannot create the first one, because it');
      console.error('never writes library-dependencies.json. Compile each project in place once to seed it,');
      console.error('then re-run this command to regenerate and validate:');
      for (const project of unseeded) {
        console.error(`  node src/cli.js ${path.join(root, project.dir).split(path.sep).join('/')}`);
      }
      process.exitCode = 1;
      return;
    }
  }

  const tmpDir = buildTempTree(projects, set);
  try {
    const results = [];
    let blocked = false;

    for (const project of projects) {
      const output = diffTree(
        path.join(tmpDir, project.dir, OUTPUT_SUBDIR),
        path.join(root, project.dir, BASELINE_SUBDIR),
        { markdownOnly: true },
      );
      printReport(`${project.name} — output`, output, { verbose: false });

      const outside = [...output.classes].filter((cls) => !allowed.has(cls));
      if (outside.length > 0) {
        console.error(`    REFUSING: ${project.name} has ${outside.join(', ')}-class changes, outside the allowed shape.`);
        blocked = true;
      }

      if (only.length > 0) {
        const strays = output.changed
          .map((change) => change.rel)
          .filter((rel) => !only.some((pattern) => rel.includes(pattern)));
        if (strays.length > 0) {
          console.error(`    REFUSING: ${project.name} changed ${strays.length} file(s) outside --only:`);
          for (const rel of strays.slice(0, 5)) console.error(`      ${rel}`);
          blocked = true;
        }
      }

      const reports = reportUnits(project, set, tmpDir).map((unit) => {
        const diff = diffTree(unit.from, unit.to, { markdownOnly: false });
        printReport(`${project.name} — report: ${unit.label}`, diff, { verbose: false });
        return { ...unit, diff };
      });

      results.push({ project, output, reports });
    }

    if (!write) {
      console.log('\nDry run — nothing written. Re-run with --write to commit these baselines.');
      return;
    }
    if (blocked) {
      console.error('\nNothing written: a change fell outside the allowed diff shape.');
      process.exitCode = 1;
      return;
    }

    for (const { project, output, reports } of results) {
      const from = path.join(tmpDir, project.dir, OUTPUT_SUBDIR);
      const to = path.join(root, project.dir, BASELINE_SUBDIR);
      let written = 0;
      for (const change of [...output.changed, ...output.added.map((rel) => ({ rel }))]) {
        if (!change.rel.endsWith('.md')) continue;
        copyFile(path.join(from, ...change.rel.split('/')), path.join(to, ...change.rel.split('/')));
        written++;
      }
      for (const rel of output.removed) {
        if (!rel.endsWith('.md')) continue;
        fs.rmSync(path.join(to, ...rel.split('/')), { force: true });
        written++;
      }

      for (const move of output.relocated || []) {
        copyFile(path.join(from, ...move.to.split('/')), path.join(to, ...move.to.split('/')));
        for (const old of move.from) fs.rmSync(path.join(to, ...old.split('/')), { force: true });
        written += 1 + move.from.length;
      }

      for (const d of output.derived || []) {
        const dest = path.join(to, ...d.rel.split('/'));
        if (d.kind === 'remove') fs.rmSync(dest, { force: true });
        else copyFile(path.join(from, ...d.rel.split('/')), dest);
        written++;
      }

      for (const unit of reports) {
        for (const change of [...unit.diff.changed, ...unit.diff.added.map((rel) => ({ rel }))]) {
          copyFile(path.join(unit.from, ...change.rel.split('/')), path.join(unit.to, ...change.rel.split('/')));
          written++;
        }
        for (const rel of unit.diff.removed) {
          fs.rmSync(path.join(unit.to, ...rel.split('/')), { force: true });
          written++;
        }
      }

      console.log(`  ${project.name}: wrote ${written} file(s)`);
    }

    console.log('\nBaselines written. Review the diff before committing — that review is the point.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { diffTree };