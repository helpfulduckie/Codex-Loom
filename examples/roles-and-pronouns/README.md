# Roles and Pronouns — a compiling example project

**The grid is protagonist (`aness` / `zephon` / `wayfarer`) crossed with rival, and it is
uneven on purpose: 3 + 3 + 4 = 10 leaves.** A named protagonist cannot be cast as their own
rival, so `aness` and `zephon` each face the other two named characters plus a
placeholder-defined stranger; the placeholder player `wayfarer` faces all three named
characters plus the stranger. This is the second example project that reads
`examples/library/`, and it reads the `core` set only.

```bash
node src/cli.js ./examples/roles-and-pronouns --clean
```

A clean run prints ten branch rows, no `ERROR` and no `WARN`.

**`output/` and `Review/` are committed, not generated-and-ignored.** They are the baseline
`__tests__/fixtures/examples.test.js` asserts against byte-for-byte, and the worked output
to read beside the source. Regenerate `.md` content and every node's `Placeholders.yaml`
through the re-baseliner, which classifies the diff before it will write:

```bash
node scripts/rebaseline.js
```

Seeding this project's baseline from an empty `output/` needs one in-place compile first —
`node src/cli.js examples/roles-and-pronouns` — so `library-dependencies.json` lands;
`rebaseline.js --write` refuses to seed a first baseline on its own and says so.

`Review/` holds only the two `output.provenance.*` files — no report modes are frozen here.
`showcase` owns the set's report baseline.

---

## What it covers

| Construct | Where |
|---|---|
| `roles:` merging down the branch chain, key by key | every node in `compile.cl.yaml` |
| A role rebound at every leaf against one shared line | `rival`, in the root `opening:` |
| A role inherited unchanged from an ancestor's binding | `ally` on `aness/vs-zephon`, `zephon/vs-aness`, `wayfarer/vs-zephon`, `wayfarer/vs-kaiden` |
| A role rebound where the ancestor's default would collide | `ally` on the three `vs-kaiden` leaves and `wayfarer/vs-aness` |
| `~` unbinding an inherited role | `ally` on the three `vs-stranger` leaves |
| `{$role}` / `{$role.pronoun}` resolving in a branch `title:` | the seven `vs-<named>` leaves |
| `{$role}` resolving in an inline `opening:` string | every leaf |
| The built-in `protagonist` role turning `{$Id}` into "you" | `Codex/cast.cl.yaml`, on each protagonist's subtree |
| A placeholder-named item bound to a role | `Stranger` (`%rivalName%`) on the `vs-stranger` leaves |
| Name-vs-pronoun verb conjugation in one sentence | the root `opening:` — `{$rival} know[s]` (singular) beside `{$rival.they} want[s]` (from the set) |
| You-mode rewriting *inside* a story card body | `Story Cards/character/character.md` on `aness/` and `zephon/` |

---

## Two things worth knowing

Each is commented at the site in the source.

**The `protagonist` role is a pronoun-POV switch, not the Plot Essentials `you` slot.**
Binding `protagonist: Aness` on the `aness` subtree makes every `{$Aness}` token render "you"
in card prose — so Aness's line in `character.md` reads in second person while Zephon's and
Kaiden's in the same file stay third. The Plot Essentials `You` block is filled by the
placeholder player (`%heroName%`) on all ten leaves regardless; the two are independent.

**Every `~` removes a binding an ancestor actually made.** `ally` is bound to a default on
each protagonist node, so a leaf that writes `ally: ~` is dropping an inherited key, not
unbinding something that was never there (which would be `CL0544`). The unbind is forced by
the grid — a rival nobody knows leaves no one to bind as the ally — rather than engineered
to demonstrate the syntax.

---

## What it deliberately does not do

**No `structure.input.snapshot`, and no second library set.** The §17 multi-library surface
and the snapshot mechanism are `variants-and-fieldops`'s to show. This project stays on the
one `core` set so the roles construct is what a reader is looking at.

**The setting is a fixed backdrop.** `Codex/world.cl.yaml` imports one location on every
leaf, present only because the shared Plot Essentials format keeps a `world` slot and warns
on an empty one. It does not vary and is not part of the grid.
