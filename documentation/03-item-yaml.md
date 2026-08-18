# Item Definition Reference

Items are the atomic units of content in a Codex Loom project — a character, a location, a settings block, or any other story card. Each YAML item file is a sequence of item entries.

---

## Complete Example

```yaml
- id: Aness
  name:
    display: Aness
    full: Aness Rozen
  pronouns: female
  aid:
    type: Character
    triggers: [Aness, Rozen]
  notes: {known: true}
  render:
    template: Character
    wrapper: none
  body:
    Tagline: Journeyman Healer; Magic Researcher
    Physical Traits:
      gender: female
      age: mid 20s
      hair: black hair, braided, waist-length
      eyes: brown eyes
      build: tall, willowy build
    Personality:
      keywords:
        - inquisitive
        - polite
        - sarcastic
        - compassionate
      expanded: |
        - {$Aness} love[s] magic research — {$Aness.she} instinctively leap[s] to explore theoretical implications
        - {$Aness.her~} polite nature is a social shield; behind it is a biting sarcasm {$Aness.she} deploy[s]
    Magic:
      affinity: high ice-affinity; moderate growth-affinity
  v:
    affiliation: Zenus Institute
    role: Magic Researcher
  variants:
    networked:
      body:
        Physical Traits:
          other: a blue interface crystal implanted at the base of {$Aness.her~} skull
    freelance:
      v:
        affiliation: Independent
```

---

## Top-Level Fields

### `id`

Compiler-internal identifier. Used to look up this item in the registry, in `import:` directives, and in pronoun tokens (`{$Aness}`). Defaults to `name` if absent. Case-insensitive for matching.

Must be unique across all canon and project items — collision is an error.

```yaml
id: Aness
```

### `name`

Display name used in rendered output. Two forms:

**Scalar string** — the compiler normalizes it automatically: `display` is set to the first word, `full` is the complete string.

```yaml
name: Aness Rozen
# → display: "Aness",  full: "Aness Rozen"
# {$name} → "Aness Rozen",  {$name.display} → "Aness"
```

**Object** — explicit separate display (short) and full forms.

```yaml
name:
  display: Aness
  full: Aness Rozen
```

Templates access `{$name}` (returns `full`), `{$name.display}`, or `{$name.full}`. Use `{list($name)}` to render both values as a bullet list. The pronoun token `{$Aness}` (ID reference) also uses `display`.

### `pronouns`

Declared pronoun set for this item. Controls how `{$she}`, `{$her~}`, `{$they}` etc. resolve within this item's field values and template.

| Value | Pronouns |
|---|---|
| `female` | she / her / her / herself / she's |
| `male` | he / him / his / himself / he's |
| `nonbinary` (or `they`) | they / them / their / themselves / they're |

When this item is the active branch protagonist, pronouns resolve to the `you` set instead. See [Pronoun System](08-pronouns.md).

### `kind`

Whether this item is narrative content or reference material. `story` (the default) or `reference` — any other value is an error.

```yaml
- id: WTG Time Config
  kind: reference
  aid: {type: System, triggers: []}
  notes:
    startDate: "06/28/1320"
```

**Declare `reference` for an item that exists to be read by a script or by a person in the story-card editor, rather than by the AI.** A mod's config card is the clearest case: it is a real story card with a deliberately empty trigger list, and no render target can express that — only you know it. Swappable alternates offered to the player (a longer or shorter copy of the AI Instructions, say) are the other case.

**What `reference` exempts is the prose heuristics, and nothing else.**

| Check | Applies to `reference`? |
|---|---|
| `empty-triggers` lint | No — trigger-less is the intended state |
| Seed-map inclusion | No — it would sit permanently atop "never seeded" |
| Card-size ranking | Reported separately — it never enters context |
| Platform field caps | **Yes** |
| Unresolved-token and artifact diagnostics | **Yes** |

The rule is that soft heuristics skip reference items and hard limits apply to everything: a card over AID's field cap is malformed whatever it exists for.

