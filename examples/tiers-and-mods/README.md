# Tiers and Mods — a compiling example project

**The grid is context (`fullContext` / `lowContext`) crossed with mod (`modA` / `modB` /
`modLess`), nested two levels: 2 × 3 = 6 leaves.** Context is the outer axis because a
context tier reshapes every card at once — so `templateFor: { base: terse.cl.yaml }` sits
once on `lowContext` and every mod branch beneath it inherits the terser field lists. The
mod is the inner axis: each mod branch turns on the convention pack that checks its config
card, and carries a comment in `compile.cl.yaml` on installing the real script on AID. This
is the third example project that reads `examples/library/`, and it reads the `core` set
only.

```bash
node src/cli.js ./examples/tiers-and-mods --clean
```

A clean run prints six branch rows, no `ERROR` and no `WARN`.

**`output/` and `Review/` are committed, not generated-and-ignored.** They are the baseline
`__tests__/fixtures/examples.test.js` asserts against byte-for-byte, and the worked output
to read beside the source. Regenerate `.md` content and every node's `Placeholders.yaml`
through the re-baseliner, which classifies the diff before it will write:

```bash
node scripts/rebaseline.js
```

Seeding this project's baseline from an empty `output/` needs one in-place compile first —
`node src/cli.js examples/tiers-and-mods` — so `library-dependencies.json` lands;
`rebaseline.js --write` refuses to seed a first baseline on its own and says so.

`Review/` holds only the two `output.provenance.*` files — no report modes are frozen here.
`showcase` owns the set's report baseline.

---

## The two mods are stubs

Neither branch ships real script code — a worked example that hosted an old copy of someone
else's mod would owe its users maintenance of it. Each ships the one story card the mod
reads, plus an install comment.

| Mod | Pack | The stub card |
|---|---|---|
| `modA` — World Time Generator | bundled `wtg` | `WTG Time Config`, a block of literal `Key: Value` lines through a `.template` escape hatch |
| `modB` — Inner Self | project-local `./lint/inner-self.cl.yaml` | three `@`-prefixed brain cards: `kind: reference`, blank entry, `notes:` holding snake_case first-person thoughts |
| `modLess` | none | — |

---

## What it covers

| Construct | Where |
|---|---|
| `templateFor` on a branch, inherited by nested children | `lowContext` in `compile.cl.yaml` |
| A tier that omits fields — terse `Character` | `templates/terse.cl.yaml` |
| One card staying full in the tier via a free-standing name | `Zephon` (`render.template: CharacterFull`) |
| Two-level nested `branches:` (context × mod) | `compile.cl.yaml` |
| `lint.packs` on a branch node, not the project root | every `modA` / `modB` node |
| A bundled pack bound by name | `wtg` on `modA` |
| A project-local pack bound by `source:` | `innerSelf` on `modB` |
| A `.template` for mod configuration with no item-field relationship | `templates/WTGTimeConfig.template` |
| `kind: reference` — a triggers-and-notes-only card with a blank entry | the brain cards in `Codex/mods.cl.yaml` |
| `notes:` as a mapping, round-tripped by a pack's schema check | the brain cards |
| Wildcard `*` dispatch selecting one branch of an axis | `Codex/mods.cl.yaml` |

---

## Two things worth knowing

Each is commented at the site in the source.

**A tiered branch fails quietly when it fails.** If `templateFor` does not match, every card
renders at full length and nothing reports it. The cheap check is placement: a card with no
`render:` block of its own should be written *separately* under `Branches/fullContext` and
`Branches/lowContext`, because it renders differently in each. In this project `Aness` and
`Kaiden` appear once under each — the tier is live. `Zephon` appears once at the output root
instead, because `render.template: CharacterFull` makes its card identical in both tiers;
that is Pattern 2 working, not the tier failing. If *every* crew card collapsed to the root,
`terse.cl.yaml` is not being picked up.

**The `innerSelf` pack cannot check that a brain card's keys are `snake_case`.** Inner Self
wants `lower_snake_case` keys, and the pack's schema vocabulary has no way to assert a
key-name pattern over an open mapping — `CL-innerSelf/0002` checks only that every value is
a string. See `lint/inner-self.cl.yaml`.

---

## What it deliberately does not do

**No second library set, and no `structure.input.snapshot`.** The §17 multi-library surface
and the snapshot mechanism are `variants-and-fieldops`'s to show. This project stays on the
one `core` set so tiering and packs are what a reader is looking at.

**The setting is a fixed backdrop.** `Codex/world.cl.yaml` imports one location on every
leaf, present only because the shared Plot Essentials format keeps a `world` slot and warns
(`CL0614`) on an empty one. It does not vary and is not part of the grid.
