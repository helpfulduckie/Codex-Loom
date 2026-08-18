---
name: aid-codex-loom
description: >
  This skill should be used when the user is working with Codex Loom — a YAML-to-Markdown compiler
  for AI Dungeon scenarios. Use this skill when the user asks to "write a Codex Loom compile.yaml",
  "add an item to my Codex Loom project", "add a card", "set up branches", "create a variant",
  "write character YAML", "configure Plot Essentials", "set up AI Instructions", "write a
  template", "import a canon item", "configure components", "declare a slot", "set a render
  target", or "use field operations". Also use when the user mentions Codex Loom by name, asks
  about the item YAML schema, branch dispatch, pronoun tokens, slots and placement, or
  compile-time output structure. Also use when reviewing Velvet Lattice compiled output for format
  correctness, cross-branch consistency, or bleed — and when validating a migration from a legacy
  VL project to a new Codex Loom compiled version. This skill covers YAML authoring and compiled
  output review — for AID engine behavior, Story Card triggers, and narrative design use
  aid-scenario; for scripting use aid-scripting.
---

# Codex Loom — Authoring Skill

> **Status: describes v4, which is a clean break from the released v3.3.2.**
>
> There is no compatibility mode. A v3 project does not compile: `version: 4` is required,
> `cards:` is now `items:`, canon is referenced with `{%name}` rather than `{@name}`, and
> Plot Essentials' block list is now a named-sections document. Each of those fails loudly
> rather than silently, and the migration tables at the end of the reference files say what
> each v3 form becomes.
>
> Phases 4–8 are additive and will land as edits rather than a rewrite.
>
> This unpacked tree is the only editable copy; `.skill` is a zip built from it.

Codex Loom is a command-line compiler that turns YAML item definitions into Velvet Lattice files for AI Dungeon scenarios. You write items (characters, locations, settings) in structured YAML; the compiler resolves pronoun tokens, applies branch-specific variant chains, and produces one complete output folder per playable branch.

**The central idea is that an item declares where it renders.** An item can become a story card, or content inside a component like Plot Essentials, or both. The component declares named slots and never learns who filled them; the item names the slot it belongs in. Everything else follows from that.

This skill covers authoring the file types you write: `compile.yaml`, item YAML files, `.template`/`.partial` files, and component YAML files.

---

## Project Structure

```
my-project/
  compile.yaml               ← required; entry point
  Codex/                     ← project item definitions and imports
  canon/                     ← shared canonical item definitions (referenced via {%name})
  templates/                 ← .template and .partial files
  SCHEMA.md                  ← project schema + authoring conventions (read before writing items)
  components/
    plot-essentials.yaml     ← Components/Plot Essentials.md content
    ai-instructions.yaml     ← Components/AI Instructions.md content
    authors-note.yaml        ← Components/Author Notes.md content
  output/                    ← compiler output (do not edit manually)
```

When working in a Codex Loom project, check for a `SCHEMA.md` in the project root and read
it before writing or revising items. It defines the author's template conventions, field-usage
rules, budget targets, and compression guidelines — project-specific constraints that the
generic Codex Loom schema doesn't cover.

---

## CLI

```bash
codex-loom path/to/compile.yaml         # compile a project
codex-loom path/to/project/             # compile from a directory (auto-finds compile.yaml)
codex-loom --overview path/to/output    # regenerate overview files
codex-loom --leafReview path/to/output  # regenerate leaf review files
codex-loom --lint path/to/output        # lint the compiled tree
```

Compile options modify a compile rather than selecting one:

| Flag | Effect |
|---|---|
| `-i` / `--with-inventory` | `Overview/Inventory.md` — which items landed in which slot, per branch |
| `-d` / `--with-diff` | `Overview/Shared.md` + per-leaf `.delta.md` — what varies across branches |
| `-a` / `--with-annotate` | Per-leaf field-level diff against the project base, attributed to variants |
| `-c` / `--clean` | Clear output folders first |
| `-v` / `--verbose` | Per-file logging |

`--with-inventory` is the one to reach for when an item is not where you expected — it is the only view that puts placement back together, because the output file records what a slot rendered to and never who filled it.

A leaf-review overview is also generated automatically after every compile.

