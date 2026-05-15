# Codex Loom — Redesign Notes

## Goals

- Standardize syntax conventions across all definition files
- Increase flexibility and reduce hardcoded special-casing
- Improve ease of use and writer-facing clarity
- Clean break from v2 — no backward compatibility
- Single output target; branch/variant system replaces all multi-output workarounds

---

## compile.yaml

```yaml
structure:
  input:
    cards:      # sequence of folder locations
    canon:      # mapping of named folder locations
    templates:  # sequence of folder locations
    components:
      aiInstructions: # mapping of named folder locations
      opening:        # mapping of named folder locations
      openingChoice:  # mapping of named folder locations
      plotEssential:  # mapping of named folder locations
      authorsNote:    # mapping of named folder locations
      scripts:        # mapping of named folder locations
  output: # single folder location

protagonist: ProtagonistId

components:
  aiInstructions: # file path to yaml definition | {@ComponentKey}
  opening:        # file path | literal string | {@ComponentKey}
  openingChoice:  # file path | literal string | {@ComponentKey}
  plotEssential:  # file path to yaml definition | {@ComponentKey}
  authorsNote:    # file path to yaml definition | {@ComponentKey}
  scripts:        # file path to folder of script files | {@ComponentKey}

variables: # mapping of string variables; must be declared at root to be usable in branches

branches:
  branchName1:
    title:      # folder name for this branch in output
    protagonist:
    components: # same keys as root components; overrides root for this branch and descendants
    variables:  # overrides or extends root variables for this branch and descendants
  branchName2:
    components:
    branches:
      leaf1:
      leaf2:
```

### Component Key Syntax — `{@KeyName}`

Resolves to the literal content of the mapped value — either the inline string or the contents of the referenced file. Resolved in the same pass as `{%variable}` expansion, before card field processing. Component keys and variables may reference each other; a cycle guard prevents infinite loops.

---

## variables

- String values only.
- Declared at root level; branch-level declarations override or extend root values for that branch and its descendants.
- Referenced with `{%key}` syntax in any text context.
- May reference other variables: `{%greeting}, I am {%name}`.
- Resolved in the same pass as `{@Key}` references. Cycle detection applies.

---

## opening vs openingChoice

Both map to AID's `opening` field but serve different authoring purposes and have different compiler behavior.

| | `opening` | `openingChoice` |
|---|---|---|
| Purpose | In-scenario play text shown at story start | Branch-picker prompt shown when player selects a branch |
| Inheritance | Inherits down the branch tree; descendants override | Does not inherit |
| Valid on leaf | Yes — overrides ancestor's opening for that leaf | No — compiler warns and ignores |
| Valid on branch node | Yes — all leaf descendants inherit unless they override | Yes — primary use case |
| Compile Location | Leaf nodes' Components/Opening.md | Branch nodes's Components/Opening.md |

A branch node may have both simultaneously: an `openingChoice` for the player picking between its children, and an `opening` that all its leaves inherit.

---

## Output Structure

Single output target. Follows Velvet Lattice folder conventions. Branch leaves compile to nested `Branches/` paths.

```
output/
  Story Cards/
    Character/
      Character.md
  Components/
    Opening.md
    Plot Essentials.md
    Author's Note.md
    AI Instructions.md
  Scripts/
  Branches/
    branchName/
      Story Cards/
      Components/
      Scripts/
    branchName2/
      Story Cards/
      Components/
      Branches/
        leaf1/
        leaf2/
```

Scripts are copied from their source location to the appropriate branch `Scripts/` folder as-is. No compiler processing. Future: direct Patchwork-Press integration.

---

## Card Definition Format

```yaml
- id:
  name:       # scalar string or mapping (see "The `name` Field")
  pronouns:   # male | female | nonBinary
  aid:
    title:    # story card title; up to the template to use
    type:     # AID card type (output folder name); defaults to render.template if unset
    triggers: # sequence of trigger strings
  render:
    template: # template file to use; defaults to aid.type if unset
    wrapper:  # curly | square | none
  body:       # card-specific content fields
  variants:   # named layered alterations to base card state
    namedVariant:
    namedVariant2:
      variants:
        type1:
        type2:
  branches:   # specifies which variants to apply per branch
    branchOne: namedVariant                 # scalar: apply one variant
    branchTwo: [namedVariant, other/type2]  # sequence: apply list in order
    branchThree:                            # mapping: longhand form
      apply: [namedVariant2/type1]
      branches:
        subBranch: namedVariant
    "*":                                    # wildcard: matches any branch not otherwise matched
      "*":
        subsubBranchName: namedVariant4
    excludedBranch: ~                       # null: exclude card from this branch entirely
```

