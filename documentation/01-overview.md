# Codex Loom — Overview & Getting Started

Codex Loom is a command-line compiler that turns YAML item definitions into Velvet Lattice story card files for AI Dungeon scenarios. You write your characters, locations, and other items in structured YAML; Codex Loom assembles them into the folder layout Velvet Lattice expects, resolves pronoun tokens, applies variant chains, and generates one complete output folder per playable branch.

---

## Installation

```
npm install
npm install -g .
```

After installing globally, the `codex-loom` command is available anywhere.

---

## CLI Usage

All flags are combinable. The positional argument is either a `compile.yaml` path or a project folder (Codex Loom looks for `compile.yaml` inside it). If omitted, the current directory is used.

```bash
# Compile a project
codex-loom path/to/compile.yaml
codex-loom path/to/project/

# Compile with verbose output (prints every file written)
codex-loom --verbose path/to/project/
codex-loom -v path/to/project/

# Compile and wipe stale branch folders first
codex-loom --clean path/to/project/
codex-loom -c path/to/project/

# Generate one leaf-review file per branch leaf
codex-loom --leafReview path/to/project/
codex-loom -l path/to/project/

# Generate a single whole-tree overview file
codex-loom --overview path/to/project/
codex-loom -o path/to/project/

# Generate a seed map (see below)
codex-loom --seed-map path/to/project/
codex-loom -s path/to/project/

# Generate an item body size report (see below)
codex-loom --card-sizes path/to/project/
codex-loom -b path/to/project/

# Generate a syntax lint report (see below)
codex-loom --lint path/to/project/
codex-loom -L path/to/project/

# Combine: compile then generate both review files in one run
codex-loom --compile --leafReview --overview path/to/project/
codex-loom -C -l -o path/to/project/
```

**Mode flags** — `-C`/`--compile`, `-l`/`--leafReview`, `-o`/`--overview`, `-s`/`--seed-map`, `-b`/`--card-sizes`, `-L`/`--lint` — control what runs. Any combination is valid:

**Compile options** — `-d`/`--with-diff`, `-a`/`--with-annotate`, `-c`/`--clean`, `-v`/`--verbose` — modify a compile rather than selecting one. `--with-diff` and `--with-annotate` emit cross-branch review reports from data that only exists in memory during compilation, so either one forces a compile. (`--diff` and `--annotate` are still accepted as aliases.)

| Flags | What happens |
|---|---|
| *(none)* | Compile only (default) |
| `-C` | Compile only (explicit) |
| `-l` | Leaf-review only |
| `-o` | Overview only |
| `-s` | Seed map only |
| `-b` | Item sizes only |
| `-L` | Lint only |
| `-l -o` | Both review modes, no compile |
| `-C -l` | Compile, then leaf-review |
| `-C -o` | Compile, then overview |
| `-C -s` | Compile, then seed map |
| `-C -b` | Compile, then item sizes |
| `-C -L` | Compile, then lint |
| `-C -l -o` | Compile, then both review modes |

`-c`/`--clean` and `-v`/`--verbose` only apply to the compile step.

**Seed map** (`-s`/`--seed-map`) — Reads compiled output and reports which items' body text contains other items' triggers. When Item A's body mentions a word from Item B's trigger list, the Storyteller AI pulling Item A into context may also pull Item B — a "seed." The seed map makes these relationships visible so you can spot unintended context cascade or find items that nothing seeds.

Two files are written to the overview folder:

| File | Contents |
|---|---|
| `{name}.seedmap.md` | Per-branch listing of every item with its trigger list and which other items seed it |
| `{name}.seedmap.csv` | `Branch, Title, Triggers, Seeded By` — sort by **Seeded By** ascending to find items that never get seeded |

"Seeded By" counts distinct seeder items, not individual trigger matches. Items with a count of 0 are never organically pulled in by another item's body text.

**Item sizes** (`-b`/`--card-sizes`) — Reads compiled output and reports the character count of each item's body text. One CSV is written to the overview folder:

| File | Contents |
|---|---|
| `{name}.bodysize.csv` | `Branch, Title, Body Size` — character count of each compiled item body, sorted by branch |

Sort by **Body Size** ascending to spot items that variants may have gutted, or descending to find items that are likely too large for AID's context window. For single-branch scenarios the `Branch` column is omitted.

