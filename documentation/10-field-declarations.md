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

```yaml surface=fieldtable
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

A declaration generates the `.template` stanza it stands for:

```yaml transform=stanza-source id=stanza-vibe
vibe: { label: Vibe, join: "; ", wrap: "[]" }
```

``` expect=stanza-vibe
{if $body.vibe}
Vibe: [{join("; ", $body.vibe)}]
{/if}
```

The `{if}` guard tests the first ref, so **a field absent from an item's `body:` emits nothing** — no empty label, no stray separator. `always: true` drops the guard:

```yaml transform=stanza-source id=stanza-always
tagline: { label: Tagline, always: true }
```

``` expect=stanza-always
Tagline: {$body.tagline}
```

**A `labelWhen` entry compiles to a nested `{if}` on the label**, so the alternate label shows only when its key is present:

```yaml transform=stanza-source id=stanza-labelwhen
appearance: { label: Appearance, join: "; ", labelWhen: { originalAppearance: Current Appearance } }
```

``` expect=stanza-labelwhen
{if $body.appearance}
{if $body.originalAppearance}Current Appearance{else}Appearance{/if}: {join("; ", $body.appearance)}
{/if}
```

`wrap` composes with `wrapLabel` and `block` in three shapes:

| Declaration | Output |
|---|---|
| `{ label: X, wrap: "[]" }` | `X: [value]` |
| `{ label: X, wrap: "[]", wrapLabel: true }` | `[X: value]` |
| `{ label: X, wrap: "[]", block: true }` | `X:` newline `[value]` |

Each of the three, as a full stanza:

```yaml transform=stanza-source id=stanza-wrap-shapes
plain:   { label: Vibe, wrap: "[]" }
inside:  { label: Vibe, wrap: "[]", wrapLabel: true }
stacked: { label: Vibe, wrap: "[]", block: true }
```

``` expect=stanza-wrap-shapes
{if $body.plain}
Vibe: [{$body.plain}]
{/if}

{if $body.inside}
[Vibe: {$body.inside}]
{/if}

{if $body.stacked}
Vibe:
[{$body.stacked}]
{/if}
```

A label-less field is always wrapped whole, since there is no label to place inside or outside.

**Whitespace is normalized after rendering** — every line trimmed, runs of spaces collapsed, blank lines removed. A declaration only has to produce the right non-blank lines in the right order; inter-stanza spacing is never load-bearing.

---

## Groups and Template Lists

**A group is a named sub-list** — what a partial's grouping role becomes. **A template is an ordered list of field or group names**, expanded in place, with list order equal to output order.

```yaml surface=fieldtable
groups:
  core: [name, vibe, appearance, personality]

templates:
  Character: [core, magic, pantheon, secret]
```

**Groups do not nest**, matching item `include:`. The two positions take different things, and the checker enforces it:

- **A group's members must be declared *fields*.** Naming another group there is `CL0424`, a WARN — it is not expanded, and it contributes nothing to the output.
- **A template's entries may name fields *or* groups.** This is the only position a group name resolves in.

**A `templates:` key is normally an `aid.type` name.** A free-standing name is reachable through `render.template` — see [Keeping one card at full detail](#keeping-one-card-at-full-detail).

### Inline overrides

**A list entry may override the declaration inline**, which is required rather than a convenience — some lists need a field rendered differently without a second declaration.

```yaml surface=fieldtable
templates:
  History: [name, { field: vibe, label: Culture Vibe, render: bare }]
```

`vibe` renders under a different label and without the universal join, in this list only. The shared declaration is untouched.

### Escapes inside a list

Three entry forms let an irregular line live inside an otherwise declared list:

```yaml surface=fieldtable
templates:
  Character:
    - core
    - { include: name }            # drop in a .partial
    - { raw: "Status: active" }    # a literal fragment
    - magic
```

`{ allowExtra: true }` opts out of the unread-field audit below — used where a template composes its body from author-shaped sub-keys the field table cannot enumerate. The marker sits in one template's list, and any item that renders through that template is opted out. Both `include` and `raw` interleave freely with field and group names.

---

## Merging: Library Over Project

**The loader merges key-wise, later winning per entry** — not per file, and not deep.

```yaml surface=fieldtable
# library templates/fields.cl.yaml
fields:
  appearance: { label: Appearance, join: "; ", labelWhen: { originalAppearance: Current Appearance } }
```

```yaml surface=fieldtable
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

```yaml surface=config
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

**This supersedes the branch-level `render.notesTemplate` special case.** That existed *because* a filename suffix cannot be branch-addressed; `templateFor` generalizes it to every rendering role.

---

## Tiering — a shorter rendering per branch

**A context tier is a branch that swaps one or more rendering roles for a terser field list.** It is not a separate feature: a tier is `templateFor` on a branch node, reusing the branch merge and the field table unchanged. A scenario can ship a low-context variant of itself — the same items, shorter cards — without a parallel source tree.

```yaml surface=config
branches:
  full:       {}                        # inherits base — the ordinary output
  lowContext:
    templateFor: { base: terse.cl.yaml }