### Field Notes

- `id` is the only field that cannot be altered by variants or branch blocks.
- All other fields — including `render.wrapper` — can be set and overridden through variants and branch blocks.
- `aid.type` and `render.template` each default to the other if unset. For simple cases only one needs to be specified.
- When `name` is a mapping, templates should use an explicit render function.

### Variants

Named, layered alterations to a card's base state. Can modify any field except `id`. Can be nested to any depth under a `variants:` key. Variant path syntax uses `/` to walk nested variants: `namedVariant2/type1` applies `namedVariant2` then its child `type1`. Multiple variants in a list are applied in order, each layering on top of the previous.

### branches on cards

Three value forms for branch blocks:

- **Scalar string** — apply one variant or variant path
- **Sequence** — apply list of variants/paths in order
- **Mapping** — longhand form with optional `apply:` key (scalar or sequence) and optional `branches:` key for sub-branch specification
- **Null (`~`)** — exclude this card from this branch entirely

Wildcard `"*"` matches any branch name not otherwise matched at that depth, and applies to all compiled branches including ones added to compile.yaml later. If a branch block is a mapping containing neither `apply` nor `branches`, the compiler warns.

The branches system (with wild cards and nulls) replaces the older versions only/except filtering. 

---

## Field Operations

Available in variants and branch blocks. Applied to `body` fields and eligible top-level fields.

| Operation | Syntax | Notes |
|---|---|---|
| Replace | `field: new value` | |
| Remove field | `field: ~` | |
| Append | `field: "+{value}"` | Scalar / Block scalar: convert existing scalar to the first entry of an array, append a new element Array: appends element. |
| Remove substring | `field: "-{text}"` | Array: removes matching elements. |
| Swap substring | `field: "/{old}/{new}"` | Array: applies swap to every element. |
| Sequential ops | `field:` as a sequence of op strings | Applied in order. |
| Subfield replace | nested key with new value | |
| Subfield remove | nested key with `~` | |

**Distinguishing op sequences from value arrays:** A YAML sequence is treated as an op list if empty or if every element begins with `+{`, `-{`, or `/{`. Otherwise it is a value replacement.

---

## Import

Cards can be imported from the canonical set into the current project and altered to fit the specifics of the project. Any variants defined on the canonical version can be applied to the base card or on project-level variants. Only canonical cards can be imported — project cards are always available in the registry without importing.

```yaml
- import: Zephon
  importVariants: [human/noble]  # applied first, before any branch variants
  body:                          # project-level field overrides, applied after importVariants
    tagline: arcane scholar
  variants:
    scifi:
      importVariants: [sci-fi/near-future]
      body:
        tagline: "+{corporate operative}"
  branches:
    "*": []
    scifiBranch: [scifi]
    excludedBranch: ~
```

Compiler warns if an `importVariants` path references a variant that does not exist on the canonical card.

### Resolution order for an imported card

1. Canonical base card
2. Top-level `importVariants:` chains in order
3. Top-level `body:` overrides
4. Branch variant `importVariants:` chains
5. Branch variant `body:` overrides
6. Child branch variants, recursing to active leaf

---

## Include

Sets of cards can be defined in canon and included together. Named variants can be applied across all cards in the file via `importVariants:`; cards that do not define a variant by that name are silently skipped with no warning. This silent behavior differs from a single `import:` where a missing variant is always a compiler warning.

Explicitly importing a card that also appears in an included file causes the include version to be skipped entirely. The explicit import's branch configuration is fully independent — include-level branch exclusions have no effect on it.

`{@Key}` references in include paths resolve to the path string rather than file contents, which differs from `{@Key}` in prose contexts where file contents are returned. The compiler infers which behavior applies from context.

