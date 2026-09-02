# Codex Loom — Overview & Getting Started

Codex Loom is a command-line compiler that turns YAML item definitions into Velvet Lattice story card files for AI Dungeon scenarios. You write your characters, locations, and other items in structured YAML; Codex Loom assembles them into the folder layout Velvet Lattice expects, resolves pronoun and role tokens, applies variant chains, and writes each file at the node in the branch tree that owns it.

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

# Freeze the library into a committed snapshot/ tree
codex-loom --snapshot path/to/project/

# Compile against the live library instead of the frozen snapshot
codex-loom --live path/to/project/

# Convert a v3 project to v4 in place (does not compile)
codex-loom --migrate path/to/project/
codex-loom --migrate --rename-cl path/to/project/

# Combine: compile then generate both review files in one run
codex-loom --compile --leafReview --overview path/to/project/
codex-loom -C -l -o path/to/project/
```

**Mode flags** — `-C`/`--compile`, `-l`/`--leafReview`, `-o`/`--overview`, `-s`/`--seed-map`, `-b`/`--card-sizes`, `-L`/`--lint`, `--snapshot`, `--migrate` — control what runs. Any combination is valid except `--migrate`, which runs alone.

**Compile options** — `-d`/`--with-diff`, `-a`/`--with-annotate`, `-i`/`--with-inventory`, `-c`/`--clean`, `-v`/`--verbose`, `--live` — modify a compile rather than selecting one. The first three emit review reports from data that only exists in memory during compilation, so any of them forces a compile. (`--diff`, `--annotate` and `--inventory` are accepted as aliases.)

**Diagnostics** — `--lint-level=off|error|warn` (also `--lint-level warn`) overrides `lint.level` from `compile.yaml`. It reaches the opinion layer only — the quality heuristics (trigger-less cards, prose guesses, unused or duplicated placeholder declarations, convention-pack findings) — and never silences a factual error like a leaked token or a platform-cap overflow. It is deliberately separate from `--verbose`: verbosity is about compile progress, this is about which diagnostics an author wants to hear.

| Flags | What happens |
|---|---|
| *(none)* | Compile only (default) |
| `-C` | Compile only (explicit) |
| `-l` | Leaf-review only |
| `-o` | Overview only |
| `-s` | Seed map only |
| `-b` | Item sizes only |
| `-L` | Lint only |
| `--snapshot` | Freeze the library, no compile |
| `--migrate` | Convert a v3 project in place, no compile |
| `-l -o` | Both review modes, no compile |
| `-C -l` | Compile, then leaf-review |
| `-C -o` | Compile, then overview |
| `-C -s` | Compile, then seed map |
| `-C -b` | Compile, then item sizes |
| `-C -L` | Compile, then lint |
| `-C -l -o` | Compile, then both review modes |

`-c`/`--clean` and `-v`/`--verbose` only apply to the compile step.

**The library snapshot** (`--snapshot`, `--live`) — Shared items declared under `library:` are frozen into a committed `snapshot/` tree with a hashed manifest, so a compile reproduces byte-for-byte even when the shared source moves underneath it. Library-name `{%name}` tokens resolve against the snapshot by default; `--live` redirects them to the working library instead. See [The Library Snapshot](12-snapshot.md).

**Migration** (`--migrate`, `--rename-cl`) — Converts a v3 project to the v4 schema in place and writes `migration-report.md` alongside the config, listing every file touched and a review queue of the conversions that need a human eye. It does not compile; run `codex-loom` again once the project has migrated. `--rename-cl` additionally renames `compile.yaml` to `compile.cl.yaml`. See [Migrating from v3](16-migrating-from-v3.md) for what changes and the hand edits the review queue asks for.

**Seed map** (`-s`/`--seed-map`) — Reads compiled output and reports which items' body text contains other items' triggers. When Item A's body mentions a word from Item B's trigger list, the Storyteller AI pulling Item A into context may also pull Item B — a "seed." The seed map makes these relationships visible so you can spot unintended context cascade or find items that nothing seeds.

Two files are written to the overview folder:

| File | Contents |
|---|---|
| `{name}.seedmap.md` | Per-branch listing of every item with its trigger list and which other items seed it |
| `{name}.seedmap.csv` | `Branch, Title, Triggers, Seeded By` — sort by **Seeded By** ascending to find items that never get seeded |

"Seeded By" counts distinct seeder items, not individual trigger matches. Items with a count of 0 are never organically pulled in by another item's body text.

**Item sizes** (`-b`/`--card-sizes`) — Reads compiled output and measures every item body and every `Opening.md` against AID's field caps: 2,000 characters for a story card body, 4,000 for an Opening. Two files are written to the overview folder:

| File | Contents |
|---|---|
| `{name}.bodysize.csv` | `Branch, Target, Title, Kind, Compiled, On Upload, Limit, Remaining, Status` — one row per measured string, tightest first |
| `{name}.bodysize.md` | A summary table per target, then every item at `NEAR` or `OVER` with how much room it has left |

**A card body has three lengths, and the report shows the two that matter for the cap:**

| Length | What it is | In the report |
|---|---|---|
| Compiled | What Codex Loom wrote into the `.md` — the body with its fence and `## Title` excluded, `%key%` still literal | `Compiled` |
| On upload | What Velvet Lattice sends and AID stores as the card's `value`, after each `%key%` expands to its `${question}` text | `On Upload` |
| In play | What the model actually sees, after the player answers the prompt and `${What is your character's name?}` collapses to their answer | not measured |

