# Field Declarations

**A field is declared once, and a template is an ordered list of field names.** This is the primary way an item body is rendered. Text templates ([Templates & Partials](07-templates.md)) remain available for the handful of shapes a field list cannot express.

The three namespaces — `fields:`, `groups:` and `templates:` — live in one `fields.cl.yaml` per templates directory.

---

## The Problem This Replaces

A hand-written template set is one stanza shape repeated. Measured on the corpus this design was drawn from: fifteen `.template` files, twenty-one `.partial` files, ~125 `{include}` lines and ~112 conditional stanzas, every stanza the shape `{if $body.X}Label: {fn($body.X)}{/if}`, varying only in a label and a choice between two render functions.

Three costs followed from that, and a declaration removes all three:

- **Nothing stated what a field *was*.** Its label, its render function, its type membership and its meaning lived in four places.
- **Membership was a three-level graph** traversed by hand.
- **A field a template did not name was silently dropped, with no diagnostic.** The corpus carried eighteen such `(template, field)` pairs.

---

## Declaring a Field

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
```

**A field's declaration never varies by branch.** There is exactly one `appearance` declaration in a project; per-branch variation is [`templateFor`](#templatefor--selecting-lists-per-branch)'s job.

### Declaration keys

| Key | Effect |
|---|---|
| `label` | The stanza's label. **Omit for a bare value** — no label, no colon |
| `render` | One of the seven render functions, or `bare`. Default is bare |
| `join` | Separator string. Implies `render: join` when `render` is unset. Defaults to `"; "` |
| `wrap` | Bracket pair around the value — `"[]"`, `"{}"`, or any two-character open+close |
| `wrapLabel` | Put the label *inside* the wrapper rather than outside it |
| `block` | Put the value on its own line beneath the label |
| `from` | Read a different body path, or several — `from: [magic.affinity, magic.effect]` |
| `always` | Emit unconditionally. Without it the stanza is guarded by `{if}` on the first ref |
| `labelWhen` | A conditional label — `{ originalAppearance: Current Appearance }` |

**`labelWhen` exists for the before-and-after case.** When the named body key is present, the alternate label replaces `label`. A project that relabels `appearance` to `Current Appearance` whenever `originalAppearance` is also set cannot express that with a static label.

**The seven render functions are `inline`, `join`, `list`, `and`, `prose`, `block`, `keys`** — identical to their template-syntax counterparts, documented in [Templates & Partials](07-templates.md#render-functions). `render: bare` applies no function.

Note that `block` is both a render function and a declaration key, and they are unrelated: `render: block` puts each array element on its own line, while `block: true` puts the value on a line beneath its label.

---

## What a Declaration Generates

**A field list renders through the text engine, not around it.** `src/render/field-list.js` *generates* the `.template` source each declaration is shorthand for, concatenates the stanzas, and hands the result to `render()`. A field list and the hand-written template it replaces go through one identical code path, which is what makes byte-identity between the two a real property rather than two emitters happening to agree.

`vibe: { label: Vibe, join: "; ", wrap: "[]" }` generates:

```
{if $body.vibe}
Vibe: [{join("; ", $body.vibe)}]
{/if}
```

The `{if}` guard tests the first ref, so **a field absent from an item's `body:` emits nothing** — no empty label, no stray separator. `always: true` drops the guard.

`wrap` composes with `wrapLabel` and `block` in three shapes:

| Declaration | Output |
|---|---|
| `{ label: X, wrap: "[]" }` | `X: [value]` |
| `{ label: X, wrap: "[]", wrapLabel: true }` | `[X: value]` |
| `{ label: X, wrap: "[]", block: true }` | `X:` newline `[value]` |

A label-less field is always wrapped whole, since there is no label to place inside or outside.

**Whitespace is normalized after rendering** — every line trimmed, runs of spaces collapsed, blank lines removed. A declaration only has to produce the right non-blank lines in the right order; inter-stanza spacing is never load-bearing.

---

## Groups and Template Lists

**A group is a named sub-list** — what a partial's grouping role becomes. **A template is an ordered list of field or group names**, expanded in place, with list order equal to output order.

```yaml
groups:
  core: [name, vibe, appearance, personality]

templates:
  Character: [core, magic, pantheon, secret]
```

**Groups do not nest**, matching item `include:`. The two positions take different things, and the checker enforces it:

- **A group's members must be declared *fields*.** Naming another group there is `CL0424`, a WARN — it is not expanded, and it contributes nothing to the output.
- **A template's entries may name fields *or* groups.** This is the only position a group name resolves in.

**A `templates:` key is normally an `aid.type` name.** A free-standing name is reachable through `render.template` — see [Context Tiering](15-context-tiering.md#pattern-2--one-card-stays-full-on-a-tiered-branch).

### Inline overrides

**A list entry may override the declaration inline**, which is required rather than a convenience — some lists need a field rendered differently without a second declaration.

```yaml
templates:
  History: [name, { field: vibe, label: Culture Vibe, render: bare }]
