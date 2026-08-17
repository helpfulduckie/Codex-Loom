# Components Reference

Components are the non-story-card output files written to each branch leaf's `Components/` folder. All optional.

**Four of them share one grammar.** Plot Essentials, Summary, AI Instructions and Author's Note are all *sectioned components*: a record of named `sections:`, where a section either carries `text:` or is marked `slot: true` for items to route into. They differ only in the file they write and in what a bare `heading:` means. Opening, branch framing, description and scripts each have their own shape.

---

## The sectioned grammar

**A component describes shape and never names an item.** Membership lives on the item: an item declares `render.<component>` naming a slot, and the component never learns who filled it. This is the inversion — the component says where content *can* go, the item says where it goes.

```yaml
sections:
  genre:
    text: |
      Genre: Dark Fantasy | Political Intrigue
      Setting: Steampunk Fantasy Feudal Europe; the Royal Academy
    render: {position: 1, wrapper: square}

  you:
    slot: true                      # items route in here
    render: {position: 5, wrapper: curly}

  cast:
    slot: true
    heading: Cast
    render: {position: 6, wrapper: curly}
    branches:
      flashback: ~                  # drop the whole section on this branch
```

And the item side, in the item's own file:

```yaml
- id: Aness
  name: {display: Aness, full: Aness Vale}
  aid: {type: Character, triggers: [Aness, Vale]}
  render:
    template: Character
    storyCard: false                # lives in Plot Essentials, not in a story card
    plotEssential: {slot: you, order: 1}
```

An item with no `render:` block emits a story card and nothing else. An item may name several targets at once — `storyCard: true` alongside a `plotEssential:` target produces both.

### Section fields

| Field | Default | Effect |
|---|---|---|
| `slot` | `false` | `true` marks a section items route into. A slot takes no `text:`. |
| `text` | — | A string, or a mapping of named lines. With a mapping only the values render; the names exist so a variant can edit one line without restating the block. |
| `heading` | — | Placed before the content, inside the wrapper. Omit to suppress. |
| `headingLevel` | see below | `1`–`6` adds a Markdown `#` prefix; `0` renders plain text. |
| `render.position` | `5` | Sort key among sections; lower is earlier. |
| `render.wrapper` | `none` | `square` → `[ … ]`, `curly` → `{ … }`, `none` → raw. |
| `render.wrap` | `each` | `each` wraps every occupant; `all` wraps the joined collection. Slots only. |
| `render.compact` | `false` | Suppress the blank line between heading and content. |
| `render.bullet` | `false` | Prefix each `text:` line with `- `. |
| `branches` | — | Branch dispatch for the section, same `resolveBranchSpec` items use. `~` drops the section. |
| `variants` | — | Named deltas this section's `branches:` can select. |

**`headingLevel` defaults differ by component:** `0` for Plot Essentials and Summary, `2` for AI Instructions and Author's Note. That reflects how the two pairs are actually authored — AI Instructions sections are real document structure, Plot Essentials blocks are not.

### Wrapping

**A slot owns the wrapping of what lands in it, and the item's own `render.wrapper` is ignored there** — `render.wrapper` governs story-card output only. Without this, an item with `wrapper: curly` in a slot with `wrapper: curly` would ship double-braced.

**`render.wrap` decides whether that wrapper encloses each occupant or the whole collection.** `each` is the default and the ordinary idiom — every character its own bracketed block. Use `all` for a directory-style listing under one bracket.

### Ordering

Sections sort by `render.position`, then by the order written in the file. **Occupants within a slot sort by the target's `order:`, then by item id** — items live in their own files, so there is no document order to fall back on, and filesystem order would make output irreproducible. Set `order:` explicitly when a slot's sequence matters.

### Branch dispatch and variants are per section

```yaml
sections:
  rules:
    text:
      pov: Second person, present tense.
      tone: Clinical observation.
    branches:
      subject: close        # apply this section's "close" variant
      researcher: ~         # drop this section entirely
    variants:
      close:
        text:
          tone: Close, unsparing observation.   # edits one line; "pov" untouched
```