**`On Upload` is the only one the cap applies to.** It is the peak: the placeholder question text is longer than the `%key%` that compiled to it, and usually longer than the answer the player eventually gives. So a card at 1,990 compiled characters can be over 2,000 on upload and arrive truncated, even though what the model reads during play would have fitted. Where the two columns agree, the text reaches no declared placeholders.

**"In play" is shown nowhere and is not a gap in the report** — it depends on answers that do not exist until someone plays the scenario, and AID has already truncated by then.

`Status` is `OVER` past the cap, `NEAR` within 10% of it, `OK` below that — the same bands the compiler raises `CL0710`–`CL0713` on, so the report and the build agree. `Target` is `Card` or `Opening`; `Kind` is `story`/`reference` for a card and `leaf`/`framing` for an Opening. Reference items get their own section in the markdown report: soft heuristics skip them, but the caps do not.

Each `Opening.md` is measured as its own file rather than per branch, because Velvet Lattice merges components by filename — a leaf's opening *replaces* an ancestor's rather than adding to it. For single-branch scenarios the `Branch` column is omitted.

**Slot inventory** (`-i`/`--with-inventory`) — Writes `Overview/Inventory.md`, listing every slot a component declares and which items landed in it, per branch. Because an item declares where it renders and a component never learns who filled it, this is the one place the two ends are put back together.

It answers what the diagnostics cannot. `CL0611` fires when a target names a slot no component declares and `CL0614` fires when a declared slot ends up empty, so the typo cases are already loud — but a slot holding the *wrong* items is well-formed by every check the compiler runs, and reading that off the output tree means opening every leaf.

Two tables, and both compress:

| Section | Rows |
|---|---|
| One per slot | Branches grouped by what the slot holds, so a slot filled the same way everywhere is one row reading `all 32` |
| `Items` | Every item with a component target, its slot, and the branches it landed on |

A branch set is written as a path pattern when one describes it exactly — `*/Aness/*/*` rather than sixteen full paths — which also names the axis that decided the row. When no pattern matches the set exactly the branches are listed instead, because a pattern that over-matched would claim a placement that never happened.

Empty and gated slots stay distinct: `(empty)` is a declared, placeable slot nobody targeted, while `(gated off this branch)` is a section the component's own `branches:` excluded, which is a legitimate way to drop a slot's whole contents from one branch.

**Lint** (`-L`/`--lint`) — Reads compiled output (`Story Cards/` and `Components/` `.md` files) and mechanically scans for compile-time artifacts that should never survive into rendered output: unresolved pronoun/character/field tokens (`{$she}`, `{$Aria}`, `{$body.Field}`), unexpanded compile variables (`{%key}`), leaked template render functions and control tags (`{join(...)}`, `{if}`/`{/if}`, `{wrapper}`, `{include}`, etc.), unresolved verb-conjugation markers (`[s]`, `[is]`, `[was]`, ...), a bracketed word that *looks like* an attempted verb marker but isn't one of the real five (e.g. `[does]`, `[have]` — an author-typo case a fixed pattern list alone can't catch, so this is flagged even without knowing what the "correct" token should have been), and JS interpolation artifacts (`[object Object]`, bare `undefined`/`NaN`). It also checks Story Cards for one structural error: an empty or missing trigger list, which means a card that can never be pulled into context.

