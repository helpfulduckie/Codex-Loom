# compile.yaml Reference

Entry point for every Codex Loom project. Controls paths, branches, protagonist, variables, roles, template selection, and components.

**`version: 4` is required.** There is no compatibility mode — a v3 file fails validation rather than compiling with warnings.

**The file may be named `compile.cl.yaml` or `compile.yaml`.** Both spellings are found. `.cl.yaml` is the current convention and extends to every authored YAML file in a project — `items.cl.yaml`, `plot-essentials.cl.yaml`, `fields.cl.yaml`.

---

## Full Schema

```yaml
version: 4                        # required
title: The Institute

structure:
  input:
    items:                        # sequence of project item directories
      - ./Codex
    library:                      # named mapping of shared library directories
      characters: '{%shared}/_General/Characters'
      lore: '{%shared}/_General/Lore'
    templates:                    # sequence; later directories override earlier on name collision
      - '{%loom}/templates'
      - ./templates
    snapshot: ./snapshot          # optional; turns on the library freeze
  output: ../Velvet Lattice/      # required
  reports: ./Review               # optional; defaults to <output>/Overview

protagonist: Aness                # global default protagonist ID (case-insensitive)

variables:                        # key-value pairs; used as {%key}
  loom: ../../../_CodexLoom
  shared: '{%loom}/Library'
  setting: The Royal Academy

roles:                            # name → item id; used as {$LI}, merged down the branch chain
  LI: Kaiden
  rival: Voss

placeholders:                     # key-question pairs; used as %key%, answered by the player
  heroName: What should we call you?
  house: 'Which wing of {%setting} claims you?'

templateFor:                      # template-selection files per rendering role
  base: templates.cl.yaml
  plotEssential: pe.cl.yaml

storyCardType:                    # AID `type` for each component's render.storyCards entries
  plotEssential: zz_Reference

render:
  notesTemplate: Notes            # project-wide default notes template

lint:
  level: warn                     # off | error | warn — the opinion-layer ceiling
  packs:
    wtg: {}

components:                       # root-level component specs
  plotEssential: ./components/plot-essentials.cl.yaml
  summary: ./components/summary.cl.yaml
  aiInstructions: '{%loom}/AI Instructions/AI Instructions.md'
  authorsNote: ./components/authors-note.cl.yaml
  description: ./components/description.cl.yaml
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
    placeholders:               # adds to the root table on this branch and below
      handler: Who signed your intake form?
      house: ~                  # unbind: the root key does not apply here
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

### `library`
Named mapping of shared source directories — library characters, house-style components — typically outside the project. All item files loaded recursively, names matched case-insensitively.

**Each library name is automatically exposed as a `{%name}` variable**, so an entry can be referenced in paths without declaring it twice.

**Reach a shared file through a library entry rather than a plain `variables:` path.** A component pulled in through an ordinary variable compiles correctly but cannot be frozen by `--snapshot`, and raises `CL0522`. See `references/library-snapshot.md`.

### `templates`
Sequence of directories for `fields.cl.yaml` field tables and for `.template` / `.partial` files. Later entries override earlier on name collision — but the field table merges **key-wise per entry**, not per file. Duplicates within the same directory are an error.

### `snapshot`
Path to the frozen library copy. **Setting this key is the only thing that turns the freeze on**; unset, every `{%name}` resolves live. See `references/library-snapshot.md`.

### What is *not* here

`structure.input.canon` is now `structure.input.library`. `structure.input.components` is gone — component specs live only under the root-level `components:` key and its per-branch counterparts. The `{@key}` reference syntax went with it; use `{%variable}` instead.

---

## Root-Level Keys

### `version`
Must be `4`. Required.

### `protagonist`
Global default protagonist ID, overridable per branch. Matched case-insensitively against item `id`.

### `variables`
Key-value pairs available in templates and field values as `{%key}`. Variables resolve against other variables, so `shared: '{%loom}/Library'` works. Branch variables merge on top of parent variables. `{%}` expands semantic string values; mapping keys and selectors remain literal.

### `roles`
Name-to-item-id bindings, referenced in prose as `{$LI}`. Binding values accept `{%variable}` from the active branch scope; role names remain literal structural keys. Merges down the branch chain key by key; `~` unbinds. `protagonist` is an ordinary entry here rather than a separate mechanism. Full semantics in `references/roles.md`.

### `templateFor`
A template-selection file per rendering role — `base`, `notes`, and one key per component. Each value names a `.cl.yaml` carrying a `templates:` namespace, or a list of them merged left to right. Branch-addressable, and the mechanism behind context tiering. See `references/field-declarations.md`.

### `storyCardType`
The AID story-card `type` that a component's `render.storyCards` entries land under, one key per component (`plotEssential`, `summary`, `aiInstructions`, `authorsNote`, `adventureDescription`, `opening`). **Root only.** Use it to steer where the alternates sort in the player's card list — a `zz_` prefix, say. Falls back to the component's display label.

### `render`
Project-wide rendering defaults. One key: `notesTemplate`, the template rendering every card's `notes:` when the item names none and no `templateFor.notes` entry matches.

### `lint`
The opinion layer's controls. `level:` is `off` / `error` / `warn` and names the one severity the opinion layer may speak at; `packs:` enables convention packs. See `references/convention-packs.md`.

**`lint.level` reaches only the opinion layer.** Facts — unknown keys, undeclared roles, platform caps, a leaked `{$she}` — are not silenceable at any level, which is what makes `off` safe to write.

### `placeholders`
Key-question pairs. The key is referenced in authored text as `%key%`; the question is what the player is asked, once, at the start of an adventure. Declarable at root and on any branch — a branch adds keys, overrides same-named ones, and inherits every key it does not mention. `~` unbinds an inherited key.

Questions may contain `{%variables}` and may reference other placeholders as `%key%`. Full semantics, the destination rules, and what gets written are in **Player Placeholders** below.

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

**`opening:` and `branchFraming:` are two keys for one filename**, and the difference is where AID reads it. An `Opening.md` at a leaf is that branch's first move; anywhere else it is the framing shown while the player chooses a branch beneath that node. `branchFraming:` does not inherit, because it belongs to the node whose children it frames — declared on a leaf it is ignored with a WARN.

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
| `roles` | Role bindings for this subtree, merged per key; `~` unbinds |
| `placeholders` | Player placeholders for this subtree, merged per key on top of the parent's; `~` unbinds |
| `templateFor` | Template-selection files for this subtree — this is how a context tier is declared |
| `scripts` | Script set for this subtree |
| `lint` | Lint configuration for this subtree, including `packs:` |
| `render` | Rendering defaults for this subtree |
| `branches` | Child branches, which makes this node a non-leaf |

**`storyCardType:` is root-only** and has no per-branch counterpart.

---

## Path Resolution

All paths resolve relative to `compile.yaml`; absolute paths are valid. Missing `items` / `library` / `templates` paths emit warnings.

---

## Player Placeholders (`%key%`)

**A placeholder is a question the player answers once, at the start of an adventure, whose answer is substituted everywhere the key appears.** `%key%` is authoring-time shorthand for AID's own `${...}` prompt syntax, not a separate mechanism — what gets substituted at upload is the *question text*, and AID replaces that with the answer at game start:

```
%heroName%  ──upload──▶  ${What should we call you?}  ──game start──▶  the player's answer
```

**Writing `${What should we call you?}` raw in your text works and always has**, so the declaration layer is a choice rather than a requirement. What declaring buys is one place to edit the question, per-branch inheritance, and the checks below. For a question used in exactly one spot it buys little, and writing it raw is a reasonable thing to do.

**`%key%` and `{%key}` are different things and the sigils are one brace apart.** `{%setting}` is a compile-time variable, substituted by Codex Loom into the output; `%heroName%` is a player placeholder, substituted by AID at game start. A question may contain both, and writing `%setting%` where `{%setting}` was meant produces `CL0532` against a key you never declared.

### Declaring and inheriting

**Declared at root and on any branch, and merged per key.** A branch adds keys, overrides same-named ones, and inherits every key it does not mention — the merge is per key, not per file, so a branch declaring one placeholder does not shadow the root's others.

```yaml
placeholders:
  heroName: What should we call you?

