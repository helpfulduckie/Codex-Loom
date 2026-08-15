# Card YAML Reference

Card files are YAML sequences. A single file can mix local card definitions, `import:`, and `include:` entries in any order.

---

## Complete Card Schema

```yaml
- id: Aness                       # compiler identifier; defaults to name; must be unique
  name:
    display: Aness                 # short name used in rendering and {$Aness} token
    full: Aness Rozen              # long name (or use scalar: name: Aness Rozen)
  pronouns: female                 # female | male | nonbinary | they
  aid:
    title: Aness Rozen             # AID display title (may differ from name)
    type: Character                # output folder; default template name
    triggers: [Aness, Rozen]       # trigger keywords (sequence or single string)
    encapsulate: true              # boolean
    known: true                    # boolean; controls [e] in notes
  render:
    template: Character            # .template filename (case-insensitive; defaults to aid.type)
    wrapper: none                  # none | square | curly
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
      expanded: |
        - {$Aness} love[s] magic research — {$Aness.she} instinctively leap[s]
    Magic:
      affinity: high ice-affinity
      effect: strong healing magic
  variants:
    networked:
      body:
        Physical Traits:
          other: a blue interface crystal
    Felix:
      name: {display: Felix, full: Felix Grayls}
      pronouns: male
      aid:
        title: Felix Grayls
        triggers: [Felix, Grayls]
      body:
        Physical Traits:
          gender: male
          hair: -{in a controlled bun}   # field operation: remove substring
  branches:
    felix: Felix            # apply Felix variant in felix branch
    networked: networked    # apply networked variant
    flashback: ~            # null: exclude card from flashback branch
```

---

## Top-Level Fields

| Field | Required | Notes |
|---|---|---|
| `id` | recommended | Compiler key; defaults to `name`; must be globally unique; immutable across variants |
| `name` | yes | Scalar string or `{display, full}` object |
| `pronouns` | recommended | Controls `{$she}` etc.; `female` / `male` / `nonbinary` / `they` |
| `aid` | recommended | AID metadata block |
| `render` | recommended | Template/wrapper config |
| `body` | yes | All card content — nested mappings, strings, block scalars, arrays |
| `variants` | optional | Named deltas; can be nested to any depth |
| `branches` | optional | Maps branch names to variant names for dispatch |

---

## `aid:` Block

All fields optional.

| Field | Description |
|---|---|
| `title` | AID display title. If absent, templates use `{$name}`. |
| `type` | Output folder name; default template name. `aid.type` and `render.template` default to each other. |
| `triggers` | Keyword list or single string. In templates: `{join(", ", $aid.triggers)}`. |
| `encapsulate` | Boolean. Passed through to output. |
| `known` | Boolean. Controls `[e]` annotation in notes. |

---

## `render:` Block

| Field | Description |
|---|---|
| `template` | `.template` filename without extension (case-insensitive). Defaults to `aid.type`. |
| `wrapper` | `none` (default) / `square` → `[ ]` / `curly` → `{ }`. Applied to `{wrapper}...{/wrapper}` block or entire output. |

---

## `body:` Block

Any structure: plain strings, block scalars (`|`), YAML sequences (arrays), nested mappings. Field names are case-insensitive throughout. Missing fields return empty string in templates.

**Field interpolation in body values** — reference other body fields via `{$body.X}`:
```yaml
body:
  graduation year: 1315
  background: "Graduated in {$body.graduation year}."
```

**Render functions in body values** — `{join(...)}`, `{list(...)}`, etc. work inside body field strings (resolved before pronoun pass, after field interpolation).

---

## `variants:` Block

Named deltas layered on top of the card. Can modify `name`, `pronouns`, `aid`, `render`, and any `body` field.

Variants can be nested: `sci-fi/near-future` applies `sci-fi` delta first, then `sci-fi.variants.near-future`.

The `id` field is immutable — no variant can change it.

See `field-operations.md` for `+{}`, `-{}`, `/{}/{}` syntax.

---

## `branches:` on Cards

Maps branch names (or paths) to variant names for dispatch. Forms:

| Syntax | Meaning |
|---|---|
| `branch: variantName` | Apply one variant |
| `branch: [v1, v2]` | Apply multiple variants in order |
| `branch: ~` | Exclude from this branch |
| `'*': variantName` | Wildcard baseline for all branches |
| Mapping form | `apply:` + sub-`branches:` for nested dispatch |

Wildcard applies first; explicit match stacks on top. Null excludes immediately without wildcard processing.

---

## Excluding a Card from Branches

Use null dispatch — no `only:` or `except:` keys exist in v3:

```yaml
branches:
  '*': []          # include (no variant) for all branches
  flashback: ~     # exclude from flashback

# Or: include only in one branch
branches:
  subject: base
  '*': ~
```

---

## Multiple Cards in One File

```yaml
- id: Aria
  ...

- id: Kaiden
  ...

- include: "{@main}/NPCs/Guards.yaml"

- import: Felicia
  ...
```
