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

placeholders:                     # key-question pairs; used as %key%, answered by the player
  heroName: What should we call you?
  house: 'Which wing of {%setting} claims you?'

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
| `placeholders` | Player placeholders for this subtree, merged per key on top of the parent's; `~` unbinds |
| `scripts` | Script set for this subtree |
| `lint` | Lint configuration for this subtree |
| `render` | Rendering defaults for this subtree |
| `branches` | Child branches, which makes this node a non-leaf |

---

## Path Resolution

All paths resolve relative to `compile.yaml`; absolute paths are valid. Missing `items`/`canon`/`templates` paths emit warnings.

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
