# compile.yaml Reference

`compile.yaml` is the entry point for every Codex Loom project. It tells the compiler where to find items and templates, where to write output, how the scenario branches, and what roles (including the protagonist) each branch binds.

---

## Minimal Example

```yaml surface=config
structure:
  input:
    items: [./Codex]
    templates: [./templates]
  output: ./output
```

---

## Full Structure

```yaml surface=config
structure:
  input:
    items:                        # sequence of project item directories
      - ./Codex
    library:                      # named mapping of shared item/component directories
      main: ../../_Library
      lore: ../../_Lore
    templates:                    # sequence of template directories (later overrides earlier)
      - ../../_SharedTemplates
      - ./templates
    snapshot: ./snapshot          # optional; freezes library entries (see 12-snapshot.md)
  output: ./output

title: The Royal Academy          # optional; written once to {output}/Label.md

variables:                        # key-value pairs; used in templates as {%key}
  setting: The Royal Academy
  year: "1315"

roles:                            # per-branch name -> item id bindings (see 13-roles.md)
  protagonist: Aness              # the built-in role — global default

components:                       # root-level component specs (inline or file path)
  opening: "Who are you?"
  plotEssential: ./plot-essentials.yaml   # inline text or a path to a component file

render:                           # project-wide rendering defaults
  notesTemplate: ProjectNotes     # template that renders every card's notes:

lint:                             # the opinion layer's controls
  level: warn                     # off | error | warn

branches:
  subject:
    roles:
      protagonist: Aness
    components:
      opening: ./openings/subject.md
    render:                       # merges over the root block, key by key
      notesTemplate: NoNotes
    variables:
      role: research subject
  researcher:
    roles:
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

A sequence of directories to load project item YAML files from. All `.yaml` files are loaded recursively. Entries support the same `{%variable}` and `{%libraryName}` token expansion as `structure.input.templates` (resolved before the path is made absolute), so a shared path prefix variable can be reused here.

```yaml surface=config level=structure.input
items: [./Codex]
```

```yaml surface=config level=structure.input
items:
  - ./cards
  - ./extra-items
```

### `structure.input.library`

A **named mapping** of directories containing shared item and component definitions — the
project's **shared library**, though the key covers more than characters and lore.
Each name is used in `{%name}` references and when reporting errors. All `.yaml`
files are loaded recursively.

```yaml surface=config level=structure.input
library:
  main: ../../_Library
  lore: ./lore-items
```

Library names are matched case-insensitively in `{%key}` references. Use the name to refer to a library directory in `include:` paths:

```yaml surface=item
- include: "{%main}/Characters/Aness.yaml"
```

**Token expansion in library values** — Library path values support token expansion before path resolution:

- `{%variableName}` — replaced with the value from the top-level `variables:` block
- `{%otherLibraryName}` — replaced with the resolved absolute path of another library entry

This makes it practical to define a root path once as a variable and reference it for multiple subdirectory entries, rather than repeating the full path:

```yaml surface=config
variables:
  libraryRoot: C:\Shared\AID\_Library

structure:
  input:
    library:
      libGeneral: '{%libraryRoot}\StoryCards\_General'
      libNovalune: '{%libraryRoot}\StoryCards\Novalune'
```

**Every library name is also exposed as a variable**, so a library entry can reference a sibling — `esudia: '{%libraryRoot}/Esudia'` then `esudiaChars: '{%esudia}/Character'` — and so can any other path in the config. A library name colliding with a declared variable is an ERROR (`CL0521`), since the two share one namespace.

**A directory may carry a reserved `library.cl.yaml`**, skipped by the item loader rather than parsed — see [Roles](13-roles.md#libraryclyaml--reserved-not-yet-read).

**`structure.input.snapshot` freezes library entries into a copy the project carries with it.** See [The Library Snapshot](12-snapshot.md) for `--snapshot`, the drift notice, and `requiresRoles`.

### `structure.input.templates`

A sequence of directories to load `.template` and `.partial` files from. When multiple directories are listed, **later directories override earlier ones** on name collision. Duplicate names within the same directory are an error.

```yaml surface=config level=structure.input
templates:
  - ../../_SharedTemplates   # base library — loaded first
  - ./templates              # project overrides — same name here wins
