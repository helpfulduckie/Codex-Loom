# Convention Packs

A convention pack is declarative data — never code — that the opinion layer runs over a
leaf's compiled story cards to check a mod's configuration. A pack carries a selector
(`appliesTo`), an optional schema over the card's `notes:` structure (or its entry, with
`over: body`), a per-leaf card-existence check (`requireCard`), and a small predicate
vocabulary (key presence, value equality, regex over the notes text and body). Packs are
opt-in: one runs only when a project names it in `lint.packs`.

---

## Why a pack rather than a built-in check

**Mod config lives in `notes:`, and the person who knows what a mod accepts is its
author.** A script like World Time Generator reads settings from a card's Notes field —
allowed values, required keys, mutually exclusive markers. Baking one mod's rules into the
compiler makes the Codex Loom maintainer a bottleneck for every mod anyone uses. A pack is
inert data instead: a scenario author ships one alongside the canon it depends on, and
consuming it is not a trust decision.

**The rules that packs replace used to be hardcoded and brittle.** v3 lint carried an
`[e]` / `/]` marker check that regex-scraped rendered markdown; it moved into the `wtg`
pack in v4, scanning the same two surfaces but as a declared rule with a namespaced code.

---

## Declaring packs

```yaml
lint:
  level: warn                 # global opinion-layer ceiling (see Errors & Warnings)
  packs:
    wtg: {}                   # a bundled pack, resolved by name against packs/
    stat-tracker:
      source: ./lint/stat-tracker.cl.yaml   # a project-local pack
      level: error
    canon-mod:
      source: '{%general}/lint/canon-mod.cl.yaml'  # travels with a canon set
```

**`lint.packs` is a mapping, keyed by pack name, because packs merge down the branch
chain.** A branch inherits every pack its ancestors declared and may override one entry or
unbind it:

```yaml
branches:
  modA-path:
    lint:
      packs:
        stat-tracker: ~       # this branch does not ship stat-tracker
```

`~` deletes the inherited binding. Unbinding a pack that was never inherited is a `CL0118`
WARN — it usually means a bare `pack-name:` (which parses as null, i.e. `~`) was meant to
be `pack-name: {}`.

**`source:` forms.** An absent `source:` means "bundled, by name" — the loader looks for
`packs/<name>.cl.yaml` beside `src/`. A present `source:` is a path, resolved relative to
the `compile.yaml` directory, with `{%token}` variables expanded. A canon-hosted pack gets
versioned and frozen alongside the canon that depends on it (see The Library Snapshot).

**The config key must match the pack's declared `name:`.** Diagnostic codes are namespaced
from the pack's own name, so a mismatch would make a hosted pack yield different codes in
every project that loads it. A disagreement is a `CL0119` ERROR naming both.

---

## The `level:` dial

**A pack's findings are where the opinion layer's ERRORs live, so each pack carries a
per-pack ceiling.** A pack ERROR fails the build — which is correct when the mod's config
is genuinely wrong, and a problem when the pack has gone stale relative to a mod that now
accepts the key it flags. Two escape hatches, both deliberate acts in config:

- **`level: warn`** demotes the pack's ERRORs to WARN and leaves its WARNs alone. It does
  not flatten every finding to one severity.
- **`level: off`** stops the pack running at all.
- **`level: error`** imposes no cap (the default).

A per-branch `lint.level` composes on top of the per-pack ceiling, and the project-level
`lint.level` composes on top of that — tightest wins. A branch-ceilinged finding names the
branch it fired on.

---

## Diagnostic codes

**A pack finding is coded `CL-<pack>/NNNN`** — `CL-wtg/0001` — outside the numeric `CLxxxx`
bands, so it never collides with a core code and suppresses independently. The rule `id:`
becomes the number, zero-padded to four digits. The opinion layer (`lint.level`) reaches
any `CL-` code, and every report renders it as free text; nothing groups or sorts by the
prefix.

The loader's own two codes are core, in the loading band: `CL0117` for a malformed pack
(missing file, bad YAML, no `rules:` list), `CL0119` for the name mismatch above. Neither
is ever a crash or a silent skip.

---

## Writing a pack

```yaml
name: wtg                     # must equal the lint.packs key
rules:
  - id: 1                     # → CL-wtg/0001
    severity: error           # error | warn — this rule's default severity
    appliesTo: <predicate>    # omitted = every card
    forbid: <predicate>       # a match contributes one finding (the rule's message)
    require: <predicate>      # a NON-match contributes one finding
    requireCard: <predicate>  # a per-leaf existence check — see below
    schema: <descriptor>      # a src/schema.js descriptor over the card's notes: mapping
    over: body                # route the schema at the card entry instead of notes:
    message: "…"
```

A rule may carry any mix of `forbid`, `require`, `requireCard`, and `schema`.

### `requireCard` — a per-leaf existence check

`forbid` / `require` / `schema` are *per-card* — they run against every card a rule's
`appliesTo` matches. `requireCard: <predicate>` is the existential: on a branch leaf that
binds the pack and resolves **no** card satisfying the predicate, the rule contributes one
finding naming that branch (the same per-leaf cadence as `CL0118`).