branches:
  subject:
    placeholders:
      handler: Who signed your intake form?   # adds
      heroName: What did the Institute log you as?   # overrides for this subtree
  researcher:
    placeholders:
      heroName: ~                             # unbinds; %heroName% is undeclared here
```

**`~` unbinds, and is a compile-time concept only.** It removes the key from this subtree's table so that a `%heroName%` written here is reported as undeclared. Nothing is emitted for an unbind, because an unbound key that no text references produces no prompt anyway.

> **A bare `heroName:` with nothing after it is `~`.** YAML parses an empty value as null, so the most natural-looking way to start a declaration is also the way to delete one. `CL0530` catches the case where the deleted key was never inherited; a bare key that *does* shadow an inherited one silently unbinds it.

### Nesting

**A question may reference another placeholder, and you write it as `%inner%` inside the outer question.** AID prompts twice, the second question showing the first answer:

```yaml
placeholders:
  liName: What is your Love Interest's name?
  liGender: What is %liName%'s gender?
```

**Declaration order does not matter — Codex Loom expands the nesting before writing anything.** In a hand-written Velvet Lattice project it matters a great deal, because VL substitutes in mapping order and an inner-first declaration ships a literal `%key%` to the model. That trap does not exist here, and an author porting a hand-ordered table can stop maintaining the order.

The pair above is emitted as:

```yaml
liName: What is your Love Interest's name?
liGender: What is ${What is your Love Interest's name?}'s gender?
```

**The inner reference becomes a `${...}` prompt inside the outer question, not the inner answer.** That nested prompt is what makes AID ask twice and show the first answer while asking the second.

A reference cycle is an ERROR (`CL0531`), and every key in the loop is named.

### Where placeholders work

**Placeholders work in every component, and in a story card's entry, name, triggers and notes.** Four destinations behave differently, and the table states the outcome rather than the rule, because none of it is visible from the source:

| Destination | What happens | Code |
|---|---|---|
| The Description | Never filled — it is shown before an adventure exists to answer it | `CL0533` ERROR |
| A card's `type` | Never filled — it is a category, and a folder name in the compiled tree | `CL0533` ERROR |
| A branch title | The prompt fills and the player sees their answer while choosing; the saved adventure keeps the raw text | `CL0534` WARN |
| The scenario `title:` | Never filled — it names the scenario in listings | `CL0534` WARN |

Both spellings are checked, since a raw `${...}` is as broken in a Description as a `%key%` is, and neither check consults the placeholder table — where a placeholder cannot go, declaring it changes nothing.

### Latitude's premade `${...}` forms

**`${character.name}`, `${character.gender}` and the five pronoun forms that follow the gender answer are written raw, permanently.** AID special-cases them; they are not questions and have no `%key%` equivalent, so there is nothing to declare and no migration to do. Leave them exactly as written.

### What gets emitted

**Each scenario node gets a `Placeholders.yaml` holding only what that node adds.** Velvet Lattice merges per key down the tree by itself, so a branch's file lists that branch's declarations rather than the whole accumulated table — the root file and the branch file are meant to differ.

```yaml
# Branches/subject/Placeholders.yaml
handler: Who signed your intake form?
heroName: What did the Institute log you as?
```

Questions are written **expanded**: `{%variables}` resolved, and nested `%key%` references replaced with the referenced question in `${...}` form. What VL receives needs no further passes.

**A branch that only unbinds gets no file at all.** `~` is compile-time only, so a branch whose entire `placeholders:` block is unbinds adds nothing to emit — the missing file is correct output, not a dropped one. The unbind still governs whether a `%key%` written on that branch is reported as undeclared.

The file sits at each node root beside `Label.md`, not under `Components/`.

### Quoting

**A leading `%key%` needs no quoting.** `opening: %heroName% woke up.` parses, because the preparser handles it — `%` is YAML's directive indicator and would otherwise be a hard error naming neither placeholders nor the fix. This works in block values, flow sequence entries (`triggers: [%heroName%, Aria]`) and flow mapping values alike. Any example that defensively quotes a leading `%key%` is carrying a workaround that no longer applies.

### Diagnostics

| Code | Severity | What |
|---|---|---|
| `CL0530` | WARN | `~` unbinds a key that was never inherited there |
| `CL0531` | ERROR | Placeholder questions form a reference cycle |
| `CL0532` | ERROR | A `%key%` reaching compiled output is not declared on that branch |
| `CL0533` | ERROR | A placeholder reached a destination AID does not fill |
| `CL0534` | WARN | A placeholder reached a title, where AID does not do what writing one implies |
| `CL0535` | WARN | Declared, and referenced nowhere beneath its declaring node |
| `CL0536` | WARN | Two or more keys declare the same question text |

`CL0535` is scoped to the declaring node's subtree — a root-level placeholder used on one branch of three is normal and correct. `CL0536` reads declarations only: two *keys* carrying one question string is the finding, because AID collapses identical questions into a single prompt and both keys receive that one answer. One key referenced from twenty places is the feature working.

**AID's own guidance puts the practical ceiling near ten placeholders** before players start abandoning a scenario, which is what makes an unused declaration worth a warning.

---

## Output Structure

```
output/
  Story Cards/                   # root-level items (all branches)
  Placeholders.yaml              # root-level placeholder declarations
  Branches/
    subject/                     # one folder per leaf
      Placeholders.yaml          # only what this node adds; VL merges the rest
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

**Every file is written at the node that owns it, never copied to every leaf.** Velvet
Lattice inherits components, placeholders, story cards and scripts down the branch tree by
itself, so a leaf resolves to its ancestors' files without holding copies. An absent file at
a leaf is not a missing file — check the owning node before treating it as one.

**`Label.md` and `Description.md` are the two exceptions**, written at every node that needs
them, because VL reads both from the node's own directory with no parent in scope.
