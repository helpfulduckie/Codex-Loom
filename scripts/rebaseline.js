#!/usr/bin/env node
'use strict';

/**
 * Regenerate a baseline fixture set (v4 spec §14.3).
 *
 * A change that moves output deliberately has to replace the committed baseline with what
 * the new compiler produces. §14.3 calls the result "a reviewed, committed artifact", and
 * the review is the part a script can protect: it classifies every changed line before
 * writing anything and refuses outright when a change lands outside the declared shape.
 *
 *   node scripts/rebaseline.js                 report only, writes nothing
 *   node scripts/rebaseline.js --write         write the baseline, if the shape allows
 *   node scripts/rebaseline.js --allow body    widen the allowed shape for this run
 *   node scripts/rebaseline.js --only "Plot Essentials.md"  restrict which files may move
 *   node scripts/rebaseline.js --set golden    the private fixtures rather than examples/
 *   node scripts/rebaseline.js showcase        one project rather than the whole set
 *
 * A first baseline needs one in-place compile to seed `library-dependencies.json`, which
 * this never writes (see below). `--write` against a project that has no committed baseline
 * yet refuses with that instruction rather than producing a baseline one file short;
 * everything else — the `.md` tree and every node's `Placeholders.yaml` — it regenerates.
 *
 * `--set` picks which fixture set to regenerate and defaults to `examples`, the committed
 * one. The two sets differ only in their manifests; see `examples/projects.js` for what
 * each field means and `__tests__/helpers/baselineHarness.js` for the reading half.
 *
 * The default allowed shape is `fence`, matching `EXPECTED_DIFF_CLASSES` in
 * `golden.test.js`. `--allow` exists because a later phase legitimately changes body text;
 * it takes an explicit argument every time rather than reading the constant, so widening
 * the shape is a decision someone typed rather than one they inherited.
 *
 * `--only` is the path-side half of the same guard, and exists for the same reason
 * `EXPECTED_DIFF_FILES` does in the harness: component output carries no envelope, so
 * every line in it classifies as `body` and `--allow body` alone would wave through a
 * rewritten story card. A phase whose diff lands in a component states both halves.
 *
 * Three things this deliberately does not do:
 *
 *   - It never copies `library-dependencies.json`. The manifest stamps the compile root, so
 *     a baseline written from a temp directory bakes that path in and defeats the
 *     harness's normalization on every later run.
 *   - It copies markdown only, with two exceptions. First: `Placeholders.yaml` (one per
 *     node) is non-`.md` but is derived, deterministic compiler output — pure scenario
 *     data, no paths or timestamps — so it is regenerated wholesale like a `.md` card,
 *     added/changed/removed via `report.derived`. Second: a non-markdown file under a
 *     `Scripts/` segment that left one path and reappeared byte-identically at another is
 *     *relocated* — Phase 12 Step 6 lifts a project's `Scripts/` dir root-ward when every
 *     leaf resolved the same one, and the re-baseline follows by moving the file, not
 *     re-contenting it. A shipped `.js` whose bytes changed, or one that vanished with no
 *     byte-identical counterpart, still aborts the run: scripts are copied input and a
 *     change to one has to be seen, not absorbed.
 *   - It compiles into a temp copy of the whole `goldenFixtures/` tree, because each
 *     project's compile.yaml writes to `../Velvet Lattice/` and reaches up three levels
 *     for shared canon, so neither the output nor the inputs can be redirected.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { compile } = require('../src/compile');
const { loadCompileConfig } = require('../src/config/load');
const { classifyDiff, OPAQUE } = require('../__tests__/helpers/diffShape');

const { DEFAULT_REPORT_MODES } = require('../__tests__/helpers/baselineHarness');

/**
 * The two baseline fixture sets, keyed by `--set`. Each names a tree and the manifest
 * inside it; the manifest's own fields say how that set is laid out. `examples` is the
 * default because it is committed and therefore always regenerable — asking for `golden`
 * on a checkout with no fixtures clone is an error worth stating plainly, but making it
 * the default would mean the common case fails for most people.
 */
const SETS = {
  examples: { dir: path.resolve(__dirname, '..', 'examples'), manifest: 'projects.js' },
  golden: { dir: path.resolve(__dirname, '..', 'goldenFixtures'), manifest: 'projects.js' },
};

