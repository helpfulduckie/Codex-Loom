---
name: aid-codex-loom
description: >
  This skill should be used when the user is working with Codex Loom — a YAML-to-Markdown compiler
  for AI Dungeon scenarios. Use this skill when the user asks to "write a Codex Loom
  compile.cl.yaml", "add an item to my Codex Loom project", "add a card", "set up branches",
  "create a variant", "write character YAML", "declare a field", "write a field table", "configure
  Plot Essentials", "set up AI Instructions", "import a library item", "configure components",
  "declare a slot", "set a render target", "bind a role", "add a context tier", "freeze the
  library", "write a lint pack", or "use field operations". Also use when the user mentions Codex
  Loom by name, asks about the item YAML schema, `fields.cl.yaml`, `templateFor`, branch dispatch,
  pronoun or role tokens, slots and placement, library snapshots, convention packs, or compile-time
  output structure. Also use when reviewing Velvet Lattice compiled output for format correctness,
  cross-branch consistency, or bleed. This skill covers YAML authoring and compiled output review —
  for AID engine behavior, Story Card triggers, and narrative design use aid-scenario; for
  scripting use aid-scripting.
---

# Codex Loom — Authoring Skill

> **Describes v4, a clean break from the released v3.3.2.** There is no compatibility mode
> — `version: 4` is required and a v3 project fails loudly rather than compiling with
> warnings. `--migrate` converts one in place; that workflow is documented in the repo's
> `documentation/15-migrating-from-v3.md` and deliberately not carried here.
>
> This unpacked tree is the only editable copy.

Codex Loom is a command-line compiler that turns YAML item definitions into Velvet Lattice files for AI Dungeon scenarios. You write items (characters, locations, settings) in structured YAML; the compiler resolves pronoun and role tokens, applies branch-specific variant chains, and produces one complete output folder per playable branch.

**Two ideas carry most of the design:**

**An item declares where it renders.** It can become a story card, or content inside a component like Plot Essentials, or both. The component declares named slots and never learns who filled them; the item names the slot it belongs in.

**A field is declared once.** `fields.cl.yaml` says what a field's label, render function and formatting are; a template is an ordered list of field names. Text templates (`.template` / `.partial`) remain as the escape hatch for what a field list cannot express.

This skill covers the file types you author: `compile.cl.yaml`, item YAML files, `fields.cl.yaml` field tables, component YAML files, and lint packs.

---

## Project Structure

```
my-project/
  compile.cl.yaml            ← required; entry point (compile.yaml also accepted)
  Codex/                     ← project item definitions and imports (*.cl.yaml)
  templates/
    fields.cl.yaml           ← field declarations, groups, and template lists
    terse.cl.yaml            ← a context tier's slot file, if the project has one
    Notes.template           ← text templates, for what a field list can't express
  components/
    plot-essentials.cl.yaml  ← Components/Plot Essentials.md content
    ai-instructions.cl.yaml  ← Components/AI Instructions.md content
    authors-note.cl.yaml     ← Components/Author Notes.md content
  snapshot/                  ← frozen library copy; committed, never hand-edited
  SCHEMA.md                  ← project conventions (read before writing items)
  output/                    ← compiler output (do not edit manually)
```

Shared item definitions live **outside** the project, in directories named under
`structure.input.library`. Each library name becomes a `{%name}` token.

**Check for a `SCHEMA.md` in the project root and read it before writing or revising
items.** It defines the author's field-usage rules, budget targets, and compression
guidelines — project-specific constraints the generic schema doesn't cover. Where it
disagrees with `--schema-tables` output, the generated tables are right.

---

## CLI

```bash
codex-loom path/to/project/             # compile (auto-finds compile.cl.yaml)
codex-loom path/to/compile.cl.yaml      # compile a named file
```

**Modes select what runs.** With no mode flag, the project compiles. Report modes read the
existing output tree.

| Mode | Effect |
|---|---|
| `-C` / `--compile` | Compile (the default) |
| `-l` / `--leafReview` | One review file per branch leaf |
| `-o` / `--overview` | A single whole-tree overview |
| `-s` / `--seed-map` | Seed map |
| `-b` / `--card-sizes` | Item body size report — the platform-cap diagnostic |
| `-L` / `--lint` | Syntax lint over the compiled tree |
| `--snapshot` | Freeze the library into `snapshot/`, with a `sync-diff.txt` review artifact |
| `--migrate` | Convert a v3 project in place; does not compile |