**A `reference` item's compiled card carries `kind: reference` in its fence.** Velvet Lattice keeps unrecognized fence keys as metadata and never forwards them to AID, so the key changes nothing about the uploaded card — it is there so the reports, which read the compiled tree rather than your YAML, can tell which cards to treat as reference material.

**`kind:` is a property of the copy, not of the canon item.** Importing a narrative item and declaring `kind: reference` on the import makes that copy reference material and leaves the canon item alone. Variants can change it too.

---

## `aid:` Block

AID-specific metadata. All fields are optional.

```yaml
aid:
  title: The Stranger       # card name in AID; defaults to name.full
  type: Character           # item type — determines output folder and default template
  triggers: [Aness, Rozen]  # trigger keywords (sequence or single string)
```

| Field | Description |
|---|---|
| `title` | The card name AID shows. Declare it only when it should differ from `name.full` — the compiler falls back to `name.full`, then `name.display`, then `id`. A `title` that merely repeats `name.full` goes stale the moment a variant renames the character, since the title wins. |
| `type` | Output folder name. Also used as the default template name if `render.template` is absent. |
| `triggers` | Trigger keyword list. Leading and trailing spaces are written as `_` — `_Era_` is the trigger `" Era "` — because a plain padded string cannot survive the round trip into AID. An interior `_` is literal. |

### `encapsulate` and `known` are gone

Both were removed with the story-card envelope, and both are now unknown-key ERRORs rather than keys nothing reads.

`encapsulate` was never a real choice: the compiler writes `encapsulate: false` on every card, because every site in the Velvet Lattice loader defaults it to true and false is what the output needs.

`known: true` existed only so a template could write `{if $aid.known}notes: '[e]'{/if}`. The flag moves to `notes:`, where it stays a flag:

```yaml
notes: {known: true}
```

**Structured rather than the flat `notes: '[e]'` v3 emitted, and the difference matters twice.** A convention pack cannot read `[e]` back out of free text, so a flattened marker is unreadable to the thing meant to read it. And a branch that does not load the mod the marker belongs to has no way to switch a baked-in string off — swapping the notes template is the mechanism, and a template can only decide per card if the card carries a flag rather than an answer.

A scalar `notes: '[e]'` is still perfectly valid; it simply renders verbatim and cannot be varied per branch.

`src/migrate/v3.js` performs both conversions, and reports that a notes template is still needed — without one the flag is carried and never written.

`aid.type` and `render.template` default to each other — if one is set the other is filled in automatically. If neither is set, the item cannot be rendered and a warning is emitted.

String values in `aid:` (e.g. `title`, `triggers`) support `{%variable}` expansion, the same as `body:`. **`aid.type` is validated after expansion** — since it becomes a folder and filename, an illegal path segment (`< > : " / \ | ? *`, control chars, `.`/`..`, or a trailing space/period) aborts the compile.

---

## `render:` Block

Controls how this item is rendered.

```yaml
render:
  template: Character      # template filename (without .template extension)
  wrapper: none            # none | square | curly
  notesTemplate: Notes     # optional: renders notes: instead of the default rule
```

| Field | Description |
|---|---|
| `template` | Filename of the `.template` file to use (case-insensitive match). Defaults to `aid.type` if absent. |
| `wrapper` | Wraps the rendered body, or a `{wrapper}...{/wrapper}` block within it. `square` → `[ ... ]`, `curly` → `{ ... }`, `none` → raw text. The envelope is written outside the wrapper. |
| `notesTemplate` | A template that renders the `notes:` fence line from this item's `notes:` field. See below. |

String values in `render:` support `{%variable}` expansion too, so `template`/`wrapper` can be variable-driven. A variable that fails to resolve in `render.template` leaves the literal token as the template name, which surfaces as a "no template found" error (and an unexpanded-variable warning).

---

## `notes:` Field

`notes:` becomes AID's card description — the `notes:` line inside the fence. It is a top-level item field, so it is variant- and branch-addressable and field operations apply to it, exactly like `body:` or `aid:`.

```yaml
- id: Aness
  notes: {known: true}      # a flag for a template to render
- id: Kaiden
  notes: '[e]'              # or the literal text, rendered verbatim
```

