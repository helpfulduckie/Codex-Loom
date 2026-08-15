---
name: aid-codex-loom
description: >
  This skill should be used when the user is working with Codex Loom — a YAML-to-Markdown compiler
  for AI Dungeon scenarios. Use this skill when the user asks to "write a Codex Loom compile.yaml",
  "add a card to my Codex Loom project", "set up branches", "create a variant", "write character
  YAML", "configure Plot Essentials", "set up AI Instructions", "write a template", "import a canon
  card", "configure components", or "use field operations". Also use when the user mentions
  Codex Loom by name, asks about the card YAML schema, branch dispatch, pronoun tokens, or
  compile-time output structure. Also use when reviewing Velvet Lattice compiled output for format
  correctness, cross-branch consistency, or bleed — and when validating a migration from a legacy
  VL project to a new Codex Loom compiled version. This skill covers YAML authoring and compiled
  output review — for AID engine behavior, Story Card triggers, and narrative design use
  aid-scenario; for scripting use aid-scripting.
---

# Codex Loom — Authoring Skill

> **Status: describes v3.3.2 — the released compiler. Do not re-upload without rewriting.**
>
> A v4 redesign is in progress on the `v4-phase1` branch and is a clean break, not an
> upgrade. This document is accurate for what people can currently run, and deliberately
> has not been carried forward: the v4 config surface alone would break the Quick Start
> below in three places (`version: 4` is required, `cards:` is now `items:`, and canon is
> referenced with `{%name}` rather than `{@name}`), and v4 renames the atomic unit from
> *card* to *item* throughout.
>
> **The rewrite waits for Phase 3**, which inverts the item/component model — items will
> declare their own placement and Plot Essentials will stop being a separately configured
> block. Those are this document's spine, so revising it earlier means revising it twice.
> Phases 4–8 are additive and will land as edits rather than a rewrite.
>
> This unpacked tree is the only editable copy; `.skill` is a zip built from it.

Codex Loom is a command-line compiler that turns YAML card definitions into Velvet Lattice story card files for AI Dungeon scenarios. You write cards (characters, locations, settings) in structured YAML; the compiler resolves pronoun tokens, applies branch-specific variant chains, and produces one complete output folder per playable branch.

