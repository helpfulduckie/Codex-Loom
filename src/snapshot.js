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

const { CODES, loadManifest, isOutOfBase } = require('./config/load');
const { buildCanonRegistry } = require('./loader/registry');
const { Diagnostics } = require('./diag');

/** Matches an applyTokenPass-style brace token: `{$X}`, `{$X.pronoun}`, `{$X's}`, etc. */
const ROLE_TOKEN_RE = /\{\$([^{}]+)\}/g;

/** The leading identifier of a `{$X...}` token — the same split `applyTokenPass` makes
 * before checking whether it names a role or an item id (`model/pronouns.js:277`). */
function leadingTokenId(inner) {
  const trimmed = inner.trim();
  const dot0 = trimmed.indexOf('.');
  if (dot0 !== -1) return trimmed.slice(0, dot0);
  if (trimmed.toLowerCase().endsWith("'s")) return trimmed.slice(0, -2);
  return trimmed;
}

/** Every distinct `{$X...}` leading identifier in a library entry's frozen files, first-seen casing kept. */
function scanRoleCandidates(sourcePath, files) {
  const seen = new Map(); // lowercase -> first-seen casing
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(sourcePath, rel), 'utf8');
    } catch (_) {
      continue; // not a text file (or unreadable) — nothing to scan
    }
    ROLE_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = ROLE_TOKEN_RE.exec(text))) {
      const leading = leadingTokenId(m[1]);
      if (!leading) continue;
      const lower = leading.toLowerCase();
      if (!seen.has(lower)) seen.set(lower, leading);
    }
  }
  return seen;
}

/**
 * `requiresRoles` per library entry, computed by elimination (§9.4.4, Decision 2): a
 * `{$X}` prefix in the entry's own frozen files that resolves to no item id anywhere in
 * the snapshotted library — checked against every entry, not only its own, because a
 * legitimate cross-set reference (§9.4.2's `requires:`, not yet enforced) must not be
 * misreported as a role.
 *
 * A precondition guards the conflation Decision 2 accepts (a typo reads exactly like a
 * role requirement): elimination is only trusted for an entry whose own item content
 * validates cleanly. An entry that fails to build its own registry — a hard throw (a
 * duplicate id, an item missing identity) or an ERROR diagnostic (a schema violation) —
 * is refused rather than published as a role list; the caller raises `CL0116` for it and
 * writes no `requiresRoles` key.
 *
 * Returns a Map of entry name -> `{ roles: string[] }` or `{ refused: string }`, library
 * entries only — template entries carry no role contract.
 */
function computeRequiresRoles(entries, allFileHashes) {
  const libraryEntries = entries.filter((e) => e.kind === 'library');
  const registries = new Map(); // name -> ItemRegistry, or null if refused
  const refusals = new Map(); // name -> reason

  for (const entry of libraryEntries) {
    const localDiag = new Diagnostics();
    let registry = null;
    try {
      registry = buildCanonRegistry(new Map([[entry.name, entry.sourcePath]]), { diagnostics: localDiag });
    } catch (err) {
      refusals.set(entry.name, err.message);
    }
    if (registry && localDiag.hasErrors()) {
      refusals.set(entry.name, localDiag.errors.map((d) => d.message).join('; '));
      registry = null;
    }
    registries.set(entry.name, registry);
  }

  const result = new Map();
  for (const entry of libraryEntries) {
    if (refusals.has(entry.name)) {
      result.set(entry.name, { refused: refusals.get(entry.name) });
      continue;
    }
    const ownRegistry = registries.get(entry.name);
    const candidates = scanRoleCandidates(entry.sourcePath, Object.keys(allFileHashes.get(entry.name) || {}));
    const roles = [];
    for (const [lower, original] of candidates) {
      if (ownRegistry.has(lower)) continue; // an ordinary item reference in this set
      const resolvesElsewhere = [...registries.entries()].some(
        ([otherName, otherRegistry]) => otherName !== entry.name && otherRegistry && otherRegistry.has(lower)
      );
      if (resolvesElsewhere) continue;
      roles.push(original);
    }
    if (roles.length) result.set(entry.name, { roles: roles.sort((a, b) => a.localeCompare(b)) });
  }

  return result;
}

