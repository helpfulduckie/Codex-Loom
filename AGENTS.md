# Codex Loom — instructions for coding agents

Codex Loom compiles YAML item definitions into Velvet Lattice story card format for AI
Dungeon scenarios. The current compiler is v4 (see `package.json`), a clean break from v3
with no compatibility mode; v3.3.2 was the last v3 release, and `--migrate` converts a v3
project in place.

This file is the single source for agent instructions. `CLAUDE.md` imports it.

## Running and finishing

`npm test` runs the Jest suite (`test:unit`, `test:integration` and `test:coverage` are also
available). `npm run compile` compiles `test/compile.yaml` as a smoke check; its
`CL0630`/`CL0631` warnings are expected.

**A change is done when the full suite passes, the smoke compile passes, and the
documentation says what the code now does.** Report the passing count, and say whether the
golden suites ran (see Fixtures).

## Where things are

- **`documentation/dev-guide.md`** is the module map and data flow. Read it before a change
  that crosses modules.
- **`documentation/design-spec.md`** is the v4 design: what each construct means and why.
- **`documentation/01`–`15`** are the author-facing chapters, and **`skill/aid-codex-loom/`**
  is the authoring skill that restates them. A behavior change edits both.
- **`documentation/11-diagnostics.md`** holds the table `diag.test.js` cross-checks against
  `src/diag.js`, so a new code or a severity change edits both.

**`sections:` is the only component grammar.** A component is a named mapping of sections,
and every component type (Plot Essentials, AI Instructions, Author's Note, Opening,
Description) reads the same way. `.template` and `.partial` files remain as the escape hatch
for what a field list cannot express.

## Fixtures — three kinds, and they fail differently

**`examples/` freezes compiled output and is committed here.** The example projects are the
worked examples `documentation/` points at and the baseline
`__tests__/fixtures/examples.test.js` asserts byte-for-byte. `examples/projects.js` is the set
manifest, `__tests__/helpers/baselineHarness.js` is the harness, and `scripts/rebaseline.js`
regenerates a baseline, classifying the diff before it will write (`--set examples` is the
default).

**`__tests__/fixtures/pathological/` freezes the diagnostic stream.** Its projects are wrong
on purpose, with a committed snapshot of every code, severity, file and message they raise.
It exists because the other fixtures are all correct projects, so a check that never fired
would pass the whole suite. Its `README.md` carries the editing rules. The important one: it
is authored from the spec, so where the compiler disagrees the fixture pins the disagreement
rather than being edited to match.

**`goldenFixtures/` freezes compiled output and is not in this repository.** The golden
projects are real scenarios containing unpublished writing, so they live in a separate
private repository cloned into the gitignored `goldenFixtures/`.

**If `goldenFixtures/` is absent, the skips are intended. Do not try to repair them.**
`golden.test.js` and `migrate.integration.test.js` register as skipped, one `describe` in
`emit-vl.test.js` skips, and everything else runs. There is no dependency to install and no
path to fix. Treat that as green.

**A green run does not prove the goldens passed, because a skipped suite and a satisfied one
look the same.** If the fixtures are present, confirm those suites ran before calling an
output-affecting change done. The `examples/` set means some baseline is always compared, but
the goldens cover scale and messiness the examples do not reach.

**A re-baseline is a reviewed diff, never a fix.** Regenerate with `scripts/rebaseline.js`
after a deliberate output change and read the classified diff. Never hand-edit a baseline to
make a test pass, and treat an unexplained difference as a bug.

**Baseline compiles pass `live: true`, so a set's committed sources are what its baseline is
checked against.** A project that declares `structure.input.snapshot` otherwise resolves
every library entry into its own frozen `snapshot/` copy, under which an edit to a shared
library compiles clean, moves no bytes, and passes. `baselineHarness.js` and
`scripts/rebaseline.js` both set the flag and must stay in step. The harness also asserts
that every snapshot entry still hashes equal to the live source it was frozen from; a
snapshot that has legitimately moved is refreshed with `--snapshot` and committed.

**`library-dependencies.json` is the one baseline `rebaseline.js` will not write,** because
the manifest records absolute paths and a copy made from the temp tree bakes that root in.
Refresh it by compiling the project in place, copying the file into the baseline directory,
and deleting the compiled output afterward.

## Where a file gets written

**A component, placeholder, script or story card is written at the node that owns it, never
copied to every leaf.** Velvet Lattice inherits these down the branch tree
(`{**parent, **local}`), so a leaf resolves to its ancestors' files without holding copies.
`Label.md` and `Description.md` are the two exceptions: Velvet Lattice reads both from the
node's own directory with no parent in scope, so they land at every node that needs them.
Collapsing `Description.md` with the rest would silently empty every leaf's adventure
description.

**Story cards and script files are placed per name, with overrides.** Velvet Lattice
resolves a leaf's file by name, nearest copy first, so `placeWithOverrides` writes each
name's versions where every leaf resolves to its own version in the fewest copies: the common
version once at the ancestor, the odd leaf overriding it. A leaf that lacks the file blocks
any copy above it, since Velvet Lattice cannot remove an inherited one. Ties go to the layout
without overrides.

**The story-card placement key is the card name, never the item id.** A `variants:` item
keeps one id while its name and type differ per branch, so keying on id files a card under
the wrong type.

**Anything that reads a leaf's cards from the compiled tree must merge by name**
(`compiledTree.resolveAt`). Concatenating ancestor folders lists an overridden card twice.

**A duplicate card name on one leaf is a compile error (`CL0622`), cross-type or not.**
Velvet Lattice merges cards by name alone, so only one would reach AI Dungeon.

## Line endings are load-bearing in the fixtures

**`.gitattributes` forces LF on checkout, and the fixtures depend on it.** The pathological
snapshot records opening lengths in characters, and `CL0710`/`CL0711` compare those lengths
against the platform's 4,000-character cap, so a CRLF checkout adds a byte per line and moves
numbers the snapshot has pinned. `git status` cannot show this, because Git normalizes on
read. If fixture assertions fail by a handful of characters on a fresh clone, check line
endings before suspecting the compiler.

## Comments and tests

**A comment explains why the present code is shaped as it is.** What the code used to be
belongs in the commit message, not beside the code.

Do not write:

- What a previous version did ("v3 walked this separately").
- Which phase, session or date produced the code, or who decided it.
- A design that was considered and rejected, unless a reader would otherwise reintroduce it.
- A restatement of what the function below does, at any length.
- Hardcoded `file.js:NNN` references. Name the function; line numbers go stale silently.

Do write the constraint that is not visible from the code: an ordering that matters, an
invariant a caller must hold, a workaround whose cause is elsewhere, a case the obvious
implementation gets wrong.

**If a comment block is longer than the code it introduces, it is documentation and belongs
in the dev guide.** Keep the one sentence a reader needs at that line and move the rest.

**Test titles name behavior, not provenance.** No phase numbers, no spec section citations.

**When a change removes behavior, deleting the tests that asserted it is part of that
change.** A test asserting that something no longer happens passes forever and proves nothing
about the current system.

## Maintainer context

The maintainer keeps private notes outside this repository at `~/.claude/codex-loom.md`.
Read that file if it exists; its absence is expected for everyone else.
