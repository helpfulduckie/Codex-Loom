# Codex Loom — Overview & Getting Started

Codex Loom is a command-line compiler that turns YAML card definitions into Velvet Lattice story card files for AI Dungeon scenarios. You write your characters, locations, and other cards in structured YAML; Codex Loom assembles them into the folder layout Velvet Lattice expects, resolves pronoun tokens, applies variant chains, and generates one complete output folder per playable branch.

---

## Installation

```
npm install
npm install -g .
```

After installing globally, the `codex-loom` command is available anywhere.

---

## CLI Usage

```bash
# Compile a project from its config file
codex-loom path/to/compile.yaml

# Compile from a project directory (looks for compile.yaml inside)
codex-loom path/to/project/

# Generate one leaf-review file per branch leaf from an already-compiled output
codex-loom --leafReview path/to/output [output-dir]
codex-loom -l path/to/output [output-dir]

# Generate a single whole-tree overview file (one section per branch node)
codex-loom --overview path/to/output [output-dir]
codex-loom -o path/to/output [output-dir]
```

If `output-dir` is omitted for `--leafReview`, files are written to `./leaf-review/`. For `--overview`, files are written to `./overview/`.

A leaf-review overview is also **generated automatically** after every compile into `{output}/Overview/`.

---

## Project Folder Layout

```
my-project/
  compile.yaml                   ← required; project entry point
  cards/                         ← project card definitions and imports
    characters.yaml
    locations.yaml
  canon/                         ← shared (canonical) card definitions
    Characters/
      Aness.yaml
      Felicia.yaml
  templates/                     ← .template and .partial files
    Character.template
    Location.template
    CardHeader.partial
  plot-essentials.yaml           ← optional; defines Components/Plot Essentials.md
  ai-instructions.yaml           ← optional; defines Components/AI Instructions.md
  authors-note.yaml              ← optional; defines Components/Author's Note.md
  output/                        ← compiler writes here (do not edit manually)
```

---

## Output Structure

For a project with two branch leaves `subject` and `researcher`, the output looks like:

```
output/
  Story Cards/                   ← root-level cards (compiled for all branches)
    Character/
      Character.md
  Branches/
    subject/
      Story Cards/               ← all cards compiled for the subject leaf
        Character/
          Character.md
      Components/
        Opening.md
        Plot Essentials.md
        AI Instructions.md
        Author's Note.md
      Scripts/                   ← optional; copied from scripts source
    researcher/
      Story Cards/
        Character/
          Character.md
      Components/
        Opening.md
        Plot Essentials.md
  Overview/                      ← leaf-review files (generated automatically)
    subject.overview.md
    researcher.overview.md
```

For nested branches (e.g. branch `A` with children `X` and `Y`), the path is `Branches/A/Branches/X/`.

A project with no `branches:` key produces a single root-level output with no `Branches/` folder.

---

## The Five File Types You Author

| File | Purpose |
|---|---|
| `compile.yaml` | Project configuration — paths, branches, protagonist, component references |
| Card YAML files | Card definitions and imports under `cards/` or `canon/` |
| `.template` files | How each card type is rendered to markdown |
| `.partial` files | Reusable template fragments |
| Component YAML files | Plot Essentials, AI Instructions, Author's Note content |

Each is covered in its own reference document.

---

## Core Concepts

**Cards** are the atomic units of content — a character, a location, a settings block. Each card has a type (which controls its output folder), a body of content fields, and AID-specific metadata like triggers and encapsulate.

**Canon vs project cards** — Canon cards live in a shared folder available to any project. Project cards are local to one scenario and can import and extend canon cards.

**Branches** define playable paths through the scenario. The compiler enumerates all leaf nodes in the branch tree and produces one complete output folder per leaf. Cards can be filtered to specific branches or shared across all of them.

**Variants** are named deltas that layer changes on top of a card. A character card might have a `networked` variant that adds implant details, or a `Felix` variant that changes gender. Branch dispatch maps branch names to variant names, so the right version of each card appears in each branch's output.

**Templates** are plain-text files that control how a card's fields are rendered to markdown. Field references, conditional blocks, and render functions let you shape the output precisely.

**Pronoun tokens** let you write field content once and have `{$she}` / `{$her~}` resolve to the correct pronouns for each card or variant. Character ID tokens (`{$Aness}`) resolve to "you" when that character is the active branch protagonist, and to the character's display name otherwise.

---

## Next Steps

- [compile.yaml Reference](02-compile-yaml.md)
- [Card Definition Reference](03-card-yaml.md)
- [Imports & Includes](04-imports-and-includes.md)
- [Branch Tree & Variant Dispatch](05-branches-and-variants.md)
- [Field Operations](06-field-operations.md)
- [Templates & Partials](07-templates.md)
- [Pronoun System](08-pronouns.md)
- [Components (PE, AIN, AN, Opening)](09-components.md)
- [Errors & Warnings](10-errors-and-warnings.md)
