# The Library Snapshot

`--snapshot` freezes a project's shared library — every `structure.input.library` entry, and
every out-of-base `structure.input.templates` directory — into a copy the project carries
alongside its own source. Once that copy exists, `{%name}` tokens resolve to it by default,
so the project compiles against a pinned tree instead of whatever the shared library
currently holds.

---

## Why a project would want this

**A shared library moves, and a project should not have to move with it every time.**
`structure.input.library` entries and shared components reached through `imports:` typically
point outside the project — at a shared-library directory, or house-style AI Instructions
shared across several scenarios. Left as ordinary paths, editing one of those files changes the
compiled output of every project that reaches it, the next time any of them compiles. A
snapshot lets a project keep working against the library as it was on the day it was frozen,
while the live library keeps moving for whoever is still editing it.

**The freeze is informational, not a lock.** A library file changing after the last
`--snapshot` never fails a build and never raises a diagnostic — it prints one line saying
how many files changed and when the snapshot was last synced, and the compile proceeds
against the frozen copy exactly as before. `--snapshot` is how a project pulls in the new
content, deliberately, when it is ready to.

---

## Freezing a project

```yaml surface=config
structure:
  input:
    library:
      characters: '{%loom}/_General/Characters'
      sharedComponents: '{%loom}/AI Instructions'
    templates:
      - '{%loom}/templates'      # out-of-base — frozen
      - ./templates              # in-base — not frozen; see below
    snapshot: ./snapshot
```

`structure.input.snapshot` names where the frozen copy lives, relative to `compile.yaml`.
Setting it is the only thing that turns the mechanism on; with the key unset,
every `{%name}` resolves to the live library.

```bash
codex-loom --snapshot compile.cl.yaml
```

This copies every `structure.input.library` entry, and every `structure.input.templates`
entry that resolves **outside the project base**, into `snapshot/<name>/`, raw bytes,
preserving each entry's internal directory structure. It then writes `snapshot/manifest.json`
— a `manifestVersion`, a `syncedAt` timestamp, and per entry a `source` path and a `sha256:`
hash of every file. Both `snapshot/` and its manifest are meant to be committed: a snapshot
that only ever exists in a temp directory proves nothing about whether a frozen compile
matches a live one.

**A project-relative template directory is never frozen.** `structure.input.templates` is a
list, and `--snapshot` only copies the entries that resolve outside the project's own base
directory — a local `./templates` is already version-controlled with the project, and
copying it into its own snapshot would duplicate it for no reason. Point at `{%loom}/templates`
or similar to get a shared template directory frozen; a bare `./templates` is left alone.

---

## What changes once a snapshot exists

**Every `{%name}` that names a library entry, or an out-of-base template entry, resolves
through the snapshot instead of the live source** — in `include:`, in component `imports:`
and `from:`, in item paths, everywhere a token expands. This decision happens exactly once,
at config load, so a library name cannot resolve to the snapshot in one code path and to the
live source in another; a compile is either frozen or it is not, never partially.

`--live` is the escape hatch back to the live source, for the run it is passed on:

```bash
codex-loom --compile compile.cl.yaml --live
```

`--snapshot` itself always reads live — freezing *from* the frozen copy would mean a stale
snapshot could never be refreshed.

**A snapshot with no manifest entry for a given library name falls back to the live
source**, silently — the redirection logic is not where `CL0113` (see below) is raised, so
it does not duplicate that diagnostic. This is also why adding a new library entry to an
already-frozen project does not break anything: the new entry simply reads live until the
next `--snapshot` picks it up.

---

## The drift notice

Every compile against a populated snapshot checks the live library against the manifest and,
if anything changed, prints one line:

```
Library "characters" has 3 changed file(s) since last snapshot (2026-06-02). Run --snapshot to review.
```

This never fails a build and never raises a diagnostic, by design. A
current snapshot and a stale one compile identically — that is the entire point of a
freeze — and the drift line is the only thing that tells the two apart, so treat it as
something to read, not something to silence.

**`--snapshot` writes a review artifact before it overwrites.** If a previous manifest
exists, the sync compares it against the fresh hash pass and writes a file-level change
summary — added, removed, and changed-by-hash, per entry — to
`<reports>/snapshot/sync-diff.txt`, so an author can see what a re-sync is about to pull in
before committing it.

