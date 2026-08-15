# compile.yaml Reference

Entry point for every Codex Loom project. Controls paths, branches, protagonist, variables, and components.

---

## Full Schema

```yaml
structure:
  input:
    cards:                        # sequence of project card directories
      - ./cards
    canon:                        # named mapping of canonical card directories
      main: ../../_Canon          # referenced as {@main} in include paths
      lore: ./lore-cards
    templates:                    # sequence; later directories override earlier on name collision
      - ../../_SharedTemplates
      - ./templates
    components:                   # named mappings per component type
      aiInstructions:
        default: ./ai-instructions.yaml
      plotEssential:
        default: ./plot-essentials.yaml
      authorsNote:
        default: ./authors-note.yaml
      opening:
        default: ./openings
      openingChoice:
        default: ./openings
      scripts:
        default: ./scripts
  output: ./output                # defaults to ./output if omitted

protagonist: Aness                # global default protagonist ID (case-insensitive)

variables:                        # key-value pairs; used in templates as {%key}
  setting: The Royal Academy
  year: "1315"

components:                       # root-level component specs
  opening: "Who are you?"                  # inline text
  plotEssential: ./plot-essentials.yaml    # file path
  aiInstructions: "{@default}"             # {@key} reference to named component dir/file
  authorsNote: ./authors-note.yaml
  scripts: ./scripts

branches:
  subject:
    title: The Subject's Path     # output folder name (key used for dispatch, title used for path)
    protagonist: Aness
    components:
      opening: ./openings/subject.md
    variables:
      role: research subject
  researcher:
    protagonist: Veyrn
  tier2:                          # non-leaf node (has branches: sub-key)
    components:
      openingChoice: "Choose a specialisation."
    branches:
      alpha: {}                   # leaf
      beta: {}                    # leaf
```

---

## `structure.input` Keys

### `cards`
Sequence of directories to load project card YAML files from. All `.yaml` files loaded recursively.

### `canon`
Named mapping of canonical card directories. Name is used in `{@name}` references in include paths and error messages. All `.yaml` files loaded recursively. Names matched case-insensitively.

### `templates`
Sequence of directories for `.template` and `.partial` files. Later entries override earlier on name collision. Duplicates within the same directory are an error.

### `components`
Named directory/file mappings per component type. Referenced via `{@name}` in `components:` values.

| Key | Written to |
|---|---|
| `aiInstructions` | `Components/AI Instructions.md` |
| `plotEssential` | `Components/Plot Essentials.md` |
| `authorsNote` | `Components/Author's Note.md` |
| `opening` | `Components/Opening.md` (leaf nodes) |
| `openingChoice` | `Components/Opening.md` (branch-point nodes) |
| `scripts` | `Scripts/` (directory copy, no processing) |

---

## Root-Level Keys

### `protagonist`
Global default protagonist ID. Overridden per branch. Matched case-insensitively against card `id`.

### `variables`
Key-value pairs available in templates and field values as `{%key}`. Branch variables merge on top of parent variables.

### `components`
Root-level component specs. Each value is:
- Inline text string
- Relative file path
- `{@key}` reference to a named component dir/file

`opening:` inherits down to leaf branches unless overridden. `openingChoice:` belongs to the node where declared and does not inherit.

### `branches`
Nested branch tree. Leaf = no `branches:` sub-key → produces one output folder. Node = has `branches:` → recurse.

**Branch config keys:**

| Key | Description |
|---|---|
| `title` | Output folder name (filesystem only; YAML key still used for dispatch) |
| `protagonist` | Protagonist ID for this branch (overrides parent) |
| `components` | Component specs for this branch (same keys as root) |
| `variables` | Variables for this subtree (merged on top of parent) |
| `branches` | Child branches (makes this node a non-leaf) |

---

## Path Resolution

All paths resolved relative to `compile.yaml`. Absolute paths valid. Missing `cards`/`canon`/`templates` paths emit warnings.

---

## Output Structure

```
output/
  Story Cards/                   # root-level cards (all branches)
  Branches/
    subject/                     # one folder per leaf
      Story Cards/
      Components/
        Opening.md
        Plot Essentials.md
        AI Instructions.md
        Author's Note.md
      Scripts/
    researcher/
      Story Cards/
      Components/
  Overview/                      # auto-generated after each compile
```

Nested branches produce `Branches/tier2/Branches/alpha/` paths.