**Compile options modify a compile rather than selecting one.**

| Flag | Effect |
|---|---|
| `-i` / `--with-inventory` | Which items landed in which slot, per branch |
| `-d` / `--with-diff` | `Shared.md` + per-leaf `.delta.md` — what varies across branches |
| `-a` / `--with-annotate` | Per-leaf field-level diff against the project base, attributed to variants |
| `--schema-tables` | Generate `schema-tables.md` from `fields.cl.yaml` |
| `--live` | Read the live library instead of the snapshot, for this run |
| `-c` / `--clean` | Clear output folders first |
| `-v` / `--verbose` | Per-file logging |

`--lint-level=off|error|warn` overrides `lint.level` and reaches the opinion layer only.

**`--with-inventory` is the one to reach for when an item is not where you expected** — it
is the only view that puts placement back together, because the output file records what a
slot rendered to and never who filled it.

A leaf-review overview is generated automatically after every compile.

---

## Quick Start: Minimal New Project

**compile.cl.yaml**
```yaml
version: 4

structure:
  input:
    items: [./Codex]
    templates: [./templates]
  output: ./output

protagonist: Aria

placeholders:                      # asked of the player at the start of an adventure
  heroName: What should we call you?

components:
  plotEssential: ./components/plot-essentials.cl.yaml

branches:
  knight:
    protagonist: Aria
    placeholders:                  # adds to the root table on this branch only
      oath: Which oath did you swear?
    components:
      opening: "%heroName% woke with %oath% still ringing."
  mage:
    protagonist: Aria
    components:
      opening: "%heroName% woke to the smell of chalk dust."
```

**Codex/characters.cl.yaml**
```yaml
- id: Aria
  name:
    display: Aria
    full: Aria Voss
  pronouns: female
  aid:
    title: Aria Voss
    type: Character
    triggers: [Aria, Voss]
  render:
    template: Character
    storyCard: false               # Aria is the protagonist; she lives in Plot Essentials
    plotEssential: {slot: you, order: 1}
  body:
    Tagline: '%heroName%, Sworn Protector'
    Physical Traits:
      gender: female
      age: late 20s
      hair: short silver hair
    Personality:
      keywords: [determined, loyal, reserved]
  variants:
    mage:
      body:
        Tagline: Academy Mage
        Physical Traits:
          other: silver staff
  branches:
    mage: mage
```

**components/plot-essentials.cl.yaml**
```yaml
sections:
  genre:
    text: |
      Genre: Dark Fantasy | Political Intrigue
      Setting: Feudal empire; the Imperial Court
    render: {position: 1, wrapper: square}

  you:
    slot: true
    render: {position: 5, wrapper: curly}
```

**templates/fields.cl.yaml**
```yaml
fields:
  Tagline:     { from: Tagline }
  appearance:  { label: Physical Traits,
                 from: [Physical Traits.gender, Physical Traits.age,
                        Physical Traits.hair, Physical Traits.other],
                 join: "; " }
  personality: { label: Personality, from: Personality.keywords, join: ", " }

templates:
  Character: [Tagline, appearance, personality]
```

Each declaration becomes one conditional stanza, so **a field absent from an item's `body:`
emits nothing** — no empty label, no stray separator. The `templates:` key matches the
item's `aid.type` (or `render.template`).

A template renders the **body alone** — the story-card envelope (`##` heading, `~~~` fence, `triggers:`) is emitted by Codex Loom. A `~~~` fence in a `.template` file is `CL0410`.

Then run: `codex-loom ./my-project`

---

## Key Concepts

**Items** are the atomic content units, with an `id`, `name`, `pronouns`, an `aid:` block (story-card metadata), a `render:` block (template, wrapper, placement), and a `body:` block. Item files are YAML sequences — one file can hold many items, imports, and includes. (v3 called these *cards*; a story card is now one of the things an item can render into, not the item itself.)

**Placement** lives in `render:`. `storyCard:` defaults to `true`; a component key like `plotEssential:` adds a target naming a slot. An item with no `render:` block emits a story card and nothing else, so the simple case stays simple. An item that resolves into a branch must produce at least one output there, or it is an ERROR — which is what replaced v3's suppression bookkeeping.

