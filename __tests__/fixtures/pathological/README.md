# The pathological fixture

Six projects that are wrong on purpose, and a committed snapshot of every diagnostic they
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

## Why it is six projects

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
  project's structure, which is exactly the reasoning that kept the Phase 8 role diagnostics
  inside `placement/` rather than in a project of their own.
  It was written as a separate project instead, and that
  was not a considered exception — it is recorded here rather than silently kept. **The
  concrete cost is real**: `placement/` dispatches across three branches (`open`, `gated`,
  `silent`), so folding the pair in would have produced three `CL0622` rows in the snapshot
  and proven the check fires once per leaf across branches. `card-collision/`'s one branch
  proves only that the check fires at all. Left as its own project rather than moved, because
  moving it now would touch the fixture the phase's later steps read against; **fold it into
  `placement/` the next time that project's item set changes for an unrelated reason**, and
  delete this directory then.

  It has since also taken the `aid.type` collisions — `CL0626` (two custom types differing
  only by case, which are one file on a case-insensitive filesystem) and `CL0628` (leading
  whitespace, trimmed). They live here because they are the same mistake one level up: a card
  name collides inside a type, a type collides inside the filesystem, and both are properties
  of items at a leaf. A *custom* pair is needed for `CL0626`, because a built-in pair folds to
  one type first and can never raise it. That distinction is the reason `Widget`/`widget` are
  here rather than a `Character`/`character`, and it is the row worth checking first if this
  snapshot ever loses `CL0626`.

  **`CL0627` was retired 2026-09-01 and the snapshot lost three rows to it.** It announced
  the built-in lowercase fold, which `placement/` raised incidentally through its
  `type: Character` declaration rather than through any purpose-built item — so nothing here
  was written to exercise it and nothing needed removing when it went. The fold still
  happens; it is simply no longer reported. If this snapshot ever *regains* a `CL0627`, the
  warning has been reintroduced rather than the fixture having changed.
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

`placement/components/adventure-description.cl.yaml` carries **two** faults rather than the
usual one, and the exception is deliberate. Its first is the CL0616 pairing — an adventure
description on a branch with no opening — which is a property of the *branch*, not of the file.
Its second is `advanced:` in `metadata:` for CL0629, which is a property of the file. They do
not interact, and the alternative was a second `adventureDescription` component existing only
to hold one key, which is exactly the unjustified extra the entries above argue against. The
`tags:` beside it is not a mistake: it is there to prove the check refuses two named keys
rather than inventing a whitelist.

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