/** Remove every empty directory under `dir` (depth-first), leaving `dir` itself in place.
 * Used after a prune pass so a slot-file rename does not strand an empty subtree. */
function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    removeEmptyDirs(sub);
    if (fs.readdirSync(sub).length === 0) fs.rmdirSync(sub);
  }
}

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

/**
 * Every `structure.input.library` entry (all of them) plus every out-of-base
 * `structure.input.templates` entry (Decision 2's template-only in-base/out-of-base rule).
 *
 * Reads the `*Source` fields — the always-live maps — so sync and drift keep hashing live
 * files regardless of whatever a given run's snapshot redirection (Phase 7 Session B)
 * decided for `_resolvedLibrary`/`_resolvedTemplates` themselves.
 */
function collectEntries(config) {
  const entries = [];
  for (const [name, resolvedPath] of config._resolvedLibrarySource) {
    entries.push({ name, sourcePath: resolvedPath, kind: 'library' });
  }
  const templates = config._resolvedTemplatesSource || [];
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

  const newManifest = { manifestVersion: 2, syncedAt: new Date().toISOString(), library: {} };
  const hasTemplates = entries.some((e) => e.kind === 'template');
  if (hasTemplates) newManifest.templates = {};

  const reportLines = [];
  let filesWritten = 0;

  // First pass: hash every entry's frozen file set. `requiresRoles` (Decision 2, Phase 8)
  // needs every entry's file list and item registry available at once, to check whether a
  // token unresolved in its own set resolves in another snapshotted one before elimination
  // treats it as a role.
  const collected = entries.map((entry) => {
    const files = listAllFiles(entry.sourcePath);
    const fileHashes = {};
    for (const rel of files) fileHashes[rel] = hashFile(path.join(entry.sourcePath, rel));
    return { entry, files, fileHashes };
  });
  const fileHashesByName = new Map(collected.map((c) => [c.entry.name, c.fileHashes]));
  const requiresRolesByName = computeRequiresRoles(entries, fileHashesByName);

  for (const { entry, files, fileHashes } of collected) {
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

    // Prune: delete any file a previous snapshot left in `destDir` that this run's source
    // no longer has. `loadTemplates` reads the directory, not the manifest, so a removed or
    // renamed slot file (a stale `.template` next to a new `fields.cl.yaml`, an old
    // `terse.cl.yaml`) would shadow the live field table and silence the emitter. Phase 12
    // Sessions B and C pruned the golden `snapshot/0/` trees by hand; this makes it
    // automatic. Deletions are not counted in `filesWritten` — that tracks copies.
    if (fs.existsSync(destDir)) {
      const keep = new Set(files);
      for (const rel of listAllFiles(destDir)) {
        if (!keep.has(rel)) fs.rmSync(path.join(destDir, rel));
      }
      removeEmptyDirs(destDir);
    }

    const section = { source: entry.sourcePath, files: fileHashes };
    const roleResult = requiresRolesByName.get(entry.name);
    if (roleResult && roleResult.refused) {
      if (diagnostics) {
        diagnostics.error(
          CODES.LIBRARY_ROLE_SCAN_REFUSED,
          `${entryLabel(entry)}: cannot compute requiresRoles — this set's own items do not `
          + `validate (${roleResult.refused}). Fix the item content and re-run --snapshot.`,
          {}
        );
      }
    } else if (roleResult && roleResult.roles) {
      section.requiresRoles = roleResult.roles;
    }
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
        `${entryLabel(entry)} has no entry in ${path.basename(manifestPath)}.`,
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
        `Snapshot directory for ${entryLabel(entry)} is missing: snapshot/${entry.name}`,
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

module.exports = {
  syncLibrary, checkDrift, listAllFiles, hashFile, hashTree, collectEntries, entryLabel, CODES,
};
