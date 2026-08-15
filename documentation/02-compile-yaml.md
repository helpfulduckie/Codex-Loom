# compile.yaml Reference

`compile.yaml` is the entry point for every Codex Loom project. It tells the compiler where to find items and templates, where to write output, how the scenario branches, and what the protagonist is for each branch.

---

## Minimal Example

```yaml
structure:
  input:
    items: [./Codex]
    templates: [./templates]
  output: ./output
```

---

## Full Structure

```yaml
structure:
  input:
    items:                        # sequence of project item directories
      - ./cards
    canon:                        # named mapping of canonical item directories
      main: ../../_Canon
      lore: ../../_Lore
    templates:                    # sequence of template directories (later overrides earlier)
      - ../../_SharedTemplates
      - ./templates
    components:                   # named directory mappings per component type
      aiInstructions:
        default: ./ai-instructions.yaml
      plotEssential:
        default: ./plot-essentials.yaml
      authorsNote:
        default: ./authors-note.yaml
      opening:
        default: ./openings
      branchFraming:
        default: ./openings
      scripts:
        default: ./scripts
      description:
        default: ./description.yaml
  output: ./output

protagonist: Aness                # global default protagonist ID
title: The Royal Academy          # optional; written once to {output}/Label.md

variables:                        # key-value pairs; used in templates as {%key}
  setting: The Royal Academy
  year: "1315"

components:                       # root-level component specs (inline or file path)
  opening: "Who are you?"
  plotEssential: "{%default}"     # reference to the "default" plotEssential dir/file

render:                           # project-wide rendering defaults
  notesTemplate: ProjectNotes     # template that renders every card's notes:

branches:
  subject:
    protagonist: Aness
    components:
      opening: ./openings/subject.md
    render:                       # merges over the root block, key by key
      notesTemplate: NoNotes
    variables:
      role: research subject
  researcher:
    protagonist: Veyrn
    components:
      opening: "You are a researcher."
  tier2:
    components:
      branchFraming: "Choose a specialisation."
    branches:
      alpha: {}
      beta: {}
```

---

## `structure:` Keys

All path resolution happens under `structure:`.

### `structure.input.items`

A sequence of directories to load project item YAML files from. All `.yaml` files are loaded recursively. Entries support the same `{%variable}` and `{%canonName}` token expansion as `structure.input.templates` (resolved before the path is made absolute), so a shared path prefix variable can be reused here.

```yaml
items: [./Codex]
# or
items:
  - ./cards
  - ./extra-items
```

### `structure.input.canon`

A **named mapping** of directories containing canonical (shared) item definitions. Each name is used in `{%name}` references and when reporting errors. All `.yaml` files are loaded recursively.

```yaml
canon:
  main: ../../_Canon
  lore: ./lore-items
```

Canon names are matched case-insensitively in `{%key}` references. Use the name to refer to canon directories in `include:` paths:

```yaml
- include: "{%main}/Characters/Aness.yaml"
```

**Token expansion in canon values** — Canon path values support token expansion before path resolution:

- `{%variableName}` — replaced with the value from the top-level `variables:` block
- `{%otherCanonName}` — replaced with the resolved absolute path of another canon entry

This makes it practical to define a root path once as a variable and reference it for multiple subdirectory entries, rather than repeating the full path:

```yaml
variables:
  canonRoot: C:\Shared\AID\_Canon

structure:
  input:
    canon:
      canonGeneral: '{%canonRoot}\StoryCards\_General'
      canonNovalune: '{%canonRoot}\StoryCards\Novalune'
```

**Every canon name is also exposed as a variable**, so a canon entry can reference a sibling — `esudia: '{%canonRoot}/Esudia'` then `esudiaChars: '{%esudia}/Character'` — and so can any other path in the config. This is what replaced v3's separate `{@name}` family; a canon name colliding with a declared variable is an ERROR (`CL0521`), since the two now share one namespace.

### `structure.input.templates`

A sequence of directories to load `.template` and `.partial` files from. When multiple directories are listed, **later directories override earlier ones** on name collision. Duplicate names within the same directory are an error.

```yaml
templates:
  - ../../_SharedTemplates   # base library — loaded first
  - ./templates              # project overrides — same name here wins
```

Template path entries support the same token expansion as canon values: `{%variableName}` and `{%canonName}`. The full canon map is available when templates are resolved, so any named canon entry can be referenced:

```yaml
templates:
  - '{%canonRoot}\templates'   # {%variable} expanded to absolute path
  - '{%canonGeneral}\templates'  # a canon name, exposed as a variable
  - ./templates
```

### `variables`

Named directory (or file) mappings for each component type. These are referenced in `components:` specs via `{%name}` tokens. The supported component types are:

| Key | Written to |
|---|---|
| `aiInstructions` | `Components/AI Instructions.md` |
| `plotEssential` | `Components/Plot Essentials.md` |
| `authorsNote` | `Components/Author's Note.md` |
| `opening` | `Components/Opening.md` |
| `branchFraming` | `Components/Opening.md` (branch-point nodes only) |
| `scripts` | `Scripts/` (directory copy) |
| `description` | `Description.md` (output root, written once — not per-branch) |

```yaml
components:
  plotEssential:
    default: ./plot-essentials.yaml
  aiInstructions:
    default: ./ai-instructions.yaml
```

### `structure.output`

