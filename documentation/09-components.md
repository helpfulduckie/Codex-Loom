# Components

Components are non-story-card files written to each branch leaf's `Components/` folder. They provide AID with the Opening prompt, Plot Essentials context, AI Instructions, and Author's Note. Each component is optional; if not configured, no file is written.

Components are declared in `compile.yaml` under the root-level `components:` key and/or per-branch `components:` overrides.

---

## Opening

`Opening.md` is written to a branch leaf's `Components/` folder. AID uses it to prompt the player to select a branch — typically a question or a brief description.

### Declaring an opening

In `compile.yaml`:

```yaml
components:
  opening: "Who are you?"                    # inline text
  opening: ./openings/root.md                # file path (read and written as-is)
  opening: "{%opening}/subject.md"           # component key reference
```

Per branch:

```yaml
branches:
  subject:
    protagonist: Aness
    components:
      opening: "You are a research subject assigned to the Zenus project."
  researcher:
    protagonist: Veyrn
    components:
      opening: ./openings/researcher.md
```

**Inheritance:** `opening:` inherits down to leaf nodes. A branch that doesn't declare its own `opening:` uses the nearest ancestor's value. Only leaf nodes receive an `Opening.md` file.

### `branchFraming:` for branch-point nodes

`branchFraming:` is written to a non-leaf branch node's `Components/Opening.md`. Unlike `opening:`, it does **not** inherit — it belongs to the node where it is declared.

```yaml
branches:
  tier2:
    components:
      branchFraming: "Choose a specialisation."
    branches:
      alpha: {}
      beta: {}
```

If `branchFraming:` is declared on a leaf node, it is ignored with a warning.

### YAML block openings

When `components.opening` points to a `.yaml` (or `.yml`) file, the compiler treats it as a **sequence of paragraph blocks** rather than a single text file. Each block can carry its own branch dispatch and variant, allowing paragraphs to be shared across non-sibling branches, interleaved conditionally, or varied by branch — without duplicating text.

```yaml
# compile.yaml
components:
  opening: ./opening.yaml
```

```yaml
# opening.yaml
# Universal block — no branches: key → appears in every leaf
- text: "A world of magic and intrigue awaits."

# Role paragraph — included only for subject/* leaves
- text: "You serve the empire as its subject."
  branches:
    subject: []   # [] = include with no variant
    _: ~          # _: ~ = exclude from all unmatched branches

# Role paragraph — included only for researcher/* leaves
- text: "You investigate ancient mysteries as a researcher."
  branches:
    researcher: []
    _: ~

# Mage specialization — shared across subject/mage and researcher/mage,
# with a variant for the researcher path
- text: "You have mastered the arcane arts."
  variants:
    researcher-mage:
      text: "You have mastered the arcane arts, informed by archival research."
  branches:
    subject:
      branches:
        mage: []
        _: ~
    researcher:
      branches:
        mage: researcher-mage
        _: ~
    _: ~

# Knight oath from an external file — included for */knight leaves
- text: ./paragraphs/knight-oath.md
  branches:
    '*':
      branches:
        knight: []
        _: ~

# Variable expansion works in block text
- text: "Your role as a {%role} defines your approach."
```

Included blocks are resolved in order and joined with `\n\n` to form the leaf's `Opening.md` content.

#### Block schema

| Key | Required | Description |
|---|---|---|
| `text` | yes | Inline string or path to a `.md`/`.txt` file. `{%variable}` tokens expanded. |
| `branches` | no | Branch dispatch map — same syntax as PE/item dispatch. Absent = include in all leaves. |
| `variants` | no | Named text deltas: `variantName: { text: "..." }` |

#### Branch dispatch for opening blocks

| `branches:` pattern | Effect |
|---|---|
| Absent | Block appears in all leaves |
| `branchName: []` | Include with base text for that branch (no variant) |
| `branchName: variantName` | Include with variant text for that branch |
| `branchName: ~` | Exclude from that branch |
| `_: ~` | Exclude from any branch not explicitly listed above |
| `'*': { branches: { mage: '*', _: ~ } }` | Wildcard at top level; nested rule selects mage only |