```yaml
- include: "{@CanonCharactersFolder}/Grayls.yaml"
  importVariants: [human]        # applied to every card in the file that defines it;
                                 # silent no-op for cards that don't define this variant
  variants:
    scifi:
      importVariants: [sci-fi]
  branches:
    "*": []
    scifiBranch: [scifi]
    excludedBranch: ~            # excludes all cards in this file from this branch;
                                 # has no effect on any card explicitly imported elsewhere
```

Only canonical cards can be included. Project cards are always available in the registry without include directives.

---

## Template System

### Interpolation Syntax

```
{$field}                     top-level card field
{$body.FieldName}            body field (case-insensitive)
{$body.FieldName.subfield}   subfield
{$otherid.body.FieldName}    cross-card reference
{%variable}                  branch/project variable
{@ComponentKey}              component reference
```

### Render Functions

Declared at the template call site.

```
{$sequenceOrMap}             for sequences and mappings, by default, every entry is appended with "\n -" and then joined. This should be identical to {list($sequenceOrMap)}
{inline($name)}              space-join all values: "Aness Rozen"
{join(", ", $tags)}          join with separator; spreads arrays
{list($body.items)}          one "\n- item" line per element
{and($body.keywords)}        comma-join with "and" before last element
{prose($body.section)}       each element as a sentence: capitalize, trim trailing punctuation, add period
{block($body.section)}       one item per line, no prefix
{keys($body.mapping)}        "key: value" lines
```

Render functions are also usable inside card YAML field values.
Note: the order of mapping fields rendered via functions or by default is in order of insertion

### Conditionals

```
{if $body.field}...{/if}
{if $body.field}...{else}...{/if}
```

A value is falsy if missing, empty string, `false`, or `0`. `{else}` is optional.

### Wrapper Block

```
{wrapper}
...content...
{/wrapper}
```

Reads the card's resolved `render.wrapper` value (`curly`, `square`, or `none`) and applies the appropriate AID wrapper. If the template does not use the block form, `render.wrapper` is applied post-render as a wrap around the entire output. Either way, `render.wrapper` always has an effect. `render.wrapper` is variant-overridable and can differ per branch.

### Partials

```
{include PartialName}
```

Expanded depth-first before any other template processing. Circular includes are a compile error. Partial files use the `.partial` extension. Name resolution is case-insensitive. Later template directories override earlier ones on name collision; duplicates within the same directory are an error.

### Hint Templates

For cards imported into Plot Essentials with `style: hint`, the compiler looks for `{templateName}.hint.template` first, then falls back to `{templateName}.template` with a warning. The same fallback chain applies whether the template name comes from `render.template` or `aid.type`.

### Literal Delimiters

```
{{  →  {        }}  →  }
[[  →  [        ]]  →  ]
```

Single `[` opens a whitespace-preserve block (see below). `[[` is the escape for a literal `[` that should not open a preserve block.

### Whitespace Normalization

Applies to all rendered text output including templates, openings, and component prose.

**Stage 1 — Conditional evaluation.** Evaluate all `{if}`/`{/if}` blocks. False blocks are removed entirely including their internal newlines. Surrounding whitespace is left for Stage 2.

**Stage 2 — Normalization** (in order):
- Content inside `[...]` blocks is preserved exactly as authored (Not `[[]]` blocks!)
- Strip tabs outside preserve blocks
- Collapse runs of whitespace-only lines to a single blank line
- Collapse 3+ consecutive newlines to `\n\n`
- Deduplicate spaces
- Trim leading/trailing whitespace from the whole document
- `[[`, `{{`, `}}`, and `]]` render as literal `[`, `{`, `}`, and `]`

---

## Protagonist & Pronoun System

### Core Principle

Cards are protagonist-agnostic by default. Any character referenced in a card can become the active protagonist for a given branch. The compiler applies second-person rendering to whichever character matches the branch protagonist; all others render in third person. `expectedProtagonist`/`protagonist`(on cards, as this field was called in previous version) has been removed.

### The `name` Field

`name` may be a scalar or a mapping. In either form, two resolvable forms are always available: a **display name** for use in prose, and a **full name** for formal contexts.

**Scalar form** — the first word becomes the display name automatically; the full value is the full name:

```yaml
name: Aness Rozen   # display → "Aness", full → "Aness Rozen"
```

