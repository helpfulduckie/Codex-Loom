# Components

Components are non-story-card files written to each branch leaf's `Components/` folder. They provide AID with the Opening prompt, Plot Essentials context, AI Instructions, and Author's Note. Each component is optional; if not configured, no file is written.

Components are declared in `compile.yaml` under the root-level `components:` key and/or per-branch `components:` overrides.

---

## Opening

`Opening.md` is written to a branch leaf's `Components/` folder. AID uses it to prompt the player to select a branch — typically a question or a brief description.

### An opening is an ordinary component

An `opening:` is built from `sections:` like Plot Essentials or AI Instructions, and everything the sections grammar offers applies: per-section branch dispatch and variants, `file:` and `from:` sources, `imports:`, and items routing into slots.

```yaml
# components/opening.cl.yaml
sections:
  scene:
    text: |
      The harbor is still. Nothing has happened yet, and that is the problem.
    render: {position: 1}
  company:
    slot: true                      # items with render.opening land here
    render: {position: 2}
  oath:
    file: './openings/knight-oath.md'
    branches:
      knight: []
      _: ~
```

Sections join with a blank line between them, which is what a paragraph break is in an opening.

**Prose is still the common case and costs nothing.** Most openings are a file or a sentence, and neither needs a document:

```yaml
components:
  opening: ./openings/root.md                # a file, copied verbatim
  opening: "Who are you, really?"            # a sentence, used as written
  opening: "{%openings}/{%role}.md"          # a path built from variables
```

A spec that names a file on disk is read; one that names nothing is the text itself. `{%variable}` tokens expand against the branch's merged table either way, so an inline opening may differ per branch without a document.

### Declaring an opening per branch

```yaml
branches:
  subject:
    roles:
      protagonist: Aness
    components:
      opening: "You are a research subject assigned to the Zenus project."
  researcher:
    roles:
      protagonist: Veyrn
    components:
      opening: ./openings/researcher.md
```

**`opening:` inherits down the tree**, like every other component: a branch that declares none uses the nearest ancestor's. Only leaves receive an `Opening.md` from it — an interior node's declaration flows down rather than being written where it was declared.

**A leaf with an adventure description and no opening is `CL0616`.** Velvet Lattice reads a node's prompt as its Opening or, failing that, its description, so the pairing produces the blurb as the first scene. See [Description](#description).

### `branchFraming:` for branch-point nodes

`branchFraming:` writes to a **non-leaf** node's `Components/Opening.md` — what AID shows while the player is choosing among the children below it. Unlike `opening:` it does **not** inherit: it belongs to the node where it is declared.

```yaml
branches:
  tier2:
    components:
      branchFraming: "Choose a specialisation."
    branches:
      alpha: {}
      beta: {}
```

It takes the same three shapes an opening does — a sentence, a file, or a `sections:` document — but **items cannot route into it**. Framing sits at an interior node and items are resolved per leaf, so there is no cast at that node to place. `render.branchFraming` on an item is declared and reports that nothing reads it, rather than being a bare unknown key.

Declared on a leaf, `branchFraming:` is ignored with a warning: a leaf has no children to frame.

