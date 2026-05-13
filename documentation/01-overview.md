# Codex Loom — Overview

Codex Loom is a command-line compiler that turns YAML card definitions into Velvet Lattice story card files for AI Dungeon scenarios. You write your characters, locations, and other cards in structured YAML; the compiler assembles them into the folder layout and file format that Velvet Lattice expects.

---

## What the compiler does

1. Reads your project configuration from `compile.yaml`.
2. Loads card definitions from your `cards/` folder and (optionally) a shared `canon/` folder.
3. For every branch leaf in your scenario, resolves each card — applying variant chains, import overrides, and branch-specific deltas in the correct order.
4. Runs post-resolution passes on every card: field interpolation, pronoun tokens, verb conjugation.
5. Renders each card through its template file.
6. Writes one output folder per branch leaf in Velvet Lattice folder structure.
7. Optionally writes `Opening.md` and `Plot Essentials.md` component files.
8. Optionally generates leaf-review `.overview.md` files for authoring reference.

---

## Installation

```
npm install
npm install -g .
```

---

## Running the compiler

```bash
# Compile from a config file
codex-loom path/to/compile.yaml

# Compile from a project directory (looks for compile.yaml inside)
codex-loom path/to/project/

# Generate one leaf-review file per branch leaf
codex-loom --leafReview path/to/output [output-dir]
codex-loom -l path/to/output [output-dir]

# Generate a single whole-tree overview file
codex-loom --overview path/to/output [output-dir]
codex-loom -o path/to/output [output-dir]
```

If `output-dir` is omitted for `--leafReview`, files are written to `./leaf-review/`. For `--overview`, files are written to `./overview/`.

When run inside a project directory that contains a `compile.yaml` with an `overview:` key, you can run `codex-loom --leafReview` with no further arguments and it will use the paths from config.

---

## Project folder layout

```
/my-project
  compile.yaml                  ← required; project entry point
  plot-essentials.yaml          ← optional; defines Plot Essentials.md content
  /canon                        ← canonical (shared) card definitions
  /cards                        ← project-level card definitions and imports
  /templates                    ← .template and .partial files
  /output                       ← compiler writes here; do not edit manually
    /Story Cards
      /Character
        Character.md
    /Branches
      /subject
        /Story Cards
          /Character
            Character.md
        /Components
          Opening.md
          Plot Essentials.md
      /researcher
        /Story Cards
        /Components
  /overview                     ← leaf review files (generated, optional)
```

---

## The five file types you author

| File | Purpose |
|---|---|
| `compile.yaml` | Project configuration — paths, branches, protagonist, openings |
| `plot-essentials.yaml` | Content for `Components/Plot Essentials.md` |
| Card YAML files | Card definitions and imports under `cards/` or `canon/` |
| `.template` files | How each card type is rendered to markdown |
| `.partial` files | Reusable template fragments |

Each of these is covered in its own document.

---

## Core concepts

**Cards** are the atomic units of content — a character, a location, a settings block. Each card has a `type` (which controls its output folder and default template), a set of `fields` (the actual content), and optional metadata like `triggers`, `pronouns`, and `encapsulate`.

**Canon vs project cards** — Canon cards live in the shared `canon/` folder and are available to any project. Project cards in `cards/` are local to this scenario. Project cards can import and extend canon cards.

**Branches** model the playable forks of your scenario. The compiler produces one complete output folder per branch leaf. Cards can be filtered to specific branches using `only:` and `except:`.

**Variants** are named deltas that layer changes on top of a card. They can be nested to any depth and activated via import paths, `import-variant:` lists, or branch position.

**Protagonists** control how bare `$` markers in card text resolve — to `you`/`your` when the character is active, or to name and third-person pronouns otherwise. Protagonist assignment lives in `compile.yaml`.

**Templates** are plain-text files with `{$field}` interpolation, `{if}` conditionals, and helper functions like `{join(...)}`. The template filename (without `.template`) must match the card's `template:` field, or fall back to its `type:`.