**Mapping form** — explicit control over both:

```yaml
name:
  display: Aness      # what appears in prose references
  full: Aness Rozen   # formal full name
```

Additional subfields (e.g. `first`, `last`, `title`) may be added and referenced via `{$Aness.name.title}` etc., but `display` and `full` are the only compiler-reserved subfields.

### Character References — `{$Id}`

Character references use brace syntax and reference a character by their registry id.

- Matches active branch protagonist → renders as `you`
- Otherwise → renders as the character's `name.display` field

The compiler distinguishes character references from field interpolation by a single-segment path that matches a known registry id. A path with dots or no registry match is treated as field interpolation instead.

```
{$Aness} watch[es] as {$Kaiden} hand[s] {$Veyrn} the letter.
```

- Aness is protagonist: `You watch as Kaiden hands Veyrn the letter.`
- Kaiden is protagonist: `Aness watches as you hand Veyrn the letter.`
- Veyrn is protagonist: `Aness watches as Kaiden hands you the letter.`

To reference the full name explicitly: `{$Aness.full}` → `Aness Rozen` regardless of protagonist status.

### Pronoun Tokens — `{$Id.she}`, `{$Id.her~}` etc.

Scoped to a character using dot syntax within braces. Resolve to second-person pronouns if that character is the active protagonist, or to the character's `pronouns` field otherwise.

```
{$Aness.she} open[s] the door and step[s] inside.
```

- Aness is protagonist: `You open the door and step inside.`
- Otherwise: `She opens the door and steps inside.`

Unscoped braced tokens `{$she}`, `{$her~}` etc. remain available for cards authored around a single implicitly-understood character (the subject of the given card usually), resolving against the card's own `pronouns` field.

### Verb Conjugation — `[s]`, `[es]`, `[is]`, `[was]`, `[has]`

Conjugation markers resolve based on the most recently referenced `{$Id}` in the text. Scope is established by any `{$Id}` reference — character reference or scoped pronoun token — and carries forward until a new `{$Id}` reference appears.

```
{$Aness} open[s] the door and step[s] inside.
```

Both `[s]` markers scope to Aness. Aness is protagonist: `you open ... step`. Otherwise: `she opens ... steps`.

```
{$Aness} open[s] the door. {$Aness.she} step[s] inside.
```

Scope is re-established on the second sentence via `{$Aness.she}`.

**Irregular present-tense forms** use the same marker syntax:

| Marker | Singular (she/he) | Plural / you-mode |
|---|---|---|
| `[is]` | is | are |
| `[was]` | was | were |
| `[has]` | has | have |

All other verbs use `[s]` or `[es]`. These are the only English present-tense verb forms that vary by person; no other hardcoded irregular forms are needed.

**Authoring convention:** Place `{$Id}` references close to their verbs. Re-establish scope explicitly at the start of a new sentence via a new `{$Id}` reference or scoped pronoun token. Relying on implicit scope carrying across sentences without re-establishment is an authoring mistake.

### Compiler Warnings

- Any conjugation marker with no preceding `{$Id}` reference in the card → always warn
- Conjugation marker appearing more than N tokens after the last `{$Id}` reference → lint warning (threshold TBD)
- `{$Id}` references an id not found anywhere in the project registry → warn

### Cross-Card References — `{$id.body.field}`

References a resolved field on another card. Resolved in a second pass after all cards have been independently resolved. If the referenced card is not compiled for this branch, the compiler warns and falls back to the canonical base card's resolved fields. Circular references warn and leave the token as-is.

### Resolution Order

1. `{@Key}` component references and `{%variable}` expansions — simultaneous, cycle-guarded
2. First-pass card field resolution — all cards resolved independently
3. Second-pass cross-card reference resolution — `{$id.body.field}` and render functions resolved against first-pass results. Cross-card references are allowed within render functions
4. Braced pronoun token resolution — `{$she}` etc. against card's `pronouns` field
5. Verb conjugation — `[s]`, `[es]`, `[is]`, `[was]`, `[has]` against scoped character context
6. Template rendering

---

## Structured Components: Plot Essentials

Compiled per branch leaf into `Components/Plot Essentials.md`.

### Importing Cards

