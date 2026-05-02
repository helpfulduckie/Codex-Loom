# AID Card Compiler — Reference

## Installation

```
npm install
npm install -g .
```

Run from anywhere:
```
compile-cards path/to/compile.yaml
```

---

## Project Structure

```
/my-project
  /canon              ← canonical card definitions (shared across projects)
    Aness.yaml
    Felicia.yaml
  /cards              ← project-level card definitions and imports
    characters.yaml
    locations.yaml
  /templates          ← one .template file per card type
    Character.template
    Location.template
  compile.yaml
  /output             ← compiler writes here (one folder per branch leaf)
    /subject
      /Character
        Character.md
    /researcher
      /Character
        Character.md
```

Cards and templates are loaded recursively from their folders. Any `.yaml` file under `cards/` or `canon/` is loaded. Any `.template` file under `templates/` is loaded. Duplicate template filenames across subfolders are an error.

---

## compile.yaml

```yaml
canon: ../../_Canon       # path to canonical cards folder (relative or absolute)
output: ./output          # where compiled output is written
templates: ./templates    # where .template files live
cards: ./cards            # where project card files live
protagonist: Aness        # optional global default protagonist ID

branches:                 # optional branch tree
  subject:
    protagonist: Aness    # optional per-branch protagonist override
  researcher:
    protagonist: Veyrn
  A:
    branches:             # nested branches
      X: {}
      Y: {}
  B:
    branches:
      Z: {}
      Q: {}
```

The compiler enumerates all leaf nodes (nodes with no `branches:` key) and produces one output folder per leaf. A project with no `branches:` produces a single root-level output.

---

## Card Definition Fields

| Field | Description |
|---|---|
| `id` | Compiler-internal identifier. Defaults to `name` if absent. Must be unique across all canon and project cards — collision is an error. Case-insensitive for matching. |
| `name` | Display name used in rendered output. |
| `type` | Output folder name. Determines what AID sees as the card type (e.g. `Character`, `Location`). |
| `template` | Template filename to use (without `.template`). Falls back to `type` if absent. |
| `pronouns` | Declared pronoun set for this card: `female`, `male`, or `they`. Compiler directive — does not appear in output. Used to resolve `{$she}` style tokens. |
| `protagonist` | ID of the character this card is written around. Activates bare `$` marker resolution. |
| `encapsulate` | Boolean. Passed through to output as-is. |
| `known` | Boolean. Controls `[e]` in notes and `\]` at end of entry. |
| `triggers` | Plain string inserted as-is into the trigger line. |
| `fields` | Mapping of card content. Values can be plain strings, block scalars, or nested mappings. |
| `variants` | Named child variants that layer changes on top of this card definition. |

`type` and `template` are inherited from a canonical definition on import and do not need to be restated unless overriding.

---

## Card YAML Example

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
      keywords: inquisitive, polite, sarcastic, compassionate
      expanded: |
        - $Aness love[s] magic research — $she instinctively leap[s] to explore theoretical implications
        - $Her~ polite nature is a social shield; behind it is a biting sarcasm $she deploy[s] when frustrated
    Magic:
      affinity: high ice-affinity; moderate growth-affinity
  variants:
    networked:
      fields:
        Physical Traits:
          other: a blue interface crystal implanted at the base of $her~ skull
```

---

## Field Operations

Used in `variants`, `import-variant` deltas, and scenario-level `fields:` overrides. All string matching is case-insensitive.

| Operation | Syntax | Notes |
|---|---|---|
| **Replace** | `field: new value` | Replaces the field entirely. |
| **Remove field** | `field:` (empty/null) | Removes the field or subfield entirely. |
| **Append** | `field: "+{value to add}"` | Appends to scalar with `; ` separator, or to block scalar with newline. If value starts with a separator character, no extra separator is added. |
| **Remove substring** | `field: "-{text to remove}"` | Removes all occurrences of the substring. |
| **Swap substring** | `field: "/{old}/{new}"` | Replaces all occurrences of `old` with `new`. |
| **Subfield replace** | nested key with new value | Replaces that subfield only. |
| **Subfield remove** | nested key with `"-"` | Removes that subfield only. |

### Examples

```yaml
# Replace
tagline: count of monwynd, shadow mage

# Remove field (empty/null value)
alternate form:
# or equivalently
alternate form: ~

# Append to single-line field
tagline: +{; retired}
# result: "count of monwynd, shadow mage; retired"

# Append with own separator (no doubling)
tagline: +{; retired}
# value already starts with '; ' — compiler doesn't add another

# Append to block scalar
background: +{- Recently returned from exile.}

# Remove substring
hair: -{in a controlled bun}
# "platinum blond hair in a controlled bun" → "platinum blond hair"

# Swap substring
background: /{her}/{his}

# Subfield operations
physical traits:
  gender: male          # replace subfield
  other:               # remove subfield (empty/null value)