```

`vibe` renders under a different label and without the universal join, in this list only. The shared declaration is untouched.

### Escapes inside a list

Three entry forms let an irregular line live inside an otherwise declared list:

```yaml
templates:
  Character:
    - core
    - { include: name }            # drop in a .partial
    - { raw: "Status: active" }    # a literal fragment
    - magic
```

`{ allowExtra: true }` opts the **whole template** out of the unread-field audit below — used where a template composes its body from author-shaped sub-keys the field table cannot enumerate. Both `include` and `raw` interleave freely with field and group names.

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

The project's entry **replaces** the library's entirely. `labelWhen` is gone for `appearance` here; it is not merged in from the base. Sibling fields resolve from the library untouched.

**Per-entry rather than per-file is deliberate.** File-level replacement — what `loadNamedFiles` does for templates — would make a project overriding one label restate all fifty, reintroducing through the loader the duplication this design removes. The cost is that a partial override restates the keys it wants to keep.

**The library→project axis and the root→branch axis layer at different points and compose without interacting.** The templates search path handles library→project, a static fact about the scenario; `templateFor` handles root→branch, what varies inside it. This is the fix for a divergence the old design could not avoid: overriding a partial to change one field meant adopting permanent ownership of every other field in it.

---

## `templateFor` — Selecting Lists Per Branch

**`templateFor` is a branch-merged map from rendering role to selection file**, one slot per role: `base`, `notes`, and one per component (`plotEssential`, …). **An unset slot falls back to `base`.**

```yaml
templateFor:
  base:          templates.cl.yaml
  plotEssential: pe.cl.yaml

branches:
  full:       {}
  lowContext:
    templateFor: { base: terse.cl.yaml }
```

What merges down the branch chain is the type-to-template map the files *produce*, key-wise — no new merge rule, the same one-level overwrite `components:` uses. A branch inherits the full list for every type its slot file does not mention.

A value may also be a list of files, merged left to right.

**A slot file is named by its filename, and located by searching `structure.input.templates`.** That is the same search the compiler uses for `.template` and `.partial` files, with the same rule when two directories hold the same filename: the later directory wins. Naming a file no directory on that list holds is `CL0120`, and the role is skipped.

That path is shared, so **put a project's slot files under its own templates directory**, not in a shared library one. A `terse.cl.yaml` sitting in a library directory is on the search path of every project that lists it, and each of them picks it up by name.

### The three ladders

| Role | Resolution, most specific first |
|---|---|
| **Body** | a *chosen* item `render.template` → `templateFor.base` keyed on `aid.type` → `aid.type` matched against a loaded text template → verbatim |
| **Notes** | item `render.notesTemplate` → `templateFor.notes` keyed on `aid.type`, then the `render.notesTemplate` scalar in `compile.yaml` → the default in [Item YAML](03-item-yaml.md) |
| **Component target** | a *chosen* target `template:` → `templateFor.<component>` keyed on `aid.type` → `templateFor.base` keyed on `aid.type` → `aid.type` matched against a loaded text template → verbatim |

**Rung 1 counts a template name as a choice only when it differs from `aid.type`.** `model/item.js` fills `render.template` and a component target's `template:` with `aid.type` for every card that names neither, and every type has a list of its own name — so a rung 1 that honored that fill would shadow every branch's `templateFor` map for the whole corpus. A name equal to `aid.type` is treated as absent; a name that differs — a cross-type name, `Character.hint`, or a free-standing name a branch's slot file defines — still wins at rung 1.

The notes ladder needs no such guard, since nothing fills `render.notesTemplate`.

**This supersedes the branch-level `render.notesTemplate` special case.** That existed *because* a filename suffix cannot be branch-addressed; `templateFor` generalizes it to every rendering role. [Context Tiering](15-context-tiering.md) is this mechanism with a terse field list per tier and a guard proving a terse list only shortens.

---

## The Unread-Field Audit

Having a declaration to compare against produces three checks, all WARN:

| Code | Meaning |
|---|---|
| `CL0426` | A `body:` key no declaration names — a typo, and content silently dropped from the card. WARN rather than ERROR because a shared `library:` item can legitimately carry a field for a template another project uses, and an ERROR would make shared items unshareable |
| `CL0427` | A key declared globally but absent from this template's list — misrouted. The message names the group it lives in |
| `CL0428` | A declared field no template names — a dead declaration, and what stops the field table rotting the way a hand-maintained schema document does |

**The audit runs on resolved leaf paths**, so `from: [personality.keywords, personality.expanded]` still flags a typo in a sub-key. Findings key on `(item id, field path)` and emit once — a `body:` field resolves through every `variants:` and `branches:` expansion, so one mistake would otherwise report once per leaf.

None of the three is an opinion-layer code: a field is read or it is not. See [Diagnostic Codes](11-diagnostics.md).

---

## The Schema Document Is Generated

**The field/label tables and the type-to-field membership are mechanically derivable from `fields.cl.yaml`.** `--schema-tables` writes `schema-tables.md` under the resolved reports directory during a compile that already loaded the field table.

**It does not write an external `SCHEMA.md`.** Where the generation disagrees with a committed schema document, the document is wrong — a human copies the tables across. The authoring conventions in such a document (budget targets, the card-role spectrum) stay hand-written.
