# Codex Loom

Codex Loom compiles YAML item definitions into Velvet Lattice story card format
for AI Dungeon scenarios. The released compiler is v3.3.2 (see `package.json`);
active work is the v4 rebuild on the `v4-phase1` branch — a clean break from v3,
with Phases 1 through 4 complete — Phase 4 being player placeholders. Phase 5, platform
limits, is planned and half built: Sessions A and B are in, Session C — the `--card-sizes`
rework — is next. See the design spec below.

Run: `npm test` (Jest — `test:unit`, `test:integration`, `test:coverage` also
available). `npm run compile` compiles `test/compile.yaml` as a smoke check.

## Fixtures — two kinds, and they fail differently

**`goldenFixtures/` freezes v3-compiled output and asserts byte identity.** Three real
projects. They stay byte-for-byte through every phase unless that phase's plan says it
re-baselines them, and a re-baseline is reviewed as a diff against intent — see §14.3 of
the design spec. Report the goldens' state when reporting a change as done.

**`__tests__/fixtures/pathological/` freezes the diagnostic stream instead.** Two projects
that are wrong on purpose, with a committed snapshot of every code, severity, file and
message they raise. It exists because the goldens are all *correct* projects, so a check
that never fired would pass the whole suite. Its own `README.md` carries the editing rules;
the important one is that it is authored from the spec, so where the compiler disagrees the
fixture pins the disagreement rather than being edited to match.

## Vault notes

Design decisions, session history, and open queues live in the vault, not
here.

- **`Vault:4.3.11 AID Tools - Codex Loom`** — durable references and plans.
  - `Codex Loom.md` — hub note; current state, known problems with v3, links to the v4 spec.
  - `v4-design-spec.md` — the v4 design spec draft; decisions and open questions for the next iteration.
  - `v4 Phase 3 plan.md`, `v4 Phase 4 plan.md`, `v4 Phase 5 plan.md` — per-phase plans. Each carries the decisions
    settled during planning, and a `## Claude` queue of what the phase deliberately left
    undone. The spec is current as of 2026-08-18 and wins on any disagreement; the plans are
    the record of how a phase went and why a section says what it says.
  - `Fable's thoughts on Codex Loom v3.md` — review of the v3 codebase done ahead of writing the v4 spec.
  - `VL inheritance and output duplication.md` — Velvet Lattice inherits components and cards down the branch tree by itself; Codex Loom writes them to every leaf instead. Measured, with the VL source that proves it.
  - `Beth's Walk through Codex Loom.md` — Beth's read-through questions on the Phase 1 codebase, and what they turned up.
- **`Vault:4.3.11 AID Tools - Codex Loom\0 System\03 Records`** — session recaps, one per
  working session, named `YYYY-MM-DD Title` and chained `prev`/`next`. Start here for
  "what happened last time".