```

---

## Imports

Import a card from the canonical registry and optionally apply variants and overrides.

```yaml
- import: Zephon/human/noble      # ID, then slash-separated variant path
  import-variant: [sci-fi/near-future, Felix/a/b/c]   # additional variant chains, applied in order
  fields:                         # scenario-level field overrides
    tagline: /{shadow mage}/{arcane scholar}
  variants:                       # branch-structured variants (same format as local cards)
    A:
      import-variant: [human/scholar]
      fields:
        background: a student of astronomy
      variants:
        X:
          fields:
            magic:
              affinity: high light-affinity
```

### Import resolution order

1. Canonical base card
2. Primary import path variants (`Zephon` → `human` → `noble`)
3. Additional `import-variant:` list entries in order (`sci-fi` → `near-future`, then `Felix` → `a` → `b` → `c`)
4. Scenario-level `fields:` overrides
5. Branch variant `import-variant:` chains (always sourced from the canonical card's variant tree)
6. Branch variant `fields:`
7. Child branch `import-variant:` chains
8. Child branch `fields:`
9. ... (recurse to active leaf)

### import-variant

Branch variants can pull variant chains from the canonical card before applying their own local changes:

```yaml
variants:
  A:
    import-variant: [human/noble, sci-fi/near-future]   # list of variant paths from canon
    fields:
      background: a student of astronomy
```

`import-variant` always sources from the original canonical card's variant tree, not the partially resolved card.

---

## Variants

Variants define named deltas applied on top of the current card state. They can be nested to any depth.

```yaml
variants:
  Felix:
    name: Felix Grayls
    pronouns: male
    triggers: Felix, Grayls
    fields:
      physical traits:
        gender: male
        hair: -{in a controlled bun}
  sci-fi:
    fields:
      magic: ~
      background: works for Helix Industries in bio-engineering
    variants:
      near-future:
        fields:
          tagline: +{; corporate operative}
```

Variants can modify any card field including top-level fields (`name`, `pronouns`, `triggers`, `encapsulate`, `known`).

Multiple sibling variants can be applied in sequence using the variant list syntax. `[Felix, sci-fi]` and `[sci-fi, Felix]` apply the same deltas in different orders and may produce different results.

---

## Post-Resolution Passes

After full card resolution, the compiler applies these passes in order before template rendering:

1. **Field interpolation** — `{$fields.graduation year}` references resolved from the card's own fields
2. **Braced pronoun tokens** — `{$she}`, `{$her~}` etc. resolved against the card's `pronouns:` field
3. **Verb conjugation** — `[s]` markers resolved against the effective pronoun set
4. **Bare `$` markers** — `$Aness`, `$she`, `$her~` etc. resolved against protagonist context
5. **Template rendering**

---

## Template Syntax

Template files are plain text with interpolation expressions. The filename (without `.template`) must match the card's `template` field, or if absent, its `type` field. Matching is case-insensitive.

### Variable interpolation

```
{$name}                           top-level card field
{$fields.Tagline}                 field value (case-insensitive)
{$fields.Physical Traits.gender}  subfield value (case-insensitive)
```

Missing fields resolve to empty string silently.

### Join function

Joins multiple values with a separator, omitting any that are missing or blank:

```
{join("; ", $fields.Physical Traits.gender, $fields.Physical Traits.age, $fields.Physical Traits.build)}
```

If `age` is missing: `male; tall broad build` — no double separators.

### Conditionals

```
{if $fields.Preferences}
Preferences:
{$fields.Preferences}
{/if}
```

With optional else:

```
{if $known}[e]{else}\]{/if}
```

A value is falsy if it is missing, an empty string, or `false`. `{else}` is optional.

### Literal braces

```
{{    →    {
}}    →    }
```

### Blank lines

All blank lines are removed from the rendered output. AID treats blank lines as bad formatting.

### Example Character template

```
## {$name}
~~~
triggers: [{$triggers}]
encapsulate: {$encapsulate}
notes: {if $known}[e]{/if}
~~~
{$name} - {$fields.Tagline}
Physical Traits: {join("; ", $fields.Physical Traits.gender, $fields.Physical Traits.age, $fields.Physical Traits.hair, $fields.Physical Traits.eyes, $fields.Physical Traits.build, $fields.Physical Traits.other)}
Personality: {$fields.Personality.keywords}
{if $fields.Personality.expanded}{$fields.Personality.expanded}
{/if}{if $fields.Magic}Magic: {join("; ", $fields.Magic.affinity, $fields.Magic.effect)}
{/if}{if $fields.Background}Background:
{$fields.Background}
{/if}{if $known}{else}\]{/if}
```

---

## Field Interpolation

Within field values, you can reference other fields on the same card using `{$...}` syntax:

```yaml
fields:
  graduation year: 1315
  background: |
    - A cohort of 50 students; graduated Primary Education in {$fields.graduation year}
