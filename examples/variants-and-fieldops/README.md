# Variants and Field Operations — a compiling example project

**The grid is setting (`medieval` / `sciFi` / `modern`) crossed with tone (`magical` /
`mundane`), six leaves.** The tone axis is a layer over the whole cast, not a dispatch that
picks different items: every character gains a Magic field on a `magical` leaf and loses it
on a `mundane` one. This is the first example project that reads `examples/library/`.

```bash
node src/cli.js ./examples/variants-and-fieldops --clean
```

A clean run prints six branch rows, no `ERROR` and no `WARN`.

**`output/` and `Review/` are committed, not generated-and-ignored.** They are the baseline
`__tests__/fixtures/examples.test.js` asserts against byte-for-byte, and the worked output
to read beside the source. Regenerate `.md` content through the re-baseliner, which
classifies the diff before it will write:

```bash
node scripts/rebaseline.js
```

`Review/` holds only the two `output.provenance.*` files — no report modes are frozen here.
`showcase` owns the set's report baseline.

---

## What it covers

| Construct | Where |
|---|---|
| Reading `examples/library/` over the relative climb | `compile.cl.yaml` |
| §17 qualified reference + rename-on-import (`core:magic`, `blood-magic`) | `Codex/world.cl.yaml` |
| Two `+{}` chains composing on one field, from different variants | `Aness` in `Codex/cast.cl.yaml` |
| A `/{old}/{new}` swap as a tone delta | `Zephon`'s `mundane` (library variant) |
| Wildcard `*` dispatch factoring the uniform axis | every cast import's `branches:` |
| `apply:` at the setting level where each delta differs | `Aness` in `Codex/cast.cl.yaml` |
| `_: ~` — present on one branch, excluded everywhere else | the three settings in `Codex/world.cl.yaml` |
| Name-vs-pronoun verb conjugation in one sentence | `Zephon`'s `expanded` (from the library) |
| A `role` delta that swaps per tone, driving the cast roster | `Zephon` (`Archivist` / `Courier`) |

---

## Two things worth knowing

Each is commented at the site in the source.

**The wildcard factors the axis that is uniform across leaves; the other axis is
enumerated.** Tone (`magical` / `mundane`) is identical under every setting, so an item that
only rides it dispatches with a single `'*': { branches: { magical: …, mundane: … } }` line.
The setting axis has to name its three branches because each one's `apply:` list is
different — `medievalFlavor` is not `sciFiFlavor`. `Aness` shows both; `Zephon` and `Kaiden`
show the tone-only one-liner.

**Every rendered body leads with the item's own name.** The library's field table carries
three partials for the shapes a field list cannot express: `cardName` (`{$aid.title} -
{tagline}`) on story cards and the World block, `rosterLine` (`{$aid.title} - {role};
{gender}; {age}; {hair}`) for the one-line cast roster, and `youLine` (`You:
{$name.display}`) for the player. The Story Card *title* is invisible to the AI
storyteller, so the name has to be a rendered line.

---

## What it deliberately does not do

**No `structure.input.snapshot`.** `--snapshot` freezes every declared library entry at
once — there is no way to pin `grimwood/` and leave `core/` live — and the manifest it
writes carries an absolute `source:` path and a wall-clock `syncedAt`, neither of which
belongs in a committed baseline. The snapshot mechanism is exercised by
`__tests__/integration/snapshot.integration.test.js` and documented in
`documentation/12-snapshot.md`.