**Lint** (`-L`/`--lint`) — Reads compiled output (`Story Cards/` and `Components/` `.md` files) and mechanically scans for compile-time artifacts that should never survive into rendered output: unresolved pronoun/character/field tokens (`{$she}`, `{$Aria}`, `{$body.Field}`), unexpanded compile variables (`{%key}`), leaked template render functions and control tags (`{join(...)}`, `{if}`/`{/if}`, `{wrapper}`, `{include}`, etc.), unresolved verb-conjugation markers (`[s]`, `[is]`, `[was]`, ...), a bracketed word that *looks like* an attempted verb marker but isn't one of the real five (e.g. `[does]`, `[have]` — an author-typo case a fixed pattern list alone can't catch, so this is flagged even without knowing what the "correct" token should have been), and JS interpolation artifacts (`[object Object]`, bare `undefined`/`NaN`). It also checks Story Cards for VL structural errors: an item carrying both `[e]` and `/]` (mutually exclusive), an item with neither, an empty trigger list, or a missing `encapsulate: true`.

This is pure pattern-matching — deterministic and exhaustive, with no false-negative risk from an LLM guessing at the token list. It catches the mechanical half of a QA pass; bleed, missing-information, and cross-branch consistency checks still require holding the whole branch structure in mind and are out of scope here.

The same patterns run automatically on every compile (no flag needed) — each item/component prints a `WARN:`/`ERROR`-style line to stdout as it's written, the same way unresolved `{$...}`/`{%...}` tokens already do. `--lint` is for post-hoc scanning of an already-compiled output folder; the automatic pass is for catching problems immediately during a normal compile.

One report is written to the overview folder:

| File | Contents |
|---|---|
| `{name}.lint.md` | Every finding, grouped by file, with severity (`ERROR`/`WARN`), category, and line number(s) |

`ERROR` findings are near-certain bugs (a token that should always resolve). `WARN` findings need a human glance — e.g. a bare `undefined` could theoretically be intentional prose, and a missing `encapsulate: true` is sometimes a deliberate exception.

**Path resolution** — When given a project folder (or no argument), Codex Loom looks for `compile.yaml` inside it to derive the output path and overview path. If no `compile.yaml` is found, it treats the folder as an already-compiled scenario root and runs any requested review modes directly on it — with a warning if `-C` was also requested.

---

## Project Folder Layout

```
my-project/
  compile.yaml                   ← required; project entry point
  items/                         ← project item definitions and imports
    characters.yaml
    locations.yaml
  canon/                         ← shared (canonical) item definitions
    Characters/
      Aness.yaml
      Felicia.yaml
  templates/                     ← .template and .partial files
    Character.template
    Location.template
    ItemHeader.partial
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
  Story Cards/                   ← root-level items (compiled for all branches)
    Character/
      Character.md
  Branches/
    subject/
      Story Cards/               ← all items compiled for the subject leaf
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
```

For nested branches (e.g. branch `A` with children `X` and `Y`), the path is `Branches/A/Branches/X/`.

A project with no `branches:` key produces a single root-level output with no `Branches/` folder.

---

## The Five File Types You Author

| File | Purpose |
|---|---|
| `compile.yaml` | Project configuration — paths, branches, protagonist, component references |
| Item YAML files | Item definitions and imports under `items/` or `canon/` |
| `.template` files | How each item type is rendered to markdown |
| `.partial` files | Reusable template fragments |
| Component YAML files | Plot Essentials, AI Instructions, Author's Note content |

Each is covered in its own reference document.

---

## Core Concepts

**Items** are the atomic units of content — a character, a location, a settings block. Each item has a type (which controls its output folder), a body of content fields, and AID-specific metadata like triggers and encapsulate.

**Canon vs project items** — Canon items live in a shared folder available to any project. Project items are local to one scenario and can import and extend canon items.

**Branches** define playable paths through the scenario. The compiler enumerates all leaf nodes in the branch tree and produces one complete output folder per leaf. Items can be filtered to specific branches or shared across all of them.

**Variants** are named deltas that layer changes on top of an item. A character item might have a `networked` variant that adds implant details, or a `Felix` variant that changes gender. Branch dispatch maps branch names to variant names, so the right version of each item appears in each branch's output.

**Templates** are plain-text files that control how an item's fields are rendered to markdown. Field references, conditional blocks, and render functions let you shape the output precisely.

**Pronoun tokens** let you write field content once and have `{$she}` / `{$her~}` resolve to the correct pronouns for each item or variant. Character ID tokens (`{$Aness}`) resolve to "you" when that character is the active branch protagonist, and to the character's display name otherwise.

---

## Next Steps

- [compile.yaml Reference](02-compile-yaml.md)
- [Item Definition Reference](03-item-yaml.md)
- [Imports & Includes](04-imports-and-includes.md)
- [Branch Tree & Variant Dispatch](05-branches-and-variants.md)
- [Field Operations](06-field-operations.md)
- [Templates & Partials](07-templates.md)
- [Pronoun System](08-pronouns.md)
- [Components (PE, AIN, AN, Opening)](09-components.md)
- [Errors & Warnings](10-errors-and-warnings.md)
