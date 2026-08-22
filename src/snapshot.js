'use strict';

/**
 * Phase 7's freeze unit: `--snapshot` (sync + manifest write) and the compile-time drift
 * notice (`checkDrift`).
 *
 * Nothing existing owns copy+hash+manifest-write, so this is a new module rather than an
 * addition to `compile.js`'s `buildLibraryManifest` (a different artifact — a compile-time
 * dependency listing into the output tree, no hashes, no copying) or `src/diff.js` (branch-
 * leaf item diffing within one compile, no frozen-vs-live tree comparison at all).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { CODES } = require('./config/load');

/** Every file under `dir`, relative paths, sorted — not suffix-filtered (companion `.md`
 * files beside a `.yaml` component must survive a freeze same as the component itself). */
function listAllFiles(dir) {
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

function hashFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function hashTree(dir) {
  const files = listAllFiles(dir);
  const out = {};
  for (const rel of files) out[rel] = hashFile(path.join(dir, rel));
  return out;
}

/** Same normalization `golden.test.js`'s `normalizeManifest` uses, for consistency. */
function normalize(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

function isOutOfBase(resolvedPath, base) {
  return !normalize(resolvedPath).startsWith(normalize(base));
}

/**
 * Every `structure.input.library` entry (all of them) plus every out-of-base
 * `structure.input.templates` entry (Decision 2's template-only in-base/out-of-base rule).
 */
function collectEntries(config) {
  const entries = [];
  for (const [name, resolvedPath] of config._resolvedLibrary) {
    entries.push({ name, sourcePath: resolvedPath, kind: 'library' });
  }
  const templates = config._resolvedTemplates || [];
  templates.forEach((resolvedPath, i) => {
    if (isOutOfBase(resolvedPath, config._base)) {
      entries.push({ name: String(i), sourcePath: resolvedPath, kind: 'template' });
    }
  });
  return entries;
}

function entryLabel(entry) {
  return `${entry.kind === 'library' ? 'Library' : 'Template'} "${entry.name}"`;
}

/**
 * Read `manifest.json`. Returns `null` for "no previous manifest" (the normal first-sync
 * state) and also `null` (after raising CL0112, if a bus was given) for "present but
 * unparseable" — both cases mean "nothing to compare against" to the caller.
 */
function loadManifest(manifestPath, diagnostics) {
  if (!fs.existsSync(manifestPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    if (diagnostics) {
      diagnostics.warn(
        CODES.SNAPSHOT_MANIFEST_UNPARSEABLE,
        `Snapshot manifest at ${manifestPath} is not valid JSON.`,
        {}
      );
    }
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.manifestVersion !== 'number') {
    if (diagnostics) {
      diagnostics.warn(
        CODES.SNAPSHOT_MANIFEST_UNPARSEABLE,
        `Snapshot manifest at ${manifestPath} does not match the expected shape.`,
        {}
      );
    }
    return null;
  }
  return parsed;
}

/** File-level change summary for one entry: added / removed / changed-by-hash. */
function diffEntryLines(entry, prevSection, liveHashes) {
  const label = entryLabel(entry);
  if (!prevSection) {
    const count = Object.keys(liveHashes).length;
    return [`${label}: ${count} file(s), all new (no previous snapshot entry).`];
  }
  const prevFiles = prevSection.files || {};
  const added = [];
  const removed = [];
  const changed = [];
  for (const rel of Object.keys(liveHashes)) {
    if (!(rel in prevFiles)) added.push(rel);
    else if (prevFiles[rel] !== liveHashes[rel]) changed.push({ rel, from: prevFiles[rel], to: liveHashes[rel] });
  }
  for (const rel of Object.keys(prevFiles)) {
    if (!(rel in liveHashes)) removed.push(rel);
  }
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return [`${label}: no changes.`];
  }
  const lines = [`${label}:`];
  for (const rel of added) lines.push(`  added:   ${rel}`);
  for (const rel of removed) lines.push(`  removed: ${rel}`);
  for (const c of changed) lines.push(`  changed: ${c.rel} (${c.from} -> ${c.to})`);
  return lines;
}

/**
 * Sync every library entry (and out-of-base template entry) into `snapshot/<name>/`, raw
 * bytes, and (re)write `snapshot/manifest.json`. Before overwriting, if a previous manifest
 * exists and parses, writes a file-level change summary to `<reports>/snapshot/sync-diff.txt`.
 */
function syncLibrary(config, options = {}) {
  const { verbose = false, diagnostics = null } = options;
  const snapshotDir = config._resolvedSnapshot;
  if (!snapshotDir) {
    throw new Error('structure.input.snapshot is not set; nothing to sync.');
  }

  const entries = collectEntries(config);
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  const previousManifest = loadManifest(manifestPath, diagnostics);

  const newManifest = { manifestVersion: 1, syncedAt: new Date().toISOString(), library: {} };
  const hasTemplates = entries.some((e) => e.kind === 'template');
  if (hasTemplates) newManifest.templates = {};

  const reportLines = [];
  let filesWritten = 0;

  for (const entry of entries) {
    const files = listAllFiles(entry.sourcePath);
    const fileHashes = {};
    for (const rel of files) fileHashes[rel] = hashFile(path.join(entry.sourcePath, rel));

    const prevSection = previousManifest
      ? (entry.kind === 'library' ? previousManifest.library : previousManifest.templates || {})[entry.name]
      : undefined;
    reportLines.push(...diffEntryLines(entry, prevSection, fileHashes));

    const destDir = path.join(snapshotDir, entry.name);
    for (const rel of files) {
      const from = path.join(entry.sourcePath, rel);
      const to = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      filesWritten += 1;
    }

    const section = { source: entry.sourcePath, files: fileHashes };
    if (entry.kind === 'library') newManifest.library[entry.name] = section;
    else newManifest.templates[entry.name] = section;

    if (verbose) console.log(`  synced ${entryLabel(entry)}: ${files.length} file(s)`);
  }

  if (config._resolvedReports) {
    const reportDir = path.join(config._resolvedReports, 'snapshot');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'sync-diff.txt'), reportLines.join('\n') + '\n', 'utf8');
  }

  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2), 'utf8');

  return { entries, filesWritten, manifestPath };
}

