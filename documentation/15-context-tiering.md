# Context Tiering

A context tier is a branch. It carries a `templateFor` map that swaps one or more of a
project's rendering roles for a terser field list, so a low-context tier of a scenario
compiles the same items into shorter cards without a parallel source tree. Tiering reuses
the branch merge, the field table, and `templateFor` — it adds no mechanism of its own
beyond a guard that proves a terse list only shortens.

---

## Declaring a tier

```yaml
templateFor:
  base:          templates.cl.yaml     # the full field lists, keyed by aid.type
  plotEssential: pe.cl.yaml            # a slot per component; unset falls back to base

branches:
  full:       {}                       # inherits base — the ordinary output
  lowContext:
    templateFor: { base: terse.cl.yaml }
```

**`templateFor.base` on a branch overrides the type-to-template map, key by key.** The
slot file `terse.cl.yaml` contributes a `templates:` block whose keys are `aid.type`
names; those entries replace the inherited ones for the types they name and the rest are
inherited unchanged. So `lowContext` renders terse `Character` cards if `terse.cl.yaml`
defines `Character`, and inherits the full list for every type it does not mention. This is
the one-level key-wise overwrite the branch model uses everywhere — no new merge rule.

**A slot exists per component** (`templateFor.plotEssential`, `templateFor.notes`, …). An
unset slot falls back to `templateFor.base`. A branch may tier one role and leave the rest
at full detail.

---

## What a terse list may and may not do

**A terse list may omit a field, or substitute it for a same-label sibling. It may not
introduce a label the full template does not have.** Omission is the common case: a
`Character.terse` list that names `[name, appearance, personality]` drops every other
stanza. Substitution is the inline-override form the field table already carries —

```yaml
templates:
  Character:       [name, appearance, personality, background]
  Character.terse: [name, appearance, backgroundBrief]   # backgroundBrief: label "Background"
```

— where `background` (a paragraph) and `backgroundBrief` (a sentence) are both declared in
the shared field table with `label: Background`, and the terse list names the short one. A
terse list still cannot name a field with no declaration: a slot file's `fields:` block is
ignored, so a condensed variant is declared once in the shared table.

Stated as three rules, a terse list must: invent no label the full list does not have, keep
the labels it does keep in their original order, and change a stanza's body only where a
declared same-label substitution backs it.

**Nothing checks this at compile time.** Codex Loom's own test suite holds a guard that
compares a terse render against a full one, but it protects the compiler's tiering behavior,
not your scenario — **a malformed terse list compiles clean and raises no diagnostic.**
Check a new tier by reading the compiled output, or with `--leafReview`.

---

## Pattern 2 — one card stays full on a tiered branch

**A slot file's `templates:` keys are usually `aid.type` names, but one may be a
free-standing name.** An item that writes `render.template: CharacterFull` selects that
list; because the name differs from its `aid.type` it counts as a real choice and wins at
rung 1 of the body ladder, and because the slot file is branch-scoped the full list
applies only where the tier is loaded.

```yaml
# terse.cl.yaml
templates:
  Character:     [name, appearance, personality]   # the terse cast
  CharacterFull: [name, appearance, personality, background, relationships, prose]

# the one NPC who must stay detailed even in the low-context tier
- id: Grand
  aid: { type: Character }
  render: { template: CharacterFull }
```

This is how a terse cast keeps its one important NPC at full detail without a per-item
flag. The free-standing name is reachable only through `templateFor` — the shared field
table never sees it — and it wins from a component target too, since a Pattern-2 name is
matched against the component and base slot maps before the shared table.

**Rung 1 counts a template name as a choice only when it differs from `aid.type`.** The
model fills `render.template` (and a component target's `template:`) with `aid.type` for
every card that names neither, and every type has a shared-table list of its own name — so
a rung 1 that honored that fill would shadow every branch's `templateFor` map. A name equal
to `aid.type` is treated as absent, and the tier's `templateFor` rung takes effect. The
notes ladder needs no such guard, since nothing fills `render.notesTemplate`.

---

## The slot file must be project-local

**A tier's slot file (`terse.cl.yaml`) belongs under the project's own `templates:`
directory, not in a shared library.** `templateFor` entries a shared slot file contributes
would apply to every project that loads that library — a terse `Character` list meant for
one scenario would re-baseline every other scenario's compiled output. Keep the tier
definition beside the project that uses it.

---

## Cost and scope

**"The tier only subsets" stops being literally true once a substitution is in play** — a
substituted stanza carries a different value under the same label. The label-membership
guard is written to permit exactly that and nothing looser. Substitution *value*
correctness (that `backgroundBrief` renders the right short sentence) is a property of one
field declaration and one item, so it is covered by a dedicated unit test rather than the
corpus guard.