```

Pronoun tokens (`{$she}`, `{$her~}` etc.) inside field values are skipped by field interpolation and handled by the pronoun pass instead.

---

## Pronoun System

### Card-subject pronoun tokens (braced)

Used in field values and templates. Resolve against the card's `pronouns:` field. Good for the card subject's own pronouns.

| Token(s) | `female` | `male` | `they` | fallback |
|---|---|---|---|---|
| `{$she}` / `{$he}` / `{$they}` | she | he | they | bare word |
| `{$her}` / `{$him}` / `{$them}` | her | him | them | bare word |
| `{$her~}` / `{$his~}` / `{$their~}` | her | his | their | bare word |
| `{$herself}` / `{$himself}` / `{$themselves}` | herself | himself | themselves | bare word |
| `{$she's}` / `{$he's}` / `{$they're}` | she's | he's | they're | bare word |

All tokens in each row are synonymous — use whichever reads most naturally. Case of the first letter is preserved from the token: `{$She}` → `She` or `He`.

Fallback (bare word, without `~`) is used when `pronouns:` is missing or unrecognized.

### Verb conjugation markers

Used in field values. Resolve to `s` or nothing based on the effective pronoun set.

```
love[s]    →  love  (you / they)   or   loves  (she / he)
leap[s]    →  leap                 or   leaps
deploy[s]  →  deploy               or   deploys
```

For protagonist cards in you-mode, the effective set is `you` (plural → drop the `s`). Otherwise the card's `pronouns:` field determines the set.

### Bare `$` markers (protagonist-aware)

Used in field values only. Mark references to the protagonist that should become `you`/`your` when that character is the active protagonist, and resolve to name or third-person pronouns otherwise. Good for NPC cards that reference the protagonist.

Token ends on whitespace or punctuation except `-` and `~`. So `$Aness.` → token `Aness`, period follows. `$her~` → token `her~`. `$Esudia-Aness` → token `Esudia-Aness`.

`$` followed by a number is left as-is silently.

#### Protagonist ID tokens (`$Aness`, `$Esudia-Aness`)

Uses the character's `id` field (not display name) to avoid multi-word name ambiguity. Resolves to the character's `name` field when not the active protagonist.

```
$Aness   →  "you"         (when Aness is active protagonist)
$Aness   →  "Aness Rozen" (when Aness is not active protagonist, resolves to name field)
```

Possessive suffixes following the token are left alone:
```
$Aness's  →  "you're"   or   "Aness Rozen's"
```

#### Pronoun tokens (`$she`, `$her`, `$her~`, etc.)

Same vocabulary as braced tokens but resolved against protagonist context instead of the card's `pronouns:` field.

**Resolution order:**

1. Active branch protagonist matches this card's `protagonist:` field → resolve to you-set:

| Token | You-set |
|---|---|
| `$she` / `$he` / `$they` | you |
| `$her` / `$him` / `$them` | you |
| `$her~` / `$his~` / `$their~` | your |
| `$herself` / `$himself` / `$themselves` | yourself |
| `$she's` / `$he's` / `$they're` | you're |

2. Otherwise → look up the card matching this card's `protagonist:` field, read its `pronouns:` field, resolve to that gender set (same table as braced tokens)

3. Any of these fail → fallback to bare word, emit warning:
   - No `protagonist:` field on this card
   - Referenced protagonist card not found in registry
   - Referenced protagonist card has no `pronouns:` field

#### Unrecognized `$word`

If `$word` doesn't match any known protagonist ID or pronoun keyword (and isn't followed by a number) — warns and leaves as-is. This catches likely authoring mistakes without breaking compilation.

### Choosing between braced and bare

| Situation | Use |
|---|---|
| Card subject's own pronouns (Felicia referring to herself) | `{$her~}` braced — resolves to gender set |
| Reference to the protagonist from an NPC card | `$her~` bare — resolves to you/your or protagonist's pronouns |
| Verb agreement on protagonist-aware sentence | `[s]` — resolves to effective set |

### Gender swap via variant

Change `pronouns:` in a variant to automatically update all braced tokens throughout the card:

```yaml
variants:
  Felix:
    name: Felix Grayls
    pronouns: male
    fields:
      physical traits:
        gender: male
        hair: -{in a controlled bun}
```

All `{$her~}`, `{$she}` etc. in Felicia's fields now resolve to `his`, `he` for the Felix variant without any additional changes.

### Protagonist declaration

The `protagonist:` field on a card uses the character's `id`. Declared in `compile.yaml` globally or per branch:

```yaml
protagonist: Aness        # global default

branches:
  subject:
    protagonist: Aness
  researcher:
    protagonist: Veyrn
```

A card's bare `$` markers are you-mode when the branch protagonist matches the card's `protagonist:` field. All protagonist matching is case-insensitive.

---

## Errors and Warnings

| Message | Cause |
|---|---|
| `Duplicate card ID "x"` | Two cards share the same id in the same context (canon, project) or across canon/project boundary. |
| `Duplicate template name "x"` | Two `.template` files in different subfolders share the same filename. |
| `Import failed: no card with id "x"` | `import:` references an id not found in the registry. |
| `No template found for card "x"` | Neither `template:` nor `type:` on the card matches any loaded template file. |
| `WARN: variant "x" not found` | A variant path references a variant name that doesn't exist in the variant tree. |
| `WARN: bare $word found on card "x" which has no protagonist field` | Bare `$` pronoun marker used on a card with no `protagonist:` declared. |
| `WARN: unrecognized bare $word` | `$word` doesn't match any known protagonist ID or pronoun keyword. Likely a stray `$` in field text. |