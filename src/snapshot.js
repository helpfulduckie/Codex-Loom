'use strict';


const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadManifest, isOutOfBase, loadCompileConfig } = require('./config/load');
const { buildCanonRegistry } = require('./loader/registry');
const { Diagnostics, CODES } = require('./diag');
const { NULL_LOG } = require('./log');
const { listFilesRelative } = require('./util');

const ROLE_TOKEN_RE = /\{\$([^{}]+)\}/g;

function leadingTokenId(inner) {
  const trimmed = inner.trim();
  const dot0 = trimmed.indexOf('.');
  if (dot0 !== -1) return trimmed.slice(0, dot0);
  if (trimmed.toLowerCase().endsWith("'s")) return trimmed.slice(0, -2);
  return trimmed;
}

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

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    removeEmptyDirs(sub);
    if (fs.readdirSync(sub).length === 0) fs.rmdirSync(sub);
  }
}

function hashFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function hashTree(dir) {
  const files = listFilesRelative(dir);
  const out = {};
  for (const rel of files) out[rel] = hashFile(path.join(dir, rel));
  return out;
}

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

// What a freeze changes in one entry, against the manifest of the freeze before it.
function diffEntry(entry, prevSection, liveHashes) {
  const diff = { name: entry.name, kind: entry.kind, isNew: !prevSection, added: [], removed: [], changed: [] };
  if (!prevSection) {
    diff.added = Object.keys(liveHashes);
    return diff;
  }
  const prevFiles = prevSection.files || {};
  for (const rel of Object.keys(liveHashes)) {
    if (!(rel in prevFiles)) diff.added.push(rel);
    else if (prevFiles[rel] !== liveHashes[rel]) diff.changed.push({ rel, from: prevFiles[rel], to: liveHashes[rel] });
  }
  for (const rel of Object.keys(prevFiles)) {
    if (!(rel in liveHashes)) diff.removed.push(rel);
  }
  return diff;
}

function diffEntryLines(entry, diff) {
  const label = entryLabel(entry);
  if (diff.isNew) return [`${label}: ${diff.added.length} file(s), all new (no previous snapshot entry).`];
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return [`${label}: no changes.`];
  }
  const lines = [`${label}:`];
  for (const rel of diff.added) lines.push(`  added:   ${rel}`);
  for (const rel of diff.removed) lines.push(`  removed: ${rel}`);
  for (const c of diff.changed) lines.push(`  changed: ${c.rel} (${c.from} -> ${c.to})`);
  return lines;
}

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};
const sameState = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function snapshotState(config, diagnostics) {
  const snapshot = config._resolvedSnapshot;
  const manifest = path.join(snapshot, 'manifest.json');
  const previous = loadManifest(manifest, diagnostics);
  const entries = collectEntries(config);
  const collected = entries.map((entry) => {
    const snapshotPath = path.join(snapshot, entry.name);
    const live = hashTree(entry.sourcePath);
    const frozen = hashTree(snapshotPath);
    const section = (previous && (entry.kind === 'library' ? previous.library : previous.templates)) || {};
    const diff = diffEntry(entry, { files: frozen }, live);
    return {
      ...entry, snapshotPath, live, frozen, isNew: !section[entry.name],
      added: diff.added, removed: diff.removed, changed: diff.changed.map((c) => c.rel),
    };
  });
  const hashes = new Map(collected.filter((e) => e.kind === 'library').map((e) => [e.name, e.live]));
  const roles = computeRequiresRoles(entries, hashes);
  const next = { manifestVersion: 2, library: {} };
  if (entries.some((e) => e.kind === 'template')) next.templates = {};
  for (const entry of collected) {
    const section = { source: entry.sourcePath, files: entry.live };
    const roleResult = entry.kind === 'library' ? roles.get(entry.name) : null;
    if (roleResult && roleResult.roles) section.requiresRoles = roleResult.roles;
    (entry.kind === 'library' ? next.library : next.templates)[entry.name] = section;
  }
  // Retired manifest entries still own frozen files which replacement must remove.
  for (const kind of ['library', 'template']) {
    const old = (previous && (kind === 'library' ? previous.library : previous.templates)) || {};
    for (const [name, section] of Object.entries(old)) {
      if (entries.some((e) => e.kind === kind && e.name === name)) continue;
      const snapshotPath = path.resolve(snapshot, name);
      if (isOutOfBase(snapshotPath, snapshot) || snapshotPath === path.resolve(snapshot)) {
        throw new Error('Snapshot manifest entry is outside its destination.');
      }
      const frozen = hashTree(snapshotPath);
      collected.push({ name, kind, sourcePath: section.source, snapshotPath, live: {}, frozen,
        isNew: false, added: [], removed: Object.keys(frozen), changed: [] });
    }
  }
  const { syncedAt, ...previousContent } = previous || {};
  const manifestChanged = !sameState(previousContent, next);
  const configFile = config._configPath;
  const fingerprint = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canonical({
    config: configFile, configHash: hashFile(configFile), snapshot, entries: collected,
    manifestHash: fs.existsSync(manifest) ? hashFile(manifest) : null,
    snapshotFiles: hashTree(snapshot),
  }))).digest('hex');
  return { entries, collected, roles, next, manifest, fingerprint, manifestChanged,
    hasChanges: manifestChanged || collected.some((e) => e.added.length || e.removed.length || e.changed.length) };
}

