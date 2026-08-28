# Codex Loom

Codex Loom compiles YAML item definitions into Velvet Lattice story card format
for AI Dungeon scenarios. The released compiler is v3.3.2 (see `package.json`);
active work is the v4 rebuild on the `v4-phase1` branch — a clean break from v3.
**Phases 1 through 11 are complete, plus Phase 12 Sessions A–C.** Phase 12
Session D (lifting `Scripts/` to its declaring node) and Phase 13 (context
tiering plus `render.storyCards`) are planned, not built; Phase 14 is convention
packs.

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
a `body:` key no template reads.

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

## Fixtures — two kinds, and they fail differently

**`__tests__/fixtures/pathological/` freezes the diagnostic stream.** Four projects that are
wrong on purpose, with a committed snapshot of every code, severity, file and message they
raise. It exists because the other fixtures are all *correct* projects, so a check that never
fired would pass the whole suite. Its own `README.md` carries the editing rules; the important
one is that it is authored from the spec, so where the compiler disagrees the fixture pins the
disagreement rather than being edited to match.

**`goldenFixtures/` freezes compiled output and asserts byte identity — and it is not in this
repository.** The golden projects are real AI Dungeon scenarios containing unpublished
writing, so they live in a separate private repo cloned into the gitignored `goldenFixtures/`.

**If that directory is absent, this is all working as intended.** `golden.test.js` and
`migrate.integration.test.js` register their suites as skipped, one `describe` in
`emit-vl.test.js` skips, and everything else runs. The full suite with the goldens present is
**1,961 across 71 suites** (as of Phase 12 Session C); without them the passing count is lower
and 15 tests register as skipped. **Do not try to repair this.** There is no missing dependency
to install and no path to fix; the tests are skipping because the data they compare against is
private. Treat that as green.

**What this costs, and it is worth stating plainly:** a passing suite is no longer proof the
goldens passed, because a skipped suite and a satisfied one both look green. If you have the
fixtures, confirm they actually ran before calling an output-affecting change done.

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
