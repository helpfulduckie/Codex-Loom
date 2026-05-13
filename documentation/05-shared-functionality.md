# Shared Functionality Reference

This document covers features that apply to both story card YAML and `plot-essentials.yaml`: field operations, branch filtering, output filtering, and the pronoun system.

---

## Field Operations

Field operations are used in `variants:`, `import:` field overrides, and `import-variant` deltas to modify card fields without rewriting the entire definition. All key matching is case-insensitive.

### Replace

Assign a new value directly. This is just setting the field to a new string or scalar.

```yaml
fields:
  Tagline: count of monwynd, shadow mage
```

### Remove

Set the value to nothing (null) or to the literal string `"-"`. Both forms remove the field entirely. The tilde `~` form is explicit YAML null.

```yaml
fields:
  Alternate Form:           # empty value — removes the field
  Magic:                    # same
  Background: ~             # explicit null — same effect
```

### Append

Prefix the value with `+{`. Appends to a scalar with `"; "` as the separator (for single-line values) or a newline (for multiline block scalars). If the value to add already starts with a separator character (`;`, `,`, space), no extra separator is prepended.

```yaml
fields:
  Tagline: +{; retired}
  # "journeyman healer" → "journeyman healer; retired"

  Background: +{- Recently returned from exile.}
  # Appends a new line to a block scalar
```

### Remove substring

Prefix the value with `-{`. Removes all occurrences of the substring from the field.

```yaml
fields:
  Physical Traits:
    hair: -{in a controlled bun}
  # "platinum blond hair in a controlled bun" → "platinum blond hair"
```

### Swap substring

Prefix the value with `/{old}/{new}`. Replaces all occurrences of `old` with `new`.

```yaml
fields:
  Background: /{her}/{his}
  Tagline: /{Apprentice}/{Master}
```

### Chained operations

Set the field to a YAML list where every element is an operation string. The operations are applied to the field in order.

```yaml
fields:
  Description:
    - "/{She}/{He}"
    - "/{she}/{he}"
    - "/{her}/{his}"

  Title:
    - "/{Apprentice}/{Master}"
    - "+{, Guild Certified}"
```

**Distinguishing op sequences from value arrays:** A YAML list is treated as an op sequence if every element is a string beginning with `+{`, `-{`, or `/{`. Otherwise it is treated as a value replacement (the field is set to that array). An empty list `[]` is always treated as an op sequence (no ops — no change).

```yaml
# Op sequence — every element is an op prefix
description:
  - "/{She}/{He}"
  - "+{; retired}"

# Value array — replaces the field with this list
keywords:
  - driven
  - pragmatic
  - cold
```

### Operations on array fields

When the current field value is a YAML sequence (array), the string ops apply element-wise rather than to a joined string:

| Operation on array | Effect |
|---|---|
| `+{item}` | Appends `item` to the array |
| `-{item}` | Removes elements equal to `item` |
| `/{old}/{new}` | Applies the swap to every element |
| `field: ~` | Removes the field entirely |
| `field: [a, b, c]` | Replaces the array with `[a, b, c]` |

### Subfield operations

When the field is a mapping (nested keys), operations can target individual subfields:

```yaml
fields:
  Physical Traits:
    gender: male             # replace subfield
    other:                   # remove subfield (empty value)
    hair: -{in a bun}        # remove substring from subfield
```

You can mix operation types across subfields in a single block.

### Operations on top-level card fields

Variants can also modify top-level card fields like `name`, `pronouns`, `triggers`, `encapsulate`, `known`. These are set directly on the variant block, not nested under `fields:`:

```yaml
variants:
  Felix:
    name: Felix Grayls          # replace top-level name
    pronouns: male              # replace pronouns
    triggers: Felix, Grayls
    fields:
      Physical Traits:
        gender: male
```

---

## Branch Filtering

`only:` and `except:` control which branch leaves a card, import, include directive, or PE block compiles for. They are mutually exclusive — set one or neither, never both on the same entry.

### only

Compile only for branch leaves whose path starts with one of the listed prefixes.

```yaml
- import: Zephon
  only: [A/X, B]
```

- `A/X` → included (exact match)
- `A/X/deeper/leaf` → included (downstream)
- `A/Y` → excluded (sibling, not downstream)
- `B` → included
- `B/Z` → included (downstream)
- `C` → excluded