Dispatch uses the same `resolveBranchSpec` logic as Plot Essentials blocks and story card branch dispatch. See `documentation/02-compile-yaml.md` for the full dispatch syntax.

#### Text file paths

`text:` values that resolve to an existing file are read at compile time. Paths are relative to the directory of `compile.yaml` (same as all other file references). Variable tokens in the path are expanded before resolution, so `text: ./paragraphs/{%role}.md` works.

#### Existing opening behavior is unchanged

A `components.opening` pointing to a `.md`, `.txt`, or inline string continues to work exactly as before. YAML block mode activates only when the path ends with `.yaml` or `.yml`.

### Output paths

| Declaration | Output path |
|---|---|
| Root `components.opening` | `{output}/Components/Opening.md` |
| Leaf branch `components.opening` | `{output}/Branches/…/leaf/Components/Opening.md` |
| Branch-point `components.branchFraming` | `{output}/Branches/…/node/Components/Opening.md` |

---

## Plot Essentials

`Components/Plot Essentials.md` aggregates genre, setting, character blocks, and other context. It is defined in a YAML file referenced by `components.plotEssential`.

**The file is a record of named `sections:`, and it describes shape only — it never names an item.** A section either carries `text:` or is marked `slot: true`, and a slot is a place items route *into*. Membership lives on the item: an item declares `render.plotEssential` naming the slot it belongs in, and the component never learns who filled it. This is the inversion described in [01-overview.md](01-overview.md) — the component says where content can go, the item says where it goes.

Naming every section is what makes the file overridable. An importing project can reposition, edit or delete a named section; v3's blocks were anonymous and could only ever be replaced wholesale.

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
| `heading` | — | Placed before the content, inside the wrapper. Omit to suppress entirely. |
| `headingLevel` | `0` here | `1`–`6` adds a Markdown `#` prefix; `0` renders plain text. AI Instructions and Author's Note default to `2` instead. |
| `render.position` | `5` | Sort key among sections; lower is earlier. |
| `render.wrapper` | `none` | `square` → `[ … ]`, `curly` → `{ … }`, `none` → raw. |
| `render.wrap` | `each` | `each` wraps every occupant; `all` wraps the joined collection. Slots only. |
| `render.compact` | `false` | Suppress the blank line between the heading and what follows. |
| `render.bullet` | `false` | Prefix each `text:` line with `- `. |
| `branches` | — | Branch dispatch for the section, using the same `resolveBranchSpec` as items. `~` drops the section on that branch. |
| `variants` | — | Named deltas this section's `branches:` can select. |

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

**There is no component-level `variants:`.** A component declares no variants of its own, so a name here is always a selector over what its sections declare. A `variants:` block at document level is a v3 file that has not been migrated, and is reported as a misplaced key.

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

**A per-target `template:` is what `style: hint` used to be**, and it is more flexible: the story card and the Plot Essentials entry can use any two templates, rather than one template and its `.hint` sibling.

An item rendered into a slot produces body text and nothing else — the `## Name` heading and `~~~` fence belong to story-card output, and Plot Essentials is not a story card.

### Migrating a v3 Plot Essentials file

A v3 file validated against this grammar reports `blocks:` as an unknown key, which is the intended signal.

| v3 | v4 |
|---|---|
| A freeform block with `body.text` | A named section with `text:` |
| `- import: Aness` with `render.wrapper` | A slot section, plus `render.plotEssential: {slot: …}` on the Aness item |
| `blocks:` grouping under a heading | One slot with that `heading:`, and `wrap: all` if the group shared a wrapper |
| `render.style: hint` | A per-target `template:` on the item's render target |
| `render.style: skip` | Do not declare the target |
| `render.stripFence` | Deleted with the fence it removed; drop the key |
| Block `position:` deciding occupant order | `order:` on each item's render target |

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

**Document-level `branches:` and `variants:` no longer exist.** v3's AI Instructions carried both, and they were a second branch walker and a second delta vocabulary for what a section already does. Writing either now reports a misplaced-key ERROR pointing at the section surface, because the migration is exactly "move it down one level":