**There is no document-level `branches:` or `variants:`.** v3's AI Instructions and Author's Note carried both; writing either now is a misplaced-key ERROR pointing at the section surface, because the migration is exactly "move it down one level".

| v3, at the document level | v4, on the section |
|---|---|
| `branches: {subject: intimate}` + `variants: {intimate: {apply: [close]}}` | `branches: {subject: close}` on each section defining a `close` variant |
| `variants: {detached: {sections: {rules: ~}}}` | `branches: {detached: ~}` on the `rules` section |
| `branches: {x: {ain: …, cards: …}}` | Not yet — becomes `render.storyCards` in a later phase |

### Prose passthrough

`aiInstructions:` and the other sectioned keys may point at a `.md` or `.txt` instead of a `.yaml`. It is copied through with trailing blank lines trimmed and nothing else done to it. A passthrough declares no sections and therefore no slots — an item targeting a slot inside one is an ERROR (`CL0611`) naming the reason, not a silent drop.

```yaml
components:
  aiInstructions: ./components/ai-instructions.md      # copied through verbatim
  aiInstructions: ./components/ai-instructions.yaml    # sections, compiled
```

---

## The four sectioned components

| Key | Output file | `headingLevel` default |
|---|---|---|
| `plotEssential` | `Components/Plot Essentials.md` | `0` |
| `summary` | `Components/Summary.md` | `0` |
| `aiInstructions` | `Components/AI Instructions.md` | `2` |
| `authorsNote` | `Components/Author Notes.md` | `2` |

`Author Notes.md` is Velvet Lattice's spelling, not a typo.

**`summary` seeds AID's `storySummary`** — the running "what has happened so far" that Auto-Summary normally writes during play. Seeding it makes an adventure start with that text as already-summarized history, which suits a scenario opening *in medias res*. Auto-Summary overwrites it as play proceeds, so it is a starting condition rather than a standing component. Expect to reach for it rarely.

---

## Opening and branch framing

`Opening.md` is written at each branch leaf; AID reads it as the branch's first move.

```yaml
components:
  opening: "Who are you?"                    # inline text
  opening: ./components/openings/root.md     # file path, read as-is
```

Per branch:
```yaml
branches:
  subject:
    components:
      opening: "You are a research subject."
  researcher:
    components:
      opening: ./components/openings/researcher.md
```

**`opening:` inherits down to leaves.** A leaf without its own value uses the nearest ancestor's, and only leaves receive `Opening.md`.

### `branchFraming:` for branch-point nodes

Written to a **non-leaf** node's `Components/Opening.md` — the framing shown while the player chooses among that node's children. The choices themselves come from each child's `title:`.

```yaml
branches:
  tier2:
    components:
      branchFraming: "Choose a specialisation."
    branches:
      alpha: {}
      beta: {}
```

**It does not inherit**, because it belongs to the node whose children it frames. Declared on a leaf it is ignored with a WARN. (v3 spelled this `openingChoice:`.)

---

## Description

`components.description` points at a `.md` or a `.yaml`, and writes `Description.md` at the node root — the AID scenario description field.

---

## Scripts

**`scripts:` is top-level, not a component.** It points at a directory copied as-is into each leaf's `Scripts/` folder, or a mapping of the four Velvet Lattice hook names. Script sets merge per file down the branch chain.

```yaml
scripts: ./scripts
```

---

## Migrating a v3 Plot Essentials file

A v3 file reports `blocks:` as an unknown key, which is the intended signal.

| v3 | v4 |
|---|---|
| A freeform block with `body.text` | A named section with `text:` |
| `- import: Aness` with `render.wrapper` | A slot section, plus `render.plotEssential: {slot: …}` on the Aness item |
| `blocks:` grouping under a heading | One slot with that `heading:`, and `wrap: all` if the group shared a wrapper |
| `style: hint` | A per-target `template:` on the item's render target |
| `style: skip` | Do not declare the target |
| `render.stripFence` | Deleted with the fence it removed; drop the key |
| Block `position:` deciding occupant order | `order:` on each item's render target |

A slot rendering produces body text and nothing else — the `## Name` heading and `~~~` fence belong to story-card output, which is why `stripFence` existed and why it no longer needs to.