It also carries one check about *intent* rather than about artifacts: a `${...}` whose
content is identifier-shaped, like `${she}` or `${Aria.she}`. AID's native placeholder and
a Codex Loom token are one transposition apart, and a mistyped `${she}` reaches the player
as a prompt asking them to type the word "she". The content is what separates them: a
token holds an identifier, a real placeholder holds a question written for a human, so
`${What is your name?}` and `${Date: (MM/DD/YYYY)}` draw nothing. Latitude's premade
specials are exempt: `${character.name}`, `${character.gender}`, and the five
`${character.pronoun.*}` forms that follow the gender answer. The exemption is the
`character.` prefix — these have no `%key%` equivalent and every project that wants them
writes them raw, so flagging them would be permanent noise. A bare identifier-shaped
`${they}` is **not** exempt: that is exactly the mistyped `{$they}` this check exists to
catch.

Core lint carries only that one structural check on purpose. Rules about what a card's *content* should say — the `[e]` background-knowledge marker, the `/]` discovery marker, and their mutual exclusion — belong to a particular mod's convention and fire wrongly for every project that does not use it, so they belong to convention packs rather than core lint.

This is pure pattern-matching — deterministic and exhaustive, with no false-negative risk from an LLM guessing at the token list. It catches the mechanical half of a QA pass; bleed, missing-information, and cross-branch consistency checks still require holding the whole branch structure in mind and are out of scope here.

The same patterns run automatically on every compile (no flag needed) — each item/component prints a `WARN:`/`ERROR`-style line to stdout as it's written, the same way unresolved `{$...}`/`{%...}` tokens already do. `--lint` is for post-hoc scanning of an already-compiled output folder; the automatic pass is for catching problems immediately during a normal compile.

One report is written to the overview folder:

| File | Contents |
|---|---|
| `{name}.lint.md` | Every finding, grouped by file, with severity (`ERROR`/`WARN`), category, and line number(s) |

`ERROR` findings are near-certain bugs (a token that should always resolve). `WARN` findings need a human glance — a bare `undefined` could theoretically be intentional prose, and an item with no triggers is legitimate when it is never meant to be pulled in by name.

**Path resolution** — When given a project folder (or no argument), Codex Loom looks for `compile.yaml` inside it to derive the output path and overview path. If no `compile.yaml` is found, it treats the folder as an already-compiled scenario root and runs any requested review modes directly on it — with a warning if `-C` was also requested.

---

## Project Folder Layout

```
my-project/
  compile.cl.yaml                ← required; project entry point
  items/                         ← project item definitions and imports
    characters.cl.yaml
    locations.cl.yaml
  canon/                         ← shared item definitions, declared under `library:`
    main/
      Aness.cl.yaml
      Felicia.cl.yaml
  templates/                     ← field tables, and .template/.partial escape hatches
    fields.cl.yaml
    terse.cl.yaml                ← a context tier's slot file, if the project has one
    Notes.template
    ItemHeader.partial
  components/                    ← optional; one file per component
    plot-essentials.cl.yaml
    ai-instructions.cl.yaml
    authors-note.cl.yaml
  snapshot/                      ← written by --snapshot; committed
  output/                        ← compiler writes here (do not edit manually)
```

**Paths are declared, not conventional.** Nothing above is a magic directory name — `structure.input.items`, `structure.input.templates`, `structure.input.library` and `structure.output` name them, and the layout here is only what a typical project chooses. `library:` is a *mapping* of names to directories (`main: ./canon/main`), and each name is auto-exposed as a `{%name}` variable, which is how a component or item refers to shared content. See [compile.yaml Reference](02-compile-yaml.md).

**`.cl.yaml` is the v4 extension.** Plain `.yaml` still loads; the suffix marks a file as Codex Loom's rather than something else's, and `--migrate --rename-cl` applies it to the config too.

---

## Output Structure

**Each file is written once, at the node that owns it.** Velvet Lattice inherits components, placeholders, scripts and story cards down the branch tree, so a leaf resolves to its ancestors' files without holding copies of them. A card or component that is identical across every branch is written at the root and nowhere else.

For a project with two branch leaves `subject` and `researcher` that share most of their content:

```
output/
  Story Cards/                   ← every card identical across both leaves
    Character/
      Character.md
  Components/
    AI Instructions.md           ← identical at both leaves, so written once here
  Label.md                       ← only when it differs from the directory name
  Branches/
    subject/
      Story Cards/
        Character/
          Character.md           ← only the cards this leaf renders differently
      Components/
        Opening.md               ← per-leaf: this branch's first move
        Plot Essentials.md       ← per-leaf: slots filled by per-branch items
      Description.md             ← never inherits; written at every node
      Scripts/                   ← optional; copied from scripts source
    researcher/
      Components/
        Opening.md
        Plot Essentials.md
      Description.md
```

