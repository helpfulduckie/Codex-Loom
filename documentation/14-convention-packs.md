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
inert data instead: a scenario author ships one alongside the shared library it depends on,
and consuming it is not a trust decision.

The bundled `wtg` pack is a worked example: its `[e]` / `/]` marker check is a regex over
rendered markdown, run only for projects that load it. See [The bundled `wtg`
pack](#the-bundled-wtg-pack) below.

---

## Declaring packs

```yaml surface=config
lint:
  level: warn                 # global opinion-layer ceiling (see 02-compile-yaml.md § lint)
  packs:
    wtg: {}                   # a bundled pack, resolved by name against packs/
    stat-tracker:
      source: ./lint/stat-tracker.cl.yaml   # a project-local pack
      level: error
    library-mod:
      source: '{%general}/lint/library-mod.cl.yaml'  # travels with a library set
```

`examples/tiers-and-mods/` shows both forms on branch nodes rather than at the root: the `modA` branches bind the bundled `wtg` pack by name, and the `modB` branches bind a project-local `innerSelf` pack by `source:`.

```yaml surface=config from=tiers-and-mods/compile.cl.yaml key=branches.fullContext.branches.modB.lint
lint:
  packs:
    innerSelf:
      source: ./lint/inner-self.cl.yaml
```

**`lint.packs` is a mapping, keyed by pack name, because packs merge down the branch
chain.** A branch inherits every pack its ancestors declared and may override one entry or
unbind it:

```yaml surface=config
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
`packs/<name>.cl.yaml` in Codex Loom's own `packs/` directory. A present `source:` is a
path, resolved relative to the `compile.yaml` directory, with `{%token}` variables expanded. A library-hosted pack gets
versioned and frozen alongside the shared library that depends on it (see The Library Snapshot).

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

```yaml check=none reason=pseudo-yaml-placeholders
name: wtg                     # must equal the lint.packs key
rules:
  - id: 1                     # → CL-wtg/0001
    severity: error           # error | warn — this rule's default severity
    appliesTo: <predicate>    # omitted = every card
    forbid: <predicate>       # a match contributes one finding (the rule's message)
    require: <predicate>      # a NON-match contributes one finding
    requireCard: <predicate>  # a per-leaf existence check — see below
    schema: <descriptor>      # a schema descriptor over the card's notes: mapping
    over: body                # route the schema at notes: (default), the card entry (body), or meta
    budget: <role→cap map>   # per card — compiled body length against a per-role char cap
    count: <field→bounds>    # per resolved item — list/map length or word count, per field
    mutexHint: <field-set>   # per resolved item — WARN when more than N of a field set are present
    message: "…"
```

A rule may carry any mix of `forbid`, `require`, `requireCard`, `schema`, `budget`, `count`,
and `mutexHint`. `forbid` / `require` / `schema` / `budget` run per card (and ride the
offline `--lint` arm); `requireCard` runs once per leaf; `count` / `mutexHint` run per
resolved item and are **inline only** — see [Per-item rules](#per-item-rules--budget-count-mutexhint).

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

A rule's `schema:` block is a schema-descriptor tree — the same descriptor language the
`compile.yaml` key surface is validated against — evaluated over a mapping recovered from
the card. By default that mapping is the re-parsed `notes:` block; `over:
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

### The `meta:` channel and `over: meta`

**`meta:` is an item key for tooling — an unvalidated annotation channel, parallel to
`v:`.** The loader accepts any shape under it and never proposes it as a relocation target;
it is distinct from `v:` in that no template ever reads it. The compiler writes it into the
card's `~~~` fence when it is a non-empty mapping, so a pack sees it in both the inline
compile pass and the offline `--lint` arm — and, like `kind: reference`, it reaches AID
nowhere: Velvet Lattice forwards only title / type / keys / value / description.

**It is pack-namespaced: a pack reads `meta.<packName>.<key>`,** where `<packName>` is the
pack's declared `name:` — the same binding that ties the `lint.packs` key and the
`CL-<name>/NNNN` code prefix. `duckieConv` reads `meta.duckieConv.role`; a `stat-tracker`
pack would read `meta.statTracker.*`, and the two never collide.

**`over: meta` is the third schema route.** `over: notes` (default) validates the parsed
`notes:` mapping; `over: body` validates the card entry; `over: meta` validates
`meta[<thisPack>]` — the pack's own sub-namespace, reached automatically. A rule cannot
assert about another pack's `meta` sub-namespace through the bare route. `duckieConv`'s role
rule is `{ over: meta, schema: { type: map, keys: { role: { values: [anchor, standard,
minor] } } } }` — a closed `map`, so a typo'd sub-key is a stray-key finding and a bad
`role` value is an out-of-set finding, both re-coded to `CL-duckieConv/NNNN`.

### Per-item rules — `budget`, `count`, `mutexHint`

Three primitives added for authoring-convention checks. A primitive is a recognized rule
key the pack engine dispatches on, the same way `forbid` / `schema` / `requireCard` are.

- **`budget: { anchor: 800, standard: 400, minor: 200 }`** — per card. Reads the card's
  role from `meta.<packName>.role` (absent *or unrecognized* → `standard`), compares the
  **raw compiled body length** to the mapped cap, and WARNs when over. Raw, not
  placeholder-expanded: a sub-budget is a soft authorial target, and the hard platform cap
  is `CL0712`'s job (and `CL0712` measures the expanded string). Runs in the per-card pass,
  so `--lint` picks it up. A role with no entry in the map — and no `standard` fallback —
  is skipped rather than measured against nothing.
- **`count: { default: { max: 5 }, fields: { vibe: { min: 3, max: 5 }, "personality.keywords":
  { min: 2, max: 4 }, tagline: { words: { min: 3, max: 5 } } } }`** — per resolved item.
  `default` applies to every body field that resolves to a **non-empty list or map**;
  `fields` overrides by case-insensitive dotted path. `words` counts whitespace tokens on a
  string value. **A multi-value field authored as a bare `"a, b, c"` string is not split** —
  `count` sees one value and skips it. Write multi-value fields as YAML lists for the check
  to see them.
- **`mutexHint: { fields: [overview, purpose, structure, methods], max: 3, message: "…" }`**
  — per resolved item. WARNs when more than `max` of the listed body fields resolve to a
  non-empty value. This is a redundancy nudge; it carries its own `message`.

**`count` and `mutexHint` are inline only.** They read the *structured* resolved item —
`item.body.vibe` as a real array, `item.body.overview` as a detectable key — which the
compiled `.md` cannot give back: `overview` renders with no label, and a rendered `Vibe:
[a; b; c]` line does not distinguish an authored list from an authored string. So they run
only inside the compile pass, never from `--lint`. `budget` and the `over: meta` role check
*do* run offline. An author who wants the full check runs a compile, not `--lint` — the
same strict-subset shape `requireCard` already has.

The `meta:` channel is branch-addressable: a variant may set `meta.<packName>.role` on one
branch and leave it default on another, and it resolves per leaf like every other
whole-value item field.

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
  silently lost — hence the closed set. Each of the 28 override keys also carries a value
  descriptor — an enum for the five multiple-choice settings, a positive-number `pattern:`
  for the three rate settings, `true` / `false` for the eighteen booleans — so `Clock
  Format: purple` is a WARN, not a bad value passed through. Read from the card body
  (`over: body`).
- **`CL-wtg/0003` — the `WTG Time Config` core fields are well-formed (ERROR).** For a
  present card: `Starting Date` must be `M/D/year` (1–6-digit year), `Starting Time` must
  be `H:MM AM|PM`, `Starting Era` must be one of `AD` / `CE` / `BC` / `BCE`, and
  `Initialized` must be `true` / `false` — all matched case-insensitively. The 28 override
  keys and any stray key pass here; unknown-key is `CL-wtg/0002`'s job. An open `record`
  with `keys:` over just the four fields.

Enable it with `lint: { packs: { wtg: {} } }`.

---

## The bundled `duckieConv` pack

`packs/duckieConv.cl.yaml` is the second bundled pack and the first that encodes authoring
**judgment** rather than a mod's config contract. It encodes the lintable half of a set of
card-authoring conventions maintained separately in the `_CodexLoom` design notes, and is
expected to drift as those conventions do. All four rules are WARN — a convention is a nudge.

- **`CL-duckieConv/0001` — per-role character budget.** Compiled body length against a
  per-role cap: `anchor` 800, `standard` 400, `minor` 200. The role is
  `meta.duckieConv.role` (absent or unrecognized → `standard`). A `budget:` rule.
- **`CL-duckieConv/0002` — list-length caps.** `vibe` 3–5, `personality.keywords` 2–4,
  `tagline` 3–5 words, and a `*` default of "at most 5" over every other list- or map-valued
  body field. A `count:` rule — inline only, and only fields authored as YAML lists/maps are
  seen.
- **`CL-duckieConv/0003` — faction field redundancy.** WARNs when more than three of
  `overview` / `purpose` / `structure` / `methods` are present on one card — the convention
  is to audit for redundancy and merge down. A `mutexHint:` rule — inline only. Unscoped,
  which is safe: no non-faction template exposes all four.
- **`CL-duckieConv/0004` — the role annotation is a known value.** `meta.duckieConv.role`,
  if set, must be `anchor` / `standard` / `minor`. An `over: meta` closed-`map` schema.

Enable it with `lint: { packs: { duckieConv: {} } }`.