function snapshotDiagnostics(diagnostics) {
  return diagnostics.all.map((d) => ({
    code: d.code, severity: d.severity, message: d.message, file: d.file, line: d.line, col: d.col,
  }));
}

function inspectSnapshot(configPath) {
  const diagnostics = new Diagnostics();
  const blocked = (reason) => ({ status: 'blocked', reason, diagnostics: snapshotDiagnostics(diagnostics),
    config: path.resolve(configPath), snapshot: null, manifest: null, fingerprint: null,
    hasChanges: false, manifestChanged: false, entries: [] });
  const config = loadCompileConfig(configPath, { diagnostics, live: true });
  if (!config || diagnostics.hasErrors()) return blocked('The compile config does not load.');
  if (!config._resolvedSnapshot) return blocked('structure.input.snapshot is not set, so there is nothing to freeze.');
  const state = snapshotState(config, diagnostics);
  if (diagnostics.hasErrors()) return blocked('The snapshot manifest does not load.');
  return { status: 'ok', reason: null, diagnostics: snapshotDiagnostics(diagnostics),
    config: path.resolve(configPath), snapshot: config._resolvedSnapshot, manifest: state.manifest,
    fingerprint: state.fingerprint, hasChanges: state.hasChanges, manifestChanged: state.manifestChanged,
    entries: state.collected };
}

function syncLibrary(config, options = {}) {
  const { log = NULL_LOG, diagnostics = new Diagnostics() } = options;
  const snapshotDir = config._resolvedSnapshot;
  if (!snapshotDir) {
    throw new Error('structure.input.snapshot is not set; nothing to sync.');
  }

  const state = snapshotState(config, diagnostics);
  if (options.expectedState !== undefined && options.expectedState !== state.fingerprint) {
    const error = new Error('Snapshot inputs changed since inspection; inspect and confirm again.');
    error.staleSnapshot = true;
    throw error;
  }

  const entries = collectEntries(config);
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  const previousManifest = loadManifest(manifestPath, diagnostics);

  if (!state.hasChanges) {
    return { entries: state.entries, filesWritten: 0, manifestPath,
      changes: state.collected.map((e) => ({ ...e, changed: [] })) };
  }

  const newManifest = { manifestVersion: 2, syncedAt: new Date().toISOString(), library: {} };
  const hasTemplates = entries.some((e) => e.kind === 'template');
  if (hasTemplates) newManifest.templates = {};

  const reportLines = [];
  const changes = [];
  let filesWritten = 0;

  const collected = entries.map((entry) => {
    const inspected = state.collected.find((e) => e.kind === entry.kind && e.name === entry.name);
    return { entry, files: Object.keys(inspected.live), fileHashes: inspected.live };
  });
  const requiresRolesByName = state.roles;

  for (const { entry, files, fileHashes } of collected) {
    const prevSection = previousManifest
      ? (entry.kind === 'library' ? previousManifest.library : previousManifest.templates || {})[entry.name]
      : undefined;
    const inspected = state.collected.find((e) => e.kind === entry.kind && e.name === entry.name);
    const diff = diffEntry(entry, { files: inspected.frozen }, fileHashes);
    diff.isNew = !prevSection;
    changes.push(diff);
    reportLines.push(...diffEntryLines(entry, diff));

    const destDir = path.join(snapshotDir, entry.name);
    for (const rel of files) {
      const from = path.join(entry.sourcePath, rel);
      const to = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      filesWritten += 1;
    }

    if (fs.existsSync(destDir)) {
      const keep = new Set(files);
      for (const rel of listFilesRelative(destDir)) {
        if (!keep.has(rel)) fs.rmSync(path.join(destDir, rel));
      }
      removeEmptyDirs(destDir);
    }

    const section = { source: entry.sourcePath, files: fileHashes };
    const roleResult = entry.kind === 'library' ? requiresRolesByName.get(entry.name) : null;
    if (roleResult && roleResult.refused) {
      diagnostics.error(
        CODES.LIBRARY_ROLE_SCAN_REFUSED,
        `${entryLabel(entry)}: cannot compute requiresRoles — this set's own items do not `
        + `validate (${roleResult.refused}), so requiresRoles is omitted; fix the item content and re-run --snapshot.`,
        { file: entry.sourcePath }
      );
    } else if (roleResult && roleResult.roles) {
      section.requiresRoles = roleResult.roles;
    }
    if (entry.kind === 'library') newManifest.library[entry.name] = section;
    else newManifest.templates[entry.name] = section;

    log.verbose(`  synced ${entryLabel(entry)}: ${files.length} file(s)`);
  }

  for (const retired of state.collected.filter((e) => !entries.some(
    (entry) => entry.kind === e.kind && entry.name === e.name,
  ))) {
    // An active entry may reuse a retired entry's destination under another kind.
    if (entries.some((entry) => entry.name === retired.name)) continue;
    if (fs.existsSync(retired.snapshotPath)) fs.rmSync(retired.snapshotPath, { recursive: true });
    changes.push({ ...retired, changed: [] });
  }

  if (config._resolvedReports) {
    const reportDir = path.join(config._resolvedReports, 'snapshot');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'sync-diff.txt'), reportLines.join('\n') + '\n', 'utf8');
  }

  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2), 'utf8');

  return { entries, filesWritten, manifestPath, changes };
}

