# Context Tiering Reference

**A context tier is a branch.** It carries a `templateFor` map that swaps one or more
rendering roles for a terser field list, so a low-context tier compiles the same items into
shorter cards without a parallel source tree.

Tiering adds no mechanism of its own — it reuses the branch merge, the field table, and
`templateFor` (see `references/field-declarations.md`), plus one guard proving a terse list
only shortens.

---

## Declaring a Tier

```yaml
templateFor:
  base:          templates.cl.yaml     # the full field lists, keyed by aid.type
  plotEssential: pe.cl.yaml            # a slot per component; unset falls back to base

branches:
  full:       {}                       # inherits base — the ordinary output
  lowContext:
    templateFor: { base: terse.cl.yaml }
```

**`templateFor.base` on a branch overrides the type-to-template map key by key.** The slot
file contributes a `templates:` block whose keys are `aid.type` names; those entries replace
the inherited ones for the types they name, and everything else is inherited unchanged. So
`lowContext` renders terse `Character` cards if `terse.cl.yaml` defines `Character`, and
full ones for every type it does not mention.

**A branch may tier one role and leave the rest at full detail** — a slot exists per
component (`templateFor.plotEssential`, `templateFor.notes`, …), and an unset slot falls
back to `templateFor.base`.

---

## What a Terse List May Do

**It may omit a field, or substitute a same-label sibling. It may not introduce a label the
full template lacks.**

**Omission** is the common case — a list naming `[name, appearance, personality]` drops
every other stanza.

**Substitution** uses the field table's ordinary declarations:

```yaml
templates:
  Character:       [name, appearance, personality, background]
  Character.terse: [name, appearance, backgroundBrief]
```

Here `background` (a paragraph) and `backgroundBrief` (a sentence) are **both declared in
the shared field table with `label: Background`**, and the terse list names the short one.

**A slot file's `fields:` block is ignored.** A terse list cannot name a field with no
declaration — declare the condensed variant once in the shared table.

---

## The Guard

**Enforcement is label membership, not byte identity.** Byte identity cannot check output
that shortens on purpose.

For every tier branch × leaf the compiler renders each card twice — terse list and full
list — and asserts three things:

1. Every label the terse render emits also appears in the full render (**the tier invents
   nothing**).
2. The labels it keeps are an **in-order subsequence** of the full render's (no reordering).
3. Every kept label whose stanza body differs is backed by a **declared same-label
   substitution**.

Anything else is a tier-correctness failure.

---

## Pattern 2 — Keeping One Card Full on a Tiered Branch

**A slot file's `templates:` keys are usually `aid.type` names, but one may be a
free-standing name.**

```yaml
# terse.cl.yaml
templates:
  Character:     [name, appearance, personality]   # the terse cast
  CharacterFull: [name, appearance, personality, background, relationships, prose]
```

```yaml
# the one NPC who must stay detailed even in the low-context tier
- id: Grand
  aid: { type: Character }
  render: { template: CharacterFull }
```

This works because **rung 1 of the body ladder counts a template name as a choice only when
it differs from `aid.type`**. `CharacterFull` differs, so it wins at rung 1; and because the
slot file is branch-scoped, the full list applies only where the tier is loaded.

A free-standing name is reachable only through `templateFor` — the shared field table never
sees it — and it wins from a component target too, since a Pattern-2 name is matched against
the component and base slot maps before the shared table.

---

## The Slot File Must Be Project-Local

**A tier's slot file belongs under the project's own `templates:` directory, never in a
shared library.** `templateFor` entries a shared slot file contributes would apply to every
project loading that library — a terse `Character` list meant for one scenario would
re-baseline every other scenario's compiled output.

Keep the tier definition beside the project that uses it.

---

## What the Guard Does Not Cover

**"The tier only subsets" stops being literally true once a substitution is in play** — a
substituted stanza carries a different value under the same label. The label-membership
guard permits exactly that and nothing looser.

Substitution *value* correctness — that `backgroundBrief` renders the right short sentence —
is a property of one field declaration and one item, so check it directly rather than
expecting the tier guard to catch it.
