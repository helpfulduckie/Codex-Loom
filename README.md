# Codex Loom

Codex Loom is a command-line compiler that turns YAML card definitions into Velvet Lattice
story card files for AI Dungeon scenarios. You write your characters, locations, spells and
lore once as structured YAML; Codex Loom assembles them into the folder layout Velvet Lattice
expects, resolves pronoun tokens, applies variant chains, and generates one complete output
folder per playable branch.

It exists because a branching scenario multiplies its own content. A cast of twelve across
four branch points is not twelve cards, it is twelve cards written some number of times each
with small deliberate differences — and keeping those differences deliberate, rather than
letting them drift, is the whole problem.

## What it does

- **One definition, many branches.** Cards are declared once and dispatched down a branch
  tree, with per-branch variants layering overrides onto a shared base.
- **Pronoun resolution.** Pronoun tokens and `[s]`-style verb agreement resolve per card, so
  a character whose gender differs by branch reads correctly in every one.
- **Templates.** Card bodies render through templates, so the shape of a Character card is
  stated once rather than repeated in every file.
- **Canon imports.** A shared canon directory can be imported across projects, with
  per-project overrides.
- **Reports.** Whole-tree overviews, per-leaf review files, seed maps, card body-size
  measurements, and a syntax lint pass.

## Install

```bash
npm install
npm install -g .
```

The `codex-loom` command is then available anywhere.

## Usage

```bash
codex-loom path/to/project/
```

The positional argument is a `compile.yaml` or a folder containing one; omitted, it uses the
current directory. Flags are combinable:

| Flag | Short | What it does |
|---|---|---|
| `--verbose` | `-v` | Print every file written |
| `--clean` | `-c` | Wipe stale branch folders first |
| `--overview` | `-o` | One whole-tree overview file |
| `--leafReview` | `-l` | One review file per branch leaf |
| `--seed-map` | `-s` | Which cards seed which branches |
| `--card-sizes` | `-b` | Card body length report |
| `--lint` | `-L` | Syntax lint report |

See [documentation/01-overview.md](documentation/01-overview.md) for the full CLI and
[documentation/](documentation/) for the YAML surface.

## Project status

**This branch is v3.3.2, the released compiler, and it is stable.**

Active development is the **v4 rebuild on the [`v4-phase1`](../../tree/v4-phase1) branch** — a
clean break rather than an upgrade. v4 changes the config format, renames cards to items,
splits the compiler from the lint pass, adds player placeholders and the platform's field
caps, and carries a much larger test suite. It is not backward compatible with v3 projects,
though it ships a migrator. **If you are reading this to see how the project is built, read
`v4-phase1` rather than this branch.**

## Tests

```bash
npm test
```

Also available: `test:unit`, `test:integration`, `test:coverage`. `npm run compile` compiles
`test/compile.yaml` as a smoke check.

## License

MIT — see [LICENSE](LICENSE).
