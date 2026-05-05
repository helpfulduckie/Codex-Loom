# AID Card Compiler — Reference

## Installation

```
npm install
npm install -g .
```

Run from anywhere:
```
codex-loom path/to/compile.yaml
codex-loom path/to/project/          ← directory form, looks for compile.yaml inside
```

To generate one leaf-review file per branch leaf from an already-compiled scenario folder:
```
codex-loom --leafReview path/to/output [output-dir]
codex-loom -l path/to/output [output-dir]
```

If `output-dir` is omitted, files are written to `./leaf-review/`. When run inside a project directory that has a `compile.yaml` with an `overview:` key, you can also run:
```
codex-loom --leafReview
```
and it will use the configured paths.

To generate a single whole-tree overview file covering every node:
```
codex-loom --overview path/to/output [output-dir]
codex-loom -o path/to/output [output-dir]
```

If `output-dir` is omitted, the file is written to `./overview/`.

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
  /templates          ← one .template file per card type; optional .partial files for shared chunks
    Character.template
    Location.template
    Header.partial      ← partial — reusable fragment, included via {include Header}
  compile.yaml
  plot-essentials.yaml              ← optional; plot essentials block definitions
  /output             ← compiler writes here (one folder per branch leaf)
    /Story Cards
      /Character
        Character.md
    /Branches
      /subject
        /Story Cards
          /Character
            Character.md
        /Components
          Plot Essentials.md
      /researcher
        /Story Cards
          /Character
            Character.md
        /Components
          Plot Essentials.md
```

Cards and templates are loaded recursively from their folders. Any `.yaml` file under `cards/` or `canon/` is loaded. Any `.template` file under `templates/` is loaded; `.partial` files in the same directories are also loaded and available for `{include}` expressions. Duplicate template or partial filenames within the same directory tree are an error; when multiple template directories are configured, later directories override earlier ones on name collision (see `templates:` below).

---

## compile.yaml

```yaml
canon: ../../_Canon       # path to canonical cards folder (relative or absolute)
output: ./output          # where compiled output is written
templates: ./templates    # where .template files live (see below for multi-dir form)
cards: ./cards            # where project card files live
protagonist: Aness        # optional global default protagonist ID

branches:                 # optional branch tree
  subject:
    protagonist: Aness    # optional per-branch protagonist override
  researcher:
    protagonist: Veyrn
  A:
    branches:             # nested branches require the 'branches:' key
      X: {}
      Y: {}
  B:
    branches:
      Z: {}
      Q: {}
```

### Leaf review output

The optional `overview:` key tells Codex-Loom to generate leaf review files after compiling. Each leaf branch gets one `.overview.md` file containing all of its inherited Story Cards plus any Opening / Plot Essentials Components resolved from the nearest ancestor. This mirrors what the compiled output looks like in AI Dungeon — one flat document per playable branch.

```yaml
overview: ./overview    # output dir for leaf review files; omit to skip
```

Filenames follow the pattern `A - B - C.overview.md` (branch path joined by ` - `). For a project with no branches, the scenario root folder name is used.

You can also generate a single whole-tree overview file (one section per node) via the `--overview`/`-o` CLI flag — this is not triggered automatically by a build.

---

### Multiple template directories

`templates:` accepts a list of directories. Directories are loaded in order; if the same template name appears in more than one directory, the later directory wins. Duplicates within the same directory tree are still an error.

```yaml
templates:
  - ../../_SharedTemplates   # base set — shared across all projects
  - ./templates              # project overrides — same name here wins