The compiler cannot detect where a mod is active, so a rule that requires a mod's config
card fires on every leaf by default; an author who does not run that mod on a branch
unbinds the pack there (`wtg: ~`, see [Declaring packs](#declaring-packs)). Offline
(`--lint`) the check still resolves each leaf's inherited card set from the compiled tree
and names the branch, but it applies the project-root `lint.packs` to every leaf — it does
not walk `branches:` — so a branch that unbound the pack still gets the offline finding.
The inline compile pass is branch-merge-aware and authoritative.

### Predicate vocabulary

| Form | Matches when |
|---|---|
| `{ hasKey: k }` | the parsed `notes:` mapping has key `k` |
| `{ equals: { key: k, value: v } }` | `notes[k]` stringifies equal to `v` |
| `{ match: re }` | the regex tests the notes **text** or the **body** |
| `{ notesMatch: re }` / `{ bodyMatch: re }` | one surface only |
| `{ titleMatch: re }` | the regex tests the card title |
| `{ notes: { … } }` | scope the nested predicate to the notes mapping |
| `{ all: [...] }` / `{ any: [...] }` / `{ not: <pred> }` | compose |

`re` is a plain string, compiled with `new RegExp(str)`. `match` is the shape a
two-surface rule needs — WTG accepts a marker in a card's Notes *or* its Entry and
normalizes the position itself, so `wtg`'s marker rule scans both.

### The schema check

A rule's `schema:` block is a `src/schema.js` descriptor tree evaluated over a mapping
recovered from the card. By default that mapping is the re-parsed `notes:` block; `over:
body` on the rule routes it at the card **entry** instead, parsed as tolerant `Key: Value`
lines (an optional `>` prefix stripped, first colon splits, first occurrence of a key
wins) — the shape a mod reads a settings card in. The descriptor keys the engine
understands:

- **`type`** — `map`, `record`, `seq`, `string`, `number`, `boolean`, `any` (or a list of
  them for a union).
- **`keys`** — for `map`: the declared key set is the whole set; an undeclared key is a
  `CL0201` ERROR with a Damerau-Levenshtein typo suggestion. Also honored on `record`,
  where it means the opposite: the declared keys are validated and everything else passes
  untouched. Use `map` for "these keys and no others," `record` + `keys` for "these keys,
  plus anything."
- **`of`** — for `seq` / `record`: the descriptor every element or value must match.
- **`required`** — the key must be present.
- **`values`** — a closed set; a value outside it is `CL0206`.
- **`min`** / **`max`** — inclusive numeric bounds; a value outside them is `CL0207`.
- **`pattern`** — for `string`: a regex the value must match, compiled case-insensitively;
  a value that does not match is `CL0208`.

Every finding the check raises is re-coded to the rule's `CL-<pack>/NNNN`, so a pack's
findings suppress as one unit and show their origin.

**A pack re-parses `notes:` itself.** The compiler emits `notes:` as a flat string by
design, so the pack layer runs a YAML parse over the block to recover its mapping form. A
`notes:` block that is prose, or a bare marker like `[e]`, parses to `{}` — which the
predicate layer reads as "carries no config," and a `hasKey` rule correctly does not fire.
A uniform Markdown blockquote prefix (`> Setting Name: value`, the form WTG's settings card
uses) is stripped before the parse.

---

## The bundled `wtg` pack

`packs/wtg.cl.yaml` is the first bundled pack. Three rules:

- **`CL-wtg/0001` — contradictory timestamp markers (ERROR, every card).** `[e]` /
  `[wtg-no-timestamp]` excludes a card from WTG timestamps entirely; `/]` marks where a
  timestamp should be inserted. A card carrying both is self-contradictory. The rule scans
  the notes text and the body together, since WTG accepts either marker in Notes or Entry.
- **`CL-wtg/0002` — the `WTG Time Config` card exists and is complete (WARN).** Fires per
  leaf when no `WTG Time Config` card resolves; per card when it is present but missing any
  of `Starting Date` / `Starting Era` / `Starting Time` / `Initialized`, or carrying a key
  outside the recognized set (the four core fields plus WTG's 28 `DEFAULT_SETTINGS`
  override names). WTG deletes this card after initialization, so a key it does not read is
  silently lost — hence the closed set. Read from the card body (`over: body`).
- **`CL-wtg/0003` — the `WTG Time Config` core fields are well-formed (ERROR).** For a
  present card: `Starting Date` must be `M/D/year` (1–6-digit year), `Starting Time` must
  be `H:MM AM|PM`, `Starting Era` must be one of `AD` / `CE` / `BC` / `BCE`, and
  `Initialized` must be `true` / `false` — all matched case-insensitively. The 28 override
  keys and any stray key pass here; unknown-key is `CL-wtg/0002`'s job. An open `record`
  with `keys:` over just the four fields.

Enable it with `lint: { packs: { wtg: {} } }`.