```

`terse.cl.yaml` contributes a `templates:` block keyed by `aid.type`. Its entries replace the inherited ones for the types they name; every type it does not mention keeps the full list. So `lowContext` renders terse `Character` cards if `terse.cl.yaml` defines `Character`, and everything else is unchanged.

A branch may tier one role and leave the rest at full detail — `templateFor: { plotEssential: terse-pe.cl.yaml }` shortens Plot Essentials and nothing else.

### What a terse list may and may not do

**A terse list may omit a field, or substitute a same-label sibling for it. It may not introduce a label the full list does not have.** Omission is the common case: a list naming `[name, appearance, personality]` drops every other stanza.

Substitution uses the inline-override form the field table already carries:

```yaml surface=fieldtable
templates:
  Character:       [name, appearance, personality, background]
  Character.terse: [name, appearance, backgroundBrief]
```

— where `background` (a paragraph) and `backgroundBrief` (a sentence) are both declared in the shared table with `label: Background`, and the terse list names the short one. **A slot file's own `fields:` block is ignored**, so a condensed variant is declared once in the shared table rather than per tier.

Stated as three rules, a terse list must invent no label the full list lacks, keep the labels it does keep in their original order, and change a stanza's body only where a declared same-label substitution backs it.

**Nothing checks this at compile time.** Codex Loom's own test suite holds a guard comparing a terse render against a full one, but it protects the compiler's tiering behavior, not your scenario — **a malformed terse list compiles clean and raises no diagnostic.** Check a new tier by reading the compiled output, or with `--leafReview`.

### Keeping one card at full detail

**A slot file's `templates:` keys are usually `aid.type` names, but one may be a free-standing name.** An item writing `render.template: CharacterFull` selects that list — the name differs from its `aid.type`, so it counts as a real choice and wins at rung 1 — and because the slot file is branch-scoped, the full list applies only where the tier is loaded.

```yaml surface=fieldtable
# terse.cl.yaml
templates:
  Character:     [name, appearance, personality]
  CharacterFull: [name, appearance, personality, background, relationships, prose]
```

```yaml surface=item
# the one NPC who stays detailed even in the low-context tier
- id: Grand
  aid: { type: Character }
  render: { template: CharacterFull }
```

That is how a terse cast keeps its one important NPC without a per-item flag. The free-standing name is reachable only through `templateFor` — the shared field table never sees it — and it wins from a component target too, since such a name is matched against the component and base slot maps before the shared table.

---

## The Unread-Field Audit

Having a declaration to compare against produces three checks, all WARN:

| Code | Meaning |
|---|---|
| `CL0426` | A `body:` key no declaration names — a typo, and content silently dropped from the card. WARN rather than ERROR because a shared `library:` item can legitimately carry a field for a template another project uses, and an ERROR would make shared items unshareable |
| `CL0427` | A key declared globally but read by none of the item's renders — misrouted. The message names the group it lives in |
| `CL0428` | A declared field no template names, directly, through a group, or inside a partial a template includes — a dead declaration, and what stops the field table rotting the way a hand-maintained schema document does |

**The check is per item, not per template.** An item can render through more than one field list on a branch — its story card, a Plot Essentials roster slot, a shorter context tier — and a key read by *any* of them is read. `CL0426`/`CL0427` test a `body:` key against the union of every list the item resolves to, so a field in the full `Character` template but absent from the roster's line is not a misroute on the roster render. A key read only through a `templateFor` slot file (a tier, or a component rendering role) is never a `CL0427` — those lists omit declared fields by design.

**On an imported item, only the consuming project's own keys are checked.** A `body:` key that came through `import:` unchanged is the library author's concern; `CL0426`/`CL0427` fire only on keys the consuming project introduced or gave a new value to. A library item can carry fields for consumers who want them without nagging one that renders a subset.

**The audit runs on resolved leaf paths**, so `from: [personality.keywords, personality.expanded]` still flags a typo in a sub-key. Findings key on `(item id, field path)` and emit once — a `body:` field resolves through every `variants:` and `branches:` expansion, so one mistake would otherwise report once per leaf.

None of the three is an opinion-layer code: a field is read or it is not. See [Diagnostic Codes](11-diagnostics.md).

---

## The Schema Document Is Generated

**The field/label tables and the type-to-field membership are mechanically derivable from `fields.cl.yaml`.** `--schema-tables` writes `schema-tables.md` under the resolved reports directory during a compile that already loaded the field table.

**It does not write an external `SCHEMA.md`.** Where the generation disagrees with a committed schema document, the document is wrong — a human copies the tables across. The authoring conventions in such a document (budget targets, the card-role spectrum) stay hand-written.