`description:` is an accepted alias for the same field, for authors who think in AID's own vocabulary. The two are collapsed to `notes:` during resolution, so nothing downstream sees which spelling arrived, and a variant may write `description:` against an item that declared `notes:`. Declaring **both on one item** is ERROR `CL0323` rather than a merge: two names for one field means two values means the author believes they are two fields, and picking a winner silently would hide that.

### What reaches the fence

By default, a scalar passes through verbatim and a mapping becomes `key: value` lines. The line is omitted entirely when the rendered text is empty, so an item with no notes emits no `notes:` key.

The value always reaches AID as a **string** — the Velvet Lattice loader declares that field as `str` and assigns it straight through, so a mapping is rendered to text before it is written, never as nested YAML keys.

### Rendering notes through a template

For anything richer than a literal, a template renders the text. Which template is found by a four-rung ladder, most specific first:

| Rung | Source | Example |
|---|---|---|
| 1 | `render.notesTemplate` on the item | `notesTemplate: SpecialNotes` |
| 2 | `<body template>.notes`, if that file exists | `Character.notes.template` |
| 3 | `render.notesTemplate` in `compile.yaml`, merged down the branch chain | see [compile.yaml](02-compile-yaml.md) |
| 4 | none — the default rendering above | |

Rung 2 follows whichever template actually rendered the body, not `aid.type` or `render.template` chosen in advance, so an item that overrides its body template cannot have its notes rendered by a different family. It is the same suffixed-sibling mechanism `Character.hint` uses.

```yaml
- id: Aness
  notes:
    known: true
```

```
# Character.notes.template
{if $notes.known}[e]{/if}
```

That item needs no `notesTemplate` declaration at all — rung 2 finds the template by name. The template sees the same item context as a body template, with the item's `notes:` under `{$notes}`. `render.wrapper` is forced off while it renders: the wrapper describes the body, and a notes template without an explicit `{wrapper}` block would otherwise emit `notes: '{...}'`.

**Opting out needs no syntax.** A template that renders empty suppresses the `notes:` line entirely, so `{if $notes.known}[e]{/if}` writes nothing for an item that never set the flag.

A mapping under `notes:` merges subfield-wise across variants and canon, the same way `aid:` and `render:` do — so canon can define a base marker config that a project appends to, and a variant setting one key leaves the others alone.

---

## `body:` Block

All item content. Values can be plain strings, block scalars, YAML sequences (arrays), or nested mappings. Field names are case-insensitive throughout — the compiler and templates match them case-insensitively.

```yaml
body:
  Tagline: Journeyman Healer; Magic Researcher
  Physical Traits:
    gender: female
    age: mid 20s
    hair: black hair, braided, waist-length
  Personality:
    keywords:
      - inquisitive
      - polite
    expanded: |
      - loves research
      - biting sarcasm
  Notes: |
    Some multi-line
    block scalar content.
```

In templates, body fields are accessed as `{$body.Tagline}`, `{$body.Physical Traits.gender}`, etc.

### Field Interpolation

Within field values you can reference other fields using dotted `{$…}` syntax. These resolve before pronoun tokens.

```yaml
body:
  graduation year: 1315
  background: |
    - Graduated Primary Education in {$body.graduation year}.
```

Supported roots in item data: `{$body.X}`, `{$v.X}` (and the `var`/`vars`/`variable`/`variables` aliases), `{$aid.X}`, `{$render.X}`, and `{$name.display}`/`{$name.full}`. These resolve in `body`, `aid`, `render`, and `name` fields alike (not only `body`).

> **Dotted only.** Only dotted refs are field interpolation. Bare single-segment `{$X}` belongs to the pronoun/character-ref system (`{$she}`, `{$Aria}`) — so bare `{$id}` and bare `{$name}` are **template-only**; in item data use `{$name.full}`/`{$name.display}`. See [07-templates.md](07-templates.md) "Token Systems at a Glance".

Cross-item body references (`{$OtherId.body.FieldName}`) are also supported and resolved in a second pass after all items for a branch are compiled (in `body`, `aid`, `render`, and `name`). See [Pronoun System](08-pronouns.md).