### except

Compile for all leaves except those whose path starts with one of the listed prefixes.

```yaml
- id: Kaiden
  type: Character
  except: [felix]
  fields: ...
```

### Prefix matching rules

- Matching is case-insensitive.
- A prefix `B` matches any leaf whose path is exactly `B` or starts with `B/`.
- Prefixes do not need to be full leaf paths — `B` matches `B`, `B/Z`, `B/Z/deep`, etc.
- A single string is valid (not just a list): `only: subject` is equivalent to `only: [subject]`.

### On include directives

`only:` and `except:` on an `include:` directive are stamped onto every card loaded from that file. See **Include Directives — Advanced Features** for `import-variant:` and `variants:` on includes.

---

## Output Filtering

When your project compiles to multiple labelled outputs (see the `compile.yaml` reference), `only_output:` and `except_output:` let you target specific outputs. They work exactly like `only:`/`except:` but match against the output `label:` instead of the branch path.

```yaml
# Card definition — compiles only into the modset2 output
- id: SettingsCard
  name: Settings
  type: Settings
  only_output: [modset2]
  fields: ...

# Import — compiles only into modset1
- import: Zephon
  only_output: [modset1]

# Include — every card from this file is restricted to modset2
- include: Characters/ModSet2Only.yaml
  only_output: [modset2]

# PE block — appears in modset2 Plot Essentials only
- wrapper: square
  only_output: [modset2]
  text: |
    Mod: AdvancedPhysics v3
```

`only_output:` and `except_output:` compose independently with `only:`/`except:` — a card must satisfy both its branch filter and its output filter to compile into a given branch × output combination.

| Filter | Effect |
|---|---|
| `only_output: [label]` | Compile only into outputs whose label matches |
| `except_output: [label]` | Compile into all outputs except those whose label matches |
| Neither | Compile into all outputs |

Labels are matched case-insensitively. If a filter references a label that doesn't exist in `compile.yaml`, the card simply never compiles for that label — no error is raised.

**Unlabelled outputs** always compile every applicable card. `only_output:` filters are ignored for unlabelled outputs (the compiler emits a warning). `except_output:` filters are also ignored silently.

---

## The Pronoun System

Codex Loom has three pronoun mechanisms, each serving a different authoring purpose.

### 1. Braced pronoun tokens — card-subject pronouns

Used in field values and templates. Resolve against the card's own `pronouns:` field. Best for writing about the card subject themselves.

```
{$she}    {$he}    {$they}           → subject pronoun
{$her}    {$him}   {$them}           → object pronoun
{$her~}   {$his~}  {$their~}         → possessive pronoun
{$herself} {$himself} {$themselves}  → reflexive
{$she's}  {$he's}  {$they're}        → contraction
```

| Token(s) | `female` | `male` | `they` | fallback |
|---|---|---|---|---|
| `{$she}` / `{$he}` / `{$they}` | she | he | they | bare word |
| `{$her}` / `{$him}` / `{$them}` | her | him | them | bare word |
| `{$her~}` / `{$his~}` / `{$their~}` | her | his | their | bare word |
| `{$herself}` / `{$himself}` / `{$themselves}` | herself | himself | themselves | bare word |
| `{$she's}` / `{$he's}` / `{$they're}` | she's | he's | they're | bare word |

All tokens in each row are synonymous — use whichever reads naturally in context. The case of the first letter is preserved: `{$She}` → `She` or `He` depending on the pronoun set.

Fallback (bare word, `~` stripped) is used when `pronouns:` is absent or unrecognized.

**Changing pronouns via variant:** Set `pronouns: male` (or any set) in a variant and all braced tokens throughout the card automatically resolve to the new set — no other changes needed.

```yaml
variants:
  Felix:
    name: Felix Grayls
    pronouns: male
    # {$her~} → his, {$she} → he, etc. everywhere in Felicia's fields
```

### 2. Verb conjugation markers

Used in field values. Resolve to `s`/`es` or nothing based on the effective pronoun set.

```
love[s]   → love   (you / they)   or   loves   (she / he)
leap[s]   → leap                  or   leaps
go[es]    → go                    or   goes
deploy[s] → deploy                or   deploys
```