function loadSet(name) {
  const set = SETS[name];
  if (!set) throw new Error(`Unknown --set "${name}". Known: ${Object.keys(SETS).join(', ')}`);

  // The goldens are a separate private repo cloned into the gitignored goldenFixtures/ (see
  // .gitignore). Say so plainly rather than letting the require throw MODULE_NOT_FOUND,
  // which names a file the reader has no reason to expect is missing.
  if (!fs.existsSync(path.join(set.dir, set.manifest))) {
    if (name === 'golden') {
      console.error('rebaseline: goldenFixtures/ is not present, so there is no baseline to regenerate.');
      console.error('The fixtures are a separate private repo. Clone it into goldenFixtures/ first:');
      console.error('  git clone https://github.com/helpfulduckie/Codex-Loom-Fixtures.git goldenFixtures');
      process.exit(1);
    }
    throw new Error(`rebaseline: ${name} set has no manifest at ${path.join(set.dir, set.manifest)}`);
  }

  // eslint-disable-next-line global-require, import/no-dynamic-require
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

// ── arguments ────────────────────────────────────────────────────────────────

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
function buildTempTree(projects, set) {
  const {
    root, OUTPUT_SUBDIR, BASELINE_SUBDIR, REPORTS_SUBDIR, SOURCE_SUBDIR, CONFIG_NAME,
    REPORT_MODES, REPORTS_IN_PLACE,
  } = set;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-rebaseline-'));
  fs.cpSync(root, tmpDir, {
    recursive: true,
    // Both committed baselines are the comparison target, not an input — and the report
    // baseline shares its path with where fresh reports are about to be written.
    // OUTPUT_SUBDIR ("Velvet Lattice/") is compiler output, gitignored: absent on a clean
    // clone, but on a checkout where someone ran the CLI against a fixture directly it
    // survives the copy, and compile does not run with --clean here — so a stale per-leaf
    // dir the current compiler no longer writes would linger as an orphan and break the
    // "emits exactly the baseline file set" assertion. Phase 12 Session D hit this with
    // the Scripts/ lift and deleted the local dirs by hand; excluding it here is the fix.
    filter: (src) => {
      const segments = path.relative(root, src).split(path.sep);
      return !segments.includes(BASELINE_SUBDIR) && !segments.includes(REPORTS_SUBDIR)
        && !segments.includes(OUTPUT_SUBDIR);
    },
  });

  for (const project of projects) {
    process.stdout.write(`compiling ${project.name}… `);
    quietly(() => {
      const configPath = path.join(tmpDir, project.dir, SOURCE_SUBDIR, CONFIG_NAME);
      // `live: true` to match `baselineHarness.js` exactly — a baseline regenerated through
      // a project's frozen snapshot while the harness checks it against the live sources is
      // a baseline that passes for the wrong reason, which is the failure this whole file
      // exists to avoid.
      const compileOptions = { live: true };
      for (const mode of project.compileReports || []) compileOptions[mode] = true;
      compile(configPath, compileOptions);

      // When reports are frozen in place, every mode writes under wherever
      // `structure.reports` resolved and nothing is collected afterward — see
      // `REPORTS_IN_PLACE` in examples/projects.js.
      const reportBase = REPORTS_IN_PLACE
        ? resolvedReportsDir(configPath)
        : path.join(tmpDir, project.dir, REPORTS_SUBDIR);

      const scenarioRoot = path.join(tmpDir, project.dir, OUTPUT_SUBDIR);
      for (const mode of project.reports) {
        const dir = path.join(reportBase, mode);
        fs.mkdirSync(dir, { recursive: true });
        REPORT_MODES[mode]()(scenarioRoot, dir, false);
      }

      if (!REPORTS_IN_PLACE) collectCompileReports(project, configPath, tmpDir, set);
    });
    process.stdout.write('done\n');
  }

  return tmpDir;
}

/**
 * Where `structure.reports` resolves for a config, read back via `loadCompileConfig` — a
 * second, side-effect-free parse of the same file. `compile()` writes reports there and
 * returns nothing that names the path.
 */
function resolvedReportsDir(configPath) {
  const config = loadCompileConfig(configPath);
  return config._resolvedReports || path.join(config._resolvedOutput, 'Overview');
}

/**
 * Copy `diff`/`annotate`/`inventory` output into `v3-reports/<mode>/`. Mirrors
 * `golden.test.js`'s helper of the same job — `compile()` writes those three wherever
 * `structure.reports` resolves and returns nothing that names that path, so it is read
 * back via `loadCompileConfig`, a second side-effect-free parse of the same `compile.yaml`.
 */
function collectCompileReports(project, configPath, tmpDir, set) {
  const { REPORTS_SUBDIR, COMPILE_REPORT_LAYOUT } = set;
  const reportBase = resolvedReportsDir(configPath);
  for (const mode of project.compileReports || []) {
    const layout = COMPILE_REPORT_LAYOUT[mode];
    if (!layout) continue;
    const dir = path.join(tmpDir, project.dir, REPORTS_SUBDIR, mode);
    fs.mkdirSync(dir, { recursive: true });
    if (layout.files) {
      for (const f of layout.files) {
        const src = path.join(reportBase, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
      }
    } else if (layout.subdir) {
      const src = path.join(reportBase, layout.subdir);
      if (fs.existsSync(src)) fs.cpSync(src, dir, { recursive: true });
    }
  }
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
  const report = {
    changed: [], added: [], removed: [], relocated: [], derived: [], classes: new Set(),
  };

  for (const rel of expected) if (!actual.has(rel)) report.removed.push(rel);
  for (const rel of actual) if (!expected.has(rel)) report.added.push(rel);

  // Phase 12 Step 6: a shipped `.js` under `Scripts/` moves when branch inheritance lifts a
  // project's script dir root-ward. Pair a removed file with an added one by its path from
  // `Scripts/` on *and* by bytes; a match is a relocation, re-baselined by moving the file
  // (many removed per-leaf copies collapse onto one added root copy). Anything left over —
  // bytes changed, or a script added or removed outright — is a real content change, and it
  // classifies OPAQUE so the run refuses exactly as an unexplained non-markdown diff does.
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

    // A script file that is added or removed but not part of a byte-identical move is a
    // real content change: pull it out of the file-set lists and report it as an OPAQUE
    // change so the shape check refuses.
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

  // `Placeholders.yaml` (one per node) is non-`.md` but it is derived, deterministic
  // compiler output — pure scenario data, no paths or timestamps — and is as safe to
  // regenerate wholesale as a `.md` card, unlike a copied-input `Scripts/*.js`. Route its
  // add/remove into `report.derived` so the `.md`-only write filter does not drop it (which
  // left a first-seed baseline one file short) and so the OPAQUE non-markdown classification
  // below never fires for a legitimate placeholder change. `library-dependencies.json` is
  // the other derived output and stays excluded everywhere: it bakes in the compile root.
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

// ── main ─────────────────────────────────────────────────────────────────────

/**
 * The report comparisons for one project, as `{ label, from, to }` triples.
 *
 * A collected set has one per mode, each in its own directory. A set frozen in place has
 * exactly one covering the whole reports directory — nothing was collected, so there is no
 * per-mode split to key on, and files no mode key names are inside it by construction.
 */
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

  // `--write` cannot seed a first baseline on its own: it never writes
  // `library-dependencies.json` (that file bakes in the compile root — see the header), so a
  // baseline built from an empty directory comes out one file short and the next
  // `examples.test.js` run fails its file-set assertion. Refuse with the one instruction that
  // fixes it — compile the project in place once — rather than producing the short baseline.
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

      // Phase 12 Step 6: apply the `Scripts/` relocations — write the file at its new path,
      // drop every old copy. Byte-identity was already proven when the move was recognized.
      for (const move of output.relocated || []) {
        copyFile(path.join(from, ...move.to.split('/')), path.join(to, ...move.to.split('/')));
        for (const old of move.from) fs.rmSync(path.join(to, ...old.split('/')), { force: true });
        written += 1 + move.from.length;
      }

      // `Placeholders.yaml` and any other derived non-`.md` output: regenerate wholesale, the
      // same as a `.md` card. The `.md`-only filters above skip it; this writes it.
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
