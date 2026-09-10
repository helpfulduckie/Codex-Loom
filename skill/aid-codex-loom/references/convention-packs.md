# Convention Packs Reference

A convention pack is **declarative data, never code**, that the opinion layer runs over a
leaf's compiled story cards. It checks a mod's configuration, or an authoring convention,
without baking either into the compiler.

**Packs are opt-in** — one runs only when a project names it in `lint.packs`.

---

## Enabling a Pack

```yaml
lint:
  level: warn                 # global opinion-layer ceiling
  packs:
    wtg: {}                   # a bundled pack, resolved by name against Codex Loom's packs/
    stat-tracker:
      source: ./lint/stat-tracker.cl.yaml          # a project-local pack
      level: error
    library-mod:
      source: '{%general}/lint/library-mod.cl.yaml'  # travels with a library set
```

**`lint.packs` is a mapping because packs merge down the branch chain.** A branch inherits
every pack its ancestors declared and may override or unbind one:

```yaml
branches:
  modA-path:
    lint:
      packs:
        stat-tracker: ~       # this branch does not ship stat-tracker
```

**Write `pack-name: {}`, not a bare `pack-name:`.** A bare key parses as null — the same as
`~` — and unbinds. Unbinding something never inherited is a `CL0118` WARN, which usually
means exactly this typo.

**An absent `source:` means "bundled, by name."** A present `source:` is a path relative to
the `compile.yaml` directory, with `{%token}` variables expanded. A library-hosted pack gets
versioned and frozen alongside the library it depends on.

**The config key must match the pack's declared `name:`** — diagnostic codes are namespaced
from it. A mismatch is a `CL0119` ERROR naming both.

---

## The `level:` Dial

| `level` | Effect |
|---|---|
| `error` | No cap — the default. A pack ERROR fails the build |
| `warn` | Demotes the pack's ERRORs to WARN; leaves its WARNs alone |
| `off` | The pack does not run |

**Reach for `level: warn` when a pack has gone stale** relative to a mod that now accepts
the key it flags. A per-branch `lint.level` composes on top of the per-pack ceiling, and the
project-level `lint.level` on top of that — tightest wins.

---

## Diagnostic Codes

**A pack finding is coded `CL-<pack>/NNNN`** — `CL-wtg/0001` — outside the numeric `CLxxxx`
bands, so it never collides with a core code and suppresses independently. The rule's `id:`
becomes the number, zero-padded to four digits.

The loader's own codes are core: `CL0117` for a malformed pack (missing file, bad YAML, no
`rules:` list), `CL0119` for the name mismatch above.

---

## Writing a Pack

```yaml
name: wtg                     # must equal the lint.packs key
rules:
  - id: 1                     # → CL-wtg/0001
    severity: error           # error | warn
    appliesTo: <predicate>    # omitted = every card
    forbid: <predicate>       # a match contributes one finding
    require: <predicate>      # a NON-match contributes one finding
    requireCard: <predicate>  # per-leaf existence check
    schema: <descriptor>      # over the card's notes: mapping
    over: body                # route the schema: notes (default) | body | meta
    budget: <role→cap map>
    count: <field→bounds>
    mutexHint: <field-set>
    message: "…"
```

A rule may carry any mix of these.

### Where each primitive runs

| Primitive | Cadence | Offline `--lint`? |
|---|---|---|
| `forbid` / `require` / `schema` / `budget` | per card | Yes |
| `requireCard` | per leaf | Yes, but applies the project-root `lint.packs` to every leaf |
| `count` / `mutexHint` | per resolved item | **No — inline compile only** |

**`count` and `mutexHint` cannot run offline** because they read the structured resolved
item — `body.vibe` as a real array, `body.overview` as a detectable key — which compiled
markdown cannot give back. An author who wants the full check runs a compile, not `--lint`.

### Predicate vocabulary

| Form | Matches when |
|---|---|
| `{ hasKey: k }` | the parsed `notes:` mapping has key `k` |
| `{ equals: { key: k, value: v } }` | `notes[k]` stringifies equal to `v` |
| `{ match: re }` | the regex tests the notes text **or** the body |
| `{ notesMatch: re }` / `{ bodyMatch: re }` | one surface only |
| `{ titleMatch: re }` | the regex tests the card title |
| `{ notes: { … } }` | scope the nested predicate to the notes mapping |
| `{ all: […] }` / `{ any: […] }` / `{ not: <pred> }` | compose |

`re` is a plain string compiled with `new RegExp(str)`.

### The schema check

`schema:` is a descriptor tree evaluated over a mapping recovered from the card.

