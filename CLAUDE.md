# Codex Loom

Codex Loom compiles YAML item definitions into Velvet Lattice story card format
for AI Dungeon scenarios. The released compiler is v3.3.2 (see `package.json`);
active work is the v4 rebuild on the `v4-phase1` branch — a clean break from v3,
with Phases 1 through 5 complete — Phase 4 being player placeholders, Phase 5 the
platform field caps, the `--card-sizes` rework, `kind:` and the compiler/lint split.
Phase 6 — component `imports:`, description as a component, multi-target render — is
next.

Run: `npm test` (Jest — `test:unit`, `test:integration`, `test:coverage` also
available). `npm run compile` compiles `test/compile.yaml` as a smoke check.

## Fixtures — two kinds, and they fail differently

**`__tests__/fixtures/pathological/` freezes the diagnostic stream.** Two projects that are
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
`emit-vl.test.js` skips, and everything else runs — roughly 1,596 passing with 13 skipped.
**Do not try to repair this.** There is no missing dependency to install and no path to fix;
the tests are skipping because the data they compare against is private. Treat that as green.

**What this costs, and it is worth stating plainly:** a passing suite is no longer proof the
goldens passed, because a skipped suite and a satisfied one both look green. If you have the
fixtures, confirm they actually ran before calling an output-affecting change done.

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