```

Template path entries support the same token expansion as library values: `{%variableName}` and `{%libraryName}`. The full library map is available when templates are resolved, so any named library entry can be referenced:

```yaml surface=config level=structure.input
templates:
  - '{%libraryRoot}\templates'   # {%variable} expanded to absolute path
  - '{%libGeneral}\templates'  # a library name, exposed as a variable
  - ./templates
```

### `structure.output`

Directory where compiled output is written. Relative to `compile.yaml`. **Required** — omitting it is `CL0203` at load, and nothing compiles.

```yaml surface=config level=structure
output: ./output
```

---

## Root-Level Keys

These keys sit **outside** `structure:` at the top level of `compile.yaml`.

### `roles`

Per-branch name → item id bindings, merged down the branch chain like `variables:` and
`placeholders:`. `protagonist` is the built-in role — a global default is set at root and
a branch overrides or unbinds (`~`) it like any other role.

Role-binding values are semantic strings, so `{%variable}` expands against the active branch
scope before role lookup; role names remain literal structural keys.

```yaml surface=config
roles:
  protagonist: Aness

branches:
  researcher:
    roles:
      protagonist: Veyrn
```

An item's `{$Id}` matching the active branch's bound `protagonist` resolves to `"you"`
rather than the item's display name, case-insensitively. See [Roles](13-roles.md) for the
full mechanism — declaring other roles, `{$RoleName}` resolution, and the diagnostics a
misused role raises.

### `title`

Optional scenario title. Written once to `{output}/Label.md` after all branches compile, expanding `{%variable}` tokens against root `variables`. This is distinct from a branch's own `title:` field, which writes `Label.md` into that branch's own output folder (see [Branch Tree & Variant Dispatch](05-branches-and-variants.md)) — the root `title` only ever produces the single top-level file, alongside `Description.md`.

```yaml surface=config
title: The Royal Academy
```

### `variables`

Key-value pairs available in templates and field values as `{%key}`. Variables at the branch level override root-level variables for that branch's subtree. `{%key}` expands in semantic string values; mapping keys, branch names, and selectors remain literal.

```yaml surface=config
variables:
  setting: "The Royal Academy"
  year: "1315"
```

Used in a template as: `The year is {%year}.`

`{%key}` is expanded consistently across item bodies, templates, opening prose, component specs, branch `title`/`roles`, and the config path fields (`structure.input.items`, `structure.input.library`, and `structure.input.templates`), making variables useful both as content values and as shared path prefixes across the config (see the `structure.input.library` section above for an example). The one exception is `include:`/`import:` paths, which resolve once before branches are enumerated and therefore see **root** variables only, not per-branch overrides.

A branch `title:` and the root scenario `title:` also resolve role and pronoun tokens (`{$Role}`, `{$Role.pronoun}` — see [Roles](13-roles.md)), the same as any other rendered text, and `{%key}` still expands first.

A `placeholders:` question's text resolves role and pronoun tokens too, after its `%key%` nesting expands — a question that reads `What is {$LI}'s name?` ships to `Placeholders.yaml` with the bound role's name in place, and the same resolved text is what the platform length caps measure.

### `components`

Specifies what content to write for root-level component files. Each value is an inline string, a relative file path, or a `{%variable}` / `{%libraryName}` token that expands to one (component specs go through the same single `{%…}` expander as every other path — there is no separate component namespace).

```yaml surface=config
components:
  opening: "Who are you?"                      # inline text
  plotEssential: ./plot-essentials.yaml        # file path
  aiInstructions: "{%shared}/ai-instructions.yaml"   # a library-name token
  authorsNote: ./authors-note.yaml
  description: ./description.cl.yaml            # the scenario blurb, root only
  adventureDescription: ./adventure.cl.yaml    # per-leaf, inherits down the tree
```

Each key writes one file. Every component except `branchFraming:` inherits down the branch tree, so a value declared at an interior node reaches the leaves beneath it:

| Key | Output file | Inherits | Items route in |
|---|---|---|---|
| `plotEssential` | `Components/Plot Essentials.md` | yes | yes |
| `summary` | `Components/Summary.md` (VL reads this into `storySummary`) | yes | yes |
| `aiInstructions` | `Components/AI Instructions.md` | yes | yes |
| `authorsNote` | `Components/Author Notes.md` (Velvet Lattice's spelling) | yes | yes |
| `opening` | `Components/Opening.md`, at each leaf | yes | yes |
| `branchFraming` | `Components/Opening.md`, at branch-point nodes only | no | no |
| `description` | `Description.md` at the output root, written once | n/a | no |
| `adventureDescription` | `Description.md`, at each leaf | yes | yes |

`scripts:` is **not** a component — it is a top-level key (see [scripts](#scripts) below), folded in here only because it merges down the branch chain the same way.

**`opening:`** — Written to each leaf's `Components/Opening.md`. An ordinary component: it inherits down the tree, may be a `sections:` document, and items may route into its slots. A `.md` file expands `{%variables}` at the leaf while preserving its other text, and a spec naming no file is used as literal text, which is what most openings are. Capped at 4,000 characters (`CL0710`/`CL0711`).

**`branchFraming:`** — Written to branch-point nodes' `Components/Opening.md`. Does **not** inherit; ignored on leaf nodes with a warning. Takes the same three shapes `opening:` does, but items cannot route into it — framing sits at an interior node, where no items are resolved.

**Declared at the project root — sibling to `branches:` rather than inside any branch node — `branchFraming:` writes once to `{output}/Components/Opening.md`** and otherwise behaves like framing at any interior node. It reads the project's own `roles:` and resolves `{%variable}`, `{$role}` and pronoun tokens in every shape — a literal sentence, a prose `.md`, or a `sections:` document (see [Roles](13-roles.md)). `{$protagonist}` renders as "you" only when a `protagonist` role is bound at the root; every other `{$role}` token resolves regardless.

**`description:`** — The scenario blurb AID shows on the listing page. Written once to `{output}/Description.md` after all branches compile. Accepts a `.md`/`.txt` file whose `{%variables}` expand at root scope, or a component document with `sections:`. Not per-branch; branch-level declarations are ignored.

**`adventureDescription:`** — The description a leaf carries, which AID applies to the adventure started from that leaf. An ordinary component: declared anywhere in the tree, inherited down it, written to each leaf's `Description.md`, and items may route into its slots. A leaf that has one and no `Opening.md` is `CL0616`, because Velvet Lattice would open the adventure on the blurb.

See [Components → Description](09-components.md#description) for both keys, the `file:`/`from:` section sources, and `metadata:` frontmatter.

### `scripts`

Points at the Velvet Lattice scripting hooks copied into each branch leaf's `Scripts/`
folder. It is a **top-level key** — sibling to `components:`, not a key inside it — and it
merges down the branch chain like `components:` and `render:`, so a branch can swap or
unbind (`~`) the script set it ships.

Two forms:

```yaml surface=config
scripts: ./scripts               # a directory, copied whole
```

```yaml surface=config
scripts:                         # the four VL hook files, named individually
  input:   ./scripts/input.js
  context: ./scripts/context.js
  output:  ./scripts/output.js
  library: ./scripts/library.js
```

Path values take `{%variable}` expansion like any other config path; the files themselves
are copied as-is, with no processing of their contents. See
[Components → Scripts](09-components.md#scripts).

### `render`

Rendering defaults for the whole project. One key so far:

```yaml surface=config
render:
  notesTemplate: ProjectNotes
```

`notesTemplate` names the template that renders every card's `notes:` field when the item does not name one itself and no `templateFor.notes` entry matches its `aid.type` — the scalar half of rung 2 of the ladder in [Item YAML → Rendering notes through a template](03-item-yaml.md). Naming a template that is not loaded is ERROR `CL0411`, reported at load rather than once per card.

**It merges down the branch chain, key by key, like `components:` and `scripts:`.** That is the point of putting it here rather than only at root: which mods a branch loads is what decides whether a marker in the notes field means anything on that branch, and swapping the template swaps the whole convention without touching a single item.

```yaml surface=config
render:
  notesTemplate: WTGNotes         # [e] suppresses the mod's discovery timestamp

branches:
  modded: {}                      # inherits WTGNotes
  vanilla:
    render:
      notesTemplate: NoNotes      # a blank template — no notes line is written at all
```

**Use a blank template rather than `~` to turn notes off.** `notesTemplate: ~` unbinds the inherited value, which drops the branch to rung 3 — the built-in rendering of the notes value itself. For a scalar like `'[e]'` that is the same marker again; for a mapping it is `known: true` reaching AID as text. A template that renders nothing emits no `notes:` line at all, which is what "off" should mean.

### `storyCardType`

The AID story-card `type` that a component's `render.storyCards` alternates land under — one per component, project-wide.

**`storyCardType` is root-only.** Its values expand `{%variables}` against the completed root table; its component-name keys remain literal. A branch-only variable here is out of scope. Entry-level `title:` and `type:` are separate leaf-scoped values; expansion happens before trimming, empty checks, collision checks, and type validation.

```yaml surface=config
storyCardType:
  aiInstructions: zz_AIN            # sorts the alternates to the end of the player's card list
  plotEssential:  zz_PE
```

This is the middle rung of the ladder in [Components → Swappable alternates](09-components.md#swappable-alternates--renderstorycards): an entry's own `type:` wins over it, and with neither set the card takes the component's display label (`AI Instructions`). It is **not** branch-addressable — which category a reference card sorts under is a whole-scenario decision — so unlike `render:` it has no branch rung.

### `lint`

Controls for Codex Loom's **opinion layer** — the checks that judge quality rather than
report facts.

```yaml surface=config
lint:
  level: error        # off | error | warn
```

**`level` cannot reach anything the compiler knows is wrong.** Unknown keys, undeclared
roles, platform field caps, a leaked `{$she}` or `{join}` — those are facts about your
output, they stay errors at every level, and that is what makes `off` a safe thing to
write. What `level` governs is the other half: trigger-less cards, prose heuristics, unused
placeholder declarations, and convention-pack findings.

Read `error` as **"validate my mod configs, skip the prose heuristics"**. The prose
heuristics are all warnings, so they disappear; pack findings about mod config survive at
full severity and can still fail a build.

| `level` | What you hear from the opinion layer |
|---|---|
| `off` | Nothing. |
| `error` | Its errors only — pack findings about mod config. |
| `warn` | Everything, demoted so that nothing in the layer fails your build. |
| *(unset)* | Everything, at the severity each finding was raised with. The default. |

`--lint-level=off|error|warn` overrides the key for one run, and is separate from
`--verbose`. See [Diagnostic Codes](11-diagnostics.md) and [design-spec §12.5](design-spec.md)
for the compiler/lint split and which checks sit in which layer.

`lint.packs` — convention packs — is a mapping keyed by pack name. `{}` names a bundled
pack, `{ source: <path> }` a project-local or library-hosted one, and either may carry a
per-pack `level:` ceiling. It is legal on a branch node and merges down the chain key-wise
(`<name>: ~` unbinds an inherited pack), because which packs should validate a branch's
`notes:` depends on which mods that branch ships. See [Convention Packs](14-convention-packs.md).

`lint.level` on a branch is a per-branch ceiling: it clamps the opinion layer for that
branch's subtree, and a finding it clamps names the branch that raised it. The order of the
ceilings is per-pack `level:`, then per-branch `lint.level`, then project-level
`lint.level`; the tightest wins.

### `branches`

The branch tree. Each key is a branch name; each value is a branch config object. A branch with no `branches:` sub-key is a **leaf** — the compiler produces one output folder for it. A branch with a `branches:` sub-key is a **node** — its children are enumerated recursively.

See [Branch Tree & Variant Dispatch](05-branches-and-variants.md) for full details.

```yaml surface=config
branches:
  subject:
    title: The Subject's Path     # output folder: Branches/The Subject's Path/
    roles:
      protagonist: Aness
    components:
      opening: "You are a research subject."
    variables:
      role: subject
  researcher:
    roles:
      protagonist: Veyrn           # no title: folder is Branches/researcher/
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
| `roles` | Role bindings for this branch, merged over inherited ones — `protagonist` included (see [Roles](13-roles.md)) |
| `components` | Component specs for this branch (same keys as root `components:`) |
| `variables` | Variables for this branch subtree (merged on top of parent variables) |
| `branches` | Child branches (makes this node a non-leaf) |

---

## Path Resolution

All paths in `compile.yaml` are resolved relative to the location of `compile.yaml` itself. Absolute paths are also valid.

The compiler warns if a declared `items`, `library`, or `templates` path does not exist. Missing `components` file paths are handled at compile time per component.