**A `branchFraming:` declared at the project root — outside every `branches:` node — is a third, separate call site with a real limitation.** It writes once to `{output}/Components/Opening.md` before any branch node exists, and resolves through the same literal/`{%variable}`-only path a plain-prose `opening:` uses: it never checks whether its spec names a `sections:` document, so a `{$role}` token there is never attempted regardless of shape. A `branchFraming:` declared inside a branch node — the case above — goes through the ordinary sectioned-component path and resolves roles the same way `opening:` and every other component does (see [Roles](13-roles.md#using-a-role-in-prose)).

### Output paths

| Declaration | Output path |
|---|---|
| Root `components.opening` | `{output}/Components/Opening.md` (an unbranched project is its own leaf) |
| Leaf branch `components.opening` | `{output}/Branches/…/leaf/Components/Opening.md` |
| Branch-point `components.branchFraming` | `{output}/Branches/…/node/Components/Opening.md` |

Both keys write the same filename at different levels, because Velvet Lattice reads a node's prompt from `Components/Opening.md` wherever that node sits. `description:` and `adventureDescription:` share `Description.md` the same way.

`Opening.md` is capped at **4,000 characters** by AID, measured after placeholder substitution — the tightest cap in the platform and the one placeholders concentrate in. Over it is `CL0710`; from 3,600 it is `CL0711`. Branch framing lands in the same filename and is capped with it.

---

## Plot Essentials

`Components/Plot Essentials.md` aggregates genre, setting, character blocks, and other context. It is defined in a YAML file referenced by `components.plotEssential`.

**The file is a record of named `sections:`, and it describes shape only — it never names an item.** A section either carries `text:` or is marked `slot: true`, and a slot is a place items route *into*. Membership lives on the item: an item declares `render.plotEssential` naming the slot it belongs in, and the component never learns who filled it. This is the inversion described in [01-overview.md](01-overview.md) — the component says where content can go, the item says where it goes.

Naming every section is what makes the file overridable: an importing project can reposition, edit or delete a named section.

### Sections and slots

```yaml
sections:
  genre:
    text: |
      Genre: Psychological Thriller | Dark Character Study
      Setting: Steampunk Fantasy Feudal Europe; the Royal Academy
    render: {position: 1, wrapper: square}

  you:
    slot: true                      # items route in here
    render: {position: 5, wrapper: curly}

  cast:
    slot: true
    heading: Cast
    headingLevel: 0                 # 0 = plain text (the default here); 1-6 = Markdown heading
    render: {position: 6, wrapper: curly}

  hints:
    slot: true
    heading: Hints
    render: {position: 7, wrapper: curly}
    branches:
      flashback: ~                  # drop the whole section on this branch
```

And the item side, which lives in the item's own file:

```yaml
- id: Aness
  name: {display: Aness, full: Aness Vale}
  aid: {type: Character, triggers: [Aness, Vale]}
  render:
    template: Character
    storyCard: false                # this item lives in PE, not in a story card
    plotEssential: {slot: you, order: 1}
```

An item may name several targets: `storyCard: true` alongside a `plotEssential:` target produces both. See [03-item-yaml.md](03-item-yaml.md) for the full `render:` surface.

### Wrapping — `each` or `all`

**A slot owns the wrapping of what lands in it, and the item's own `render.wrapper` is ignored there.** `render.wrapper` governs story-card output only. Without this rule an item with `wrapper: curly` placed in a slot with `wrapper: curly` would ship double-braced.

**`render.wrap` decides whether that wrapper encloses each occupant or the whole collection.** The default is `each`, which is the ordinary Plot Essentials idiom — every character its own bracketed block.

```yaml
  cast:
    slot: true
    render: {position: 6, wrapper: curly}              # wrap: each — four occupants, four blocks

  party:
    slot: true
    heading: The Coinflip Company
    render: {position: 7, wrapper: curly, wrap: all}   # one wrapper around the joined list
```

### Ordering

**Sections sort by `render.position`, then by the order they are written in the file.** A document has a reading order, so it can be the tiebreak.

**Occupants within a slot sort by the target's `order:`, then by item id.** Items live in their own files after the inversion, so there is no document order to fall back on — and filesystem traversal order varies between machines and shifts when a file is renamed, which would make compiled output irreproducible. Set `order:` explicitly when a slot's sequence matters.

### Section fields

| Field | Default | Effect |
|---|---|---|
| `slot` | `false` | `true` marks a section items can route into. A slot section takes no `text:`. |
| `text` | — | A string, or a mapping of named lines. With a mapping only the values render; the names exist so a variant can edit one line without restating the block. |
| `file` | — | A path whose contents become the section's text, included verbatim. |
| `from` | — | `{script:, extract:}` — a path read through a named transform. `extract: scriptBanner` reads a JavaScript file's leading comment block. |
| `heading` | — | Placed before the content, inside the wrapper. Omit to suppress entirely. |
| `headingLevel` | `0` here | `1`–`6` adds a Markdown `#` prefix; `0` renders plain text. AI Instructions and Author's Note default to `2` instead. |
| `render.position` | `5` | Sort key among sections; lower is earlier. |
| `render.wrapper` | `none` | `square` → `[ … ]`, `curly` → `{ … }`, `none` → raw. |
| `render.wrap` | `each` | `each` wraps every occupant; `all` wraps the joined collection. Slots only. |
| `render.compact` | `false` | Suppress the blank line between the heading and what follows. |
| `render.bullet` | `false` | Prefix each `text:` line with `- `. |
| `branches` | — | Branch dispatch for the section, using the same `resolveBranchSpec` as items. `~` drops the section on that branch. |
| `variants` | — | Named deltas this section's `branches:` can select. |

**A section takes its text from one of `text:`, `file:` and `from:`.** Declaring two is `CL0619`. `file:` and `from:` paths resolve against the project base with `{%variable}` expansion, and are read once per component file rather than once per branch. The Description section below has the full account of both, including the `extract:` roster.

**Document-level keys.** Besides `sections:`, a component document may declare `imports:` (see [Sharing a component with `imports:`](#sharing-a-component-with-imports)), `branches:` (the fan-out over every section), and `metadata:` — frontmatter for the output file, emitted only by the components that write one with a place for it, which today is Description alone.

`only:` and `except:` are not supported; use `branches:` with `~`.

### Branch dispatch and variants are per section

```yaml
sections:
  genre:
    text: |
      Genre: Psychological Thriller
    branches:
      flashback: lighter            # apply this section's "lighter" variant
      briefing: ~                   # drop this section entirely
    variants:
      lighter:
        text: |
          Genre: Character Study
```

**Gating a slot off is a legitimate way to drop its whole contents from one branch**, and does not require editing every item that targets it. It becomes an ERROR only when it would make an item vanish from *every* output it declared — see `CL0610` in [11-diagnostics.md](11-diagnostics.md).

### `branches:` on the whole component

**A tone shift that affects several sections is written once, at the document level.** `branches:` on the component names *every* section it holds: the variant name is looked up in each section's own `variants:` and applied wherever it is found.

```yaml
branches:
  flashback: lighter          # every section defining "lighter" gets it
  briefing: ~                 # this branch gets no Plot Essentials file at all

sections:
  genre:
    text: "Genre: Thriller"
    variants:
      lighter: {text: "Genre: Caper"}
  tone:
    text: Write with weight.
    variants:
      lighter: {text: Write with a light touch.}
  setting:
    text: The Royal Academy.   # defines no "lighter" — untouched, and not a mistake
```

**Sections that do not define the name are silently unaffected**, because most of them will be — that is what fanning out means. A name matching *no* section is `CL0605`, which is the only report a misspelling at this position produces.

**There is no component-level `variants:`.** A component declares no variants of its own, so a name here is always a selector over what its sections declare. A `variants:` block at document level is reported as a misplaced key.

**`~` at this position excludes the whole component from that branch**, and writes no file. This is not the same as every section resolving away, which is `CL0615` and an ERROR — an exclusion is what the author asked for. An item whose only target was a slot in an excluded component is caught by `CL0610` instead, the same way a section-level `~` already behaves.

**Both dispatch positions can fire at once, and they stack.** The component's fan-out applies first, then the section's own `branches:`, so a section that names a variant specifically gets the last word over one that reached it by fan-out. Neither declaration is a denial of the other. The full resolution order for a component is: `imports:` with their `importVariants:`, then local `sections:` layering, then the component dispatch, then the section dispatch — the same order items already resolve in.

### Sharing a component with `imports:`

Every component can pull in another with `imports:`, so one document can be written once and used by many projects. This is what `imports:` exists for: a single AI Instructions body currently sits in 67 places across the scenario corpus, reached by copy or by absolute path, and neither of those supports a variant, a branch dispatch, or a one-line override.

```yaml
# shared/ai-instructions.cl.yaml — the canonical document
sections:
  narrativeTone:
    heading: Narrative Tone
    text: Write with psychological weight.
    render: {position: 1}
    variants:
      dark: {text: '+{ Do not soften outcomes. }'}

  writingRules:
    heading: Writing Rules
    render: {position: 2, bullet: true}
    text:
      pov: Second person, present tense.
      tone: Clinical observation.
```

```yaml
# the project's own ai-instructions.cl.yaml
imports:
  - from: '{%components}/ai-instructions.cl.yaml'
    importVariants: [dark]

sections:
  writingRules:                       # override by name — one line, not the block
    text:
      pov: '+{ Never break the second person. }'
  institute:                          # a section the import does not provide
    heading: The Institute
    text: Conditioning scenes are clinical.
    render: {position: 5}
  legalese: ~                         # delete an inherited section
```

**`imports:` is a list, applied in order**, so components compose: a house-style base, then a world layer, then the project's own deltas. A later import wins over an earlier one on the same section name, and the local `sections:` win over all of them.

**Local sections layer rather than replace.** A name the import provided is merged field by field with the full operation vocabulary — `+{}`, `-{}`, `/{}/{}` — so an override can edit one named line of `text:` without restating the block, move a section with `render.position` while keeping its wrapper, or add a `branches:` dispatch to a variant the *imported* section defines. A name no import provided is appended as a new section. `~` deletes an inherited one; deleting a name nothing provided is `CL0608`.

**Slots merge by name.** An imported component contributes its slots, wrappers, headings and positions, and the local file may add slots, override a wrapper or position, or delete an inherited slot with `~`. Because membership lives on items rather than in the component, an imported component describes shape only and is genuinely project-independent — an item routes into `cast` without the shared file knowing anything about that item.

**`importVariants:` is a selector, not a declaration.** The name is looked up in each imported section's own `variants:`, and applied to every section that defines it. Sections that do not are silently unaffected — most of them will be, which is the point. A selector matching *no* section at all is `CL0326`, because a misspelling would otherwise apply to nothing and say nothing.

**Paths resolve against the project base**, the same base `include:` and every `components:` entry use, and `{%variables}` expand first — including canon names, which are variables. A `from:` naming no file is `CL0606`; an import chain that loops is `CL0607` and the offending import is skipped rather than followed.

### Full example

```yaml
sections:
  genre:
    text: |
      Genre: Psychological Thriller | Dark Character Study
    render: {position: 1, wrapper: square}

  setting:
    text: |
      Setting: Steampunk Fantasy Feudal Europe; the Royal Academy
    render: {position: 2, wrapper: square}

  you:
    slot: true
    render: {position: 5, wrapper: curly}

  cast:
    slot: true
    render: {position: 6, wrapper: curly}

  hints:
    slot: true
    heading: Hints
    render: {position: 7, wrapper: curly}
    branches:
      flashback: ~
```

```yaml
# The items that fill it, in their own files
- id: Aness
  render:
    template: Character
    storyCard: false
    plotEssential: {slot: you, order: 1}
  branches: {researcher: ~}

- id: Kaiden
  aid: {type: Character, triggers: [Kaiden]}
  render:
    template: Character
    plotEssential: {slot: cast, order: 1, template: CharacterBrief}
```

**A per-target `template:` lets the story card and the Plot Essentials entry use different templates.**

An item rendered into a slot produces body text and nothing else — the `## Name` heading and `~~~` fence belong to story-card output, and Plot Essentials is not a story card.

---

## AI Instructions

`Components/AI Instructions.md` provides AID with explicit authoring or behavioral instructions, set by `components.aiInstructions`.

**It is a sectioned component, exactly like Plot Essentials and Summary.** The four differ only in the file they write and in what a bare `heading:` means — Plot Essentials and Summary read it as level 0, AI Instructions and Author's Note as level 2. Everything else on this page about sections, slots, wrapping, branch gating and section variants applies unchanged.

### Prose, or a document

The spec may point at either:

```yaml
components:
  aiInstructions: ./components/ai-instructions.md      # copied through verbatim
  aiInstructions: ./components/ai-instructions.yaml    # sections, compiled
```

A `.md` or `.txt` file is copied through with trailing blank lines trimmed and nothing else done to it. It declares no sections, so it declares no slots — an item whose `render.aiInstructions` names a slot in a passthrough component is an ERROR (`CL0611`) saying so, rather than a silent drop.

### Sections

```yaml
sections:
  narrative:
    heading: Narrative Tone
    text: |
      Write with psychological weight. The horror is not what you do to them.
    render:
      position: 1

  rules:
    heading: Writing Rules
    render:
      position: 2
      compact: true
      bullet: true
    text:
      pov: Second person, present tense.
      tone: Clinical observation punctuated by visceral sensation.

  cast:
    slot: true               # items route in here via render.aiInstructions
    render:
      position: 3
```

The `rules` section renders as:

```
## Writing Rules
- Second person, present tense.
- Clinical observation punctuated by visceral sensation.
```

**Text may be a string or a mapping of named lines.** With a mapping, the keys are internal identifiers and only the values are rendered — the names exist so a variant can replace or delete one rule without restating the block.

| Field | Default | Effect |
|---|---|---|
| `render.position` | `5` | Sort order; lower = earlier |
| `render.compact` | `false` | Suppress the blank line between heading and text |
| `render.bullet` | `false` | Prefix each text line with `- ` |
| `headingLevel` | `2` | Heading depth; `0` = plain text heading; omit `heading:` to suppress entirely |

### Branch dispatch and variants are per section

```yaml
sections:
  rules:
    text:
      pov: Second person, present tense.
      tone: Clinical observation.
    branches:
      subject: close          # on the subject branch, apply this section's "close" variant
      researcher: ~           # on the researcher branch, drop this section entirely
    variants:
      close:
        text:
          tone: Close, unsparing observation.    # edits one line; "pov" is untouched
```

**There is no document-level `branches:` or `variants:`.** Branch dispatch and variant selection are per section, as shown above; writing either at the document level reports a misplaced-key ERROR pointing at the section surface.

### Swappable alternates — `render.storyCards`

A scenario ships one version of a component in its field and offers alternates as story cards the player can read and paste in themselves — a fuller ruleset, a terser one, or the scenario-specific parts only. Every component can do this; AI Instructions is where it is used most.

```yaml
render:
  component:
    variant: concise                 # what ships in the AI Instructions field (optional)
  storyCards:
    - title: AI Instructions — Full
      variant: verbose               # a section-variant selector, applied everywhere it is defined
    - title: AI Instructions — Scenario Rules Only
      sections: [institute, pacing]   # a subset — omits the imported house style
      type: zz_AIN                     # overrides the project default (see below)
```

Each `storyCards` entry renders the component again — with the leaf's slot occupants in place — as a **trigger-less** story card: `kind: reference` is set for you, the rendered text goes in `notes:` (AID's 10,000-character `description` field), and the body is a one-line "copy the description field…" prompt. A trigger-less card never enters context, so the alternates cost nothing during play, and the `empty-triggers` lint knows not to flag them.

The card's AID `type` — which groups it in the story-card editor — resolves on three rungs, most specific first:

1. the entry's own `type:`;
2. `storyCardType.<component>` in `compile.yaml` (project-wide, e.g. `storyCardType: {aiInstructions: zz_AIN}` to sort the alternates to the end of the player's list);
3. the component's display label (`AI Instructions`, `Plot Essentials`, …).

Placement is the ordinary frontier mechanism: an alternate that renders identically across a subtree is written once at that subtree's root; one that varies per branch has each version placed on its own frontier. Two entries whose titles collide under one type are an ERROR (`CL0622`), the same as any two story cards sharing a name.

---

## Author's Note

`Components/Author Notes.md` — Velvet Lattice's spelling, not a typo — works exactly like AI Instructions, including the level-2 heading default, slots, and per-section variants.

```yaml
sections:
  tone:
    text: Maintain second-person perspective throughout.
    branches:
      subject: close
    variants:
      close:
        text: Stay inside the subject's head; report sensation before thought.
```

Author's Note produces no story card of its own, but like every component it can offer alternates through `render.storyCards` (see [AI Instructions](#swappable-alternates--renderstorycards) above).

---


## Scripts

`scripts:` points at the Velvet Lattice scripting hooks **copied** into each branch leaf's `Scripts/` folder. It is a **top-level `compile.yaml` key**, not a `components:` sub-key — putting it under `components:` is a `CL0210` error — but it merges down the branch chain the same way a component does, so a branch can swap or unbind (`~`) its script set.

```yaml
scripts: ./scripts               # a directory, copied whole

scripts:                         # or the four VL hook files, named individually
  input:   ./scripts/input.js
  context: ./scripts/context.js
  output:  ./scripts/output.js
  library: ./scripts/library.js
```

No processing is applied to the files — they are copied as-is. Path values still take `{%variable}` expansion. See [compile.yaml → scripts](02-compile-yaml.md#scripts).

---

## Description

A description is an ordinary component built from `sections:`, and there are **two keys** for it. `description:` is the scenario blurb AID shows in listings; `adventureDescription:` is the description a leaf carries, which AID applies to the adventure started from that leaf. Both write `Description.md`, at different levels — the same arrangement `opening:` and `branchFraming:` have with `Opening.md`.

```yaml
components:
  description: ./components/description.cl.yaml           # the store listing, root only
  adventureDescription: ./components/adventure.cl.yaml    # per-leaf, inherits down the tree
```

### Which key to use

| | `description:` | `adventureDescription:` |
|---|---|---|
| What AID does with it | Shows it on the scenario's listing page | Becomes the adventure's description |
| Where it is declared | The project root only | Anywhere in the tree |
| Inherits down the tree | No | Yes, like every other component |
| Where the file lands | `{output}/Description.md` | `{output}/Branches/…/Description.md`, at each leaf |
| Items can route into its slots | No | Yes |

**The scenario blurb does not inherit, and that is deliberate.** A scenario has one listing, so copying it into every leaf would write the same paragraph thirty times and say nothing new. `adventureDescription:` is the one that inherits, because a description that varies by branch is a per-adventure thing.

**Items route into an adventure description, not into the scenario blurb.** A `render.adventureDescription` target places an item in a slot exactly as `render.plotEssential` does. The blurb has no branch, so there is no cast to place into it.

### Per-node descriptions depend on an AID oversight

There is no field in the AID editor for a per-node description. Velvet Lattice writes one at every node, and AID *does* apply it to the resulting adventure — verified by uploading one. This works because reaching it requires a tool like VL, so nothing on AID's side has had reason to close it. It is harmless and unlikely to change soon, but it is an oversight rather than a feature: if it is ever closed, `adventureDescription:` stops having an effect and `description:` is unaffected.

### A leaf with a description and no opening is an ERROR

Velvet Lattice sets a node's prompt to `components["Opening"] or node.description`. A leaf carrying a description and no `Opening.md` therefore does not open on an empty prompt — it opens on the blurb, as though the store listing were the first scene. That is `CL0616`, and it is an ERROR rather than a warning because the output is wrong in a way that reads as intentional.

Give the branch an `opening:`, or drop the `adventureDescription:` it inherits:

```yaml
branches:
  silent:
    components:
      adventureDescription: ./components/adventure.cl.yaml
      opening: ./openings/silent.md      # without this, CL0616
```

### Sections take their text from three places

Besides `text:`, a section may read a file (`file:`) or read one through a named transform (`from:`). These are ordinary section keys and work in any component, not only a description.

```yaml
sections:
  pitch:
    text: |
      A psychological thriller set in {%setting}.
    render: {position: 1}

  body:
    file: './components/blurb.md'        # included verbatim
    render: {position: 2}

  modBanner:
    from:
      script: '{%scripts}/library.js'    # read through a transform
      extract: scriptBanner
    render: {position: 9}
```

**A section takes its text from one source.** Declaring `text:` alongside `file:` or `from:` is `CL0619`; the `text:` is kept and the file is ignored. Split them into two sections if both were meant to appear — which also lets each carry its own heading and position.

**Paths resolve against the project base**, the same base `imports:`, `include:` and every `components:` entry use, and `{%variable}` tokens expand first. They are read once per component file rather than once per branch, so a missing path is reported once (`CL0617`) however many leaves the component reaches.

**An override replaces the source rather than joining it.** A project importing a component whose section uses `file:` can replace it with its own `text:`, or append to the file's contents with a field operation, and neither is an error:

```yaml
imports:
  - from: '{%components}/house-blurb.cl.yaml'
sections:
  body:
    text: '+{And this project in particular.}'   # appends to the imported file's text
```

### `extract:` — the transform roster

| Name | What it reads |
|---|---|
| `scriptBanner` | The leading `//` comment block of a JavaScript file, cleaned up for prose |

An unrecognized name is `CL0618` and names the roster. Adding a transform is a row here and a function in `src/extract.js`.

#### `scriptBanner`

Reads the top contiguous `//` comment block and transforms it line by line:

| Line (after stripping `//`) | Treatment |
|---|---|
| All `=` characters | Group boundary |
| Text padded with `=` on both sides | Condensed to `=== text ===` |
| Empty | Dropped |
| Anything else | Kept as written |

This comment block:

```js
// ============================================================
// ============= Standard Build - 26.9.6 - library ============
// ============================================================
// - UnifiedSettings@1.1.2
// - DuckieDebug@1.0.3
// ============================================================
// Paste this ONLY into the library tab in AI Dungeon scripting
// ============================================================
```

becomes:

```
=== Standard Build - 26.9.6 - library ===
- UnifiedSettings@1.1.2
- DuckieDebug@1.0.3
```

**The trailing group is dropped when it reads as an install note.** If the final group has no list items and an earlier group does, it is removed — which is how "Paste this ONLY into…" stays out of a store listing without hardcoding the text. The rule needs both halves, so a banner that is entirely prose keeps all of it, and a banner whose last group is itself a list keeps that too.

There is no way to turn this off — the extractor always strips a trailing install-note group. There is no flag for it.

### `metadata:` becomes frontmatter

A component document may declare `metadata:`, which is written as a YAML frontmatter block above the body. Velvet Lattice reads scenario tags from `Description.md`'s frontmatter, which is what this is for.

```yaml
# components/description.cl.yaml
metadata:
  tags: [thriller, dark]
sections:
  pitch:
    text: A psychological thriller.
```

produces:

```
---
tags:
  - thriller
  - dark
---

A psychological thriller.
```

The key is declared on every component, but only the two description components emit it — nothing else writes a file with a place to put frontmatter. Declaring it elsewhere is `CL0620` and the metadata is ignored.

### Prose descriptions still work

A `.md` or `.txt` path is copied verbatim, exactly as it is for every other component:

```yaml
components:
  description: ./components/description.md
```

### Output paths

- `description:` → `{output}/Description.md`, written once after all branches compile, alongside `Branches/` and `Overview/`.
- `adventureDescription:` → `Description.md` at each leaf's output directory, beside that leaf's `Opening.md`.

An unbranched project is its own leaf, so both keys aim at the same file there. Declaring both is `CL0621`; the scenario blurb is what survives.

## Label

`Label.md` holds a human-readable title and is written by two independent, same-named mechanisms depending on where `title:` is declared:

- **Root `title:`** (top-level of `compile.yaml`, sibling of `protagonist:`) — written once to `{output}/Label.md`, alongside `Description.md`. See [Root-Level Keys → title](02-compile-yaml.md#title).
- **Branch `title:`** (inside a `branches:` node) — written to that branch's own output folder (`Branches/<path>/Label.md`), falling back to the branch key when omitted. See [Branch Tree & Variant Dispatch](05-branches-and-variants.md).

Both expand `{%variable}` tokens against the variables in scope (root variables for the root label; branch-merged variables for a branch label). Neither accepts a file path or `{%Key}` reference — the value is used as literal text.
