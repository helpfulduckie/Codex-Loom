# Story Card YAML Reference

Cards are the core content units in Codex Loom — characters, locations, factions, settings, or anything else you model as an AID story card. Card definitions live in `.yaml` files under your `cards/` or `canon/` folder. A single file can contain one card or a list of cards.

---

## Card definition fields

| Field | Required | Notes |
|---|---|---|
| `id` | No | Compiler identifier. Defaults to `name` if absent. Must be unique across all canon and project cards. Case-insensitive for matching. |
| `name` | Yes (or `id`) | Display name used in rendered output. |
| `type` | Yes* | Output folder name. Determines what AID sees as the card type (e.g. `Character`, `Location`). Also the default template name if `template:` is absent. |
| `template` | No | Template filename without `.template`. Falls back to `type`. Case-insensitive. |
| `pronouns` | No | `female`, `male`, or `they`. Compiler directive — does not appear in output. Controls braced `{$she}` token resolution. |
| `protagonist` | No | ID of the character this card is written around. Activates bare `$` marker resolution. |
| `encapsulate` | No | Boolean. Passed through to output. |
| `known` | No | Boolean. Controls `[e]` in notes and `\]` at end of entry. |
| `triggers` | No | Plain string; inserted as-is into the trigger line of the template. |
| `fields` | No | All card content. Values may be strings, block scalars, arrays, or nested mappings. |
| `variants` | No | Named child variants that layer changes on top of this card. |

*`type` is inherited from a canonical definition on import and does not need to be restated unless overriding.

---

## Minimal card

```yaml
- id: Aness
  name: Aness Rozen
  type: Character
  triggers: Aness, Rozen
  fields:
    Tagline: Journeyman Healer; Magic Researcher
```

---

## Full example card

```yaml
- id: Aness
  name: Aness Rozen
  type: Character
  template: Character
  encapsulate: true
  known: true
  pronouns: female
  protagonist: Aness
  triggers: Aness, Rozen
  fields:
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
        - $Aness love[s] magic research — $she instinctively leap[s] to explore theoretical implications
        - $Her~ polite nature is a social shield; behind it is a biting sarcasm $she deploy[s] when frustrated
    Magic:
      affinity: high ice-affinity; moderate growth-affinity
```

---

## The `fields` mapping

`fields:` holds all the card's content. The compiler does not enforce any particular structure — it depends entirely on what your template expects.

### Plain string

```yaml
fields:
  Tagline: Journeyman Healer; Magic Researcher
```

### Block scalar (multiline)

```yaml
fields:
  Background: |
    - Assigned to the Zenus subproject against her will.
    - Former student of the Royal Academy, class of 1315.
```

### Nested mapping (subfields)

```yaml
fields:
  Physical Traits:
    gender: female
    age: mid 20s
    hair: black hair, braided
```

Subfield keys are case-insensitive when referenced from templates.

### Array (YAML sequence)

```yaml
fields:
  Personality:
    keywords:
      - inquisitive
      - polite
      - sarcastic
```

Arrays can be rendered with `{join(...)}`, `{list(...)}`, or `{$fields.Personality.keywords}` in your template — each producing a different format. See the Templates document.

---

## Variants

Variants define named deltas that layer changes on top of the current card state. They can be nested to any depth.

```yaml
- id: Felicia
  name: Felicia Grayls
  type: Character
  pronouns: female
  triggers: Felicia, Grayls
  fields:
    Physical Traits:
      gender: female
      hair: platinum blond hair in a controlled bun
    Magic:
      affinity: high shadow-affinity
  variants:
    Felix:
      name: Felix Grayls
      pronouns: male
      triggers: Felix, Grayls
      fields:
        Physical Traits:
          gender: male
          hair: -{in a controlled bun}    # removes substring from hair
    sci-fi:
      fields:
        Magic:                            # remove field entirely
        Background: works for Helix Industries in bio-engineering
      variants:
        near-future:
          fields:
            Tagline: +{; corporate operative}   # append to tagline
```

Variants can modify any card field including top-level fields: `name`, `pronouns`, `triggers`, `encapsulate`, `known`, `protagonist`, `template`, `type`.

See the **Shared Functionality** document for full field operation syntax. See **Branch Variant Resolution** for wildcard (`*`) and named group variant behaviour.

---

## Importing canon cards

