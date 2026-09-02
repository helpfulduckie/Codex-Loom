# Library & Snapshot Reference

A **library** is a shared source directory outside the project — a canon character set,
house-style AI Instructions reused across scenarios. Declared under
`structure.input.library`, each entry's name becomes a `{%name}` token.

A **snapshot** freezes those entries into a committed copy the project carries alongside
its own source, so the project compiles against a pinned tree rather than whatever the
shared library currently holds.

---

## Declaring Libraries

```yaml
structure:
  input:
    library:
      characters:       '{%canon}/_General/Characters'
      sharedComponents: '{%loom}/AI Instructions'
    templates:
      - '{%loom}/templates'      # out-of-base — frozen by --snapshot
      - ./templates              # in-base — never frozen
    snapshot: ./snapshot
```

**Each library name is automatically a `{%name}` variable**, usable in `include:`, in
component `imports:` and `from:`, and in item paths.

**Reach a shared file through a library entry, not a plain variable.** A component pulled
in through an ordinary `variables:` entry compiles correctly but freezes not at all, and
raises `CL0522` once the compile resolves it. The fix is to declare the directory as a
library entry and reference `{%sharedComponents}/…` instead of `{%loom}/…`.

---

## Freezing

`structure.input.snapshot` names where the frozen copy lives, relative to `compile.yaml`.
**Setting that key is the only thing that turns the mechanism on** — unset, every `{%name}`
resolves live.

```bash
codex-loom --snapshot compile.cl.yaml
```

This copies every `library:` entry, and every `templates:` entry resolving **outside the
project base**, into `snapshot/<name>/` as raw bytes, then writes `snapshot/manifest.json`
with a `syncedAt` timestamp and a `sha256:` hash per file.

**Commit both `snapshot/` and its manifest.** A snapshot that exists only in a temp
directory proves nothing about whether a frozen compile matches a live one.

**A project-relative `./templates` is never frozen** — it is already version-controlled
with the project. Point at `{%loom}/templates` to get a shared template directory frozen.

---

## Compiling Against a Snapshot

**Once the snapshot exists, every `{%name}` resolves through it by default.** The decision
happens once, at config load, so a compile is either frozen or it is not — never partially.

| Command | Reads |
|---|---|
| `codex-loom compile.cl.yaml` | the snapshot, when one is populated |
| `codex-loom compile.cl.yaml --live` | the live library, for that run only |
| `codex-loom --snapshot compile.cl.yaml` | always live — freezing from a frozen copy could never refresh |

**A library name with no manifest entry falls back to the live source, silently.** Adding a
new library entry to an already-frozen project does not break anything; the new entry reads
live until the next `--snapshot` picks it up.

---

## The Drift Notice

Every compile against a populated snapshot checks the live library against the manifest and
prints one line if anything changed:

```
Library "characters" has 3 changed file(s) since last snapshot (2026-06-02). Run --snapshot to review.
```

**This never fails a build and never raises a diagnostic.** A current snapshot and a stale
one compile identically — that is the point of a freeze — and the drift line is the only
thing that tells them apart. Read it; don't try to silence it.

**`--snapshot` writes a review artifact before it overwrites.** When a previous manifest
exists, the sync writes a file-level change summary (added, removed, changed-by-hash, per
entry) to `<reports>/snapshot/sync-diff.txt`, so you can see what a re-sync is about to
pull in before committing it.

---

## `requiresRoles`

**Each library entry's manifest section may carry `requiresRoles`** — the role names a
consuming project must bind for that entry's cards to compile.

```json
{
  "manifestVersion": 2,
  "library": {
    "esudia": {
      "source": "C:/Shared/Esudia",
      "files": { "Characters/Malcolm.cl.yaml": "sha256:9f2c…" },
      "requiresRoles": ["LI"]
    }
  }
}
```

**Computed, not declared.** `--snapshot` scans the entry's frozen files for every `{$X}`
token and checks whether `X` resolves to an item id anywhere in the snapshotted library.
What resolves nowhere is published as a required role — the same elimination the
compile-time role check uses, since role and item references share one grammar.

**An entry whose own items don't validate refuses instead of publishing.** `CL0116` fires
in place of a role list; the files are still frozen, only the key is withheld. Template
entries carry no role contract — only `library:` entries can be referenced by `{$X}`.

---

## Diagnostics

| Code | Severity | Meaning |
|---|---|---|
| `CL0111` | WARN | `structure.input.snapshot` names a directory `--snapshot` never populated |
| `CL0112` | WARN | `manifest.json` exists but is not valid JSON, or not the expected shape |
| `CL0113` | WARN | A declared library or template entry has no section in an otherwise-valid manifest |
| `CL0114` | WARN | A file under `snapshot/<name>/` has no entry in the manifest |
| `CL0115` | **ERROR** | A snapshot file no longer matches its manifest-recorded hash — hand-edited since the last `--snapshot` |
| `CL0116` | **ERROR** | `--snapshot` refused to compute `requiresRoles` because the entry's own items do not validate |
| `CL0522` | WARN | A component reads from outside the project and no library entry covers it |

**`CL0115` is the only drift-related ERROR** — a corrupted freeze rather than drift, and
the one condition under which a frozen compile can no longer answer the question it exists
to answer. Never hand-edit files under `snapshot/`.
