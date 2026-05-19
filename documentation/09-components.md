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
  opening: "{@opening}/subject.md"           # component key reference
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

### `openingChoice:` for branch-point nodes

`openingChoice:` is written to a non-leaf branch node's `Components/Opening.md`. Unlike `opening:`, it does **not** inherit — it belongs to the node where it is declared.

```yaml
branches:
  tier2:
    components:
      openingChoice: "Choose a specialisation."
    branches:
      alpha: {}
      beta: {}
```

If `openingChoice:` is declared on a leaf node, it is ignored with a warning.

### Output paths

| Declaration | Output path |
|---|---|
| Root `components.opening` | `{output}/Components/Opening.md` |
| Leaf branch `components.opening` | `{output}/Branches/…/leaf/Components/Opening.md` |
| Branch-point `components.openingChoice` | `{output}/Branches/…/node/Components/Opening.md` |

---

## Plot Essentials

`Components/Plot Essentials.md` aggregates genre, setting, character blocks, and other context. It is defined in a YAML file referenced by `components.plotEssential`.

The Plot Essentials file is a **YAML sequence** of block definitions. Blocks compile in the order they appear (with optional position sorting).

### Block types

#### Freeform block

Provides arbitrary text content. Goes through pronoun and conjugation token resolution.

```yaml
- body:
    text: |
      Genre: Psychological Thriller | Dark Character Study
      Setting: Steampunk Fantasy Feudal Europe; the Royal Academy
  render:
    wrapper: square
    position: 1
```

#### Card import block

Imports a card from the registry and renders it through a template. Useful for character blocks in PE.

```yaml
- import: Aness
  importVariants: [networked]
  render:
    wrapper: curly
    stripFence: true
    position: 3
  branches:
    subject: networked
```

#### Section block

A section block groups multiple child blocks under a single shared wrapper with an optional heading. Presence of the `blocks:` key identifies it as a section. Child `render.wrapper` values are ignored — the section applies the wrapper to the combined output.

```yaml
# Group two genre lines under one square bracket
- blocks:
    - body:
        text: "Genre: Psychological Thriller"
    - body:
        text: "Genre: Dark Character Study"
  render:
    wrapper: square
    position: 1
```

With a heading and hint-style card imports:

```yaml
- blocks:
    - import: Aness
      render:
        style: hint
        stripFence: true
        position: 1
    - import: Kaiden
      render:
        style: hint
        stripFence: true
        position: 2
  heading: Hints
  headingLevel: 0        # 0 = plain text (default); 1-6 = Markdown heading
  render:
    wrapper: curly
    position: 4
    compact: false       # true = no blank line between heading and children
  branches:
    flashback: ~         # null = exclude entire section from this branch
```

Sections are **not nestable** — a child block may not itself have a `blocks:` key.

### Block fields

| Field | Description |
|---|---|
| `import` | Card ID to import. If absent, block is freeform. |
| `importVariants` | Variant chains to apply to the imported card (slash-separated paths). |
| `body` | For freeform blocks: content mapping with a `text` key. For import blocks: additional body field overrides. |
| `pronouns` | For freeform blocks: pronoun set for token resolution within `body.text`. |
| `branches` | Branch dispatch spec — uses the same `resolveBranchSpec` mechanism as card-level `branches:`. |
| `render.style` | `full` (default), `hint`, or `skip`. `hint` tries a `TemplateName.hint` template first. `skip` excludes the block. |
| `render.wrapper` | `square` → `[ ... ]`, `curly` → `{ ... }`, `none` → raw. |
| `render.stripFence` | Boolean. When `true`, strips everything up to and including the last `~~~` line from the rendered output (keeps only the card body, not the story card header). |
| `render.position` | Numeric sort key for block ordering. Default `5`. Lower numbers appear first. |
| `render.template` | Template override for the imported card. Falls back to the card's own `render.template` / `aid.type`. |
| `variants` | Local card deltas applied after import resolution. |

### Section fields

| Field | Description |
|---|---|
| `blocks` | Sequence of child block definitions. Presence of this key identifies the entry as a section. |
| `heading` | Optional heading placed before child content, inside the wrapper. Omit to suppress entirely. |
| `headingLevel` | `1`–`6` adds a Markdown `#` prefix. `0` (default) renders plain text. |
| `render.wrapper` | Applied to the entire section output (heading + joined children). Child `render.wrapper` values are ignored. |
| `render.position` | Sort key for the section among all top-level PE segments. Default `5`. |
| `render.compact` | When `true`, suppresses the blank line between the heading and the first child. Default `false`. |
| `branches` | Branch dispatch for the entire section. `~` excludes the whole section. Child blocks may also carry their own `branches:`. |

