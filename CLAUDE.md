# Codex Loom

Codex Loom compiles YAML item definitions into Velvet Lattice story card format
for AI Dungeon scenarios. The released compiler is v3.3.2 (see `package.json`);
active work is the v4 rebuild on the `v4-phase1` branch — a clean break from v3.
**Phases 1 through 13 are complete.** Phase 13 added context tiering (a tier is
a branch carrying `templateFor: { base: terse.cl.yaml }`; a label-membership
guard replaces byte-identity for tier output), the `render.storyCards` emit path
with `card:` removed, a `syncLibrary` prune, and the notes-ladder collapse to
three rungs. Coinflip carries the one worked `lowContext` tier. Phase 14 is
convention packs.

The phases a change today is most likely to touch. **Phase 8** migrates v3
projects in place (`--migrate`, `--rename-cl`) and writes a `migration-report.md`
with a review queue. **Phase 9** is the diagnostics layer —
`documentation/11-diagnostics.md` is the table `diag.test.js` cross-checks, so a
severity change edits both. **Phase 10** froze five report modes against
committed baselines and gave the compiled tree one shape (`src/compiledTree.js`,
`own` vs `resolved`). **Phase 11** stopped writing every component to every
leaf: Velvet Lattice inherits down the branch tree by itself, so each component,
placeholder and story card is written at the node that owns it — The Institute's
compiled tree went from 891 files to 186. **Phase 12** replaced the text-template
surface with declarations: a field is declared once in `fields.cl.yaml`, a
template is an ordered list of field and group names, `templateFor` selects a
template per rendering role, and an unread-field audit (`CL0426`–`CL0428`) flags
a `body:` key none of an item's renders read (rescoped per-item 2026-09-03).

**Phase 7's library snapshot is the mechanism a snapshot question hits:**
`structure.input.canon` is `library:`, `--snapshot` freezes it into a committed
`snapshot/` tree with a hashed manifest, and library-name `{%name}` tokens
redirect to the snapshot unless `--live` is passed.

**`sections:` is the only component grammar.** v3's four syntaxes are gone:
`src/pe.js`, `src/description.js` and `src/opening.js` no longer exist. A
component is a named mapping of sections, and every component type — Plot
Essentials, AI Instructions, Author's Note, Opening, Description — reads the
same way. The multi-target render (`render: {component, storyCards}`) is Phase
13, where `card:` is also removed; `.template` / `.partial` stay as the escape
hatch for what a field list cannot express.

Run: `npm test` (Jest — `test:unit`, `test:integration`, `test:coverage` also
available). `npm run compile` compiles `test/compile.yaml` as a smoke check.

## Fixtures — three kinds, and they fail differently

**`examples/` freezes compiled output and is committed here.** The example projects are
double-duty: worked examples `documentation/` points at, and the baseline
`__tests__/fixtures/examples.test.js` asserts byte-for-byte. Because they are committed they
always run, which is why they carry the standing output obligation. `examples/projects.js` is
the set manifest; `__tests__/helpers/baselineHarness.js` is the harness it shares with the
goldens; `scripts/rebaseline.js` regenerates a baseline, classifying the diff before it will
write (`--set examples` is the default).

**`__tests__/fixtures/pathological/` freezes the diagnostic stream.** Four projects that are
wrong on purpose, with a committed snapshot of every code, severity, file and message they
raise. It exists because the other fixtures are all *correct* projects, so a check that never
fired would pass the whole suite. Its own `README.md` carries the editing rules; the important
one is that it is authored from the spec, so where the compiler disagrees the fixture pins the
disagreement rather than being edited to match.

**`goldenFixtures/` freezes compiled output and asserts byte identity — and it is not in this
repository.** The golden projects are real AI Dungeon scenarios containing unpublished
writing, so they live in a separate private repo cloned into the gitignored `goldenFixtures/`.