This skill covers authoring the five file types you write: `compile.yaml`, card YAML files, `.template`/`.partial` files, and component YAML files (Plot Essentials, AI Instructions, Author's Note).

---

## Project Structure

```
my-project/
  compile.yaml               ← required; entry point
  cards/                     ← project card definitions and imports
  canon/                     ← shared canonical card definitions (referenced via {@name})
  templates/                 ← .template and .partial files
  SCHEMA.md                  ← card schema + authoring conventions (read before writing cards)
  plot-essentials.yaml       ← Components/Plot Essentials.md content
  ai-instructions.yaml       ← Components/AI Instructions.md content
  authors-note.yaml          ← Components/Author's Note.md content
  output/                    ← compiler output (do not edit manually)
```

When working in a Codex Loom project, check for a `SCHEMA.md` in the project root and read
it before writing or revising cards. It defines the author's template conventions, field-usage
rules, budget targets, and compression guidelines — project-specific constraints that the
generic Codex Loom schema doesn't cover.

---

## CLI

```bash
codex-loom path/to/compile.yaml      # compile a project
codex-loom path/to/project/          # compile from directory (auto-finds compile.yaml)
codex-loom --overview path/to/output # regenerate overview files
codex-loom --leafReview path/to/output  # regenerate leaf review files
```

A leaf-review overview is also generated automatically into `{output}/Overview/` after every compile.

---

## Quick Start: Minimal New Project

**compile.yaml**
```yaml
structure:
  input:
    cards: [./cards]
    templates: [./templates]
  output: ./output

protagonist: Aria

branches:
  knight:
    protagonist: Aria
    components:
      opening: "You are a knight sworn to the crown."
  mage:
    protagonist: Aria
    components:
      opening: "You are a mage of the Academy."
```

**cards/characters.yaml**
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
    encapsulate: true
    known: true
  render:
    template: Character
    wrapper: none
  body:
    Tagline: Sworn Protector
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

Then run: `codex-loom ./my-project`

---

## Key Concepts

**Cards** are atomic content units with an `id`, `name`, `pronouns`, an `aid:` block (AID metadata), a `render:` block (template, wrapper), and a `body:` block (all card content). Card files are YAML sequences — one file can hold many cards, imports, and includes.

**Branches** are playable paths. The `branches:` tree in `compile.yaml` defines them; every leaf node (no sub-`branches:`) gets one output folder. A branch path is the slash-joined key sequence to the leaf (`tier2/alpha`).

**Variants** are named deltas on cards — partial definitions that layer changes on top of the base. Written under `variants:` on a card. Applied via branch dispatch or `importVariants:`. Can be nested: `sci-fi/near-future` applies `sci-fi` then descends into `sci-fi.variants.near-future`.

**Branch dispatch** maps branch names to variant names in the `branches:` block on a card or import. Scalar = one variant; array = multiple applied in order; `~` (null) = exclude card from that branch; `'*'` = wildcard baseline.

**Canon vs project cards** — Canon cards live in shared directories; project cards live under `cards/`. Import canon cards into a project with `import:` (single card, full control) or `include:` (whole file, optional filtering).

**Pronoun tokens** (`{$she}`, `{$her~}`, `{$she's}`) resolve against a card's `pronouns:` field. Character ID tokens (`{$Aria}`) resolve to "you" if that character is the active protagonist, or to their display name otherwise — with automatic verb conjugation via `[s]`, `[is]`, `[was]` markers.

**Components** are non-card output files per branch leaf: `Opening.md`, `Plot Essentials.md`, `AI Instructions.md`, `Author's Note.md`. Declared in `compile.yaml` under `components:` at root level or per branch.

---

## Common Task Patterns

### Add a new character card (local)

```yaml
- id: Mentor
  name: Elder Roshan
  pronouns: male
  aid:
    title: Elder Roshan
    type: Character
    triggers: [Roshan, Elder]
    encapsulate: true
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

### Import a canon card with local overrides

```yaml
- import: Felicia           # canon card ID
  importVariants: [noble]   # apply canon "noble" variant chain first
  body:
    Tagline: +{; guild liaison}   # append to existing tagline
  variants:
    felix:
      importVariants: [Felix]     # apply canon Felix variant for this branch
  branches:
    felix: felix            # dispatch: felix branch → apply local "felix" variant
```

### Create a branch with per-branch components

In `compile.yaml`:
```yaml
branches:
  noble:
    protagonist: Aria
    title: The Noble Path
    components:
      opening: ./openings/noble.md
    variables:
      role: noble heir
  commoner:
    protagonist: Aria
    components:
      opening: "You grew up on the streets."
    variables:
      role: street thief
```

### Add a variant to an existing card (gender swap example)

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
        hair: -{silver}        # remove "silver", keep rest of string
branches:
  male-pc: Connor
```

### Set up Plot Essentials blocks

**plot-essentials.yaml**
```yaml
# Genre block — all branches
- body:
    text: |
      Genre: Dark Fantasy | Political Intrigue
      Setting: Feudal empire; the Imperial Court
  render:
    wrapper: square
    position: 1

# You-block — protagonist card, branch-specific variant
- import: Aria
  render:
    wrapper: curly
    stripFence: true
    position: 5
  branches:
    mage: mage        # apply mage variant for mage branch
    knight: ~         # exclude from knight branch (use story card instead)
```

---

## Variants as Situational Versions

The variant system isn't only for branch dispatch (race swaps, gender swaps, per-path
changes). It's also the mechanism for maintaining multiple *versions* of the same card for
different usage contexts — even when writing the canon version of a card.

### The Pattern

A card's base holds the content that's always relevant. Variants add content that's only
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
separate card files per scenario (which drift out of sync). Variants let you write the content
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
- Variants combine with Codex Loom's partial/component system to compile the same source
  content into different context-tier outputs — e.g., a high-context branch that includes
  ambient lore in Plot Essentials, and a low-context branch that reshapes and curates the
  same source content into Story Cards with trigger keys assigned.

### When to Reach for a Variant vs. a Separate Card

If the content is *about the same entity* but only relevant in certain scenarios → variant.
If the content is *about a relationship between entities* complex enough to deserve its own
trigger set → separate card (see Single-Home Principle in the scenario design skill).

---

## Reference Index

Read these reference files when you need schema detail:

| File | Read when you need... |
|---|---|
| `references/compile-yaml.md` | Full `compile.yaml` schema — `structure:`, `protagonist:`, `variables:`, `branches:`, all keys |
| `references/card-yaml.md` | Card schema — `id`, `name`, `pronouns`, `aid:`, `render:`, `body:`, `variants:`, `branches:` on cards |
| `references/field-operations.md` | Field ops — `+{}` append, `-{}` remove substring, `/{}/{}` swap, null remove, chained ops |
| `references/branches-variants.md` | Branch tree structure, dispatch syntax (scalar/array/null/mapping/wildcard), nested paths |
| `references/imports-includes.md` | `import:` vs `include:`, `importVariants:`, resolution order, primary variant path syntax |
| `references/templates.md` | Template syntax — `{$field}`, `{join}`, `{list}`, `{if}`, `{wrapper}`, partials, `{%var}` |
| `references/components.md` | Opening, Plot Essentials blocks, AI Instructions sections/variants, Author's Note |
| `references/pronouns.md` | Unscoped `{$she}`, ID refs `{$Aria}`, scoped `{$Aria.she}`, verb markers `[s]` `[is]`, cross-card refs |

