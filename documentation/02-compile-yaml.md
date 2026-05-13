# compile.yaml Reference

`compile.yaml` is the entry point for every Codex Loom project. It tells the compiler where to find cards and templates, where to write output, how your scenario branches, and what the protagonist is for each branch.

---

## Minimal example

```yaml
output: ./output
templates: ./templates
cards: ./cards
```

That is the smallest valid config. Everything else is optional.

---

## All top-level keys

| Key | Type | Notes |
|---|---|---|
| `output` | string or list | Where compiled output is written. See below for multiple-output form. |
| `templates` | string or list | Where `.template` and `.partial` files live. |
| `cards` | string | Where project card YAML files live. Loaded recursively. |
| `canon` | string | Path to a shared canonical cards folder. Optional. |
| `protagonist` | string | Global default protagonist ID. Used when a branch doesn't declare its own. |
| `opening` | string | Inline text or path to a file. Written to `{output}/Components/Opening.md`. |
| `overview` | string | Output directory for leaf review files. When set, leaf review files are generated automatically after each compile. |
| `branches` | mapping | Branch tree. See the Branches section below. |

All paths are relative to the location of `compile.yaml`.

---

## output

### Single output

```yaml
output: ./output
```

### Multiple outputs (list of paths)

```yaml
output:
  - ./mod-set-1
  - ./mod-set-2
```

### Multiple outputs with labels

Labels let you target specific outputs using `only_output:` and `except_output:` filters on cards and PE blocks.

```yaml
output:
  - path: ./mod-set-1
    label: modset1
  - path: ./mod-set-2
    label: modset2
```

Plain strings (with or without a list) are equivalent to the `path:` form with no label. Unlabelled outputs always compile every applicable card — `only_output:` filters on cards are ignored for unlabelled outputs (with a warning), and `except_output:` filters are also ignored.

---

## templates

### Single directory

```yaml
templates: ./templates
```

### Multiple directories

When you list multiple directories, later directories override earlier ones on name collision. Duplicate names within the same directory tree are still an error.

```yaml
templates:
  - ../../_SharedTemplates    # base set — shared across all projects
  - ./templates               # project overrides — same name here wins
```

---

## branches

The compiler enumerates all *leaf* nodes — nodes with no `branches:` key — and produces one output folder per leaf. A project with no `branches:` key produces a single root-level output.

```yaml
branches:
  subject:
    protagonist: Aness
    opening: "You are a research subject."
  researcher:
    protagonist: Veyrn
    opening: ./openings/researcher.md
```

### Nested branches

Any branch node can have sub-branches by including a nested `branches:` key.

```yaml
branches:
  A:
    opening: "Choose a path."
    branches:
      X: {}
      Y: {}
  B:
    branches:
      Z: {}
      Q: {}
```

Leaf nodes here are `A/X`, `A/Y`, `B/Z`, `B/Q`. `A` and `B` are branch points — the compiler writes their `Opening.md` (if set) but does not produce a story cards output folder for them directly.

### Per-branch keys

| Key | Notes |
|---|---|
| `protagonist` | Protagonist ID for this branch. Overrides the global `protagonist:`. |
| `opening` | Inline text or path to a file. Written to this branch's `Components/Opening.md`. |
| `branches` | Nested branch map. Present this key on a branch-point node; omit it on leaf nodes. |

An empty branch node must still be a YAML mapping — use `{}` if you have nothing to set:

```yaml
branches:
  alpha: {}
  beta: {}
```

---

## opening

`opening:` can appear at the top level of `compile.yaml` (written to `{output}/Components/Opening.md`) and at any branch node level (written to that node's `Components/Opening.md`).

The value is either:
- Inline text: used as-is.
- A path to a file (relative to `compile.yaml`): the file's contents are used.

```yaml
# Inline
opening: "Who are you?"

# File-based
opening: ./openings/intro.md
```

For multiple output paths, every output receives the Opening.md file.

---

## overview

When `overview:` is set, the compiler automatically generates one leaf-review `.overview.md` file per branch leaf after each compile. These files are for authoring reference — they show what the compiled output looks like for each playable branch as a single flat document.

```yaml
overview: ./overview
```

Filenames follow the pattern `A - B - C.overview.md` (branch path segments joined by ` - `). For a project with no branches, the scenario root folder name is used.

You can also generate these files manually without `overview:` in config:

```bash
codex-loom --leafReview path/to/output [output-dir]
```

---

## protagonist

The protagonist declared in `compile.yaml` controls how bare `$` markers in card field values resolve. When a card's `protagonist:` field matches the active branch protagonist, that card's bare `$she`, `$her~`, `$Aness` etc. resolve to `you`/`your`/`you` instead of third-person.

```yaml
protagonist: Aness        # global default

branches:
  subject:
    protagonist: Aness    # same as global here; shown for clarity
  researcher:
    protagonist: Veyrn    # different character is active protagonist
```

Protagonist matching is case-insensitive. If a branch declares no `protagonist:`, the global default is used. If there is no global default, protagonist-aware resolution is inactive for that branch.

---

## Full annotated example

```yaml
# Paths
canon: ../../_Canon
output: ./output
templates:
  - ../../_SharedTemplates
  - ./templates
cards: ./cards

# Protagonist default
protagonist: Aness

# Root-level opening (written to output/Components/Opening.md)
opening: "Who are you?"

# Leaf review output directory (generated after each compile)
overview: ./overview

# Branch tree
branches:
  subject:
    protagonist: Aness
    opening: "You are a research subject assigned to the Zenus subproject."

  researcher:
    protagonist: Veyrn
    opening: ./openings/researcher.md

  tier2:
    opening: "Choose a specialisation."
    branches:
      alpha: {}
      beta:
        protagonist: Mira
        opening: "You are Mira."
```

---

## Output folder structure

For the example above, the compiler writes:

```
output/
  Components/
    Opening.md                ← root opening
  Story Cards/
    Character/
      Character.md            ← cards not filtered to any branch
  Branches/
    subject/
      Components/
        Opening.md
        Plot Essentials.md
      Story Cards/
        Character/
          Character.md
    researcher/
      Components/
        ...
    tier2/
      Components/
        Opening.md
      Branches/
        alpha/
          Story Cards/
            ...
        beta/
          Components/
            Opening.md
          Story Cards/
            ...
```

Cards at the root level (not filtered by `only:`/`except:`) appear in every branch's output. Cards filtered to specific branches appear only in those branches' output folders.