```yaml
- import: cardId
  style: full | hint | skip
  render:
    template:    # override card's template
    wrapper:     # override card's wrapper
    stripFence:  # boolean; strip everything above last ~~~ fence line
    position:    # float in [1, 10); defaults to 5; ties broken by order of definition
    # any additional fields the chosen template expects
  variants:      # rendering variants using standard field operation syntax
  branches:      # which variants apply per branch, using standard branch syntax
```

**`style` values:**

- `full` — render the entire card body. Card is not rendered as a separate story card.
- `hint` — render a compact version via `{templateName}.hint.template`; falls back to full template with warning if absent. Card is still rendered as a separate story card.
- `skip` — do not render on this component for this branch. Compiler warns if a card is `skip` on every branch.

Only render-related fields should be altered on PE imports. Content changes belong in the card definition.

### Inline PE Cards

Cards may be defined directly in the PE definition using standard card syntax plus PE-specific render fields.

- Never rendered as story cards.
- Not referenceable via `{$id}` variables.
- IDs are optional; serve only as author organization aids.
- Convention: inline PE cards should be Genre/Setting/Theme prose. Characters/Places/Things should be proper card definitions. Stylistic convention only, not compiler-enforced.

---

## Semi-Structured Components: AI Instructions and Author's Note

AI Instructions (AIN) and Author's Note (AN) share the same base format. AIN supports an additional `card:` block for rendering story-card versions; AN does not.

### AIN Format

```yaml
sections:
  sectionId:
    heading:      # optional display heading string
    headingLevel: # optional integer (1-6)
    render:
      template:   # optional; section-level template override
      position:   # float in [1, 10); defaults to 5; variant-overridable
    text: |       # scalar prose block
      ...
    # OR text as a mapping of named rules:
    text:
      ruleId: Rule text here...
      ruleId2: Another rule...
    variants:     # section-level variants using standard field operation syntax
      variantName:
        text: |                          # replace text entirely
          ...
        text:                            # OR operate on mapping text
          ruleId: ~                      # remove a rule
          newRule: New text              # add a rule
          existingRule: "+{more text}"   # append to a rule

card:             # optional; defines story-card renders of this component
  aid:
    name:
    type:
  render:
    template:

variants:         # document-level variants; composable, applied in order
  variantName:
    apply: [sectionVariantName]  # applies named section variant to all sections that define it
    sections:
      sectionId: ~               # null a section entirely for this variant
    card:                        # override card metadata for this variant
      aid:
        name:
      render:
        template:

branches:
  "*":
    ain: [standardVersion]
    cards: [lowContextVersion, standardVersion, highContextVersion]
  lowContextBranch: [lowContextVersion, compact]  # scalar or sequence: applies to ain only
```

**Branch value forms for AIN:**

- **Scalar or sequence** — applies to `ain:` render only; no card renders produced
- **Mapping with `ain:` and/or `cards:` keys** — controls component render and story card renders independently

**`cards:` list** — each named variant produces a distinct story card. The variant's `card.aid.name` distinguishes them in output. Compiler warns if `card.aid.name` is unset on a variant appearing in `cards:`, as the template will need to provide a title another way.

**Document variants are composable** — applied in order like card variants. `apply:` accepts a list; multiple section variants stack.

### AN Format

Identical to AIN except no `card:` block, and `branches:` uses scalar or sequence only:

```yaml
branches:
  "*": standardVersion
  lowContextBranch: [lowContextVersion, compact]
```

### Rendering

As with everything else, how these components are rendered is entirely up to the templates set by the author. The author should remember to handle text fields carrying mappings appropriately. 

### Shared behaviors

- `{%}`, `{$}`, and `{if}` syntax work in all section text.
- Whitespace normalization applies to all rendered output.

---

## Unstructured Components: Opening and OpeningChoice

Pure prose. Support `{%}`, `{$id}`, and `{if}`/`{/if}` syntax. No card imports.

Whitespace normalization (see Template System) applies. Tabs in source files are stripped at compile time and may be used freely as source formatting.

`opening` and `openingChoice` share the same prose format. Their difference is entirely in compiler behavior (inheritance, output location, leaf validity) as described in the compile.yaml section.

---

## Open Questions (Deferred)

- Lint warning token threshold N for scope-gap conjugation warnings.