| v3, at the document level | v4, on the section |
|---|---|
| `branches: {subject: intimate}` with `variants: {intimate: {apply: [close]}}` | `branches: {subject: close}` on each section that defines a `close` variant |
| `variants: {detached: {sections: {rules: ~}}}` | `branches: {detached: ~}` on the `rules` section |
| `branches: {x: {ain: …, cards: …}}` | `render.storyCards` (§7.8, Phase 12) |

The two dispatches disagreed, which is the other half of why only one survives: `~` on an item or a section excludes it, while `~` on an AI Instructions document meant "apply no variants".

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

A `card:` block is carried through but not yet read — §7.8, Phase 12. Author's Note produces no story card.

---


## Scripts

`components.scripts` points to a directory that is **copied** into each branch leaf's `Scripts/` folder.

```yaml
components:
  scripts: ./scripts
```

No processing is applied — files are copied as-is.

---

## Description

`Description.md` is a **project-level** file written once to the output root, at the same level as the `Branches/` folder. Unlike other components it is not written per-branch.

Its content can come from a plain body file, from a cleaned-up banner extracted from a JavaScript script file, or both.

### Declaration modes

`components.description` accepts three formats based on file extension:

```yaml
components:
  description: ./description.md        # .md or .txt → body content only
  description: ./scripts/library.js    # .js → script banner only
  description: ./description.yaml      # .yaml → full config (body + script)
```

### Description config file (`.yaml`)

When pointing to a YAML file, the following keys are supported:

```yaml
# description.yaml
body:   ./components/description.md   # optional: path to body text file
script: ./scripts/library.js          # optional: path to JS file to extract banner from
stripTrailingInstructions: true        # optional; default false
```

All path values in the config file support `{%variable}` and `{%Key}` token expansion, resolved the same way as `include:` paths — relative to `compile.yaml`.

```yaml
# description.yaml with token expansion
body:   '{%bodyKey}'                   # {%Key} resolved from variables
script: '{%scripts}/library.js'        # a directory variable + path suffix
```

### Script banner extraction

When a `.js` file is specified (via `script:` or directly), the compiler reads the top contiguous `//` comment block and transforms it:

| Line (after stripping `//`) | Treatment |
|---|---|
| All `=` characters | Skipped (pure separator) |
| Text padded with `=` on both sides | Condensed to `=== text ===` |
| Empty | Skipped |
| Anything else | Kept as-is |

Example — this comment block:

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

Becomes:

```
=== Standard Build - 26.9.6 - library ===
- UnifiedSettings@1.1.2
- DuckieDebug@1.0.3
Paste this ONLY into the library tab in AI Dungeon scripting
```

#### `stripTrailingInstructions`

When `true`, the compiler checks whether the final group of lines (content between the last separator block and end of the comment) contains no list items (lines starting with `-` or `*`), while at least one earlier group did. If so, that final group is dropped.

This automatically removes footer instructions like "Paste this into…" without hardcoding any text.

### Combined output

When both `body:` and `script:` are set, the body content comes first, followed by a blank line, then the extracted banner:

```
[body content]

=== Standard Build - 26.9.6 - library ===
- UnifiedSettings@1.1.2
...
```

### Output path

`{output}/Description.md` — written once after all branches compile, alongside `Branches/` and `Overview/`. It is not written per-branch and cannot be declared at branch level.

---

## Label

`Label.md` holds a human-readable title and is written by two independent, same-named mechanisms depending on where `title:` is declared:

- **Root `title:`** (top-level of `compile.yaml`, sibling of `protagonist:`) — written once to `{output}/Label.md`, alongside `Description.md`. See [Root-Level Keys → title](02-compile-yaml.md#title).
- **Branch `title:`** (inside a `branches:` node) — written to that branch's own output folder (`Branches/<path>/Label.md`), falling back to the branch key when omitted. See [Branch Tree & Variant Dispatch](05-branches-and-variants.md).

Both expand `{%variable}` tokens against the variables in scope (root variables for the root label; branch-merged variables for a branch label). Neither accepts a file path or `{%Key}` reference — the value is used as literal text.