**Components** are the non-story-card output files per branch leaf: `Plot Essentials.md`, `Summary.md`, `AI Instructions.md`, `Author Notes.md`, `Opening.md`, `Description.md`. The first four share one grammar — a record of named `sections:`, where a section carries `text:` or is marked `slot: true`. Declared in `compile.yaml` under `components:`, at root level or per branch.

**Slots** are the sections items route into. A slot owns the wrapping of everything placed in it (so an item's own `wrapper:` cannot double-brace it), and `render.wrap` chooses whether that wrapper encloses each occupant or the whole collection. Occupants sort by the target's `order:`, then by item id.

**Branches** are playable paths. The `branches:` tree in `compile.yaml` defines them; every leaf node (no sub-`branches:`) gets one output folder. A branch path is the slash-joined key sequence to the leaf (`tier2/alpha`).

**Variants** are named deltas on items — partial definitions layered on top of the base, written under `variants:`. Applied via branch dispatch or `importVariants:`. Nestable: `sci-fi/near-future` applies `sci-fi` then descends into `sci-fi.variants.near-future`. A variant can change placement as readily as content.

**Branch dispatch** maps branch names to variant names, in a `branches:` block on an item, an import, or a component *section*. Scalar = one variant; array = several in order; `~` = exclude; `'*'` = wildcard baseline. One walker serves all three, so `~` means the same thing everywhere.

**Fields and templates** — a field is declared once in `fields.cl.yaml` with its label, render function and formatting; a template is an ordered list of field and group names, and list order is output order. A field's declaration never varies by branch. `.template` / `.partial` files remain for what a list cannot express.

**`templateFor`** is a branch-merged map from rendering role (`base`, `notes`, one per component) to a selection file. It is how one branch renders different templates from another — and a **context tier** is exactly that: a branch carrying `templateFor: {base: terse.cl.yaml}`, guarded so a terse list can only shorten, never invent.

**Library vs project items** — shared items live in directories named under `structure.input.library`; project items live under `structure.input.items`. Each library name is automatically a `{%name}` variable. Pull them in with `import:` (one item, full control) or `include:` (a whole file, optionally filtered).

**A snapshot freezes the library.** Set `structure.input.snapshot` and run `--snapshot`, and every `{%name}` resolves through a committed frozen copy instead of the live source. Drift prints one informational line and never fails a build; `--live` escapes for one run.

**Roles** bind a name to an item id per branch (`roles: {LI: Kaiden}`), so `{$LI}` in prose means "whoever this branch cast in that part". A role token and an item-id token share the `{$…}` grammar. `protagonist` is an ordinary entry in `roles:`.

**Convention packs** are declarative lint data — never code — that check a mod's configuration or an authoring convention. Opt in per project with `lint.packs`; findings are coded `CL-<pack>/NNNN` and suppress independently.

**Player placeholders** (`%heroName%`) are questions the player answers once at the start of an adventure; the answer is substituted everywhere the key appears. Declared under `placeholders:` in `compile.yaml`, at root or per branch, merging per key down the tree. They work in every component and in a card's entry, name, triggers and notes — but never in the Description or a card's `type`, which are ERRORs. AID's native `${What is your name?}` spelling is also valid to write raw, and Latitude's premade `${character.name}` and its pronoun siblings *must* be, since they have no `%key%` form.

**Pronoun tokens** (`{$she}`, `{$her~}`, `{$she's}`) resolve against an item's `pronouns:` field. Character ID tokens (`{$Aria}`) resolve to "you" if that character is the active protagonist, or to their display name otherwise — with automatic verb conjugation via `[s]`, `[is]`, `[was]` markers.

---

## Common Task Patterns

### Add a new character item

```yaml
- id: Mentor
  name: Elder Roshan
  pronouns: male
  aid:
    title: Elder Roshan
    type: Character
    triggers: [Roshan, Elder]
  render:
    template: Character
  body:
    Tagline: Master Archivist
    Physical Traits:
      gender: male
      age: 60s
      hair: white beard, bald
    Personality:
      keywords: [wise, patient, cryptic]
```

No `render.storyCard` and no target, so it emits a story card and nothing else.

### Put an item into Plot Essentials

Declare the slot on the component:

```yaml
sections:
  cast:
    slot: true
    heading: Cast
    render: {position: 6, wrapper: curly}
```

Then name it on each item that belongs there:

```yaml
- id: Mentor
  aid: {type: Character, triggers: [Roshan]}
  render:
    template: Character
    plotEssential: {slot: cast, order: 2, template: CharacterBrief}
```

This item ships **both** a story card (full template) and a Cast entry (brief template). Add `storyCard: false` for a Plot-Essentials-only item — the protagonist "you" block is the usual case.

### Import a library item with local overrides

```yaml
- import: Felicia           # library item ID
  importVariants: [noble]   # apply the library's "noble" variant chain first
  body:
    Tagline: +{; guild liaison}   # append to the existing tagline
  variants:
    felix:
      importVariants: [Felix]     # apply the library's Felix variant on this branch
  branches:
    felix: felix
```

### Create a branch with per-branch components

In `compile.yaml`:
```yaml
branches:
  noble:
    protagonist: Aria
    title: The Noble Path
    components:
      opening: ./components/openings/noble.md
    variables:
      role: noble heir
  commoner:
    protagonist: Aria
    components:
      opening: "You grew up on the streets."
    variables:
      role: street thief
```

### Add a variant to an existing item (gender swap example)

```yaml
variants:
  Connor:
    name: {display: Connor, full: Connor Voss}
    pronouns: male
    aid:
      title: Connor Voss
      triggers: [Connor, Voss]
    body:
      Physical Traits:
        gender: male
        hair: -{silver}        # remove "silver", keep the rest of the string
branches:
  male-pc: Connor
```

### Move an item between outputs per branch

Placement is in `render:`, and `render:` is variant-modifiable, so this needs no new machinery:

```yaml
- id: Aria
  render:
    template: Character
  variants:
    you-block:
      render:
        storyCard: false
        plotEssential: {slot: you, order: 1}
    in-the-cast:
      render:
        storyCard: true
        plotEssential: {slot: cast, template: CharacterBrief}
  branches:
    knight: you-block
    mage: in-the-cast
```

### Drop a whole slot's contents from one branch

Gate the section, not every item that targets it:

```yaml
sections:
  hints:
    slot: true
    heading: Hints
    render: {position: 7, wrapper: curly}
    branches:
      hardMode: ~
```

This is legitimate and stays quiet. It only becomes an ERROR when it would make an item vanish from *every* output it declared — an item with `storyCard: false` whose only target was that slot.

### Add a new field to the schema

Declare it once, then name it in the templates that should read it:

```yaml
# templates/fields.cl.yaml
fields:
  allegiance: { label: Allegiance, join: "; " }

templates:
  Character: [core, allegiance, secret]
```

**A `body:` key no declaration names is `CL0426`** — content silently dropped from the card, usually a typo. **A declared field no template names is `CL0428`** — a dead declaration. Both are WARN, and between them they keep the field table from rotting.

### Bind a character to a role

```yaml
# compile.cl.yaml
roles:
  LI: Kaiden

branches:
  subject:
    roles:
      LI: Felicia        # this branch casts someone else
```

Then write prose that does not name either: `{$LI} does not raise it, and {$LI.his} restraint reads as deliberate.` Pronouns follow the bound item automatically.

### Add a low-context tier

```yaml
templateFor:
  base: templates.cl.yaml

branches:
  full: {}
  lowContext:
    templateFor: { base: ./templates/terse.cl.yaml }
```

`terse.cl.yaml` carries only a `templates:` block naming shorter lists per `aid.type`; types it does not mention inherit the full list. **Keep the slot file under the project's own `templates/`, never in a shared library** — a shared one would re-baseline every project that loads that library.

### Turn on a lint pack

```yaml
lint:
  packs:
    wtg: {}            # note the {} — a bare `wtg:` parses as null and unbinds
```

---

## Variants as Situational Versions

The variant system isn't only for branch dispatch (race swaps, gender swaps, per-path
changes). It's also the mechanism for maintaining multiple *versions* of the same item for
different usage contexts — even when writing the shared library version of an item.