- **`type`** — `map`, `record`, `seq`, `string`, `number`, `boolean`, `any`, or a list for
  a union.
- **`keys`** — on `map`, the declared key set is the *whole* set and an undeclared key is an
  ERROR with a typo suggestion. On `record`, the declared keys are validated and everything
  else passes. **Use `map` for "these keys and no others," `record` + `keys` for "these
  keys, plus anything."**
- **`of`** — for `seq` / `record`: the descriptor every element or value must match.
- **`required`** — the key must be present.
- **`values`** — a closed set.
- **`min`** / **`max`** — inclusive numeric bounds.
- **`pattern`** — a regex the string must match, compiled case-insensitively.

Every finding is re-coded to the rule's `CL-<pack>/NNNN`.

**A pack re-parses `notes:` itself**, since the compiler emits it as a flat string. A
`notes:` block that is prose, or a bare marker like `[e]`, parses to `{}` — so a `hasKey`
rule correctly does not fire. A uniform `> ` blockquote prefix is stripped before parsing.

### The `meta:` channel

**`meta:` is an item key for tooling** — an unvalidated annotation channel parallel to `v:`,
which no template ever reads. The compiler writes it into the card's `~~~` fence when it is
a non-empty mapping, and it reaches AID nowhere.

**It is pack-namespaced: a pack reads `meta.<packName>.<key>`.** `duckieConv` reads
`meta.duckieConv.role`; a `stat-tracker` pack would read `meta.statTracker.*`, and the two
never collide. `over: meta` validates the pack's own sub-namespace automatically — a rule
cannot assert about another pack's.

**`meta:` is branch-addressable** — a variant may set `meta.<packName>.role` on one branch
and leave it default on another.

### Per-item primitives

- **`budget: { anchor: 800, standard: 400, minor: 200 }`** — reads the card's role from
  `meta.<packName>.role` (absent or unrecognized → `standard`) and WARNs when the **raw
  compiled body length** exceeds the cap. Raw, not placeholder-expanded: the hard platform
  cap is `CL0712`'s job.
- **`count: { default: { max: 5 }, fields: { vibe: { min: 3, max: 5 }, tagline: { words: { max: 5 } } } }`**
  — `default` applies to every body field resolving to a non-empty list or map; `fields`
  overrides by case-insensitive dotted path; `words` counts whitespace tokens on a string.
  **A multi-value field authored as a bare `"a, b, c"` string is not split** — write
  multi-value fields as YAML lists for this check to see them.
- **`mutexHint: { fields: [overview, purpose, structure, methods], max: 3, message: "…" }`**
  — WARNs when more than `max` of the listed fields resolve non-empty. A redundancy nudge.

---

## The Bundled `wtg` Pack

Enable with `lint: { packs: { wtg: {} } }`.

| Code | Severity | Checks |
|---|---|---|
| `CL-wtg/0001` | ERROR | Contradictory timestamp markers — `[e]` / `[wtg-no-timestamp]` (exclude) together with `/]` (insert here). Scans notes text and body together |
| `CL-wtg/0002` | WARN | The `WTG Time Config` card exists and is complete — per leaf when absent; per card when missing `Starting Date` / `Starting Era` / `Starting Time` / `Initialized`, or carrying a key outside the four plus WTG's 28 override names. Read `over: body` |
| `CL-wtg/0003` | ERROR | The four core fields are well-formed — `M/D/year`, `H:MM AM\|PM`, one of `AD`/`CE`/`BC`/`BCE`, and `true`/`false`, all case-insensitive |

**`WTG Time Config` is the card to lint — not `Configure WTG`.** The latter is
auto-generated by the mod; the former is author-shipped, and lives in the card body.

The closed key set in `CL-wtg/0002` exists because WTG deletes the card after
initialization, so a key it does not read is silently lost.

---

## The Bundled `duckieConv` Pack

Enable with `lint: { packs: { duckieConv: {} } }`. **All four rules are WARN** — this pack
encodes authoring judgment rather than a mod's config contract, and is expected to drift as
those conventions do.

| Code | Checks |
|---|---|
| `CL-duckieConv/0001` | Per-role character budget — `anchor` 800, `standard` 400, `minor` 200, from `meta.duckieConv.role` |
| `CL-duckieConv/0002` | List-length caps — `vibe` 3–5, `personality.keywords` 2–4, `tagline` at most 5 words, `*` default of at most 5. Inline only |
| `CL-duckieConv/0003` | Faction field redundancy — more than three of `overview` / `purpose` / `structure` / `methods` on one card. Inline only |
| `CL-duckieConv/0004` | `meta.duckieConv.role`, if set, is `anchor` / `standard` / `minor` |