A `{$…}` token that no pass resolves and that survives into output triggers a `WARN: unresolved token {$x} in …`.

---

## `v:` Block (Item Variables)

Arbitrary author-defined key/value data attached to this item. Use this for metadata that isn't part of the rendered content — affiliation, faction, role, status flags, or any other per-item values you want to reference in templates or override in variants.

```yaml
v:
  affiliation: Academy
  role: Researcher
  rank: 3
```

In templates, access as `{$v.affiliation}`, `{$v.role}`, etc.

**Aliases** — the following field names are all equivalent and normalize to `v` at compile time:

| Alias | Example |
|---|---|
| `v` | `v:` |
| `var` | `var:` |
| `vars` | `vars:` |
| `variable` | `variable:` |
| `variables` | `variables:` |

You can write any alias in your item YAML, in a variant delta, or in a template token — they all resolve to the same data. If multiple aliases appear as sibling top-level keys on the same item or within the same variant delta, a warning is emitted and their subfields are merged (last-writer-wins per subfield).

> **Item variables vs. compile variables.** `{$v.key}` (this block) is *per-item* data resolved through the `{$…}` field-reference system. It is a different mechanism from the `{%key}` *compile variables* declared in `compile.yaml` `variables:`, which are branch-scoped string values. The `variable`/`variables` alias above applies only to the item `v:` block, not to `{%}`. See [07-templates.md](07-templates.md) "Token Systems at a Glance" for the full comparison.

---

## `variants:` Block

Named deltas that layer changes on top of this item definition. Variants can modify any top-level item field (`name`, `pronouns`, `aid`, `render`, `v`) and any `body` field.

```yaml
variants:
  networked:
    body:
      Physical Traits:
        other: a blue interface crystal implanted at the base of {$Aness.her~} skull

  Felix:
    name:
      display: Felix
      full: Felix Grayls
    pronouns: male
    aid:
      title: Felix Grayls
      triggers: [Felix, Grayls]
    body:
      Physical Traits:
        gender: male
        hair: -{in a controlled bun}

  sci-fi:
    body:
      Magic:                       # remove field (null value)
      background: works for Helix Industries
    variants:
      near-future:
        body:
          Tagline: +{; corporate operative}
```

Variants can be nested to any depth. A slash-separated path like `sci-fi/near-future` applies the `sci-fi` delta first, then the `near-future` child.

The `id` field is immutable and cannot be changed by any variant.

See [Branch Tree & Variant Dispatch](05-branches-and-variants.md) and [Field Operations](06-field-operations.md) for how variants are applied and what operations are available.

---

## `branches:` Key (on local items)

Maps branch names to variant names for branch-specific dispatch. Separate from `variants:` — `variants:` defines the named deltas, `branches:` dispatches to them based on which branch is being compiled.

```yaml
- id: Aness
  ...
  variants:
    subject:
      body:
        Tagline: +{; Fused-Squad Subject}
  branches:
    subject: subject    # when in the "subject" branch, apply the "subject" variant
```

See [Branch Tree & Variant Dispatch](05-branches-and-variants.md) for the full syntax including wildcards and nested dispatch.

---

## Excluding an Item from Specific Branches

To exclude a local item from a branch, use a null (`~`) value in the `branches:` dispatch map. This is the v3 mechanism for branch exclusion — there are no `only:` or `except:` keys on items.

```yaml
- id: ContextItem
  branches:
    '*': base          # apply "base" variant for all branches
    flashback: ~       # null: exclude this item from the flashback branch entirely
  variants:
    base:
      body:
        ...
```

See [Branch Tree & Variant Dispatch](05-branches-and-variants.md) for the full `branches:` dispatch syntax.

---

## Item File Structure

A single `.yaml` file can contain multiple item entries as a sequence:

```yaml
- id: Aness
  name: Aness Rozen
  ...

- id: Kaiden
  name: Kaiden Ventus
  ...
```

A file can also mix local item definitions with import and include directives. All entries in a sequence are processed in order.

Items and templates are loaded recursively from their configured directories. Any `.yaml` file found is loaded.