/**
 * Compile-time drift check. A complete no-op — no console output, no diagnostics — unless
 * `structure.input.snapshot` is set *and* `snapshot/manifest.json` exists and parses; that
 * covers every project until it opts in (§Decision 4: drift is expected and comfortable,
 * never a warning, never a non-zero exit).
 */
function checkDrift(config, diagnostics) {
  const snapshotDir = config._resolvedSnapshot;
  if (!snapshotDir) return;
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;

  const manifest = loadManifest(manifestPath, diagnostics);
  if (!manifest) return; // unparseable — CL0112 already raised

  const syncedDate = (manifest.syncedAt || '').slice(0, 10);
  const entries = collectEntries(config);

  for (const entry of entries) {
    const section = entry.kind === 'library'
      ? (manifest.library || {})[entry.name]
      : (manifest.templates || {})[entry.name];

    if (!section) {
      diagnostics.warn(
        CODES.SNAPSHOT_MISSING_ENTRY,
        `${entryLabel(entry)} has no entry in the snapshot manifest at ${manifestPath}.`,
        {}
      );
      continue;
    }

    // Live drift — informational only, never routed through the diagnostics bus.
    const liveHashes = hashTree(entry.sourcePath);
    let changedCount = 0;
    for (const rel of Object.keys(liveHashes)) {
      if (section.files[rel] !== liveHashes[rel]) changedCount += 1;
    }
    for (const rel of Object.keys(section.files)) {
      if (!(rel in liveHashes)) changedCount += 1;
    }
    if (changedCount > 0) {
      console.log(
        `${entryLabel(entry)} has ${changedCount} changed file(s) since last snapshot `
        + `(${syncedDate}). Run --snapshot to review.`
      );
    }

    // Corruption check — the frozen copy itself, compared against its own manifest hashes.
    const snapEntryDir = path.join(snapshotDir, entry.name);
    if (!fs.existsSync(snapEntryDir)) {
      diagnostics.warn(
        CODES.SNAPSHOT_DIR_MISSING,
        `Snapshot directory for ${entryLabel(entry)} is missing: ${snapEntryDir}`,
        {}
      );
      continue;
    }
    const snapFiles = listAllFiles(snapEntryDir);
    for (const rel of snapFiles) {
      if (!(rel in section.files)) {
        diagnostics.warn(
          CODES.SNAPSHOT_FILE_UNTRACKED,
          `${entryLabel(entry)}: snapshot/${entry.name}/${rel} has no entry in the manifest.`,
          {}
        );
        continue;
      }
      const onDiskHash = hashFile(path.join(snapEntryDir, rel));
      if (onDiskHash !== section.files[rel]) {
        diagnostics.error(
          CODES.SNAPSHOT_HASH_MISMATCH,
          `${entryLabel(entry)}: snapshot/${entry.name}/${rel} does not match its manifest `
          + 'hash — it was hand-edited since the last --snapshot.',
          {}
        );
      }
    }
  }
}

module.exports = { syncLibrary, checkDrift, listAllFiles, hashFile, hashTree, CODES };