### The Pattern

An item's base holds the content that's always relevant. Variants add content that's only
relevant in specific scenario types or plot focuses. The variant doesn't replace the base; it
layers additional fields or extends existing ones.

```yaml
- id: CrimeSyndicate
  # ... aid, render ...
  body:
    tagline: Warrens crime family; old blood, long memory
    overview: ...base content relevant in every scenario...
  variants:
    # Only when the syndicate's secret is central to the plot
    syndicate-conspiracy:
      body:
        secret: The syndicate has been quietly losing members to a conversion
          program. They have not forgotten.
    # Only when syndicate territory is the scenario's primary location
    syndicate-turf:
      body:
        methods: +{Fills civic gaps the corps ignore — dispute resolution,
          emergency lending, community enforcement.}
```

### Why This Matters

Without variants, you face a choice: include plot-specific content in the base (paying budget
on every turn it fires, even in scenarios where that content is irrelevant) or maintain
separate item files per scenario (which drift out of sync). Variants let you write the content
once and compile it into only the scenarios where it's needed.

### Practical Notes

- Name variants descriptively for their usage context (`helix-rivalry`,
  `expansion-focused`, `novalune-crime`), not generically (`plot`, `extra`).
- A single keyword in the base `vibe` list can carry the *flavor* of a variant's content
  without the budget cost. When moving detail to a variant, check whether a well-chosen base
  keyword preserves the hint. (E.g., keeping `expanding` in a base vibe while moving the full
  expansion-motivation text to a variant.)