To use a canon card in your project, add an import entry to a card YAML file in your `cards/` folder.

```yaml
# Import with no modifications
- import: Felicia

# Import and apply a slash-separated variant path
- import: Felicia/Felix

# Import, apply multiple variant chains, and override fields
- import: Felicia
  import-variant: [Felix, sci-fi/near-future]
  fields:
    Tagline: /{shadow mage}/{arcane scholar}
```

### Import syntax

```yaml
- import: CardID/variant/sub-variant
```

The ID is the base canonical card ID. Everything after the first `/` is a variant path — the compiler walks the card's `variants:` tree, applying each named variant in order.

### import-variant

`import-variant:` is a list of additional variant chains to apply, sourced from the *original* canonical card's variant tree. These are applied after the primary import path and before scenario-level `fields:`.

```yaml
- import: Zephon
  import-variant: [human/noble, sci-fi/near-future]
  fields:
    tagline: arcane scholar
```

### Scenario-level field overrides

The `fields:` block on an import applies after all variant chains. It uses full field operation syntax.

```yaml
- import: Felicia
  fields:
    Tagline: /{shadow mage}/{arcane scholar}
    Physical Traits:
      other: a blue interface crystal implanted at the base of her skull
```

### Branch-structured variants on imports

An import can also have its own `variants:` tree that activates based on which branch is being compiled:

```yaml
- import: Zephon/human/noble
  import-variant: [sci-fi/near-future]
  fields:
    tagline: arcane scholar
  variants:
    A:
      import-variant: [human/scholar]
      fields:
        Background: a student of astronomy
      variants:
        X:
          fields:
            Magic:
              affinity: high light-affinity
```

### Import resolution order

For any given branch leaf, the compiler applies changes to the card in this order:

1. Canonical base card
2. Primary import path variants (`Zephon/human/noble` → apply `human`, then `noble`)
3. `import-variant:` list entries in order
4. Scenario-level `fields:` overrides
5. Top-level field overrides from import def (`name`, `pronouns`, etc.)
6. Branch variant `import-variant:` chains (sourced from canonical card)
7. Branch variant `fields:`
8. Child branch levels… (recurse to active leaf)

### `import-variant` always sources from the canonical card

`import-variant` always pulls variant chains from the *original canonical* card's variant tree, not from the partially-resolved card. This means you can mix and match canonical variants freely without worrying about resolution order affecting what's available.

---

## Including whole canon files

To load all cards from a canon file without listing them individually:

```yaml
- include: Characters/Grayls.yaml
- include: Locations/OssianHall.yaml
```

Paths are relative to the `canon:` folder declared in `compile.yaml`. All cards in the included file compile as-is. If any card from an included file is also explicitly imported elsewhere in the project, the explicit import wins and the included version is silently skipped.

`only:`, `except:`, `only_output:`, `except_output:` can be set on an `include:` directive and are stamped onto every card loaded from that file. `import-variant:` and `variants:` are also supported — see **Include Directives — Advanced Features** for details.

```yaml
- include: Characters/Grayls.yaml
  only: [A/X, B]
```

---

## Canon vs project cards

**Canon cards** live in the `canon/` folder (path declared with `canon:` in `compile.yaml`). They are the base definitions — they exist in the registry whether or not any project imports them.

**Project cards** live in the `cards/` folder. They are either entirely local definitions or import/include directives that reference canon cards. If a project card has the same `id` as a canon card, the compiler throws an error — use `import:` instead of redefining.

Cards are loaded recursively from their respective folders. Any `.yaml` file found anywhere under `cards/` or `canon/` is loaded.

---

## Protagonist-aware cards

When a card has a `protagonist:` field, its bare `$` markers resolve relative to the active branch protagonist. This is the mechanism that lets you write a single card definition that produces `you`/`your` text on the subject branch and third-person text on all other branches.

```yaml
- id: SomeNPCCard
  name: Mira
  type: Character
  protagonist: Aness        # this card is written from Aness's perspective
  fields:
    Relationship: |
      - $Aness is $her~ assigned handler — $she ha[s] access to all of $her~ experiment logs
```

When `Aness` is the active branch protagonist, `$Aness` → `you`, `$her~` → `your`, `$she` → `you`, `ha[s]` → `have`. When Aness is not active, everything resolves to third-person using Aness's declared `pronouns:`.

See the **Shared Functionality** document for full pronoun system reference.