---

## Quick Start: Minimal New Project

**compile.yaml**
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
  plotEssential: ./components/plot-essentials.yaml

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

**Codex/characters.yaml**
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

**components/plot-essentials.yaml**
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

**templates/Character.template**
```
{$aid.title} - {$body.Tagline}
Physical Traits: {join("; ", $body.Physical Traits.gender, $body.Physical Traits.age, $body.Physical Traits.hair, $body.Physical Traits.other)}
Personality: {join(", ", $body.Personality.keywords)}
```

A template renders the **body alone** — the story-card envelope (`##` heading, `~~~` fence, `triggers:`) is emitted by Codex Loom. A `~~~` fence left in a `.template` file is `CL0410`.

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

**Canon vs project items** — canon items live in shared directories named under `structure.input.canon`; project items live under `structure.input.items`. Each canon name is automatically a `{%name}` variable. Pull canon in with `import:` (one item, full control) or `include:` (a whole file, optionally filtered).

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

### Import a canon item with local overrides

```yaml
- import: Felicia           # canon item ID
  importVariants: [noble]   # apply the canon "noble" variant chain first
  body:
    Tagline: +{; guild liaison}   # append to the existing tagline
  variants:
    felix:
      importVariants: [Felix]     # apply the canon Felix variant on this branch
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

---

## Variants as Situational Versions

The variant system isn't only for branch dispatch (race swaps, gender swaps, per-path
changes). It's also the mechanism for maintaining multiple *versions* of the same item for
different usage contexts — even when writing the canon version of an item.

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
| `references/compile-yaml.md` | Full `compile.yaml` schema — `version:`, `structure:`, `protagonist:`, `variables:`, `placeholders:`, `components:`, `branches:`; player placeholders in full |
| `references/item-yaml.md` | Item schema — `id`, `name`, `pronouns`, `aid:`, `render:` and its targets, `body:`, `notes:`, `variants:`, `branches:` |
| `references/components.md` | The sectioned grammar — sections, slots, wrapping, ordering, per-section variants; Opening, branch framing, description, scripts |
| `references/field-operations.md` | Field ops — `+{}` append, `-{}` remove substring, `/{}/{}` swap, null remove, chained ops |
| `references/branches-variants.md` | Branch tree structure, dispatch syntax (scalar/array/null/mapping/wildcard), nested paths |
| `references/imports-includes.md` | `import:` vs `include:`, `importVariants:`, resolution order, primary variant path syntax |
| `references/templates.md` | Template syntax — `{$field}`, `{join}`, `{list}`, `{if}`, `{wrapper}`, partials, `{%var}`, and where `%placeholders%` may land |
| `references/pronouns.md` | Unscoped `{$she}`, ID refs `{$Aria}`, scoped `{$Aria.she}`, verb markers `[s]` `[is]`, cross-item refs |

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

### Migration Validation

When comparing a legacy hand-authored VL project to a new Codex Loom compiled version:

**Goal:** confirm the new version matches the old where it should, and where it differs, the difference is an intentional upgrade — not a loss or corruption.

**Process:**
1. **Item-by-item match** — for each card in the legacy project, find its counterpart in the compiled output. Flag: missing items (dropped in migration), new items (additions), and content changes. Remember that an item may deliberately have moved *out* of Story Cards and into a component — check the inventory before calling it missing.
2. **Content delta triage** — for each changed item, classify the delta:
   - *Equivalent* — wording changed but meaning preserved (acceptable)
   - *Upgrade* — content improved, expanded, or corrected (intentional)
   - *Regression* — content lost, truncated, or corrupted (flag)
   - *Unexplained* — difference with no obvious source in the YAML (flag)
3. **Trigger set comparison** — note triggers added or removed; flag any that could cause items to over-fire or under-fire compared to the legacy version
4. **Component comparison** — Opening, Plot Essentials, Summary, AI Instructions, Author's Note: match expected content, flag any lines present in legacy but absent from compiled output
5. **Branch coverage** — confirm the compiled branch set matches the intended branch structure; flag extra or missing branches

When flagging issues, be specific: quote the legacy content and the compiled content side by side, name the item and branch, and classify the delta type so the author can triage quickly.
