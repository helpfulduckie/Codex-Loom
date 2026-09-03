# Showcase — a compiling example project

**Every construct here is copied from `documentation/` or `skill/aid-codex-loom/`.** The
project exists so those snippets are executable rather than merely plausible: if a doc
example is wrong, this project stops compiling cleanly.

```bash
node src/cli.js ./examples/showcase --clean
```

A clean run prints three branch rows, no `ERROR` and no `WARN`. Anything else is a
regression — either in the compiler or in a documentation snippet this project copies.

Every report mode also runs against it. Each post-hoc mode needs its own flag, and
`--clean` clears `output/` but never `Review/` — so a partial invocation leaves stale
report directories behind rather than removing them:

```bash
node src/cli.js --lint ./examples/showcase
node src/cli.js ./examples/showcase --with-inventory --schema-tables
node src/cli.js ./examples/showcase -l -o -s -b
```

**`output/` and `Review/` are committed, not generated-and-ignored.** They are the
baseline `__tests__/fixtures/examples.test.js` asserts against byte-for-byte, and the
worked output to read beside the source that produced it. Regenerate both through the
re-baseliner, which classifies the diff before it will write anything:

```bash
node scripts/rebaseline.js
```

That is a dry run. Add `--write` once the reported diff is the one you intended, widening
the allowed shape explicitly (`--allow body`) rather than by default — v4 spec §14.3.
`--write` regenerates the `.md` tree and every node's `Placeholders.yaml`; it will not
seed a *first* baseline (it never writes `library-dependencies.json`), so a brand-new
project needs one in-place `node src/cli.js examples/showcase` first, then the re-baseliner.

---

## What it covers

| Construct | Where |
|---|---|
| `structure.input.library`, `{%name}` tokens | `compile.cl.yaml`, `library/main/` |
| `roles:` with per-branch rebinding and `~` unbinding | `compile.cl.yaml` |
| Player placeholders, including a nested `%liName%` reference | `compile.cl.yaml` |
| `templateFor` and a `lowContext` context tier | `compile.cl.yaml`, `templates/terse.cl.yaml` |
| `storyCardType`, `render.notesTemplate`, `lint.packs` | `compile.cl.yaml` |
| Field declarations — every declaration key, groups, inline overrides | `templates/fields.cl.yaml` |
| Pattern 2 (one card stays full on a tiered branch) | `Voss`, `templates/terse.cl.yaml` |
| Variants, branch dispatch, `~` exclusion | `Codex/characters.cl.yaml` |
| Field operations `+{}` and `-{}` | `Felicia`'s `Felix` variant |
| `import:` / `include:`, `importVariants:`, explicit-import-wins | `Codex/places.cl.yaml` |
| Component sections, slots, per-section variants, `render.storyCards` | `components/` |
| `meta:` for a convention pack, `kind: reference` | `Mentor`, `Kaiden`, `Guild` |
| A `.template` escape hatch | `templates/Notes.template` |

---

## Three behaviors worth knowing

Each is commented at the site in the source.

**A declaration key must match its body key's case.** The renderer matches body fields
case-insensitively, so declaring `background` against a `Background:` body key renders
correctly — but `CL0426`'s audit compares exactly, and warns that the content is "dropped
from the compiled card" when it demonstrably is not. Name the declaration exactly as the
body key until that audit is fixed.

**An inline prose `opening:` resolves `{$role}` and `{$Item}` tokens** — the same token
pass a `sections:` opening runs. The `knight` branch's opening references `{$rival}`
(bound to `Voss` at the project root) alongside a placeholder and a compile variable. A
`{$token}` matching nothing still leaks to `CL0430`; an unresolved `{%var}` in the spec is
still `CL0634`.

**A `render.storyCards` entry's `variant:` applies on every branch**, not only where the
section's own `branches:` dispatches it — this is the documented behavior, not a defect.
An alternate selecting a variant whose text references a role will pull that role onto
branches that unbind it, so gate the role or leave the alternate on the shipped version.

---

## Verifying the tier is live

**A tiered branch fails quietly when it fails.** If `templateFor` does not match, every
card simply renders at full length and nothing reports it.

The cheap check is placement: a card with no `render:` block of its own should be written
separately under `Branches/knight` and `Branches/lowContext`, because it renders
differently in each. If it appears once at the output root instead, the tier is not
applying and every `lowContext` card is silently full-length.
