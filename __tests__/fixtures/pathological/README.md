# The pathological fixture

Five projects that are wrong on purpose, and a committed snapshot of every diagnostic they
raise. Added as Step 0 of Phase 4 (see `v4 Phase 4 plan` in the vault); grown one project
at a time as later phases added checks the golden corpora cannot exercise.

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

## Why it is five projects

**The layers abort differently (§4.3), and Phase 7 added a second axis that aborts the
same way.** A schema violation is an ERROR that stops the compile before anything is
written: `reportLoadDiagnostics` throws as soon as the config is validated. Putting a bad
config in the placement project would mean the load errors fired and every placement
diagnostic silently vanished — the suite would still be red, and would prove nothing about
the checks the fixture was written for. `checkDrift` (Phase 7) runs at the same point in
`compileRun`, before that same throw, so its one ERROR code (`CL0115`) aborts a compile
exactly like a schema violation does — which is why `snapshot-corrupt/` is its own project
rather than a fourth mistake folded into `snapshot-mismatch/`.

- `card-collision/` — a single project, single branch, two items sharing a displayed card
  name across `aid.type` values, for `CL0622` (Phase 10 Step 3). **This should have been two
  items added to `placement/Codex/items.cl.yaml`, per the precedent Phase 8 already set for
  role diagnostics**: a card-name collision is a property of two items at a leaf, not of a
  project's structure, which is exactly the reasoning the role-diagnostics entry below gives
  for staying out of a fifth project. It was written as a separate project instead, and that
  was not a considered exception — it is recorded here rather than silently kept. **The
  concrete cost is real**: `placement/` dispatches across three branches (`open`, `gated`,
  `silent`), so folding the pair in would have produced three `CL0622` rows in the snapshot
  and proven the check fires once per leaf across branches. `card-collision/`'s one branch
  proves only that the check fires at all. Left as its own project rather than moved, because
  moving it now would touch the fixture the phase's later steps read against; **fold it into
  `placement/` the next time that project's item set changes for an unrelated reason**, and
  delete this directory then.

  It has since also taken the `aid.type` collisions — `CL0626` (two custom types differing
  only by case, which are one file on a case-insensitive filesystem), `CL0627` (a built-in
  category named in non-lowercase form, folded) and `CL0628` (leading whitespace, trimmed).
  They live here because they are the same mistake one level up: a card name collides inside
  a type, a type collides inside the filesystem, and both are properties of items at a leaf.
  `CL0627` needed no new item — `placement/` already declares `type: Character` and raises it
  incidentally — but a *custom* pair does, because a built-in pair folds to one type and can
  never raise `CL0626`. That distinction is the reason `Widget`/`widget` are here rather than
  a second `Character`/`character`, and it is the row worth checking first if this snapshot
  ever loses `CL0626`.
- `placement/` — load-clean on purpose, so the compile phase runs in full. Carries §7.4's
  placement invariants and the §12 placeholder content that is still inert.
- `schema/` — three unknown-key shapes, asserted for their hints as much as their codes.
- `snapshot-mismatch/` — load-clean, like `placement/`: a committed `snapshot/manifest.json`
  that disagrees with the config (`CL0113`, a declared library entry with no manifest
  section) and with the disk (`CL0114`, a frozen file the manifest never recorded).
- `snapshot-corrupt/` — a frozen file hand-edited since the manifest was written. `CL0115`
  is the one snapshot code that is an ERROR, so — like `schema/` — this project aborts
  before anything downstream runs.
- `unread-fields/` — load-clean, like `placement/`: a field table plus items routed to
  templates that do not read every `body:` key they carry, for `CL0426`/`CL0427`/`CL0428`
  (Phase 12 Step 4, §13.6). Two branches so each item resolves twice and the
  `(item id, field path)` dedupe is exercised. **This has the same shape as
  `card-collision/` and the same argument against a separate project** — the mistakes are
  properties of items at a leaf, not of a project's structure, so they could fold into
  `placement/`. Kept separate for the same reason `card-collision/` was: `placement/` has
  no field table and adding one would perturb a fixture the earlier phases read against.
  Fold both in the next time `placement/`'s item set changes for an unrelated reason.

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

## Why `placement/` has a third leaf that raises almost nothing new

**The `silent` branch exists for one row — `CL0616` — and pays for it with twenty-nine
repeats of the per-leaf checks.** §7.7's guard fires on a leaf that carries an adventure
description and declares no opening, and neither `open` nor `gated` could host it: both
declare openings that the §8.5 cap rows depend on, so removing one to make room would trade
a cap case for a description case. The items in `placement/Codex/` are branch-unrestricted,
so any third leaf re-raises every placement and placeholder ERROR they already produce.