For nested branches (e.g. branch `A` with children `X` and `Y`), the path is `Branches/A/Branches/X/`.

A project with no `branches:` key produces a single root-level output with no `Branches/` folder.

**Two files never inherit and are written at every node that needs one:** `Label.md` and `Description.md`. Velvet Lattice reads both from the node's own directory with no parent in scope. `Label.md` is additionally omitted whenever the rendered label equals the directory segment, because VL falls back to the directory name when the file is absent.

**Story cards are placed by frontier.** For each card and each distinct rendered text, the compiler finds the minimal set of nodes whose subtrees cover exactly the leaves that produced that text. A card constant everywhere lands at the root; a card scoped to one subtree lands once per subtree; a card with per-branch variant bodies gets one copy per version. This is why a leaf folder can contain far fewer cards than the branch actually plays with — the rest are inherited.

**Reading the output tree is not how you check what a branch contains.** Use `--leafReview`, which resolves each leaf through its ancestor chain and writes one file showing everything that branch actually gets.

---

## The File Types You Author

| File | Purpose |
|---|---|
| `compile.cl.yaml` | Project configuration — paths, branches, roles, placeholders, component references |
| Item YAML files | Item definitions and imports, under the directories `structure.input.items` and `library:` name |
| `fields.cl.yaml` | Field declarations, groups and template lists — how each item type is rendered |
| `.template` / `.partial` files | The escape hatch, for what a field list cannot express |
| Component YAML files | Plot Essentials, Summary, AI Instructions, Author's Note, Opening and Description content |
| Lint pack files | Optional; declarative convention checks, enabled per project under `lint.packs` |

Each is covered in its own reference document.

**All seven component types share one grammar.** A component is a named mapping of `sections:`, and Plot Essentials, Summary, AI Instructions, Author's Note, Opening, branch framing and Description all read the same way. `imports:` pulls sections in from another component file and nests to any depth, which is how a house style is shared across projects. A component key may also point straight at a `.md` or `.txt`, which is copied through verbatim and declares no sections. See [Components](09-components.md).

---

## Core Concepts

**Items** are the atomic units of content — a character, a location, a settings block. Each item has a type (which controls its output folder), a body of content fields, and AID-specific metadata such as its triggers and card name.

**Library vs project items** — Library items live in shared folders available to any project, declared as a mapping of names to directories under `library:`. Each name becomes a `{%name}` variable. Project items are local to one scenario and can import and extend library items. `--snapshot` freezes the library so a compile reproduces byte-for-byte even after the shared source moves.

**Branches** define playable paths through the scenario. The compiler enumerates every leaf in the branch tree and resolves each one's full content, then writes each file once at the node that owns it — Velvet Lattice inherits the rest down the tree. Items can be filtered to specific branches or shared across all of them.

**Roles** name a character by the part they play rather than by who fills it — `protagonist`, `LI`, `rival`. A `{$role}` token resolves to whichever item that branch binds the role to, so one piece of text serves every branch. Roles are declared at the project root and rebound per branch node.

**Placeholders** are AID's own `${question}` prompts, declared once under `placeholders:` and referenced as `%key%`. The player answers them when the adventure starts.

**Variants** are named deltas that layer changes on top of an item. A character item might have a `networked` variant that adds implant details, or a `Felix` variant that changes gender. Branch dispatch maps branch names to variant names, so the right version of each item appears in each branch's output.

**Field declarations** control how an item's fields are rendered to markdown. A field is declared once — its label, render function and formatting — and a template is an ordered list of field and group names, with list order equal to output order. `templateFor` selects which lists apply per branch, which is also how a context tier works. Text templates remain available for the few shapes a field list cannot express.

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
- [Components (PE, Summary, AIN, AN, Opening, Description)](09-components.md)
- [Field Declarations](10-field-declarations.md)
- [Diagnostic Codes](11-diagnostics.md)
- [The Library Snapshot](12-snapshot.md)
- [Roles](13-roles.md)
- [Convention Packs](14-convention-packs.md)
- [Context Tiering](15-context-tiering.md)
- [Migrating from v3](16-migrating-from-v3.md)
