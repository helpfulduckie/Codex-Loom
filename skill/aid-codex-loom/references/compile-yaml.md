# compile.yaml Reference

Entry point for every Codex Loom project. Controls paths, branches, protagonist, variables, and components.

**`version: 4` is required.** There is no compatibility mode — a v3 file fails validation rather than compiling with warnings.

---

## Full Schema

```yaml
version: 4                        # required
title: The Institute

structure:
  input:
    items:                        # sequence of project item directories
      - ./Codex
    canon:                        # named mapping of canonical item directories
      characters: '{%canon}/_General/Characters'
      lore: '{%canon}/_General/Lore'
    templates:                    # sequence; later directories override earlier on name collision
      - '{%loom}/templates'
      - ./templates
  output: ../Velvet Lattice/      # required
  reports: ./Review               # optional; defaults to <output>/Overview

protagonist: Aness                # global default protagonist ID (case-insensitive)

variables:                        # key-value pairs; used as {%key}
  loom: ../../../_CodexLoom
  canon: '{%loom}/Canon'
  setting: The Royal Academy

components:                       # root-level component specs
  plotEssential: ./components/plot-essentials.yaml
  summary: ./components/summary.yaml
  aiInstructions: '{%loom}/AI Instructions/AI Instructions.md'
  authorsNote: ./components/authors-note.yaml
  description: ./components/description.yaml
  opening: "Who are you?"                    # inline text
  branchFraming: "Choose your path."

scripts: ./scripts                # top-level, not a component

branches:
  subject:
    title: The Subject's Path     # output folder name; the YAML key is still what dispatch uses
    protagonist: Aness
    components:
      opening: ./components/openings/subject.md
    variables:
      role: research subject
  researcher:
    protagonist: Veyrn
  tier2:                          # non-leaf node (has a branches: sub-key)
    components:
      branchFraming: "Choose a specialisation."
    branches:
      alpha: {}                   # leaf
      beta: {}                    # leaf
```

---

## `structure.input` Keys

### `items`
Sequence of directories to load project item YAML files from. All `.yaml` files loaded recursively. **Named `items`, not `cards`** — an item is the definition, and a story card is one of the things it can render into.

### `canon`
Named mapping of canonical item directories. All `.yaml` files loaded recursively, names matched case-insensitively.

**Each canon name is automatically exposed as a `{%name}` variable**, so a canon entry can be referenced in paths without declaring it twice.

### `templates`
Sequence of directories for `.template` and `.partial` files. Later entries override earlier on name collision. Duplicates within the same directory are an error.

### What is *not* here

`structure.input.components` is gone. Component specs live only under the root-level `components:` key and its per-branch counterparts, so there is one declaration site rather than a named-directory indirection layered under a spec. The `{@key}` reference syntax went with it — use `{%variable}` instead.

---

## Root-Level Keys

### `version`
Must be `4`. Required.

### `protagonist`
Global default protagonist ID, overridable per branch. Matched case-insensitively against item `id`.

### `variables`
Key-value pairs available in templates and field values as `{%key}`. Variables resolve against other variables, so `canon: '{%loom}/Canon'` works. Branch variables merge on top of parent variables.

### `components`
Each value is either inline text, or a path to a file. There are seven keys:

| Key | Written to | Inherits down the tree? |
|---|---|---|
| `plotEssential` | `Components/Plot Essentials.md` | yes |
| `summary` | `Components/Summary.md` | yes |
| `aiInstructions` | `Components/AI Instructions.md` | yes |
| `authorsNote` | `Components/Author Notes.md` | yes |
| `description` | `Description.md` at the node root | yes |
| `opening` | `Components/Opening.md` at a **leaf** | yes |
| `branchFraming` | `Components/Opening.md` at a **non-leaf** | **no** |

`Author Notes.md` is Velvet Lattice's spelling, not a typo.

**`opening:` and `branchFraming:` are two keys for one filename**, and the difference is where AID reads it. An `Opening.md` at a leaf is that branch's first move; anywhere else it is the framing shown while the player chooses a branch beneath that node. `branchFraming:` does not inherit, because it belongs to the node whose children it frames — declared on a leaf it is ignored with a WARN. (v3 called it `openingChoice:`.)

### `scripts`
**Top-level, not a component.** Points at a directory copied into each leaf's `Scripts/` folder, or a mapping of the four Velvet Lattice hook names. Merges per file down the branch chain.

### `branches`
Nested branch tree. Leaf = no `branches:` sub-key, and produces one output folder. Node = has `branches:`, and recurses.

| Key | Description |
|---|---|
| `title` | Output folder name (filesystem only; the YAML key is still what dispatch matches) |
| `protagonist` | Protagonist ID for this branch, overriding the parent |
| `components` | Component specs for this branch, same keys as root |
| `variables` | Variables for this subtree, merged on top of the parent's |
| `scripts` | Script set for this subtree |
| `lint` | Lint configuration for this subtree |
| `render` | Rendering defaults for this subtree |
| `branches` | Child branches, which makes this node a non-leaf |

---

## Path Resolution

All paths resolve relative to `compile.yaml`; absolute paths are valid. Missing `items`/`canon`/`templates` paths emit warnings.

---

## Output Structure

```
output/
  Story Cards/                   # root-level items (all branches)
  Branches/
    subject/                     # one folder per leaf
      Story Cards/
      Components/
        Opening.md
        Plot Essentials.md
        Summary.md
        AI Instructions.md
        Author Notes.md
      Scripts/
    researcher/
      Story Cards/
      Components/
  Review/                        # or Overview/ — wherever structure.reports points
```

Nested branches produce `Branches/tier2/Branches/alpha/` paths.

---

## Migrating a v3 compile.yaml

| v3 | v4 |
|---|---|
| *(no `version:` key)* | `version: 4`, required |
| `structure.input.cards` | `structure.input.items` |
| `structure.input.components` | Deleted — declare under root `components:` directly |
| `{@name}` references | `{%name}` variables; canon names auto-expose |
| `components.openingChoice` | `components.branchFraming` |
| `components.scripts` | Top-level `scripts:` |
| *(no summary)* | `components.summary`, if you want to seed `storySummary` |