`only:` and `except:` are **not** supported directly on PE blocks; use `branches:` with null values to exclude blocks from specific branches:

```yaml
branches:
  flashback: ~    # null → exclude this block from the flashback branch
```

### strip_fence example

For a character block in PE, you typically want only the card body (not the `## Name` header and `~~~` fence). Set `render.stripFence: true`:

```yaml
- import: Aness
  importVariants: [networked]
  render:
    wrapper: curly
    stripFence: true
  branches:
    subject: networked
    researcher: ~       # exclude from researcher branch
```

Rendered output (wrapper=curly, strip_fence=true):
```
{
Aness - Journeyman Healer; Magic Researcher; Fused-Squad Subject
Physical Traits: female; mid 20s; black hair, braided, waist-length; ...
...
}
```

### Full example

```yaml
# Genre — all branches
- body:
    text: |
      Genre: Psychological Thriller | Dark Character Study
  render:
    wrapper: square
    position: 1

# Setting — all branches
- body:
    text: |
      Setting: Steampunk Fantasy Feudal Europe; the Royal Academy
  render:
    wrapper: square
    position: 2

# NPC compact reference — all branches
- import: Kaiden
  render:
    wrapper: curly
    stripFence: true
    template: pe-character
    position: 4

# You-block — one per branch, subject branch gets networked variant
- import: Aness
  importVariants: [networked]
  render:
    wrapper: curly
    stripFence: true
    position: 5
  branches:
    subject: networked
    researcher: ~

- import: Veyrn
  render:
    wrapper: curly
    stripFence: true
    position: 5
  branches:
    researcher: base
    subject: ~

# Grouped hints — one curly block with heading, excluded from flashback branch
- blocks:
    - import: Aness
      render:
        style: hint
        stripFence: true
        position: 1
    - import: Kaiden
      render:
        style: hint
        stripFence: true
        position: 2
  heading: Hints
  headingLevel: 0
  render:
    wrapper: curly
    position: 6
  branches:
    flashback: ~
```

---

## AI Instructions

`Components/AI Instructions.md` provides AID with explicit authoring or behavioral instructions. It is defined in a YAML file referenced by `components.aiInstructions`.

The AIN file is a **YAML mapping** with:

```yaml
sections:
  SectionId:
    heading: "Section Title"
    headingLevel: 2            # default: 2
    text: "prose content"      # OR a mapping: {RuleId: text} — keys are internal only, not rendered
    headingLevel: 2            # 0 = plain text heading; omit heading: to suppress entirely
    render:
      position: 5              # sort order; default 5
      compact: false           # true = no blank line between heading and text
      bullet: false            # true = prefix each text line with "- "

variants:
  DocumentVariant:
    apply: [SectionVariantName]   # apply named variant to all sections that define it
    sections:
      SectionId:                   # null → remove this section
card:                              # optional; story card metadata for AIN card output
  ...

branches:                          # branch dispatch
  branchName: variantName
  branchName:
    ain: variantName               # variant for the AIN document
    cards: [cardVariantSet]        # variant sets for story card output
```

### Sections

Each section has an optional heading and text. Text can be a plain string or a mapping — when using a mapping, the keys are purely internal identifiers (for field operations); only the values are rendered.

**Render controls:**

| Field | Default | Effect |
|---|---|---|
| `render.position` | `5` | Sort order; lower = earlier |
| `render.compact` | `false` | Suppress blank line between heading and text |
| `render.bullet` | `false` | Prefix each text line with `- ` |
| `headingLevel` | `2` | Markdown heading depth; `0` = plain text heading; omit `heading:` to suppress entirely |

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
```

The `rules` section above renders as:
```
## Writing Rules
- Second person, present tense.
- Clinical observation punctuated by visceral sensation.
```

### Branch variants

```yaml
branches:
  subject: intimate       # apply "intimate" document variant for subject branch
  researcher: detached

variants:
  intimate:
    apply: [close]        # apply "close" section variant to all sections that have it
  detached:
    apply: [distant]
    sections:
      rules:              # remove the "rules" section for detached variant
```

---

## Author's Note

`Components/Author's Note.md` works identically to AI Instructions except:

- The file structure is the same (sections, variants, branches)
- No `card:` block is supported (ignored with a warning if present)
- No story card output is produced

```yaml
# authors-note.yaml
sections:
  tone:
    text: |
      Maintain second-person perspective throughout.

branches:
  subject: subject-tone

variants:
  subject-tone:
    apply: [close]
```

---

## Scripts

`components.scripts` points to a directory that is **copied** into each branch leaf's `Scripts/` folder.

```yaml
components:
  scripts: ./scripts
```

No processing is applied — files are copied as-is.