**Baseline compiles pass `live: true`, so a set's committed sources are what its baseline is
checked against.** Each golden project declares `structure.input.snapshot`, and without that
flag every library entry and every out-of-base template dir resolves into the project's own
frozen `snapshot/` copy — under which an edit to the shared `_CodexLoom/` tree compiles clean,
moves no bytes, and passes. `baselineHarness.js` and `scripts/rebaseline.js` both set it, and
they must stay in step or the regeneration and the check disagree about what they compiled.
The harness also asserts per project that every snapshot entry still hashes equal to the live
source it was frozen from, because that is now the only check standing between a stale freeze
and nothing: `checkDrift`'s live-drift report is a bare `console.log` the harness mutes, and
`CL0113` compares the frozen copy against its own manifest rather than against its source. A
snapshot that has genuinely moved gets refreshed with `--snapshot` and committed.

**`library-dependencies.json` is the one baseline `rebaseline.js` will not write**, because
the manifest records absolute paths and a copy made from the temp tree bakes that root in. It
is refreshed by compiling the project in place, copying the file into the baseline directory,
and deleting the `Velvet Lattice/` output afterward — that directory is gitignored, so output
left behind there is invisible to `git status` and is inherited by
`migrate.integration.test.js`, which copies the golden tree unfiltered.

**If that directory is absent, this is all working as intended.** `golden.test.js` and
`migrate.integration.test.js` register their suites as skipped, one `describe` in
`emit-vl.test.js` skips, and everything else runs. The full suite with the goldens present is
**2,704 across 86 suites** (2026-09-03, live-baseline session); without them the passing
count is lower and the four fixture-dependent `describe`s register as skipped. **Do not try to
repair this.** There is no missing dependency to install and no path to fix; the tests are
skipping because the data they compare against is private. Treat that as green.

**What this costs, and it is worth stating plainly:** a passing suite is no longer proof the
goldens passed, because a skipped suite and a satisfied one both look green. If you have the
fixtures, confirm they actually ran before calling an output-affecting change done. **The
`examples/` set narrows this but does not close it** — some baseline is now always checked, so
a green run is no longer compatible with *nothing* having been compared, but the goldens cover
scale and messiness the examples do not yet reach.

## Where a file gets written — the Phase 11 rule

**A component, placeholder or story card is written at the node that owns it, never copied
to every leaf.** Velvet Lattice inherits all four categories down the branch tree
(`{**parent, **local}`), so a leaf resolves to its ancestors' files without holding copies.
`Label.md` and `Description.md` are the two exceptions: VL reads both from the node's own
directory with no parent in scope, so they still land at every node that needs them.
Collapsing `Description.md` alongside the rest would silently empty every leaf's adventure
description.

**Story cards are placed by frontier, and the key is `(type, name)` — never the item id.**
For each card and each distinct rendered text, the emitter finds the minimal set of nodes
whose subtrees partition exactly the leaves that produced that text, and writes one copy per
frontier node. A `variants:` item keeps one id while its name and type differ per branch, so
keying placement on id files a card under the wrong type. This cost a real bug on the first
pass.

**A duplicate card name on one leaf is a compile ERROR (`CL0622`), cross-type or not.** VL
merges cards by name alone, so only one ever reaches AID and an author who wrote two is
always wrong.

## Line endings are load-bearing in the fixtures

`.gitattributes` pins `__tests__/fixtures/**` and `test/**` to `eol=lf`. This is not
housekeeping. The pathological snapshot records opening lengths in characters and CL0710 /
CL0711 compare those lengths against the platform's 4,000-character cap, so a checkout that
turns LF into CRLF adds a byte per line and moves numbers the snapshot has pinned. Under
`text=auto` alone that happens on any machine with `core.autocrlf=true`, and `git status`
cannot show it — Git normalizes on read and reports the file unmodified. If fixture
assertions ever fail by a handful of characters on a fresh clone, check this before
suspecting the compiler.

@~/.claude/codex-loom.md