/**
 * The library freeze as a call that returns data, for a caller that is not the CLI. Reads
 * the live libraries from disk, replaces the project's frozen copy with them, and says what
 * changed. See "Freezing libraries" in the dev guide.
 */
function freezeLibraries(configPath, options = {}) {
  const diagnostics = new Diagnostics();
  const describe = () => diagnostics.all.map((d) => ({
    code: d.code, severity: d.severity, message: d.message, file: d.file, line: d.line, col: d.col,
  }));
  const blocked = (reason) => ({
    status: 'blocked', reason, diagnostics: describe(), snapshot: null, manifest: null, filesWritten: 0, entries: [],
  });

  const config = loadCompileConfig(configPath, { diagnostics, live: true });
  if (!config || diagnostics.hasErrors()) return blocked('The compile config does not load.');
  if (!config._resolvedSnapshot) return blocked('structure.input.snapshot is not set, so there is nothing to freeze.');

  let result;
  try {
    result = syncLibrary(config, { diagnostics, expectedState: options.expectedState });
  } catch (error) {
    if (!error.staleSnapshot) throw error;
    return blocked(error.message);
  }
  return {
    status: 'ok',
    reason: null,
    diagnostics: describe(),
    snapshot: config._resolvedSnapshot,
    manifest: result.manifestPath,
    filesWritten: result.filesWritten,
    entries: result.changes.map((diff) => ({
      name: diff.name,
      kind: diff.kind,
      isNew: diff.isNew,
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed.map((c) => c.rel),
    })),
  };
}

function checkDrift(config, diagnostics, log) {
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
        `${entryLabel(entry)} has no entry in ${path.basename(manifestPath)}, so it cannot be checked as frozen; regenerate the snapshot manifest.`,
        { file: manifestPath }
      );
      continue;
    }

    const liveHashes = hashTree(entry.sourcePath);
    let changedCount = 0;
    for (const rel of Object.keys(liveHashes)) {
      if (section.files[rel] !== liveHashes[rel]) changedCount += 1;
    }
    for (const rel of Object.keys(section.files)) {
      if (!(rel in liveHashes)) changedCount += 1;
    }
    if (changedCount > 0) {
      log.info(
        `${entryLabel(entry)} has ${changedCount} changed file(s) since last snapshot `
        + `(${syncedDate}). Run --snapshot to review.`
      );
    }

    const snapEntryDir = path.join(snapshotDir, entry.name);
    if (!fs.existsSync(snapEntryDir)) {
      diagnostics.warn(
        CODES.SNAPSHOT_DIR_MISSING,
        `Snapshot directory for ${entryLabel(entry)} is missing: snapshot/${entry.name}; frozen inputs are unavailable. Run --snapshot to populate it.`,
        { file: snapEntryDir }
      );
      continue;
    }
    const snapFiles = listFilesRelative(snapEntryDir);
    for (const rel of snapFiles) {
      if (!(rel in section.files)) {
        diagnostics.warn(
          CODES.SNAPSHOT_FILE_UNTRACKED,
          `${entryLabel(entry)}: snapshot/${entry.name}/${rel} has no entry in the manifest, so it is outside the freeze; remove it or regenerate the snapshot.`,
          { file: path.join(snapEntryDir, rel) }
        );
        continue;
      }
      const onDiskHash = hashFile(path.join(snapEntryDir, rel));
      if (onDiskHash !== section.files[rel]) {
        diagnostics.error(
          CODES.SNAPSHOT_HASH_MISMATCH,
          `${entryLabel(entry)}: snapshot/${entry.name}/${rel} does not match its manifest `
          + 'hash, so the snapshot is corrupted and compilation stops; restore the file or regenerate the snapshot.',
          { file: path.join(snapEntryDir, rel) }
        );
      }
    }
  }
}

module.exports = {
  syncLibrary, freezeLibraries, inspectSnapshot, checkDrift, hashTree, collectEntries, entryLabel,
};