```

This lets you maintain a canonical template library alongside project-specific overrides without copying files.

The compiler enumerates all leaf nodes (nodes with no `branches:` key) and produces one output folder per leaf. A project with no `branches:` produces a single root-level output. Each leaf's output follows Velvet Lattice folder structure:

```
Branches/A/Branches/X/Story Cards/Character/Character.md
Branches/A/Branches/X/Components/Plot Essentials.md
```

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
| `fields` | Mapping of card content. Values can be plain strings, block scalars, YAML sequences (arrays), or nested mappings. |
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
| **Remove field** | `field:` (empty/null) | Removes the field or subfield entirely. `field: ~` is equivalent. |
| **Append** | `field: "+{value to add}"` | Appends to scalar with `; ` separator, or to block scalar with newline. If value starts with a separator character, no extra separator is added. |
| **Remove substring** | `field: "-{text to remove}"` | Removes all occurrences of the substring. |
| **Swap substring** | `field: "/{old}/{new}"` | Replaces all occurrences of `old` with `new`. |
| **Chained operations** | `field:` is a YAML sequence of ops | Applies each operation to the field in order. Any operation type may appear in the list. |
| **Subfield replace** | nested key with new value | Replaces that subfield only. |
| **Subfield remove** | nested key with empty/null value | Removes that subfield only. |

When a field holds a YAML array (sequence), the string ops behave element-wise rather than on a joined string:

| Operation on array field | Effect |
|---|---|
| `+{item}` | Appends `item` to the array |
| `-{item}` | Removes elements equal to `item` |
| `/{old}/{new}` | Applies the swap to every element |
| `field: ~` | Removes the field entirely (same as any field) |
| `field: [a, b, c]` | Replaces the array with `[a, b, c]` (see below) |

**Distinguishing value arrays from op sequences:** A YAML sequence in a variant block is treated as a **value replacement** (sets the field to that array) unless every element is a string beginning with `+{`, `-{`, or `/{` — in which case it is treated as a sequential ops list. An empty sequence `[]` is always treated as an ops list (no ops = no change).

```yaml
# Op sequence — every element is an op prefix, applied in order
description:
  - "/{She}/{He}"
  - "/{her}/{his}"

# Value array — elements are plain strings, replaces the field
keywords:
  - a different
  - personality
  - here
```

### Examples

```yaml
# Replace
tagline: count of monwynd, shadow mage

# Remove field (empty value)
alternate form:

# Remove field (explicit null — both forms work)
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

# Multiple operations on one field — applied in order
description:
  - "/{She}/{He}"
  - "/{she}/{he}"
  - "/{her}/{his}"

# Mix different operation types in a sequence
title:
  - "/{Apprentice}/{Master}"   # swap
  - "+{, Guild Certified}"     # then append

# Subfield operations
physical traits:
  gender: male          # replace subfield
  other:                # remove subfield (empty value)
```

---

## Including Canon Files

To include all cards from a canonical file without listing them individually:

```yaml
- include: Characters/Grayls.yaml
- include: Locations/OssianHall.yaml
```

Paths are relative to the canon folder declared in `compile.yaml`. All cards in the file are loaded and compiled as-is. If a card from an included file is also explicitly imported elsewhere in the project, the explicit import takes precedence and the included version is silently skipped.

```yaml
# Felicia from Grayls.yaml will be skipped — the explicit import below wins
- include: Characters/Grayls.yaml

- import: Felicia
  variants:
    felix:
      import-variant: [Felix]
```

---

## Imports

Import a card from the canonical registry and optionally apply variants and overrides.

```yaml
- import: Zephon/human/noble      # ID, then slash-separated variant path
  import-variant: [sci-fi/near-future, Felix/a/b/c]   # additional canon variant chains, applied in order
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
3. Top-level `import-variant:` list entries in order (`sci-fi` → `near-future`, then `Felix` → `a` → `b` → `c`)
4. Scenario-level `fields:` overrides
5. Branch variant `import-variant:` chains (always sourced from the canonical card's variant tree)
6. Branch variant `fields:`
7. Child branch `import-variant:` chains
8. Child branch `fields:`
9. ... (recurse to active leaf)

### import-variant

Pulls named variant chains from the canonical card's variant tree and applies them to the card in progress. Available at both the top level of an import and inside branch variants.

```yaml
# Top level — applied after primary import path, before scenario fields
- import: Zephon
  import-variant: [human/noble, sci-fi/near-future]
  fields:
    tagline: arcane scholar

# Branch level — applied before that branch's local fields
  variants:
    A:
      import-variant: [human/noble]
      fields:
        background: a student of astronomy
```

`import-variant` always sources from the original canonical card's variant tree, not the partially resolved card. `variants:` at any level means branch-structured child variants, never a list of variant chains.

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
      magic:             # remove field — empty value
      background: works for Helix Industries in bio-engineering
    variants:
      near-future:
        fields:
          tagline: +{; corporate operative}
```

Variants can modify any card field including top-level fields (`name`, `pronouns`, `triggers`, `encapsulate`, `known`).

---

## Post-Resolution Passes

After full card resolution, the compiler applies these passes in order before template rendering:

1. **Field interpolation** — `{$fields.graduation year}` references resolved from the card's own fields
2. **Braced pronoun tokens** — `{$she}`, `{$her~}` etc. resolved against the card's `pronouns:` field
3. **Verb conjugation** — `[s]` markers resolved against the effective pronoun set
4. **Bare `$` markers** — `$Aness`, `$she`, `$her~` etc. resolved against protagonist context
5. **Template rendering**

The same passes apply to PE block content — both freeform `text:` and card-body blocks.

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

When a ref resolves to an array field, `join` spreads all its elements into the list rather than treating the whole array as one value:

```
{join(", ", $fields.Personality.keywords)}
→  inquisitive, polite, sarcastic, compassionate
```

You can also mix array refs with scalar refs in a single call.

### Array fields

Fields can be stored as YAML sequences rather than semicolon-delimited strings. The rendering format is then a template decision, not a data decision:

```yaml
# In the card definition
Personality:
  keywords:
    - inquisitive
    - polite
    - sarcastic
    - compassionate
```

```
{join(", ", $fields.Personality.keywords)}   →  inquisitive, polite, sarcastic, compassionate
{join("; ", $fields.Personality.keywords)}   →  inquisitive; polite; sarcastic; compassionate
{list($fields.Personality.keywords)}         →  - inquisitive
                                                - polite
                                                - sarcastic
                                                - compassionate
{$fields.Personality.keywords}               →  inquisitive; polite; sarcastic; compassionate  (default join, "; ")
{if $fields.Personality.keywords}            →  truthy if the array is non-empty
```

`{list(...)}` takes a single field reference and renders each element on its own `- ` prefixed line. When passed a plain string instead of an array (for backwards compatibility with block scalars), it outputs the string unchanged.

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
Personality: {join(", ", $fields.Personality.keywords)}
{if $fields.Personality.expanded}{$fields.Personality.expanded}
{/if}{if $fields.Magic}Magic: {join("; ", $fields.Magic.affinity, $fields.Magic.effect)}
{/if}{if $fields.Background}Background:
{$fields.Background}
{/if}{if $known}{else}\]{/if}
```

---

## Partials

Partials are reusable template fragments stored in `.partial` files alongside your `.template` files. They let you factor out repeated layout chunks — a common header, a shared fenced block, a recurring section structure — without duplicating text across templates.

### Defining a partial

Create a file with a `.partial` extension anywhere under your template directory:

```
templates/
  Character.template
  StoryCard.partial      ← shared fenced-block header
  TraitLine.partial      ← reusable trait formatting
```

The file contains plain template text. Any template syntax works inside a partial: field interpolation, `{join(...)}`, `{list(...)}`, `{if...}{/if}`, and even other `{include}` calls.

### Using a partial

Inside a `.template` or another `.partial`, write:

```
{include PartialName}
```

The partial's content is expanded in-place before any other template processing, so `{if}` blocks and field references inside the partial see the same card data as the outer template. The name is matched case-insensitively against the partial's filename (without `.partial`).

### Nesting

Partials can include other partials to any depth:

```
# StoryCard.partial
## {$name}
~~~
{include FenceHeader}
~~~
```

```
# FenceHeader.partial
triggers: [{$triggers}]
encapsulate: {$encapsulate}
notes: {if $known}[e]{/if}
```

### Multiple template directories

When `templates:` lists multiple directories, partials follow the same override rules as templates: later directories win on name collision, duplicates within the same directory are an error.

### Errors

| Condition | Error |
|---|---|
| `{include Ghost}` — no `Ghost.partial` file found | `Unknown partial "Ghost" (no .partial file found with that name)` |
| Circular include (`A` includes `B` includes `A`) | `Circular partial include detected: a → b → a` |

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

## Plot Essentials

`plot-essentials.yaml` sits alongside `compile.yaml` and defines the content of `Components/Plot Essentials.md` for each branch. The file is a YAML sequence; blocks compile in the order they appear.

If `plot-essentials.yaml` is absent, no `Components/` folder is written — existing projects are unaffected.

### Block fields

| Field | Description |
|---|---|
| `wrapper` | Required. `square` → `[ ... ]`, `curly` → `{ ... }`, `none` → raw text. |
| `text` | Freeform block content. Used when `import:` is absent. Goes through pronoun and conjugation passes. |
| `import` | Import a card from the registry using the same syntax as card imports, including slash-separated variant paths. When present, the block renders via a template instead of `text:`. |
| `strip_fence` | Boolean. When `true`, everything up to and including the last `~~~` line is stripped from the rendered output, leaving only the card body. Defaults to `false`. |
| `template` | Template override for card-body blocks. Falls back to the card's own `template` field, then `type`, same as Story Card compilation. |
| `pronouns` | For freeform blocks only: declares the pronoun set for token resolution within `text:`. Not needed for card-body blocks — the card carries its own `pronouns:`. |
| `protagonist` | For freeform blocks only: declares the protagonist for bare `$` marker resolution. Not needed for card-body blocks. |
| `only` | Compile this block only for branches whose path starts with one of the listed prefixes. Same semantics as `only` on card definitions. |
| `except` | Compile this block for all branches except those whose path starts with one of the listed prefixes. |

`only` and `except` are mutually exclusive — set one or neither, not both.

### Freeform blocks

Used for genre, setting, mechanics, format instructions, and any other prose that isn't drawn from a card definition. The `text:` field supports the full pronoun and conjugation syntax: `$Aness`, `[s]`, `{$she}`, etc. Declare `pronouns:` and `protagonist:` on the block if you use those tokens.

```yaml
- wrapper: square
  text: |
    Genre: Psychological Thriller | Dark Character Study
    Psychological Thriller — The horror is not what you do to them. It is how little it costs you.

- wrapper: square
  only: [subject]
  protagonist: Aness
  pronouns: female
  text: |
    You are $Aness, a journeyman healer assigned to the Zenus subproject against {$her~} will.
```

### Card-body blocks

Used for character blocks in PE. The card is resolved through the full import pipeline — canonical base, variant paths, `import-variant` chains, branch variants — then rendered via a template. Set `strip_fence: true` to drop the `## Name` / `~~~...~~~` header and keep only the card body.

The you-block (the player character entry) is a card-body block whose imported card matches the branch protagonist. You-mode pronoun resolution activates automatically — no special configuration needed.

```yaml
# Full character block — strip the Story Card header, wrap in curly braces
- wrapper: curly
  strip_fence: true
  import: Aness/networked
  only: [subject]

# Same card, different variant for a different branch
- wrapper: curly
  strip_fence: true
  import: Aness
  only: [researcher]

# Quick-reference NPC using a compact template
- wrapper: curly
  strip_fence: true
  import: Kaiden
  template: pe-character
  except: [subject]
```

### Template authoring for PE

PE card-body blocks work with any template. For full character blocks, the existing `Character.template` works as-is — `strip_fence: true` removes everything above the last `~~~` line, leaving the card body.

For compact NPC quick-reference lines, write a dedicated template (e.g. `pe-character.template`) that produces a single dense line:

```
{$name} ({join("; ", $fields.Physical Traits.hair, $fields.Physical Traits.eyes, $fields.Physical Traits.gender)}) - {$fields.Tagline}
```

### Example plot-essentials.yaml

```yaml
# Genre block — applies to all branches
- wrapper: square
  text: |
    Genre: Psychological Thriller | Dark Character Study
    Psychological Thriller — The horror is not what you do to them. It is how little it costs you.
    Dark Character Study — You are not cruel. You are consumed.

# Setting — applies to all branches
- wrapper: square
  text: |
    Setting: Steampunk Fantasy Feudal Europe; the Royal Academy
    - Research subjects are generally called by their Unit Designation rather than their names.

# NPC blocks — apply to all branches
- wrapper: curly
  strip_fence: true
  import: Kaiden
  template: pe-character

- wrapper: curly
  strip_fence: true
  import: Prime

# You-block — one per branch, filtered by only:
- wrapper: curly
  strip_fence: true
  import: Aness
  only: [subject]

- wrapper: curly
  strip_fence: true
  import: Veyrn
  only: [researcher]
```

---

## Branch Filtering

By default, every card compiles for every branch leaf. Use `only` or `except` to restrict which branches a card or include appears on. Only one may be set on a given entry — not both. The same filtering applies to PE blocks.

### only

Compile this card only for leaves whose path starts with one of the listed prefixes:

```yaml
- import: Zephon
  only: [A/X, B]
```

- `A/X` → included
- `A/X/deeper/leaf` → included (downstream of A/X)
- `A/Y` → excluded (sibling of X, not downstream)
- `B` → included
- `B/Z` → included (downstream of B)
- `C` → excluded

### except

Compile this card for all leaves except those whose path starts with one of the listed prefixes:

```yaml
- id: Kaiden
  except: [felix]
  ...
```

### On include directives

`only` and `except` work the same way on `include:` — all cards loaded from the file inherit the filter:

```yaml
- include: Characters/Zephon.yaml
  only: [A/X, B]
```

### Prefix matching rules

- Matching is case-insensitive
- A prefix matches a leaf if the leaf path equals the prefix exactly, or starts with the prefix followed by `/`
- Prefixes do not need to be full leaf paths — `B` matches `B`, `B/Z`, `B/Z/deep`, etc.

---

## Errors and Warnings

| Message | Cause |
|---|---|
| `Duplicate card ID "x"` | Two cards share the same id in the same context (canon, project) or across canon/project boundary. |
| `Duplicate template name "x"` | Two `.template` files within the same template directory share the same filename. (Same name across different top-level directories is allowed — the later directory wins.) |
| `Duplicate partial name "x"` | Two `.partial` files within the same template directory share the same filename. Same override rules as templates across multiple directories. |
| `Unknown partial "x"` | `{include x}` used in a template or partial, but no `x.partial` file was found. |
| `Circular partial include detected: a → b → a` | A chain of `{include}` calls loops back to a partial already in the current expansion stack. |
| `Import failed: no card with id "x"` | `import:` references an id not found in the registry. |
| `No template found for card "x"` | Neither `template:` nor `type:` on the card matches any loaded template file. |
| `WARN: include path not found` | An `include:` path does not exist relative to the canon folder. |
| `WARN: variant "x" not found` | A variant path references a variant name that doesn't exist in the variant tree. |
| `WARN: bare $word found on card "x" which has no protagonist field` | Bare `$` pronoun marker used on a card with no `protagonist:` declared. |
| `WARN: unrecognized bare $word` | `$word` doesn't match any known protagonist ID or pronoun keyword. Likely a stray `$` in field text. |
| `WARN [PE]: freeform block has no text field` | A PE block has no `import:` and no `text:` — nothing to render. |
| `ERR [PE]: resolving import "x"` | A PE card-body block's `import:` path failed to resolve. |
| `ERR [PE]: template "x" not found` | The `template:` override on a PE block doesn't match any loaded template file. |
| `ERR [PE]: no template found for card "x"` | A PE card-body block has no `template:` override and the card's own `template`/`type` doesn't match any loaded template. |