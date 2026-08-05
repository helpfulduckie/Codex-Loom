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
    title: Aness Rozen
    type: Character
    triggers: [Aness, Rozen]
    known: true
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

---

## `aid:` Block

AID-specific metadata. All fields are optional.

```yaml
aid:
  title: Aness Rozen        # display title in AID (can differ from name)
  type: Character           # item type — determines output folder and default template
  triggers: [Aness, Rozen]  # trigger keywords (sequence or single string)
  encapsulate: true         # boolean; passed through to output
  known: true               # boolean; controls [e] in notes
```

| Field | Description |
|---|---|
| `title` | The title shown in AID. If absent, the template typically uses `{$name}` instead. |
| `type` | Output folder name. Also used as the default template name if `render.template` is absent. |
| `triggers` | Trigger keyword list. In the template, accessed as `{$aid.triggers}` or `{join(", ", $aid.triggers)}`. |
| `encapsulate` | Boolean. Passed through to the rendered output. |
| `known` | Boolean. Typically used to control `[e]` annotation in the AID notes field. |

`aid.type` and `render.template` default to each other — if one is set the other is filled in automatically. If neither is set, the item cannot be rendered and a warning is emitted.

String values in `aid:` (e.g. `title`, `triggers`) support `{%variable}` expansion, the same as `body:`. **`aid.type` is validated after expansion** — since it becomes a folder and filename, an illegal path segment (`< > : " / \ | ? *`, control chars, `.`/`..`, or a trailing space/period) aborts the compile.

---

## `render:` Block

Controls how this item is rendered.

```yaml
render:
  template: Character    # template filename (without .template extension)
  wrapper: none          # none | square | curly
```

| Field | Description |
|---|---|
| `template` | Filename of the `.template` file to use (case-insensitive match). Defaults to `aid.type` if absent. |
| `wrapper` | Wraps the entire rendered output or a `{wrapper}...{/wrapper}` block. `square` → `[ ... ]`, `curly` → `{ ... }`, `none` → raw text. |

String values in `render:` support `{%variable}` expansion too, so `template`/`wrapper` can be variable-driven. A variable that fails to resolve in `render.template` leaves the literal token as the template name, which surfaces as a "no template found" error (and an unexpanded-variable warning).

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