Directory where compiled output is written. Relative to `compile.yaml`. Defaults to `./output` if omitted.

```yaml
output: ./output
```

---

## Root-Level Keys

These keys sit **outside** `structure:` at the top level of `compile.yaml`.

### `protagonist`

Global default protagonist ID. Used when a branch doesn't declare its own. Matched case-insensitively against item `id` values.

```yaml
protagonist: Aness
```

### `title`

Optional scenario title. Written once to `{output}/Label.md` after all branches compile, expanding `{%variable}` tokens against root `variables`. This is distinct from a branch's own `title:` field, which writes `Label.md` into that branch's own output folder (see [Branch Tree & Variant Dispatch](05-branches-and-variants.md)) — the root `title` only ever produces the single top-level file, alongside `Description.md`.

```yaml
title: The Royal Academy
```

### `variables`

Key-value pairs available in templates and field values as `{%key}`. Variables at the branch level override root-level variables for that branch's subtree.

```yaml
variables:
  setting: "The Royal Academy"
  year: "1315"
```

Used in a template as: `The year is {%year}.`

`{%key}` is expanded consistently across item bodies, templates, opening prose, component specs, branch `title`/`protagonist`, and the config path fields (`structure.input.items`, `structure.input.canon`, and `structure.input.templates`), making variables useful both as content values and as shared path prefixes across the config (see the `structure.input.canon` section above for an example). The one exception is `include:`/`import:` paths, which resolve once before branches are enumerated and therefore see **root** variables only, not per-branch overrides.

### `components`

Specifies what content to write for root-level component files. Each value is an inline string, a relative file path, a `{%variable}`, or a `{%key}` reference to a named directory/file in `variables` (or a canon entry — `{%key}` resolves against components first, then canon).

```yaml
components:
  opening: "Who are you?"                     # inline text
  plotEssential: ./plot-essentials.yaml        # file path
  aiInstructions: "{%default}"                # component key reference
  authorsNote: ./authors-note.yaml
  scripts: ./scripts
  description: ./description.yaml             # project-level description
```

**`opening:`** — Written to `{output}/Components/Opening.md`. Inherits down to leaf branches unless overridden.

**`branchFraming:`** — Written to branch-point nodes' `Components/Opening.md`. Does **not** inherit; ignored on leaf nodes with a warning.

**`description:`** — Written once to `{output}/Description.md` after all branches compile. Accepts a `.md`/`.txt` file (body only), a `.js` file (script banner only), or a `.yaml` config combining both. Not per-branch; branch-level overrides are ignored. See [Components → Description](09-components.md#description) for full details.

### `render`

Rendering defaults for the whole project. One key so far:

```yaml
render:
  notesTemplate: ProjectNotes
```

`notesTemplate` names the template that renders every card's `notes:` field when the item does not name one itself and no `<body template>.notes` file exists — rung 3 of the ladder in [Item YAML → Rendering notes through a template](03-item-yaml.md). Naming a template that is not loaded is ERROR `CL0411`, reported at load rather than once per card.

**It merges down the branch chain, key by key, like `components:` and `scripts:`.** That is the point of putting it here rather than only at root: which mods a branch loads is what decides whether a marker in the notes field means anything on that branch, and swapping the template swaps the whole convention without touching a single item.

```yaml
render:
  notesTemplate: WTGNotes         # [e] suppresses the mod's discovery timestamp

branches:
  modded: {}                      # inherits WTGNotes
  vanilla:
    render:
      notesTemplate: NoNotes      # a blank template — no notes line is written at all
```

**Use a blank template rather than `~` to turn notes off.** `notesTemplate: ~` unbinds the inherited value, which drops the branch to rung 4 — the built-in rendering of the notes value itself. For a scalar like `'[e]'` that is the same marker again; for a mapping it is `known: true` reaching AID as text. A template that renders nothing emits no `notes:` line at all, which is what "off" should mean.

### `branches`

The branch tree. Each key is a branch name; each value is a branch config object. A branch with no `branches:` sub-key is a **leaf** — the compiler produces one output folder for it. A branch with a `branches:` sub-key is a **node** — its children are enumerated recursively.

See [Branch Tree & Variant Dispatch](05-branches-and-variants.md) for full details.

```yaml
branches:
  subject:
    title: The Subject's Path     # output folder: Branches/The Subject's Path/
    protagonist: Aness
    components:
      opening: "You are a research subject."
    variables:
      role: subject
  researcher:
    protagonist: Veyrn             # no title: folder is Branches/researcher/
  multipath:
    components:
      branchFraming: "Choose a path."
    branches:
      alpha: {}
      beta: {}
```

**Branch config keys:**

| Key | Description |
|---|---|
| `title` | Output folder name for this branch node. When set, the compiler uses this string as the filesystem folder name instead of the YAML key. The key is still used for item branch dispatch and all internal matching; `title` only affects the output path. |
| `protagonist` | Protagonist ID for this branch leaf (overrides root `protagonist`) |
| `components` | Component specs for this branch (same keys as root `components:`) |
| `variables` | Variables for this branch subtree (merged on top of parent variables) |
| `branches` | Child branches (makes this node a non-leaf) |

---

## Path Resolution

All paths in `compile.yaml` are resolved relative to the location of `compile.yaml` itself. Absolute paths are also valid.

The compiler warns if a declared `items`, `canon`, or `templates` path does not exist. Missing `components` file paths are handled at compile time per component.