---

## Reading Velvet Lattice Output

Codex Loom compiles to Velvet Lattice (VL) — a markdown-with-YAML-fences format that AID's
uploader consumes. You never author VL directly; it's an intermediate format for QA review and
upload. The two tasks that arise in VL are **compiled output review** and **migration validation**.

### VL Card Format

A compiled card looks like this:

```
## Card Title

~~~
triggers: [Trigger1, Trigger2]
encapsulate: true
~~~

[e] Subject Name - Tagline
Field: value
Field: value
[Secret: hidden detail the AI won't reveal unprompted]
```

**Fields:**

| Element | Meaning |
|---|---|
| `## Card Title` | Author-facing label only. AID never sees it. Used for navigation in review. |
| `triggers: [...]` | Keywords that pull this card into context when they appear in recent text. |
| `encapsulate: true` | Keeps card content self-contained in context; standard on most cards. |
| `[e]` prefix | Marks this as pre-existing background knowledge — no discovery timestamp. Use for world facts the player character knew before play. |
| No `[e]` | Card describes something discovered during play. AID prepends a discovery timestamp. |
| `/]` marker | Appears near the end of non-`[e]` cards; marks where the timestamp is inserted. Never appears alongside `[e]`. |
| `[Secret: ...]` | Content the AI has but should not reveal unless narratively appropriate. Can appear in any card. |

**Rule: `[e]` and `/]` are mutually exclusive.** A card with both is malformed.

**The AI sees only the content below the `~~~` fence.** Title and YAML front-matter are
invisible to it — the card's first line must identify its own subject. A card titled "Elena"
whose entry opens "She is…" gives the AI no name anchor.

### QA Review Checklist

When reviewing a compiled VL output for correctness and consistency:

**Format correctness (per card):**
- Entry first line names the subject (matches the title / trigger set)
- `[e]` cards have no `/]`; non-`[e]` cards have `/]` near the end
- No card has both `[e]` and `/]`
- `encapsulate: true` present where expected (most cards; deliberate absence is the exception)
- Trigger list is non-empty; triggers are specific enough to avoid constant false fires on common words
- No unresolved pronoun tokens visible (`{$she}`, `{$her~}`, etc.) — these should have resolved at compile time
- No unresolved character ID tokens visible (`{$Aria}`, `{$Aria.she}`) — same
- No template syntax visible (`{$field}`, `{join}`, `{if}`, etc.) — these are compile-time artifacts that should never appear in output

**Cross-branch consistency (comparing branch folders):**
- Cards that should be identical across branches are identical
- Cards that should differ between branches differ only in the expected ways (declared variant application)
- No card from Branch A appears verbatim in Branch B when it should be absent or variant-swapped
- Component files (Opening, Plot Essentials, AI Instructions, Author's Note) differ only where branches deliberately diverge

**Bleed detection** — the main thing to flag:
- A character, location, or concept specific to one branch appearing in another branch's cards or components
- A branch-specific name, pronoun set, or plot detail present in a card that should be shared/neutral
- A variant that was supposed to be excluded (`~` dispatch) but whose content still appears

**Intentional vs. unintentional differences:**
When two branches differ, ask: is this a declared variant, a branch-specific component, or something that shouldn't differ? Flag anything that looks like an unintentional delta — same card, different content, no variant in the source that explains it.

### Migration Validation

When comparing a legacy hand-authored VL project to a new Codex Loom compiled version:

**Goal:** confirm the new version matches the old where it should, and where it differs, the difference is an intentional upgrade — not a loss or corruption.

**Process:**
1. **Card-by-card match** — for each card in the legacy project, find its counterpart in the compiled output. Flag: missing cards (dropped in migration), new cards (additions), and content changes.
2. **Content delta triage** — for each changed card, classify the delta:
   - *Equivalent* — wording changed but meaning preserved (acceptable)
   - *Upgrade* — content improved, expanded, or corrected (intentional)
   - *Regression* — content lost, truncated, or corrupted (flag)
   - *Unexplained* — difference with no obvious source in the YAML (flag)
3. **Trigger set comparison** — note triggers added or removed; flag any that could cause cards to over-fire or under-fire compared to the legacy version
4. **Component comparison** — Opening, Plot Essentials, AI Instructions, Author's Note: match expected content, flag any lines present in legacy but absent from compiled output
5. **Branch coverage** — confirm the compiled branch set matches the intended branch structure; flag extra or missing branches

When flagging issues, be specific: quote the legacy content and the compiled content side by side, name the card and branch, and classify the delta type so the author can triage quickly.
