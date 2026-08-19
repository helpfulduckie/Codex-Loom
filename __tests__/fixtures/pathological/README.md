# The pathological fixture

Two projects that are wrong on purpose, and a committed snapshot of every diagnostic they
raise. Added as Step 0 of Phase 4 (see `v4 Phase 4 plan` in the vault).

## Why it exists

**The three golden corpora are all correct projects, so they can go red on a byte and never
on a check.** They pin whole-output identity, which is exactly what a refactor needs and
exactly what a new diagnostic does not. No fixture names a slot that does not exist, no
declared slot is empty on any leaf, and none of them uses placeholders at all — so §7.4's
invariant table and every §12 check are invisible to them. A version of those checks that
never fires would pass the whole suite.

**This fixture is the missing third source.** Not bytes, but the diagnostic stream: code,
severity, file, message, in the order the compiler produces them.

## Why it is not a fourth golden corpus

A golden fixture freezes v3-compiled output and asserts byte identity. A project that is
wrong on purpose has no v3 baseline worth freezing — v3 would refuse it or compile it
wrongly, and either way the bytes are not the thing under test.

## Why it is two projects

**The layers abort differently (§4.3).** A schema violation is an ERROR that stops the
compile before anything is written: `reportLoadDiagnostics` throws as soon as the config is
validated. Putting a bad config in the placement project would mean the load errors fired
and every placement diagnostic silently vanished — the suite would still be red, and would
prove nothing about the checks the fixture was written for.

- `placement/` — load-clean on purpose, so the compile phase runs in full. Carries §7.4's
  placement invariants and the §12 placeholder content that is still inert.
- `schema/` — three unknown-key shapes, asserted for their hints as much as their codes.

## Editing rules

- **Author from the spec, not from the implementation.** The fixture states what *should*
  happen. Where the compiler currently disagrees, pin the disagreement and mark it, rather
  than rewriting the fixture until it matches.
- **One deliberate mistake per item**, named in a comment with the code it should raise.
- **Nothing here is an example.** Every file in both projects is wrong somewhere.
- **An item-level *schema* ERROR cannot live here at all**, and it is worth knowing why
  before trying. `reportLoadDiagnostics` throws the moment loading finishes with any ERROR,
  so a bad key or value on an item in `placement/` would abort that project's compile and
  take every placement row with it — while `schema/` never reaches item loading, because its
  config violations abort first. Both projects were checked; neither can carry one. Item
  schema violations are `schema.test.js`'s to cover, and the fixture's own scope is the
  diagnostic stream of a project that *compiles*.

## Known-incorrect rows in the snapshot

**None.** Every row the snapshot now holds is a row the fixture means to raise, and there is
no known-incorrect absence either.

**The bare `import: Anchor` absence was the last entry here, and Phase 5 Step 0 closed it.**
That def in `placement/Codex/items.cl.yaml` emitted a second `Anchor` — a duplicate entry in
the `cast` slot and a second `## Anchor` story card carrying the same trigger — while the
snapshot did not move at all when the def was added or removed, because `buildRegistry`
skips a bare import by design and nothing downstream asked the question again. `CL0325` now
asks it in `resolveBranchItems`, and the snapshot carries one row per branch on which both
defs survive dispatch. This was the fixture's only recorded absence, and the pattern it
proved is worth keeping: a snapshot cannot hold a row for a diagnostic nobody raised, so a
missing check leaves no trace and has to be written down in prose instead.

`CL0322` on `Ghost` and `Silent` was an earlier entry here, and was resolved by scoping the
check rather than by editing the fixture: it now fires only when a story-card target
exists, which is what §7.4 said all along. `Ghost` is specified by the `template:` on its
`plotEssential` target and `Silent` emits nothing at all, so neither is owed an `aid.type`.
Both items keep their `CL0610`, which is the ERROR that actually describes `Silent` — the
`CL0322` row was a second, weaker report of the same fact.

## What the snapshot is expected to lose and gain in Phase 5

| Step | Expected change |
|---|---|
| 0 | `CL0325` appears on the bare `import: Anchor`, once per branch — **landed** |
| 9 | `CL0710`–`CL0713` appear once the fixture gains over-cap and in-band content — **landed** |

Step 1's `kind:` enum (`CL0206`) is deliberately absent from that table: it is an item-level
schema ERROR, which the editing rules above explain this fixture cannot hold.

**The four limit rows come from four items and two Openings, and the Openings are the reason
this fixture exists.** `Bloated` is a card body past 2,000 characters with no placeholders in
it — the plain case, where compiled length and upload length agree. `Ledger` is a
`kind: reference` card inside the WARN band, which pins §4.8's other half: `reference` exempts
an item from the soft heuristics and from nothing the platform enforces. The two `Opening.md`
files are the case no golden project can reach:

| File | Compiled | On upload | Code |
|---|---|---|---|
| `opening-open.md` | 3,301 | 3,626 | `CL0711` |
| `opening-gated.md` | 3,501 | 4,021 | `CL0710` |

**Both are under their thresholds on compiled length and over them on upload length**, which
is exactly the failure §8.5 names and the reason Phase 5 could not precede Phase 4. A check
written against `text.length` reports nothing at all on either file. No golden project
declares a single placeholder, so without these two the expansion arithmetic ships untested
— which is what the Phase 5 plan's `## Watch` section says in prose and this says in rows.

`longPrompt` exists in `compile.cl.yaml` purely to make that arithmetic visible: at 12
characters the key expands to a 79-character `${…}`, so a handful of references move a file
across a cap. Its question text is not a mistake, and it is the fixture's only non-mistake.

**The `kind: reference` fence key is `emit-vl.test.js`'s to pin, not this fixture's.** The
snapshot holds diagnostics, and a fence key that reaches compiled output correctly raises
none. `Ledger` proves the source-to-diagnostic path; the source-to-fence path is a unit test.

Phase 4's table, kept for the shape it records: `CL0204` on `placeholders:` disappeared at
Step 1, undeclared `%ghostName%` in `Greeter` started erroring at Step 3, the invalid-context
checks appeared on Description and card `type` at Step 4, `neverUsed` started warning at
Step 6, and `heroName` / `altName` collapsed into one prompt warning at Step 7.
