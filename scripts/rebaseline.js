#!/usr/bin/env node
'use strict';

/**
 * Regenerate the golden fixture baselines (v4 spec §14.3).
 *
 * A phase that changes output deliberately has to replace `v3/` and `v3-reports/` under
 * each fixture with what the new compiler produces. §14.3 calls the result "a reviewed,
 * committed artifact", and the review is the part a script can protect: it classifies
 * every changed line before writing anything and refuses outright when a change lands
 * outside the shape the phase declared.
 *
 *   node scripts/rebaseline.js                 report only, writes nothing
 *   node scripts/rebaseline.js --write         write the baseline, if the shape allows
 *   node scripts/rebaseline.js --allow body    widen the allowed shape for this run
 *   node scripts/rebaseline.js "The Institute" one project rather than all three
 *
 * The default allowed shape is `fence`, matching `EXPECTED_DIFF_CLASSES` in
 * `golden.test.js`. `--allow` exists because a later phase legitimately changes body text;
 * it takes an explicit argument every time rather than reading the constant, so widening
 * the shape is a decision someone typed rather than one they inherited.
 *
 * Three things this deliberately does not do:
 *
 *   - It never copies `canon-dependencies.json`. The manifest stamps the compile root, so
 *     a baseline written from a temp directory bakes that path in and defeats the
 *     harness's normalization on every later run.
 *   - It copies markdown only. Everything else under `v3/` — the scripts a project ships
 *     — is copied input, not compiler output, and re-baselining it would hide a change in
 *     what gets copied rather than record one.
 *   - It compiles into a temp copy of the whole `goldenFixtures/` tree, because each
 *     project's compile.yaml writes to `../Velvet Lattice/` and reaches up three levels
 *     for shared canon, so neither the output nor the inputs can be redirected.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { compile } = require('../src/compile');
const { classifyDiff, OPAQUE } = require('../__tests__/helpers/diffShape');
const {
  PROJECTS, OUTPUT_SUBDIR, BASELINE_SUBDIR, SOURCE_SUBDIR, REPORTS_SUBDIR, REPORT_MODES,
} = require('../goldenFixtures/projects');

const GOLDEN_DIR = path.resolve(__dirname, '..', 'goldenFixtures');

// ── arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const allowed = new Set(['fence']);
  const names = [];
  let write = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') write = true;
    else if (arg === '--allow') allowed.add(argv[++i]);
    else if (arg.startsWith('--')) throw new Error(`Unknown flag ${arg}`);
    else names.push(arg);
  }

  const projects = names.length === 0
    ? PROJECTS
    : names.map((name) => {
      const found = PROJECTS.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!found) throw new Error(`Unknown fixture "${name}". Known: ${PROJECTS.map((p) => p.name).join(', ')}`);
      return found;
    });

  return { write, allowed, projects };
}

// ── file walking ─────────────────────────────────────────────────────────────

function listFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// ── compile ──────────────────────────────────────────────────────────────────

/** Compile every project into a temp copy of the fixture tree and run its frozen reports. */
function buildTempTree(projects) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-rebaseline-'));
  fs.cpSync(GOLDEN_DIR, tmpDir, {
    recursive: true,
    // Both committed baselines are the comparison target, not an input — and the report
    // baseline shares its path with where fresh reports are about to be written.
    filter: (src) => {
      const segments = path.relative(GOLDEN_DIR, src).split(path.sep);
      return !segments.includes(BASELINE_SUBDIR) && !segments.includes(REPORTS_SUBDIR);
    },
  });

  for (const project of projects) {
    process.stdout.write(`compiling ${project.name}… `);
    quietly(() => {
      compile(path.join(tmpDir, project.dir, SOURCE_SUBDIR, 'compile.yaml'));
      const scenarioRoot = path.join(tmpDir, project.dir, OUTPUT_SUBDIR);
      for (const mode of project.reports) {
        const dir = path.join(tmpDir, project.dir, REPORTS_SUBDIR, mode);
        fs.mkdirSync(dir, { recursive: true });
        REPORT_MODES[mode]()(scenarioRoot, dir, false);
      }
    });
    process.stdout.write('done\n');
  }

  return tmpDir;
}