**That repetition is a cost, not a feature, and it is worth knowing before reading a diff.**
A future row added to any per-leaf check will now appear three times rather than twice. The
duplication does prove one thing worth having — that each report names the branch it belongs
to — but that is a side effect. If the fixture ever grows a fourth leaf for a fourth reason,
branch-scoping the item set is the change to make first.

## Known-incorrect rows in the snapshot

**The fifteen `CL0321` rows naming items in `canon/lore.cl.yaml` and `canon/rumors.cl.yaml`
are wrong, and Phase 6 Step 0 deletes them.** Ten come from the `importVariants:` include,
which resolves on both branches; five from the `branches:` include, which dispatches only on
`gated`. Both include directives in
`placement/Codex/items.cl.yaml` are in §7.6.2a's arity-N cell — an `include:` stamps its
`importVariants:` and its `branches:` onto every item in the file it names — so an item that
does not define the name is the ordinary case and is owed silence, not a warning. The
compiler currently applies the arity-1 rule at that position and warns once per item per
selector per branch. The fixture is authored from the spec, so it pins the disagreement
rather than being written around it.

**What replaces them is two `CL0326` rows**, one per include directive, naming the
misspelled selector (`wrm`, `hshed`) that matched none of the three items. That check is
the whole of what keeps arity-N silence safe: without it a misspelled fanned-out name
applies to nothing, changes no output, and says nothing at all.

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

## What the snapshot gains in Phase 8

**Step 4 adds `RoleTester` to `placement/Codex/items.cl.yaml`**, and `roles:` to
`placement/compile.cl.yaml`, per §9.3's four role ERRORs and §6.4's unused-role WARN.
Unlike Phase 7's snapshot states, a role diagnostic is a property of an item and a
branch rather than of a whole project's library wiring, so `placement/` carries them as
rows rather than needing a fifth project — the same reasoning the fixture already used
for the field-cap items.

`RoleTester` carries no render target, the same shape as `Bloated`/`Ledger`/`Verbose`/
`Chatty` — it exists only to give the role checks something to fire on, not to exercise
§7.4 placement. `roles:` is declared at the project root, so all three branches inherit
it and `RoleTester`'s four tokens fire once per leaf, the same tripling cost already
named above for root-unrestricted content. `{$Anchor}` resolves as an ordinary item
reference once its `CL0541` collision is reported — "Anchor" is a real item id — so it
raises no `CL0430`; `{$Missing}`, `{$Loop}` and `{$Undeclared}` each raise their specific
role code *and* `CL0540`, because none of them ends up resolving to anything by the time
the generic unknown-token check runs. That double report is `resolveRole` returning
`null` on every failure path, same as the `CL0602`-style two-reports trade already
settled for `CL0430` itself (§9.3, Phase 8 Session A). `LI` is declared and never
referenced by any token in the project, so it draws one whole-compile `CL0545` — as does
every other declared role here, since none of the four is ever referenced successfully.

## What the snapshot gains in Phase 6

**Step 4 adds a third field cap: `notes:`, capped at 10,000 characters and measured the same
way as the other two** — `Verbose` and `Chatty`, both in `Codex/items.cl.yaml`, carry the
`notes:` case the way `Bloated`/`Ledger` carry the card-body case and the two Openings carry
theirs. Both are under 10,000 compiled and diverge only after `%longPrompt%` substitution,
which is the case the other two field caps exist to test and this one needed of its own:

| Item | Compiled | On upload | Code |
|---|---|---|---|
| `Verbose` | 9,466 | 10,051 | `CL0714` |
| `Chatty` | 8,864 | 9,189 | `CL0715` |

Both items are branch-unrestricted like the rest of `Codex/`, so each row appears once per
leaf — three times in the snapshot, per the `silent`-branch cost the README already names
above.

**The `kind: reference` fence key is `emit-vl.test.js`'s to pin, not this fixture's.** The
snapshot holds diagnostics, and a fence key that reaches compiled output correctly raises
none. `Ledger` proves the source-to-diagnostic path; the source-to-fence path is a unit test.

Phase 4's table, kept for the shape it records: `CL0204` on `placeholders:` disappeared at
Step 1, undeclared `%ghostName%` in `Greeter` started erroring at Step 3, the invalid-context
checks appeared on Description and card `type` at Step 4, `neverUsed` started warning at
Step 6, and `heroName` / `altName` collapsed into one prompt warning at Step 7.
