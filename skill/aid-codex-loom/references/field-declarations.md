# Field Declarations Reference

**This is the primary way to render an item body.** A field is declared once in
`fields.cl.yaml`; a template is an ordered list of field and group names. `.template` and
`.partial` files remain as the escape hatch for what a field list cannot express — see
`references/templates.md`.

A field list is not a second renderer. `src/render/field-list.js` *generates* the
`.template` source each declaration is shorthand for, concatenates the stanzas, and hands
the result to the same text engine. Anything true of template output is true of field-list
output.

---

## The Three Namespaces

`fields:`, `groups:` and `templates:` live in one `fields.cl.yaml` per templates directory.

```yaml
fields:
  name:          { label: Name }
  vibe:          { label: Vibe, join: "; ", wrap: "[]" }
  appearance:    { label: Appearance, join: "; " }
  personality:   { label: Personality, render: list }
  magic:         { label: Magic, from: [magic.affinity, magic.effect], join: "; " }
  pantheon:      { label: Pantheon, render: keys, block: true }
  secret:        { label: Hidden Info, wrap: "[]", wrapLabel: true }
  landmarks:     { render: list }              # bare — no label

groups:
  core: [name, vibe, appearance, personality]

templates:
  Character: [core, magic, pantheon, secret]
```

- **`fields:`** — one entry per field, keyed by the `body:` key it reads.
- **`groups:`** — a named sub-list, expanded in place. **Groups do not nest**; a group
  named inside a group expands one level and no further.
- **`templates:`** — an ordered list of field and group names. **List order is output
  order.** Keys are normally `aid.type` names; a free-standing name is reachable through
  `render.template` (see Pattern 2 in `references/context-tiering.md`).

**A field's declaration never varies by branch.** There is exactly one `appearance`
declaration in a project. Per-branch variation is `templateFor`'s job, not the field
table's.

---

## Declaration Keys

| Key | Effect |
|---|---|
| `label` | The stanza's label. **Omit for a bare value** — no label, no colon |
| `render` | One of the seven render functions, or `bare`. Default is bare |
| `join` | Separator string. Implies `render: join` when `render` is unset. Defaults to `"; "` |
| `wrap` | Bracket pair around the value — `"[]"`, `"{}"`, or any two-character open+close |
| `wrapLabel` | Put the label *inside* the wrapper rather than outside it |
| `block` | Put the value on its own line beneath the label |
| `from` | Read a different body path, or several — `from: [magic.affinity, magic.effect]` |
| `always` | Deliberately emit blank-form labels, separators and wrappers even when every ref is absent |
| `labelWhen` | A conditional label: `{ originalAppearance: Current Appearance }` |

**`labelWhen` exists for the before-and-after case.** A single mapping entry — when the
named body key is present, the alternate label is used instead of `label`. The Institute
relabels `appearance` to `Current Appearance` when `originalAppearance` is also set, which
a static label cannot express.

### The seven render functions

`inline`, `join`, `list`, `and`, `prose`, `block`, `keys` — identical in behavior to their
template-syntax counterparts, documented in `references/templates.md`. `render: bare`
emits the raw value with no function applied.

Note that `block` is both a render function and a declaration key, and they are unrelated:
`render: block` puts each array element on its own line; `block: true` puts the value on a
line beneath its label.

---

## What a Declaration Generates

Each declaration becomes one conditional stanza. `vibe: { label: Vibe, join: "; ", wrap: "[]" }`
generates:

```
{if $body.vibe}
Vibe: [{join("; ", $body.vibe)}]
{/if}
```

**Empty values are absent by default.** An empty or whitespace-only scalar is absent, as is
an array or mapping whose members are recursively empty; mixed aggregates omit empty members.
A declaration with only absent refs emits nothing — no label, separator or wrapper.
`always: true` is the explicit blank-form exception: it deliberately preserves that
declaration's literal scaffolding, whether it uses ordinary declaration sugar or `parts:`.

**`wrap` interacts with `wrapLabel` and `block` in three shapes:**

| Declaration | Output |
|---|---|
| `{ label: X, wrap: "[]" }` | `X: [value]` |
| `{ label: X, wrap: "[]", wrapLabel: true }` | `[X: value]` |
| `{ label: X, wrap: "[]", block: true }` | `X:` newline `[value]` |

A label-less field (`label` omitted) is always wrapped whole, since there is no label to
place inside or outside.

**Whitespace is normalized after rendering** — every line trimmed, runs of spaces
collapsed, blank lines removed. A declaration only has to produce the right non-blank
lines in the right order; inter-stanza spacing is not load-bearing.

---

## Escapes Inside a List

Three entry forms let an irregular line live inside an otherwise declared list:

```yaml
templates:
  Character:
    - core
    - { include: name }            # drop in a .partial
    - { raw: "Status: active" }    # a literal fragment
    - magic
```

- **`{ include: partialName }`** — expands a `.partial` file at that position.
- **`{ raw: "…" }`** — emits a literal fragment.
- **`{ allowExtra: true }`** — opts the *whole template* out of the unread-field audit
  below. Used where a template composes its body from author-shaped sub-keys the field
  table cannot enumerate.

Both `include` and `raw` interleave freely with field and group names.

---

## Inline Overrides

**A template list entry may override the declaration inline**, which is required rather
than a convenience — some lists need a field rendered differently without a second
declaration.

```yaml
templates:
  History: [name, { field: vibe, label: Culture Vibe, render: bare }]
```

Here `vibe` renders under a different label and without the universal join, in this list
only. The shared declaration is untouched.

---

## Merging: Library Over Project

**The loader merges key-wise, later winning per entry** — not per file, and not deep.

```yaml
# library templates/fields.cl.yaml
fields:
  appearance: { label: Appearance, join: "; ", labelWhen: { originalAppearance: Current Appearance } }

# project templates/fields.cl.yaml
fields:
  appearance: { label: Face, join: "; " }
```

The project's entry **replaces** the library's entirely. `labelWhen` is gone for
`appearance` here — it is not merged in from the base. Sibling fields (`vibe`,
`personality`, …) still resolve from the library untouched.

**This is deliberate: per-entry rather than per-file.** File-level replacement would make
a project overriding one label restate all fifty. The cost is that a partial override must
restate the keys it wants to keep — a project adding `labelWhen` writes `label` and `join`
alongside it.

---

## `templateFor` — Selecting Lists Per Branch

**`templateFor` is a branch-merged map from rendering role to selection file**, one slot
per role: `base`, `notes`, and one per component (`plotEssential`, …). **An unset slot
falls back to `base`.**

```yaml
templateFor:
  base:          templates.cl.yaml
  plotEssential: pe.cl.yaml

branches:
  full:       {}
  lowContext:
    templateFor: { base: terse.cl.yaml }
```

What merges down the branch chain is the type-to-template map the files *produce*,
key-wise — the same one-level overwrite `components:` uses. A branch inherits the full
list for every type its slot file does not mention.

### The three resolution ladders

| Role | Most specific first |
|---|---|
| **Body** | a *chosen* item `render.template` → `templateFor.base` keyed on `aid.type` → `aid.type` matched against a loaded text template → verbatim |
| **Notes** | item `render.notesTemplate` → `templateFor.notes` keyed on `aid.type`, then the `render.notesTemplate` scalar in `compile.yaml` → the built-in default |
| **Component target** | a *chosen* target `template:` → `templateFor.<component>` keyed on `aid.type` → `templateFor.base` keyed on `aid.type` → `aid.type` matched against a loaded text template → verbatim |

**Rung 1 counts a template name as a choice only when it differs from `aid.type`.** The
model fills `render.template` (and a component target's `template:`) with `aid.type` for
every item naming neither, and every type has a list of its own name — so honoring that
fill would shadow every branch's `templateFor` map. A name equal to `aid.type` is treated
as absent. A name that *differs* — a cross-type name, `Character.hint`, or a free-standing
name a branch's slot file defines — still wins at rung 1.

The notes ladder needs no such guard, since nothing fills `render.notesTemplate`.

---

## The Unread-Field Audit

Having a declaration to compare against produces three checks, all WARN:

| Code | Meaning |
|---|---|
| `CL0426` | A `body:` key no declaration names — a typo, and content silently dropped from the card. WARN not ERROR because a shared library item can legitimately carry a field for another project's template |
| `CL0427` | A key declared globally but absent from this template's list — misrouted. The message names the group it lives in |
| `CL0428` | A declared field no template names — a dead declaration |

**The audit runs on resolved leaf paths**, so `from: [personality.keywords, personality.expanded]`
still flags a typo in a sub-key. Findings key on `(item id, field path)` and emit once — a
`body:` field resolves through every `variants:` and `branches:` expansion, so one mistake
would otherwise report once per leaf.

None of the three is an opinion-layer code: a field is read or it is not.

---

## Generating the Schema Tables

`--schema-tables` writes `schema-tables.md` under the resolved reports directory during a
compile, deriving the field/label tables and type-to-field membership mechanically from
`fields.cl.yaml`.

**It does not write a project's `SCHEMA.md`.** Where the generated tables disagree with a
hand-maintained schema document, the document is wrong — copy the tables across. The
authoring conventions in that document (budget targets, the card-role spectrum) stay
hand-written.