The effective pronoun set is:
- `you` (plural → drop the suffix) when this card's `protagonist:` matches the active branch protagonist.
- The card's declared `pronouns:` field otherwise.

`[es]` is matched before `[s]` so partial matches inside `[es]` don't occur.

### 3. Bare `$` markers — protagonist-aware resolution

Used in field values only. These are the mechanism for writing text that says `you`/`your` when a character is the active protagonist and third-person otherwise — enabling a single card definition to serve multiple branches.

Token boundaries: a bare `$` token ends at whitespace or punctuation (except `-` and `~`). So:
- `$Aness.` → token `Aness`, period follows.
- `$her~` → token `her~` (tilde is part of the token).
- `$Esudia-Aness` → token `Esudia-Aness` (hyphen is part of the token).

`$` followed by a number is left as-is silently.

#### Protagonist ID tokens (`$Aness`, `$Esudia-Aness`)

Uses the character's `id` field for lookup. Resolves to `you` when that character is the active branch protagonist, or to the character's `name` field otherwise.

```
$Aness      → "you"           (when Aness is active protagonist)
$Aness      → "Aness Rozen"  (when not active protagonist)
$Aness's    → "your"  / "Aness Rozen's"
```

#### Pronoun tokens (`$she`, `$her~`, `$they`, etc.)

Same vocabulary as braced tokens. Require a `protagonist:` field on the card to know whose pronouns to resolve to.

**Resolution order:**

1. Active branch protagonist matches this card's `protagonist:` field → resolve to you-set:

| Token | You-set |
|---|---|
| `$she` / `$he` / `$they` | you |
| `$her` / `$him` / `$them` | you |
| `$her~` / `$his~` / `$their~` | your |
| `$herself` / `$himself` / `$themselves` | yourself |
| `$she's` / `$he's` / `$they're` | you're |

2. Active protagonist doesn't match → look up the card for this card's `protagonist:` field in the registry, read its `pronouns:`, resolve to that gender set (same table as braced tokens).

3. Any of the above fail → fallback to bare word, emit warning:
   - No `protagonist:` field on this card
   - Referenced protagonist card not found in registry
   - Referenced protagonist card has no `pronouns:` field

#### Unrecognized `$word`

If `$word` doesn't match any known protagonist ID or pronoun keyword, the compiler warns and leaves it as-is. This catches stray `$` characters in field text without silently breaking compilation.

### Choosing between the three mechanisms

| Situation | Use |
|---|---|
| Card refers to itself (Felicia's own hair, magic, backstory) | Braced `{$her~}` — resolves to gender set from the card's `pronouns:` |
| Card refers to the protagonist (NPC card mentioning Aness) | Bare `$her~` — resolves to `your` or Aness's pronouns |
| Verb agreement on a protagonist-aware sentence | `[s]` / `[es]` — resolves to effective set |
| Freeform PE block referring to protagonist | Bare `$Aness`, `$she` with `protagonist:` and `pronouns:` declared on the block |

---

## Field Interpolation

Within field values, you can reference other fields on the same card using `{$...}` syntax. This is resolved before pronoun passes.

```yaml
fields:
  graduation year: 1315
  background: |
    - A cohort of 50 students; graduated Primary Education in {$fields.graduation year}
    - See also: {$name}
```

Supported reference paths:
- `{$name}` — top-level card field
- `{$fields.Tagline}` — field value (case-insensitive)
- `{$fields.Physical Traits.gender}` — subfield value (case-insensitive, multi-level)

Pronoun tokens (`{$she}`, `{$her~}` etc.) inside field values are skipped by field interpolation and handled by the pronoun pass instead.

---

## Post-Resolution Pass Order

After all variants, imports, and branch deltas are applied, the compiler runs these passes in order before template rendering:

1. **Field interpolation** — `{$fields.X}` references resolved from the card's own fields
2. **Braced pronoun tokens** — `{$she}`, `{$her~}` etc. resolved against `pronouns:`
3. **Verb conjugation** — `[s]`, `[es]` resolved against the effective pronoun set
4. **Bare `$` markers** — `$Aness`, `$she`, `$her~` resolved against protagonist context
5. **Template rendering**

These same passes apply to PE block content — both freeform `text:` and card-body blocks.
