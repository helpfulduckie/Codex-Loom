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

#### Item import block

Imports an item from the registry and renders it through a template. Useful for character blocks in PE.

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

With a heading and hint-style item imports:

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
| `import` | Item ID to import. If absent, block is freeform. |
| `importVariants` | Variant chains to apply to the imported item (slash-separated paths). |
| `body` | For freeform blocks: content mapping with a `text` key. For import blocks: additional body field overrides. |
| `pronouns` | For freeform blocks: pronoun set for token resolution within `body.text`. |
| `branches` | Branch dispatch spec — uses the same `resolveBranchSpec` mechanism as item-level `branches:`. |
| `render.style` | `full` (default), `hint`, or `skip`. `hint` tries a `TemplateName.hint` template first. `skip` excludes the block. |
| `render.wrapper` | `square` → `[ ... ]`, `curly` → `{ ... }`, `none` → raw. |
| `render.stripFence` | Boolean. When `true`, strips everything up to and including the last `~~~` line from the rendered output (keeps only the item body, not the story card header). |
| `render.position` | Numeric sort key for block ordering. Default `5`. Lower numbers appear first. |
| `render.template` | Template override for the imported item. Falls back to the item's own `render.template` / `aid.type`. |
| `variants` | Local item deltas applied after import resolution. |

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

For a character block in PE, you typically want only the item body (not the `## Name` header and `~~~` fence). Set `render.stripFence: true`:

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
item:                              # optional; story card metadata for AIN item output
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
- No `item:` block is supported (ignored with a warning if present)
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

All path values in the config file support `{%variable}` and `{@Key}` token expansion, resolved the same way as `include:` paths — relative to `compile.yaml`.

```yaml
# description.yaml with token expansion
body:   '{@bodyKey}'                   # {@Key} resolved from structure.input.components
script: '{@scripts}/library.js'        # {@ dir key} + path suffix
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

Both expand `{%variable}` tokens against the variables in scope (root variables for the root label; branch-merged variables for a branch label). Neither accepts a file path or `{@Key}` reference — the value is used as literal text.
