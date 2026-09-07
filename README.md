# Codex Loom

> A better way to write and manage reusable and branching content in AI Dungeon scenarios.

by helpfulduckie (aka Aness)

---

## Overview

Codex Loom is a structured prose based authoring language for writing AI Dungeon scenarios for upload via [Velvet Lattice](https://gitlab.com/robyn-hourglass/velvet-lattice). It lets you define sections of your characters, world building, and lore in bite sized pieces that can then be overwritten on demand and combined dynamically for reuse across many branches of a scenario or even between scenarios. 

When authoring through AI Dungeon's built in scenario editor, every branch is a significant authoring burden. Every shared story card needs to be copied to every branch. Every variation of every card needs to be copied and then surgically line edited to match your vision. Later revisions need to be carefully propagated between branches so as not to overwrite something specific to a given branch while rolling out a global change. It is hard and the combinatorics mean every additional layer of branching multiplies that effort. It isn't sustainable on large projects. 

Worse, if you have a reoccurring cast, a world you keep writing scenarios in, a magic system you reuse, and you decide you want to edit it, you are forced to choose between editing your existing catalogue (every branch of every scenario you wish to maintain) or letting older scenarios (that you might still be play new adventures from) fall out of date. 

These two pain points are what Codex Loom was built to mitigate. 

Write your characters, locations, lore once. Tweak the parts that matter per project or per branch. Edit the baseline version once and watch it propagate to every other instance while automatically respecting the project level changes that you already have been made there. 

Easily make male, female, or non-binary versions of any character. 

Provide multiple prebuilt protagonists (or love interests) alongside the option for a custom built one. 

Configure a low context version along side your high context vision. 

Set up different scripts on different branches.

All while increasing your authoring burden linearly, instead of multiplicatively. 

---

## What it does

- **One definition, many branches.** Content is authored once and dispatched down a branch
  tree, with per-branch variants layering overrides onto a shared base.
- **Pronoun resolution.** `{$Aness.she}` and `[s]`-style verb agreement resolve per item, so
  a character whose gender differs by branch reads correctly in every one.
- **Declared fields.** A field's label and formatting are stated once, and a template is an
  ordered list of field names — so the shape of a Character card lives in one place rather
  than repeated across template files.
- **Library imports.** A shared library directory can be imported across projects, with
  per-project overrides, and frozen into a committed snapshot so a compile reproduces
  byte-for-byte after the shared source moves.
- **Reports.** Seed maps, card-size measurements against the platform's field caps, and a
  syntax lint pass — all reading the compiled tree back, so they measure what AID will
  actually store.

---

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

---

## What is in this repo?

**Authors**:
- [documentation/](documentation/) - Full details on how to use Codex Loom and author with it. 
- [examples/](examples/) - Four example projects that demonstrate what Codex Loom can do and the shared library of content the examples pull from. 
- [skill/](skill/) - a skill to teach your AI agent of choice how to author with Codex Loom (written for Claude, likely compatible with most systems) 
- [packs/](packs/) - a set of authoring opinions about what makes a "good" scenario. They are optional add-ons you can set Codex Loom up police. Use as is or write your own to help enforce your own desired authoring patterns (see [Convention Packs](documentation/14-convention-packs.md) for more information)

**Developers**: check out the [Dev-README.md](Dev-README.md) for more information. 

---

## License

MIT — see [LICENSE](LICENSE).