/**
 * compile() and the report modes are chatty — The Institute alone prints a line per lint
 * finding across 829 files — and the diff report is the output that matters here.
 */
function quietly(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    fn();
  } finally {
    Object.assign(console, saved);
  }
}

// ── diffing ──────────────────────────────────────────────────────────────────

/**
 * Classify every difference between a compiled tree and its committed baseline.
 *
 * Files present in one tree and not the other are reported as added/removed rather than
 * classified: a new or vanished card is a change to the file set, which the harness
 * asserts separately and which no line-class can describe.
 */
function diffTree(actualDir, expectedDir, { markdownOnly }) {
  const actual = new Set(listFiles(actualDir));
  const expected = new Set(listFiles(expectedDir));
  const report = { changed: [], added: [], removed: [], classes: new Set() };

  for (const rel of expected) if (!actual.has(rel)) report.removed.push(rel);
  for (const rel of actual) if (!expected.has(rel)) report.added.push(rel);

  for (const rel of [...actual].sort()) {
    if (!expected.has(rel)) continue;
    if (path.basename(rel) === 'canon-dependencies.json') continue; // never re-baselined

    const actualPath = path.join(actualDir, ...rel.split('/'));
    const expectedPath = path.join(expectedDir, ...rel.split('/'));
    if (fs.readFileSync(actualPath).equals(fs.readFileSync(expectedPath))) continue;

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
  const counts = `${report.changed.length} changed, ${report.added.length} added, ${report.removed.length} removed`;
  console.log(`\n  ${label}: ${counts}`);
  for (const rel of report.added) console.log(`    + ${rel}`);
  for (const rel of report.removed) console.log(`    - ${rel}`);

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

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const { write, allowed, projects } = parseArgs(process.argv.slice(2));
  console.log(`allowed diff shape: ${[...allowed].join(', ')}`);

  const tmpDir = buildTempTree(projects);
  try {
    const results = [];
    let blocked = false;

    for (const project of projects) {
      const output = diffTree(
        path.join(tmpDir, project.dir, OUTPUT_SUBDIR),
        path.join(GOLDEN_DIR, project.dir, BASELINE_SUBDIR),
        { markdownOnly: true },
      );
      printReport(`${project.name} — output`, output, { verbose: false });

      const outside = [...output.classes].filter((cls) => !allowed.has(cls));
      if (outside.length > 0) {
        console.error(`    REFUSING: ${project.name} has ${outside.join(', ')}-class changes, outside the allowed shape.`);
        blocked = true;
      }

      const reports = {};
      for (const mode of project.reports) {
        reports[mode] = diffTree(
          path.join(tmpDir, project.dir, REPORTS_SUBDIR, mode),
          path.join(GOLDEN_DIR, project.dir, REPORTS_SUBDIR, mode),
          { markdownOnly: false },
        );
        printReport(`${project.name} — report: ${mode}`, reports[mode], { verbose: false });
      }

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
      const to = path.join(GOLDEN_DIR, project.dir, BASELINE_SUBDIR);
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

      for (const mode of project.reports) {
        const reportFrom = path.join(tmpDir, project.dir, REPORTS_SUBDIR, mode);
        const reportTo = path.join(GOLDEN_DIR, project.dir, REPORTS_SUBDIR, mode);
        const report = reports[mode];
        for (const change of [...report.changed, ...report.added.map((rel) => ({ rel }))]) {
          copyFile(path.join(reportFrom, ...change.rel.split('/')), path.join(reportTo, ...change.rel.split('/')));
          written++;
        }
        for (const rel of report.removed) {
          fs.rmSync(path.join(reportTo, ...rel.split('/')), { force: true });
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

module.exports = { diffTree, parseArgs };
