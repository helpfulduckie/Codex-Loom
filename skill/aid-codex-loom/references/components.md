# Components Reference

Components are non-story-card output files written to each branch leaf's `Components/` folder. All optional.

---

## Opening

`Opening.md` is written to each branch leaf. AID uses it as the branch-selection prompt.

### Declaration

```yaml
# In compile.yaml
components:
  opening: "Who are you?"                    # inline text
  opening: ./openings/root.md                # file path (read as-is)
  opening: "{@opening}/subject.md"           # {@key} component reference
```

Per branch:
```yaml
branches:
  subject:
    components:
      opening: "You are a research subject."
  researcher:
    components:
      opening: ./openings/researcher.md
```

**Inheritance:** `opening:` inherits down to leaf nodes. A leaf without its own value uses the nearest ancestor's. Only leaf nodes receive `Opening.md`.

### `openingChoice:` for branch-point nodes

Written to non-leaf node's `Components/Opening.md`. Does not inherit; ignored on leaf nodes with a warning.

```yaml
branches:
  tier2:
    components:
      openingChoice: "Choose a specialisation."
    branches:
      alpha: {}
      beta: {}
```

---

## Plot Essentials

`Components/Plot Essentials.md` aggregates genre, setting, character context. Defined as a **YAML sequence** of block definitions.

### Block types

**Freeform block** — arbitrary text:
```yaml
- body:
    text: |
      Genre: Dark Fantasy | Political Intrigue
      Setting: Steampunk Fantasy Feudal Europe; the Royal Academy
  render:
    wrapper: square
    position: 1
```

**Card import block** — renders a card through a template:
```yaml
- import: Aness
  importVariants: [networked]
  render:
    wrapper: curly
    stripFence: true
    position: 3
  branches:
    subject: networked
    researcher: ~      # exclude from researcher branch
```

### Block fields

| Field | Description |
|---|---|
| `import` | Card ID. Absent → freeform block. |
| `importVariants` | Variant chains applied to the imported card. |
| `body` | Freeform: `text` key. Import: additional body field overrides. |
| `pronouns` | For freeform blocks: pronoun set for token resolution in `body.text`. |
| `branches` | Branch dispatch — same `resolveBranchSpec` as card-level dispatch. Null → exclude. |
| `style` | `full` (default) / `hint` (tries `TemplateName.hint` first) / `skip`. |
| `render.wrapper` | `square` / `curly` / `none`. |
| `render.stripFence` | Boolean. Strips everything up to and including the last `~~~` line (removes card header, keeps body). |
| `render.position` | Numeric sort key. Default 5. Lower numbers appear first. |
| `render.template` | Template override for the imported card. |
| `variants` | Local card deltas applied after import resolution. |

### Full example

```yaml
# Genre — all branches
- body:
    text: |
      Genre: Dark Fantasy
  render:
    wrapper: square
    position: 1

# NPC reference — all branches
- import: Kaiden
  render:
    wrapper: curly
    stripFence: true
    position: 4

# You-block — one per branch
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
```

---

## AI Instructions

`Components/AI Instructions.md` — explicit authoring/behavioral instructions for AID.

Structure: a **YAML mapping** (not a sequence):

```yaml
sections:
  narrative:
    heading: Narrative Tone
    headingLevel: 2          # default: 2
    text: |
      Write with psychological weight.
    render:
      position: 1

  rules:
    heading: Writing Rules
    text:
      POV: Second person, present tense.
      Tone: Clinical observation punctuated by visceral sensation.
    render:
      position: 2

variants:
  intimate:
    apply: [close]           # apply "close" section-variant to all sections that define it
  detached:
    apply: [distant]
    sections:
      rules:                 # null → remove this section for detached variant

branches:
  subject: intimate
  researcher: detached
```

**Section fields:** `heading`, `headingLevel` (default 2), `text` (string or mapping of `id: text`), `render.position`.

**Document variants** have `apply: [sectionVariantName]` (applied to sections that define that name) and optional `sections:` (null value removes the section).

---

## Author's Note

`Components/Author's Note.md` — same structure as AI Instructions (sections, variants, branches). No `card:` block supported.

```yaml
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

`components.scripts` points to a directory copied as-is into each leaf's `Scripts/` folder. No processing applied.

```yaml
components:
  scripts: ./scripts
```
