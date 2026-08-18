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

## Known-incorrect rows in the snapshot

**None.** Every row the snapshot now holds is a row the fixture means to raise.

**One known-incorrect *absence*, which is the harder kind to see.** The bare `import:
Anchor` def in `placement/Codex/items.cl.yaml` emits a second `Anchor` — a duplicate entry
in the `cast` slot and a second `## Anchor` story card carrying the same trigger — and the
snapshot does not move at all when that def is added or removed. `buildRegistry` skips a
bare import by design, so the registry's duplicate-id check never sees the pair, and
nothing downstream asks the question again. A snapshot cannot hold a row that was never
raised, so this one is recorded here instead: the day a duplicate check lands, the fixture
already carries the case that should trip it.

`CL0322` on `Ghost` and `Silent` was the last entry here, and was resolved by scoping the
check rather than by editing the fixture: it now fires only when a story-card target
exists, which is what §7.4 said all along. `Ghost` is specified by the `template:` on its
`plotEssential` target and `Silent` emits nothing at all, so neither is owed an `aid.type`.
Both items keep their `CL0610`, which is the ERROR that actually describes `Silent` — the
`CL0322` row was a second, weaker report of the same fact.

## What the snapshot is expected to lose and gain in Phase 4

| Step | Expected change |
|---|---|
| 1 | `CL0204` on `placeholders:` disappears — the key stops being "not yet implemented" |
| 3 | Undeclared `%ghostName%` in `Greeter` starts erroring |
| 4 | The invalid-context checks appear on Description and card `type` |
| 6 | `neverUsed` starts warning |
| 7 | `heroName` / `altName` start warning as one collapsed prompt |