---

## `requiresRoles` — a library entry's role contract, computed

**`manifestVersion: 2`.** Every library entry's manifest section may carry a `requiresRoles`
key: the role names a consuming project must bind for that entry's cards to compile.

```json
{
  "manifestVersion": 2,
  "syncedAt": "2026-08-22T10:22:31Z",
  "library": {
    "esudia": {
      "source": "C:/Shared/Esudia",
      "files": { "Characters/Malcolm.cl.yaml": "sha256:9f2c…" },
      "requiresRoles": ["LI"]
    }
  }
}
```

**Computed, not declared.** `--snapshot` scans the entry's own frozen files for every
`{$X}` token and checks whether `X` resolves to an item id anywhere in the snapshotted
library — its own set or another one alongside it. What resolves nowhere is published as a
required role. A `{$X}` role reference and a `{$X}` item reference share one grammar (see
[Roles](13-roles.md)), so this is elimination, the same way an ERROR for an undeclared
role at compile time is: a set with no unresolved tokens gets no `requiresRoles` key at
all, the same "omit rather than assert" rule the manifest already follows for an entry with
no `templates` section.

**A set whose own items don't validate refuses instead of publishing.** Elimination is only
trustworthy when the entry's own item content loads cleanly — a schema violation or a
broken registry build means the scan cannot tell a role from a typo any better than the
elimination it's built on, so `CL0116` fires instead of a role list for that entry. The
entry's files are still frozen; only its `requiresRoles` key is withheld until the content
is fixed and `--snapshot` runs again.

Template entries carry no role contract — only `library:` entries can be referenced by
`{$X}`.

---

## Diagnostics

| Code | Severity | Meaning |
|---|---|---|
| `CL0111` | WARN | `structure.input.snapshot` names a directory `--snapshot` never populated. |
| `CL0112` | WARN | `snapshot/manifest.json` exists but is not valid JSON, or not the expected shape. |
| `CL0113` | WARN | A library or template entry the config declares has no section in an otherwise-valid manifest. |
| `CL0114` | WARN | A file under `snapshot/<name>/` on disk has no entry in the manifest. |
| `CL0115` | ERROR | A file under `snapshot/<name>/` no longer matches its own manifest-recorded hash — hand-edited since the last `--snapshot`. |
| `CL0116` | ERROR | `--snapshot` refused to compute `requiresRoles` for a library entry because the entry's own items do not validate. |
| `CL0522` | WARN | A component reads from outside the project, and no library entry covers it — see below. |

`CL0115` is the only ERROR: a corrupted freeze, not drift, and the one condition under which
a frozen compile can no longer answer the question it exists to answer. `CL0113` and
`CL0114` are mutually exclusive per entry — a missing manifest section is checked, and
skipped, before the file-level comparison that would raise `CL0114` ever runs for that entry.

### The dependency-coverage check (`CL0522`)

A shared component reached through a plain `variables:` entry, rather than a library entry,
compiles and renders correctly today — and freezes not at all. `--snapshot` walks *declared*
library entries; it has no way to notice a file a compile happened to read through some other
path. `CL0522` closes that gap from the other direction: once a compile has actually resolved
a component — including everything a chain of `imports:` pulls in, not only a project's
top-level `components:` specs — anything that came from outside the project base without a
covering library entry is reported.

```yaml surface=config
# Fires CL0522: {%loom} is a plain variable, not a library entry.
variables:
  loom: ../../_CodexLoom
components:
  aiInstructions: ./components/wrapper.cl.yaml
# wrapper.cl.yaml: imports: [{from: '{%loom}/AI Instructions/AI Instructions.yaml'}]
```

```yaml surface=config
# Silent: the same file, reached through a library entry instead.
structure:
  input:
    library:
      sharedComponents: '{%loom}/AI Instructions'
# wrapper.cl.yaml: imports: [{from: '{%sharedComponents}/AI Instructions.yaml'}]
```

A component the project authors itself — anything that resolves inside the project base —
is never in scope for this check, however it is reached.