- Use `+{}` field operations to *extend* base fields in a variant rather than replacing them,
  when the variant adds to rather than changes the base content. This keeps the variant delta
  minimal.
- Variants combine with render targets to compile the same source content into different
  context-tier outputs — e.g., a high-context branch that routes an item into Plot Essentials,
  and a low-context branch that ships it as a triggered story card instead. That is now one
  variant changing `render:`, not two separate definitions.

### When to Reach for a Variant vs. a Separate Item

If the content is *about the same entity* but only relevant in certain scenarios → variant.
If the content is *about a relationship between entities* complex enough to deserve its own
trigger set → separate item (see Single-Home Principle in the scenario design skill).

---

## Reference Index

Read these reference files when you need schema detail:

| File | Read when you need... |
|---|---|
| `references/compile-yaml.md` | Full `compile.cl.yaml` schema — `structure:`, `protagonist:`, `variables:`, `roles:`, `placeholders:`, `templateFor:`, `storyCardType:`, `lint:`, `components:`, `branches:`; player placeholders in full |
| `references/item-yaml.md` | Item schema — `id`, `name`, `pronouns`, `aid:`, `render:` and its targets, `body:`, `notes:`, `meta:`, `kind:`, `variants:`, `branches:` |
| `references/field-declarations.md` | **The primary rendering surface** — `fields:` / `groups:` / `templates:`, declaration keys, inline overrides, library-over-project merging, `templateFor` and the three ladders, `CL0426`–`CL0428` |
| `references/components.md` | The sectioned grammar — sections, slots, wrapping, ordering, per-section variants, `render.storyCards` alternates; Opening, branch framing, description, scripts |
| `references/field-operations.md` | Field ops — `+{}` append, `-{}` remove substring, `/{}/{}` swap, null remove, chained ops |
| `references/branches-variants.md` | Branch tree structure, dispatch syntax (scalar/array/null/mapping/wildcard), nested paths, the four branch-merged tables |
| `references/imports-includes.md` | `import:` vs `include:`, `importVariants:`, resolution order, primary variant path syntax |
| `references/roles.md` | `roles:` binding and merging, `{$LI}` in prose, where roles do and don't resolve, `CL0540`–`CL0545` |
| `references/library-snapshot.md` | `structure.input.library`, `--snapshot` / `--live`, the drift notice, `requiresRoles`, `CL0111`–`CL0116` |
| `references/context-tiering.md` | Declaring a tier, what a terse list may do, the label-membership guard, keeping one card full |
| `references/convention-packs.md` | Enabling packs, the `level:` dial, writing rules, predicates, `schema:` / `budget:` / `count:` / `mutexHint:`, the bundled `wtg` and `duckieConv` packs |
| `references/templates.md` | **The escape hatch** — `.template` / `.partial` syntax, `{join}`, `{list}`, `{if}`, `{wrapper}`, partials, and where `%placeholders%` may land |
| `references/pronouns.md` | Unscoped `{$she}`, ID refs `{$Aria}`, scoped `{$Aria.she}`, role refs `{$LI}`, verb markers `[s]` `[is]`, cross-item refs |

---

## Reading Velvet Lattice Output

Codex Loom compiles to Velvet Lattice (VL) — a markdown-with-YAML-fences format that AID's
uploader consumes. You never author VL directly; it's an intermediate format for QA review and
upload. The two tasks that arise in VL are **compiled output review** and **migration validation**.

