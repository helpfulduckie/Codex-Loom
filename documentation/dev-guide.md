# Codex Loom — Developer Guide

This document describes the internal architecture of Codex Loom v3 for maintainers. It is meant to augment the inline JSDoc in source files, not duplicate it — focus here is on data flow, non-obvious design decisions, and algorithm structure.

---

## Module Map

| File | Role |
|---|---|
| `src/compile.js` | CLI entry point; orchestrates the full compilation pipeline |
| `src/loader.js` | Loads YAML files, templates, partials, and `compile.yaml`; builds card registries |
| `src/resolver.js` | Resolves cards through import/variant/branch chains; `applyFieldOp`; `enumerateLeaves` |
| `src/template.js` | Template rendering engine; field interpolation; all render functions |
| `src/pronouns.js` | Pronoun and verb conjugation passes; cross-card reference resolution |
| `src/pe.js` | Plot Essentials compilation and output |
| `src/ain.js` | AI Instructions compilation, branch dispatch, document variants |
| `src/an.js` | Author's Note compilation (thin wrapper over `ain.js` logic) |
| `src/overview.js` | Leaf-review and whole-tree overview file generation |
| `src/util.js` | File enumeration, YAML loading, deep clone, case-insensitive object utilities |

---

## Compilation Pipeline

```
loadCompileConfig()
    ↓
loadTemplates()                  → templates Map, partials Map
buildCanonRegistry()             → merged canon registry (Map<id, card>)
loadCardsFromDir()               → raw project card defs (array)
resolveIncludes()                → included canon cards stamped with _include_* metadata
buildRegistry(projectCards)      → project registry
mergeRegistries(canon, project)  → full registry
enumerateLeaves(branches)        → [[path], [path], ...]
    ↓
FOR EACH LEAF:
  getBranchConfig()              → branchProtagonist, protagonist
  buildCompileContext()          → variables (merged), componentRefs (resolved paths)
  compileBranchPhaseA()          → resolvedCards[]
    FOR EACH cardDef:
      resolveCard()              → resolved card object or null (excluded)
      applyFieldInterpolation()  → {$body.X} refs expanded in body fields
  compileBranchPhaseB()
    applyCrossCardRefs()         → {$Id.body.Field} refs resolved across all cards
    FOR EACH resolvedCard:
      applyPronounPasses()       → pronoun + conjugation tokens resolved
      render()                   → markdown string
    writeOutput()                → Story Cards/{type}/{type}.md
  compilePE() / writeAIN() / writeAN()
  copyScripts()
writeOpeningsRecursive()         → Components/Opening.md at leaf/node levels
runLeafReviewMode()              → Overview/*.overview.md
```

---

## Card Registry

`buildRegistry(cards, context)` indexes cards by lowercase `id` (falling back to `name` if `id` is absent). Collision within a context is fatal.

`mergeRegistries(canon, project)` combines two registries. Any ID present in both is also fatal.

Canon cards are loaded from all named directories in `structure.input.canon`. Multiple canon directories are merged into one registry; cross-canon ID collision is fatal.

The final merged registry is passed to every downstream function. It is **read-only** during compilation — no function mutates it.

---

## Card Resolution Order

`resolveCard(cardDef, registry, branchPath)` in `resolver.js` applies deltas in this fixed order:

1. Deep-clone the canonical base card (or local card def if no `import:`)
2. Apply the **primary import path** variant chain (slash-separated suffix on the import ID)
3. Apply each entry in `importVariants:` (slash-separated paths on the canonical card's variant tree)
4. Apply top-level `body:`, `name:`, `pronouns:`, `aid:`, `render:` overrides from the import def
5. Call `resolveBranchSpec(cardDef.branches, branchPath)` → list of local variant names
6. For each dispatched local variant name:
   a. Walk `cardDef.variants` tree to collect the variant delta
   b. If the delta has `importVariants:`, apply those from the **canonical card's** variant tree first
   c. Apply the delta fields
7. Return `null` if `resolveBranchSpec` returns `null` (card excluded from this branch)

For local (non-import) cards, steps 2–4 are skipped. `_include_variants` and `_include_branch_spec` are attached by `resolveIncludes()` to carry include-directive settings.

After resolution, `aid.type` and `render.template` are cross-defaulted: each is filled in from the other if absent.

---

## Branch Dispatch Algorithm

`resolveBranchSpec(spec, branchPath)` in `resolver.js` walks the branch path depth-first, accumulating variant names:

```
For each level of the branch path:
  1. If the exact key exists and maps to null → return null (card excluded, stop immediately)
  2. If '*' key exists and is not null → collect its apply list, descend into its sub-branches
  3. If exact key exists → collect its apply list, descend into its sub-branches

Return accumulated variant names (may be empty — meaning no variant applied but card included)
```

A branch spec value can be:
- **Scalar string** → `[string]` (single variant name)
- **Array** → those variant names
- **Mapping with `apply:`** → `apply:` value (scalar or array); optionally `branches:` for further descent
- **Mapping without `apply:`** → `[]` (no variant, but descend)
- **`null` / `~`** → exclude card from this branch

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

`applyFieldsDelta(card, delta)` maps keys to either top-level card fields (`name`, `pronouns`, `aid`, `render`) or body subfields. Unknown keys are treated as body field ops. The `id` key is silently skipped — it is immutable.

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

`applyPronounPasses(card, registry, branchProtagonist)` in `pronouns.js` applies two passes per card:

**Pass 1 — `applyTokenPass`** processes the combined regex `/{(\$[^{}]+)\}|\[(s|es|is|was|has)\]/g` left-to-right:

- `{$she}` / `{$her~}` etc. (unscoped, no dot) → resolve against card's own `pronouns:` field. Does **not** set the conjugation scope.
- `{$Id}` (registry ID, no dot) → "you" if protagonist, else display name. Sets scope to Id's pronoun set.
- `{$Id.pronoun}` (registry ID + pronoun token) → resolve pronoun against Id's effective pronoun set. Sets scope to Id's pronoun set.
- `{$Id.full}` / `{$Id.display}` → full or display name. Does not set scope.
- `{$Id.body.Field}` (registry ID + body path) → left as-is for Pass 2.
- `[s]` / `[es]` / `[is]` / `[was]` / `[has]` → conjugate using the current scope (or card's own pronouns if no scope set).

**Pass 2 — `applyCrossCardRefs`** is run once after **all cards for a branch are resolved** (before `applyPronounPasses` is called individually per card — actually cross-card refs are resolved first in Phase B). It replaces `{$Id.body.FieldPath}` patterns by looking up the resolved card for `Id` and reading its body field.

Scope tracking via `currentScope` is local to each string processed by `applyTokenPass`, reset for each call.

---

## Field Interpolation

`applyFieldInterpolation(card)` in `template.js` runs after `resolveCard()` but before pronoun passes. It expands `{$body.X}` references within `body` field values only.

Pronoun tokens (`{$she}`, `{$Id}` etc.) are deliberately left alone by field interpolation. The regex only matches `{$body.X}` patterns. This ordering matters: interpolating `{$body.year}` into another field must happen before pronoun resolution so the interpolated content can itself contain pronoun tokens that get resolved in the pronoun pass.

`processFieldInterpolation(value, context)` in `template.js` handles the per-string expansion. It uses `resolveField` for lookup but only matches the `{$body.X}` prefix form.

---

## Key Design Decisions

**`body:` not `fields:`**

v3 introduced explicit namespacing for the four card block types: `aid:`, `render:`, `body:`, and `variants:`. This eliminates ambiguity about which block a delta key belongs to in `applyFieldsDelta` — any key not in `['name', 'pronouns', 'aid', 'render']` is treated as a body field op, and `body:` explicitly targets the whole body object. v2's flat `fields:` key required all keys to be treated as field operations with no clean separation from card metadata.

**Braced tokens replacing bare `$` markers**

v3 switched from bare `$Aness`, `$her~` markers (v2) to fully braced `{$Aness}`, `{$Aness.her~}` tokens. Braced tokens integrate cleanly with the existing template engine regex, avoid ambiguity at word boundaries, and compose naturally with field interpolation and other `{...}` expressions. The `TOKEN_RE` regex in `applyTokenPass` covers braced tokens and verb markers in a single pass.

**Phase A / Phase B split**

Phase A (`compileBranchPhaseA`) resolves all cards for a branch and applies field interpolation before Phase B starts. Phase B (`compileBranchPhaseB`) runs `applyCrossCardRefs` first (which needs all resolved cards available simultaneously), then processes pronouns and rendering per card. This two-phase design ensures cross-card `{$Id.body.Field}` references can always find the target card's resolved body, regardless of card ordering in the source files.

**`__DELETE__` sentinel**

`applyFieldOp` returns the string `'__DELETE__'` to signal that a field should be deleted. Callers (`applyFieldsDelta`, recursive subfield ops) check for this sentinel and call `delete obj[key]` rather than setting the key. Using a sentinel avoids the need for a wrapper type or exception throwing, and works cleanly through the recursive subfield application.

**Canon naming (mapping not string)**

`structure.input.canon` is a named mapping (`{main: ./path}`) rather than a plain string or array. Names serve two purposes: they appear in error messages (`Duplicate card ID "x" across canon dirs: canon:main`) and enable `{@main}` reference resolution in `include:` paths. A plain path string would require either path-based display (brittle) or `{@}` syntax without a name.

**Token expansion in config paths**

Canon values and template path entries support `{%variable}` and `{@canonName}` substitution before `path.resolve()` runs. This is handled in `loadCompileConfig()` in `loader.js` via the `expandPathTokens()` helper, using the same `/\{[@%]([^}]+)\}/g` regex pattern as the rest of the codebase.

Canon resolution uses a two-pass approach: plain-path entries (no `{@}` tokens after variable expansion) are resolved in pass 1, forming the lookup table for pass 2 which handles entries that reference sibling canon names. Template paths are expanded after both passes, so they can reference any named canon entry. Unresolved tokens pass through unchanged, causing the standard missing-path warning to fire with the unexpanded token visible in the path string.
