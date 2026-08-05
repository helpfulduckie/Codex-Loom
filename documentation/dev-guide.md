# Codex Loom — Developer Guide

This document describes the internal architecture of Codex Loom v3 for maintainers. It is meant to augment the inline JSDoc in source files, not duplicate it — focus here is on data flow, non-obvious design decisions, and algorithm structure.

---

## Module Map

| File | Role |
|---|---|
| `src/compile.js` | CLI entry point; orchestrates the full compilation pipeline |
| `src/loader.js` | Loads YAML files, templates, partials, and `compile.yaml`; builds item registries |
| `src/resolver.js` | Resolves items through import/variant/branch chains; `applyFieldOp`; `enumerateLeaves` |
| `src/template.js` | Template rendering engine; field interpolation; all render functions |
| `src/pronouns.js` | Pronoun and verb conjugation passes; cross-item reference resolution |
| `src/pe.js` | Plot Essentials compilation and output |
| `src/ain.js` | AI Instructions compilation, branch dispatch, document variants |
| `src/an.js` | Author's Note compilation (thin wrapper over `ain.js` logic) |
| `src/overview.js` | Leaf-review and whole-tree overview file generation |
| `src/diff.js` | Cross-branch `--diff` (Shared/delta) and `--annotate` report generation |
| `src/util.js` | File enumeration, YAML loading, deep clone, case-insensitive object utilities |

---

## Compilation Pipeline

```
loadCompileConfig()
    ↓
loadTemplates()                  → templates Map, partials Map
buildCanonRegistry()             → merged canon registry (Map<id, item>)
loadCardsFromDir()               → raw project item defs (array)
resolveIncludes()                → included canon items stamped with _include_* metadata
buildRegistry(projectItems)      → project registry
mergeRegistries(canon, project)  → full registry
enumerateLeaves(branches)        → [[path], [path], ...]
    ↓
FOR EACH LEAF:
  getBranchConfig()              → branchProtagonist, protagonist
  buildCompileContext()          → variables (merged), componentRefs (resolved paths)
  compileBranchPhaseA()          → resolvedItems[]
    FOR EACH itemDef:
      resolveItem()              → resolved item object or null (excluded)
      applyFieldInterpolation()  → dotted {$body/v/aid/render/name.X} refs expanded
  compileBranchPhaseB()
    applyCrossItemRefs()         → {$Id.body.Field} refs resolved across all items
    FOR EACH resolvedItem:
      applyPronounPasses()       → pronoun + conjugation tokens resolved
      validateCardType()         → abort if resolved aid.type is not a legal path segment
      render()                   → markdown string
    writeOutput()                → Story Cards/{type}/{type}.md
  compilePE() / writeAIN() / writeAN()
  copyScripts()
writeOpeningsRecursive()         → Components/Opening.md at leaf/node levels
runLeafReviewMode()              → Overview/*.leaf.md
(if --diff)     runDiffMode()     → Overview/Shared.md + Overview/*.delta.md
(if --annotate) runAnnotateMode() → Overview/*.annotate.md
```

---

## Item Registry

`buildRegistry(items, context)` indexes items by lowercase `id` (falling back to `name` if `id` is absent). Collision within a context is fatal.

`mergeRegistries(canon, project)` combines two registries. Any ID present in both is also fatal.

Canon items are loaded from all named directories in `structure.input.canon`. Multiple canon directories are merged into one registry; cross-canon ID collision is fatal.

The final merged registry is passed to every downstream function. It is **read-only** during compilation — no function mutates it.

---

## Item Resolution Order

`resolveItem(itemDef, registry, branchPath)` in `resolver.js` applies deltas in this fixed order:

1. Deep-clone the canonical base item (or local item def if no `import:`)
2. Apply the **primary import path** variant chain (slash-separated suffix on the import ID)
3. Apply each entry in `importVariants:` (slash-separated paths on the canonical item's variant tree)
4. Apply top-level `body:`, `name:`, `pronouns:`, `aid:`, `render:` overrides from the import def
5. Call `resolveBranchSpec(itemDef.branches, branchPath)` → list of local variant names
6. For each dispatched local variant name:
   a. Walk `itemDef.variants` tree to collect the variant delta
   b. If the delta has `importVariants:`, apply those from the **canonical item's** variant tree first
   c. Apply the delta fields
7. Return `null` if `resolveBranchSpec` returns `null` (item excluded from this branch)

For local (non-import) items, steps 2–4 are skipped. `_include_variants` and `_include_branch_spec` are attached by `resolveIncludes()` to carry include-directive settings.

After resolution, `aid.type` and `render.template` are cross-defaulted: each is filled in from the other if absent.

---

## Branch Dispatch Algorithm

`resolveBranchSpec(spec, branchPath)` in `resolver.js` walks the branch path depth-first, accumulating variant names:

```
For each level of the branch path:
  1. If the exact key exists and maps to null → return null (item excluded, stop immediately)
  2. If '*' key exists and is not null → collect its apply list, descend into its sub-branches
  3. If exact key exists → collect its apply list, descend into its sub-branches

Return accumulated variant names (may be empty — meaning no variant applied but item included)
```

A branch spec value can be:
- **Scalar string** → `[string]` (single variant name)
- **Array** → those variant names
- **Mapping with `apply:`** → `apply:` value (scalar or array); optionally `branches:` for further descent
- **Mapping without `apply:`** → `[]` (no variant, but descend)
- **`null` / `~`** → exclude item from this branch

This allows wildcards and explicit keys to compose at each depth level, and arbitrary nested dispatch for complex branch trees.

---

## Field Operation Engine

`applyFieldOp(current, op)` in `resolver.js` dispatches based on the type and content of `op`:

```
op is array?
  → All elements start with +{, -{, or /{ ?
    → op-sequence: apply each element to current value in order
    → value-sequence: replace current with op array as-is
op is object (mapping)?
  → current is also mapping?
    → recurse into subfields
    → else start from empty mapping, apply subfield ops
op is null/undefined?
  → return '__DELETE__' sentinel
op is string?
  current is array?
    → array-element ops: append/remove element/swap each element
  op matches +{...}?
    → if currentStr is empty: return toAdd as scalar
    → else: return [currentStr, toAdd] (two-element array)
  op matches -{...}?
    → remove substring, trim result
  op matches /{...}/{...}?
    → swap all occurrences, trim result
  else
    → replace with op value
```

The `'__DELETE__'` sentinel is propagated up the call chain so callers can delete the key instead of setting it to the sentinel string.

`applyFieldsDelta(item, delta)` maps keys to either top-level item fields (`name`, `pronouns`, `aid`, `render`) or body subfields. Unknown keys are treated as body field ops. The `id` key is silently skipped — it is immutable.

---

## Template Pipeline

`render(template, data, partials)` in `template.js` applies 7 steps in order:

1. **Escape literals** — `{{` and `}}` replaced with internal sentinel strings to prevent them from being parsed as expressions
2. **Expand partials** — `{include PartialName}` expanded depth-first, with circular-include detection via a stack
3. **Process conditionals** — `{if ...}...{else}...{/if}` resolved innermost-first (repeated until stable)
4. **Process wrapper blocks** — `{wrapper}...{/wrapper}` replaced with wrapped content per `data.render.wrapper`
5. **Process inline expressions** — `{$field}`, `{join(...)}`, `{list(...)}`, render functions
6. **Restore sentinels** — sentinel strings replaced back with literal `{` and `}`
7. **Normalize whitespace** — `{preserve}...{/preserve}` blocks extracted; tabs stripped, blank lines removed, spaces deduplicated, document trimmed; preserved blocks restored

Post-render: if `data.render.wrapper` is non-`none` and no `{wrapper}` block was used, the entire output is wrapped automatically (unless it already starts with the corresponding bracket).

`resolveField(ref, data)` is the core field lookup: splits the ref on `.`, walks the data object case-insensitively at each level. Returns arrays and objects as-is (for render functions), scalars as trimmed strings, missing/empty as `null`.

---

## Pronoun Resolution Passes

`applyPronounPasses(item, registry, branchProtagonist)` in `pronouns.js` applies two passes per item:

**Pass 1 — `applyTokenPass`** processes the combined regex `/{(\$[^{}]+)\}|\[(s|es|is|was|has)\]/g` left-to-right:

- `{$she}` / `{$her~}` etc. (unscoped, no dot) → resolve against item's own `pronouns:` field. Does **not** set the conjugation scope.
- `{$Id}` (registry ID, no dot) → "you" if protagonist, else display name. Sets scope to Id's pronoun set.
- `{$Id.pronoun}` (registry ID + pronoun token) → resolve pronoun against Id's effective pronoun set. Sets scope to Id's pronoun set.
- `{$Id.full}` / `{$Id.display}` → full or display name. Does not set scope.
- `{$Id.body.Field}` (registry ID + body path) → left as-is for Pass 2.
- `[s]` / `[es]` / `[is]` / `[was]` / `[has]` → conjugate using the current scope (or item's own pronouns if no scope set).

**Pass 2 — `applyCrossItemRefs`** is run once after **all items for a branch are resolved** (before `applyPronounPasses` is called individually per item — actually cross-item refs are resolved first in Phase B). It replaces `{$Id.body.FieldPath}` patterns by looking up the resolved item for `Id` and reading its body field. Like the other `{$…}` passes it walks `body`/`aid`/`render`/`name` (via `walkItemTextFields`); the cross-item source path itself is still `.body.`-only.

Scope tracking via `currentScope` is local to each string processed by `applyTokenPass`, reset for each call.

---

## Field Interpolation

`applyFieldInterpolation(item)` in `template.js` runs after `resolveItem()` but before pronoun passes. It expands dotted field refs within the item's text sections.

**Coverage:** all three `{$…}` item-data walkers — `applyFieldInterpolation` (here), `applyCrossItemRefs`, and `applyPronounPasses` — route through the shared `walkItemTextFields(item, transform)` in `util.js`, which visits string values in `item.body`, `item.aid`, `item.render`, and `item.name`. That helper is the single place the section list lives, so the three passes always reach the same fields. (`name` is already normalized to an object before these passes run.)

**Surface:** `processFieldInterpolation(value, context)` matches dotted refs rooted at `body`, `v` (+ aliases), `aid`, `render`, or `name`, and resolves them via `resolveField`. The **required dot** is deliberate: bare single-segment `{$X}` (pronoun tokens like `{$she}`, character refs like `{$Id}`) is left for the pronoun pass. This ordering matters — interpolating `{$body.year}` into another field must happen before pronoun resolution so the interpolated content can itself contain pronoun tokens.

**Failure visibility:** `warnUnresolvedFieldTokens(text, label)` (`util.js`) scans final rendered items and component outputs for any surviving `{$…}` and warns once per distinct token (sibling of the `{%}` `warnUnexpandedVariables` sweep). Template field-ref *misses* resolve to empty at render time and are not flagged; only verbatim survivors are.

---

## Key Design Decisions

**`body:` not `fields:`**

v3 introduced explicit namespacing for the four item block types: `aid:`, `render:`, `body:`, and `variants:`. This eliminates ambiguity about which block a delta key belongs to in `applyFieldsDelta` — any key not in `['name', 'pronouns', 'aid', 'render']` is treated as a body field op, and `body:` explicitly targets the whole body object. v2's flat `fields:` key required all keys to be treated as field operations with no clean separation from item metadata.

**Braced tokens replacing bare `$` markers**

v3 switched from bare `$Aness`, `$her~` markers (v2) to fully braced `{$Aness}`, `{$Aness.her~}` tokens. Braced tokens integrate cleanly with the existing template engine regex, avoid ambiguity at word boundaries, and compose naturally with field interpolation and other `{...}` expressions. The `TOKEN_RE` regex in `applyTokenPass` covers braced tokens and verb markers in a single pass.

**Phase A / Phase B split**

Phase A (`compileBranchPhaseA`) resolves all items for a branch and applies field interpolation before Phase B starts. Phase B (`compileBranchPhaseB`) runs `applyCrossItemRefs` first (which needs all resolved items available simultaneously), then processes pronouns and rendering per item. This two-phase design ensures cross-item `{$Id.body.Field}` references can always find the target item's resolved body, regardless of item ordering in the source files.

**`__DELETE__` sentinel**

`applyFieldOp` returns the string `'__DELETE__'` to signal that a field should be deleted. Callers (`applyFieldsDelta`, recursive subfield ops) check for this sentinel and call `delete obj[key]` rather than setting the key. Using a sentinel avoids the need for a wrapper type or exception throwing, and works cleanly through the recursive subfield application.

**Canon naming (mapping not string)**

`structure.input.canon` is a named mapping (`{main: ./path}`) rather than a plain string or array. Names serve two purposes: they appear in error messages (`Duplicate item ID "x" across canon dirs: canon:main`) and enable `{@main}` reference resolution in `include:` paths. A plain path string would require either path-based display (brittle) or `{@}` syntax without a name.

**Token expansion (`{%}` and `{@}`) — single shared expander**

All `{%variable}` and `{@name}` expansion routes through one helper, `expandTokens()` in `src/tokens.js`. It handles both sigils in a single `/\{([@%])([^}]+)\}/g` pass:

- `{%}` always delegates to `util.resolveVariables` — the canonical `%` core, which is recursive, cycle-detecting, and warns on undeclared variables. There is no second `%` implementation.
- `{@}` resolves a name against **components first, then canon** (case-insensitive). `mode: 'path'` returns the resolved path; `mode: 'content'` reads a resolved *file* to its contents (directories always return the path). `warnMissing` controls whether an unresolved `{@}` emits a warning or passes through silently (path contexts pass through so the standard missing-path warning fires instead).

Every call site is a thin wrapper over `expandTokens`: `loader.expandPathTokens` (canon/template config paths), `compile.resolveComponentSpec`/`resolveComponentKey`/`expandOpeningKeyRef`, the `include:`-path block in `resolveIncludes`, and `description.loadDescConfig`. When adding a new context that needs tokens, call `expandTokens` rather than re-deriving the regex.

Coverage notes:
- `{%}` is expanded in item bodies, templates, opening prose, component specs, branch `title`/`protagonist`, and config paths. In `include:`/`import:` paths it uses **root** `config.variables` only, because `resolveIncludes` runs once before branch enumeration — branch-merged variables do not exist yet.
- `{@}` is deliberately **not** expanded in item bodies or `.template` files; it is a path/prose construct only.
- The `{$…}` field-reference family (`{$v.field}`, `{$Id.body.field}`) is a separate system (field interpolation + pronoun passes) and is **not** part of `expandTokens`. It has been standardized for coverage (`body`/`aid`/`render`/`name` via `walkItemTextFields`), surface (dotted field refs in item data), and failure visibility (`warnUnresolvedFieldTokens`); only collapsing its four resolvers into one dispatcher remains deferred. See `07-templates.md` "Token Systems at a Glance".

Canon resolution still uses a two-pass approach: plain-path entries (no `{@}` tokens after variable expansion) are resolved in pass 1, forming the lookup table for pass 2 which handles entries that reference sibling canon names. Template paths are expanded after both passes, so they can reference any named canon entry. Unresolved tokens pass through unchanged, causing the standard missing-path warning to fire with the unexpanded token visible in the path string.

---

## Cross-Branch Review Reports (`--diff` / `--annotate`)

These reports answer the authoring question "are my branches/variants wired up the way I intended?" — `--diff` for *discovery* (scan, or hand to an agent), `--annotate` for *drill-down* once discovery flags a suspect item.

**They are compile options, not post-hoc report modes.** Unlike `--leafReview`/`--overview`/`--seed-map`/`--card-sizes`/`--lint` (which read the already-written `output/` tree from disk), `--diff`/`--annotate` need the identity-keyed, fully-resolved item objects that only exist in memory *during* compilation — the on-disk markdown has discarded `item.id` and variant-application metadata. So setting either flag forces a compile (`doCompile`) and the reports are emitted at the end of `compile()` from data captured in the per-leaf loop (`leafData`), gated behind `options.diff`/`options.annotate`. Capture overhead is zero for a normal compile.

**`--diff` → `Overview/Shared.md` + `Overview/<leaf>.delta.md`** (`runDiffMode` in `diff.js`).
Partition rule (`buildSharedAndDeltas`): for each item id and each component block, collect its rendered text from every leaf. Identical in *all* leaves → `Shared.md`. Otherwise varying → each leaf's own version goes to that leaf's `.delta.md`; leaves where it is absent (`~`-excluded) silently omit it. Each `.delta.md` is therefore self-contained ("everything this branch has that isn't universal"), read against `Shared.md` once. Rendered-block granularity, no annotation.

**`--annotate` → `Overview/<leaf>.annotate.md`** (`runAnnotateMode`).
Per leaf, per item, field-level diff of `resolveItem(itemDef, registry, branchPath)` against the **project base** `resolveItem(itemDef, registry, [])` (empty branch path = project imports/overrides applied, no branch dispatch — *not* canon base). Because both sides share the same source tokens/variables, the only differences are branch-variant effects. Each changed field is attributed to the applied variant(s) whose delta touches that path (`collectDeltaKeyPaths` + prefix match), or flagged `unexplained` (the bleed signal). `~`-nulled items are reported explicitly; items identical to base with no variants are omitted (they live in `Shared.md`).

**Scope / current limitations.** Items and Plot Essentials diff at block level (PE via `compilePEBlocks`, which exposes the un-joined segments with stable keys). AI Instructions and Author's Note are captured as a single whole-component block each. Opening is resolved post-loop (`writeOpeningsRecursive`) and is not yet captured. The annotate `base`/`leaf` values are the pre-render resolved field structures, so `+{}` appends show as two-element arrays.