### VL Story Card Format

A compiled story card looks like this:

```
## Bryn Lysen
~~~
triggers: [Bryn, Lysen, battlemage]
encapsulate: false
notes: '[e]'
~~~
{
Bryn Lysen - Battle Mage
Appearance: female; mid 20s; black hair, braided
Personality: inquisitive, sarcastic
[Secret: hidden detail the AI won't reveal unprompted]
}
```

| Element | Meaning |
|---|---|
| `## Title` | Author-facing label only. AID never sees it. Used for navigation in review. |
| `triggers: [...]` | Keywords that pull this card into context when they appear in recent text. |
| `encapsulate: false` | Emitted unconditionally. Velvet Lattice's own sources default it to `true` and nothing in AID depends on the author choosing, so there is no key for it. |
| `notes: '...'` | The AID description field, from the item's `notes:`. Story-card output only. |
| `{ … }` | The item's `render.wrapper`. Story-card output only — a slot owns its own wrapping. |
| `[Secret: ...]` | Content the AI has but should not reveal unless narratively appropriate. |

**`[e]` and `/]` are mod conventions, not compiler concepts.** The compiler does not know what
they mean and will not generate or validate them. `[e]` reaches the output as ordinary `notes:`
text that you write, so if a project uses the convention it is the author's string, not a flag.
A lint pack can check conventions like these; the compiler proper stays out of it.

**The AI sees only the content below the `~~~` fence.** Title and YAML front-matter are
invisible to it — the card's first line must identify its own subject. A card titled "Elena"
whose entry opens "She is…" gives the AI no name anchor.

### QA Review Checklist

When reviewing a compiled VL output for correctness and consistency:

**Format correctness (per card):**
- Entry first line names the subject (matches the title / trigger set)
- Trigger list is non-empty; triggers are specific enough to avoid constant false fires on common words
- No unresolved pronoun tokens visible (`{$she}`, `{$her~}`, etc.) — these should have resolved at compile time
- No unresolved character ID tokens visible (`{$Aria}`, `{$Aria.she}`) — same
- No template syntax visible (`{$field}`, `{join}`, `{if}`, etc.) — compile-time artifacts that should never appear in output
- No unexpanded `{%variable}` tokens

**Placement (use `--with-inventory` rather than reading every leaf):**
- Each slot holds the items it should, in the order it should
- No slot is unexpectedly empty; an `(empty)` row that should have occupants means a target named the wrong slot or the items were excluded from that branch
- A `(gated off this branch)` row is deliberate — check it was meant
- An item that should be in a component but is shipping as a story card, or vice versa

**Cross-branch consistency (comparing branch folders, or reading `--with-diff`):**
- Items that should be identical across branches are identical
- Items that should differ do so only in the expected ways (declared variant application)
- No item from Branch A appears verbatim in Branch B when it should be absent or variant-swapped
- Component files differ only where branches deliberately diverge

**Bleed detection** — the main thing to flag:
- A character, location, or concept specific to one branch appearing in another branch's cards or components
- A branch-specific name, pronoun set, or plot detail present in an item that should be shared/neutral
- A variant that was supposed to be excluded (`~` dispatch) but whose content still appears

**Intentional vs. unintentional differences:**
When two branches differ, ask: is this a declared variant, a branch-specific component, or something that shouldn't differ? Flag anything that looks like an unintentional delta — same item, different content, no variant in the source that explains it.

### Reading the Compiled Tree

**Every file is written at the node that owns it, never copied to every leaf.** Velvet Lattice inherits components, placeholders, story cards and scripts down the branch tree by itself, so a leaf resolves to its ancestors' files without holding copies. **An absent file at a leaf is not a missing file** — check the owning node before treating it as one.

`Label.md` and `Description.md` are the two exceptions, written at every node that needs them, because VL reads both from the node's own directory with no parent in scope.

**Story cards are placed by frontier, keyed on `(type, name)`.** For each card and each distinct rendered text, the emitter finds the minimal set of nodes whose subtrees partition exactly the leaves producing that text, and writes one copy per frontier node. A `variants:` item keeps one id while its name and type differ per branch, so placement is never keyed on the item id.

**A duplicate card name on one leaf is `CL0622`, an ERROR, cross-type or not.** VL merges cards by name alone, so only one ever reaches AID and an author who wrote two is always wrong.
