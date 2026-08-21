# Codex Loom

Codex Loom is a command-line compiler that turns YAML item definitions into Velvet Lattice
story card files for AI Dungeon scenarios. You write characters, locations, spells and lore
once as structured YAML;
Codex Loom resolves pronoun tokens, applies variant chains, and emits one complete output
folder per playable branch.

It exists because a branching scenario multiplies its own content. A cast of twelve across
four branch points is not twelve cards, it is twelve cards written some number of times each
with small deliberate differences — and keeping those differences deliberate, rather than
letting them drift, is the whole problem.

## What it does

- **One definition, many branches.** Items are declared once and dispatched down a branch
  tree, with per-branch variants layering overrides onto a shared base.
- **Pronoun resolution.** `{$Aness.she}` and `[s]`-style verb agreement resolve per item, so
  a character whose gender differs by branch reads correctly in every one.
- **Templates.** Item bodies render through templates, so the shape of a Character card is
  stated once rather than repeated in every file.
- **Canon imports.** A shared canon directory can be imported across projects, with
  per-project overrides.
- **Reports.** Seed maps, card-size measurements against the platform's field caps, and a
  syntax lint pass — all reading the compiled tree back, so they measure what AID will
  actually store.

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
current directory. Flags are combinable — `--verbose`, `--clean`, `--overview`, `--seed-map`,
`--card-sizes`, `--lint`. See [documentation/01-overview.md](documentation/01-overview.md)
for the full CLI and [documentation/](documentation/) for the YAML surface.

## Project status

**The released compiler is v3.3.2, on `main`.** Active development is the v4 rebuild on the
`v4-phase1` branch — a clean break from v3, with Phases 1 through 5 complete. v4 changes the
config format, splits the compiler from the lint pass, adds player placeholders and the
platform field caps, and reworks `--card-sizes`. If you are reading this to see how the thing
is built, read `v4-phase1`.

## Tests

```bash
npm test
```

Also available: `test:unit`, `test:integration`, `test:coverage`. `npm run compile` compiles
`test/compile.yaml` as a smoke check.

Two fixture sets back the suite, and they fail differently:

- **`__tests__/fixtures/pathological/`** freezes the *diagnostic stream* — two projects that
  are wrong on purpose, with a committed snapshot of every code, severity, file and message
  they raise. It is authored from the spec, so where the compiler disagrees the fixture pins
  the disagreement rather than being edited to match.
- **`goldenFixtures/`** freezes v3-compiled *output* and asserts byte identity across every
  phase. These are real scenario projects and unpublished worldbuilding, so they live in a
  separate **private** repository — `helpfulduckie/Codex-Loom-Fixtures`, cloned into the
  gitignored `goldenFixtures/` — rather than in this tree. You will not have access to it,
  and you do not need it: `__tests__/fixtures/golden.test.js` reports its tests as skipped
  when the directory is absent, and the other 50 suites run normally.

## License

MIT — see [LICENSE](LICENSE).
