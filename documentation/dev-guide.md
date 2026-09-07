# Codex Loom — Developer Guide

This document describes the internal architecture of Codex Loom for maintainers. It is meant to augment the inline JSDoc in source files, not duplicate it — focus here is on data flow, non-obvious design decisions, and algorithm structure.

Section references of the form §N point at [`design-spec.md`](design-spec.md), the as-built design spec alongside this file.

---

## Module Map

The codebase is one file per concern (§3.2). `compile.js` orchestrates the pipeline; item loading, resolution, token expansion, rendering, emit, the per-leaf loop, the tree-level writes and the report dispatch are each their own module or directory.

| File | Role |
|---|---|
| `src/cli.js` | CLI entry point: argument parsing, mode dispatch, `--migrate`, `syncLibrary` |
| `src/compile.js` | `compile()` / `compileRun()` — orchestrates the pipeline; the per-leaf, tree-write and report stages live in the modules below |
| `src/compileState.js` | The mutable state of one `compileRun`, grouped into the clusters the decomposed stages pass around |
| `src/config/load.js` | Loads and resolves `compile.cl.yaml`: variables, paths, library names |
| `src/config/schema.js` | The `compile.cl.yaml` key surface, validated by `src/schema.js` |
| `src/snapshot.js` | `--snapshot`: the library freeze (copy + hash + manifest write) and the compile-time drift notice (§11) |
| `src/loader/preparse.js` | Rescues leading `{$…}`/`{%…}` tokens YAML would swallow (§4.1) |
| `src/loader/yaml.js` | YAML parsing with a source map, so diagnostics carry positions |
| `src/loader/registry.js` | Item loading, `ItemRegistry`, library merge, overlays, includes |
| `src/loader/schema.js` | The item key surface (§4.3) |
| `src/loader/component.js`, `src/loader/component-schema.js` | Component-document loading and its key surface (§7.2) |
| `src/loader/field-table.js` | Loads `fields.cl.yaml` — the field and template declarations (§13.2) |
| `src/loader.js` | Template and partial loading; holds `loadNamedFiles`, `loadTemplates` and `loadFieldTable` |
| `src/schema.js` | The shared validation engine both key surfaces run through |
| `src/diag.js` | The diagnostic bus: codes, severities, source spans (§4.4) |
| `src/log.js` | The progress log — `{ info, verbose }` — that narration goes to; exports only the silent default |
| `src/model/item.js` | Item resolution through import/variant/branch chains |
| `src/model/branches.js` | Branch-spec dispatch; `enumerateLeaves`; branch-chain walks |
| `src/model/fieldops.js` | Value-level field operations (`applyFieldOp` and friends) |
| `src/model/refs.js` | Item reference resolution, plain and library-qualified (§17.2) |
| `src/model/pronouns.js` | Pronoun and verb conjugation passes; cross-item reference resolution |
| `src/model/component.js` | Component documents: sections, slots, section variants, branch gating (§7.2) |
| `src/util.js` | `{%variable}` expansion (`resolveVariables` — the single expander, §5.1), recursive string-value transformation; file enumeration, YAML loading, deep clone, case-insensitive object utilities |
| `src/template.js` | The render entry point: `{%}` expansion, `{include}` splicing, whitespace normalization, field interpolation |
| `src/templateResolve.js` | The template-selection ladders (§13.4): `templateFor` per rendering role, the branch-merged type→template map, the load-time `notesTemplate` check |
| `src/render/parse.js`, `src/render/eval.js` | The template lexer and parser (the whole tag grammar, not just render functions), and the AST evaluator |
| `src/render/field-list.js`, `src/render/field-audit.js` | Declared-field-list rendering, and the unread-field audit (`CL0426`–`CL0428`) |
| `src/crossItem.js` | Cross-item render-function resolution: dependency graph, one topological pass, cycle-by-name (§13) |
| `src/emit/vl.js` | The Velvet Lattice format — the only place that knows the envelope (§8) |
| `src/emit/components.js` | The component descriptor table; sectioned rendering and passthrough (§7.2, §7.3) |
| `src/emit/placeholders.js` | Placeholder checks: undeclared, out-of-context, unused, duplicate question text |
| `src/cardType.js` | `aid.type` validation and normalization for emit (§4.4) |
| `src/limits.js` | AID's platform field caps and the post-render length measurement (§8.5) |
| `src/slots.js` | The sections one `render.storyCards`/`render.component` entry renders; slot index; empty-slot warnings (§7.8) |
| `src/leafLoop.js` | The per-leaf compile loop: branch-chain merge, sectioned components, slot index, card + slot render in one pass |
| `src/inherit.js` | Component and script inheritance down the branch tree; story-card frontier placement (§7.3a) |
| `src/outputPaths.js` | Where a branch node's folder lands on disk; the pre-build sweep that wipes output folders and archives stale nodes |
| `src/treeWrite.js` | Recursive writers for interior-node framing, labels, placeholders and descriptions; component-spec resolution |
| `src/compiledTree.js` | The one compiled-output-tree traversal `seedmap`/`bodysize`/`overview` are built from — child lists, ancestor walk, per-node merge (§7.3a) |
| `src/reportDispatch.js` | End-of-compile report dispatch and the load-diagnostic replay; the `CL0545` unused-role check |
| `src/extract.js` | Named transforms for a section's `from:` source — `scriptBanner` (§7.7) |
| `src/overview.js` | Leaf-review and whole-tree overview file generation |
| `src/diff.js` | Cross-branch `--with-diff` (Shared/delta) and `--with-annotate` report generation |
| `src/inventory.js` | `--with-inventory`: slot × branch × occupants report (§7.9) |
| `src/provenance.js` | Provenance report: library set and source file per resolved item (§17.2) |
| `src/schematables.js` | The generated schema reference: field/label tables and type membership, derived from `fields.cl.yaml` (§13.8) |
| `src/seedmap.js`, `src/bodysize.js`, `src/lint.js`, `src/lint/packs.js` | Post-compile report modes and convention-pack execution, read from the written tree |
| `src/migrate/v3.js`, `src/migrate/index.js` | One-time v3 → v4 conversion and its file-walk driver (§14.2) |
| `src/migrate/description.js`, `src/migrate/opening.js` | Two of the v3 file formats §7.1 counted, converted to `sections:` |
| `src/migrate/plot-essentials.js` | The third: decides what each v3 Plot Essentials block becomes (slot vs. render target), and touches nothing |
| `src/migrate/plot-essentials-apply.js` | Applies that decision — rewrites the component as `sections:`, adds render targets, moves inline blocks out into item files |

`model/` is pure by contract (§3.3): no `fs`, no `console`. Warnings go to a caller-supplied `onWarn`, and failed lookups come back described rather than thrown, so the caller decides what reaches a terminal. A test enforces both the purity and the roster.

---

## Progress Logging and Limits

Compilation progress is not a diagnostic. `cli.js` installs the console-backed `{ info, verbose }` log and library callers receive `NULL_LOG` unless they supply their own sink. Diagnostics remain structured data because they determine failure, are asserted by code, and appear in the pathological fixture snapshot; progress text must never enter that channel.

`limits.js` measures the strings that AID receives after Velvet Lattice expands `%placeholder%` tokens. A card body excludes its heading, fence and `notes:` scalar. Each `Opening.md` is capped independently because branch inheritance replaces a component file by filename; story cards are measured at each leaf because their inherited placeholder tables can differ. The warning threshold is 90 percent of each cap, and a value over the cap produces only the error rather than a duplicate warning.

`bodysize.js` reports openings per output node and cards per leaf. The distinction keeps a branch-framing opening from being counted once for each descendant while still accounting for placeholder expansion in a card inherited by several leaves.

---

## Compilation Pipeline

```
loadCompileConfig()
    ↓
loadTemplates()                  → templates Map, partials Map
buildCanonRegistry()             → library ItemRegistry (plain keys + qualified/ambiguous sidecars)
loadItemsFromDir()               → raw project item defs (array)
resolveIncludes()                → included library items stamped with _include_* metadata
buildRegistry(projectItems)      → project registry
mergeRegistries(library, project) → full registry
enumerateLeaves(branches)         → [[path], [path], ...]
    ↓
FOR EACH LEAF:
  walkBranchChain()             → merged variables/roles/placeholders/components; branchProtagonist
  buildCompileContext()          → variables (merged), componentRefs (resolved paths)
  resolveBranchItems()           → resolvedItems[]
    FOR EACH itemDef:
      resolveItem()              → resolved item object or null (excluded)
      applyFieldInterpolation()  → dotted {$body/v/aid/render/name.X} refs expanded
  resolveSectionedComponents()   → the leaf's component documents
  buildSlotIndex()               → what a render target may name on this branch
  renderBranchItems()            → {written, occupants} — cards and slot contents in one pass
    applyRolePass()              → {$Role…} leading names rewritten to bound item ids, all items
    applyCrossItemRefs()         → {$Id.body.Field} refs resolved across all items
    FOR EACH resolvedItem:
      applyPronounPasses()       → pronoun + conjugation tokens resolved
      resolvePlacements()        → {storyCard, targets} — §7.2's inversion
      validateCardType()         → abort if resolved aid.type is not a legal path segment
      render()                   → markdown string
    writeOutput()                → Story Cards/{type}/{type}.md
  renderSectionedComponent()     → Components/{Plot Essentials,Summary,AI Instructions,
                                    Author Notes,Opening}.md + Description.md
  copyScripts()
writeFramingRecursive()          → Components/Opening.md at every branch node incl. the root;
                                    roles resolve in every shape (sentence, prose .md, sections:)
Root Description                 → Description.md, roles resolve, branchProtagonist always null
runLeafReviewMode()              → Overview/*.leaf.md
runProvenanceMode()               → Overview/<root>.provenance.{md,csv}  (always, §17.2)
(if --with-inventory) runInventoryMode() → Overview/Inventory.md
(if --with-diff)      runDiffMode()      → Overview/Shared.md + Overview/*.delta.md
(if --with-annotate)  runAnnotateMode()  → Overview/*.annotate.md
```

---

## Item Registry

`buildRegistry(items, context)` indexes items by lowercase `id` (falling back to `name` if `id` is absent). Collision within a context is fatal. `include:` defs are skipped, and so are bare `import:` defs — they *are* the item they name, with local deltas. An import def carrying its own `id:` is the exception and registers under that local id, which is rename-on-import (§17.4).

`mergeRegistries(library, project)` combines two registries. Any ID present in both is also fatal.

`ItemRegistry` is a `Map` first — plain lowercase id → item, so every `registry.get(id)` consumer reads it the way it always did. Three sidecars carry what multi-set shared libraries needed (§17.2):

| | |
|---|---|
| `qualified` | `set:id` → item, for every library item, so `grimwood:magic` always resolves |
| `ambiguous` | plain id → the rival items, for ids more than one library set defines |
| `sources` | the declared library set names, so an unknown qualifier is distinguishable from a known set that lacks the id |

**A duplicate id across two library sets is not fatal, and is not resolved by declaration order.** Both copies are kept and the plain key is left empty; only a reference that cannot choose between them fails, and it fails at the reference (§17.3, `resolveItemRef` in `model/refs.js`). The absence of the plain key *is* the mechanism — the unqualified lookup has to miss before the resolver can reach the sidecar and name the alternatives.

The asymmetry with the two fatal cases above is deliberate. One set owning an id twice is a mistake inside that set, and a project id colliding with a library id is a clash whose both sides the author owns; a cross-set clash is neither. `.itemCount` counts items rather than plain keys, since an ambiguous id holds none.

The final merged registry is passed to every downstream function. It is **read-only** during compilation — no function mutates it.

---

## Item Resolution Order

`resolveItem(itemDef, registry, branchPath)` in `model/item.js` applies deltas in this fixed order:

1. Resolve `import:` through `resolveItemRef` (plain or `set:id`), then deep-clone the library base item — or the local item def if there is no `import:`
2. Apply the **primary import path** variant chain (slash-separated suffix on the import ID)
3. Apply each entry in `importVariants:` (slash-separated paths on the library item's variant tree)
4. Apply top-level `body:`, `name:`, `pronouns:`, `aid:`, `render:` overrides from the import def
5. If the import def carries its own `id:`, overwrite the imported id with it (§17.4). Only the id moves — `name:` is deliberately left as the imported item set it, so a rename that should also change the display name says so rather than having one guessed from a slug
6. Call `resolveBranchSpec(itemDef.branches, branchPath)` → list of local variant names
7. For each dispatched local variant name:
   a. Walk `itemDef.variants` tree to collect the variant delta
   b. If the delta has `importVariants:`, apply those from the **library item's** variant tree first
   c. Apply the delta fields
8. Return `null` if `resolveBranchSpec` returns `null` (item excluded from this branch)

For local (non-import) items, steps 2–5 are skipped. `_include_variants` and `_include_branch_spec` are attached by `resolveIncludes()` to carry include-directive settings.

After resolution, `aid.type` and `render.template` are cross-defaulted: each is filled in from the other if absent.

---

## Branch Dispatch Algorithm

`resolveBranchSpec(spec, branchPath)` in `model/branches.js` walks the branch path depth-first, accumulating variant names:

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

`applyFieldOp(current, op)` in `model/fieldops.js` dispatches based on the type and content of `op`:

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

**Phase 9 replaced the regex-and-sentinel engine with a lexer, a parser and a tree walk.** Through Phase 8 this was a sequence of text passes over the whole document — escape to sentinels, expand partials, resolve conditionals by repeating a regex until the string stopped changing, restore sentinels. That engine is gone. `render()` now tokenizes once and evaluates an AST, which is what lets a block tag nest properly and lets every diagnostic carry a line.

`render(template, data, partials, variables, options)` in `template.js` runs five stages:

1. **Expand `{%variable}` tokens** — `resolveVariables` over the template source, before anything else looks at it (§5.1)
2. **Splice in partials** — `expandIncludes` expands each partial's `{%variable}` values before parsing its own `{include Name}` directives, then splices depth-first with circular-include detection via a stack
3. **Tokenize** — `tokenize()` (`render/parse.js`) walks the source once into a flat token stream, each token carrying a 1-based `{line, column, length}` span
4. **Parse** — `parse()` builds a document tree of `Text`, `FieldRef`, `FuncCall`, `If`, `Wrapper` and `Preserve` nodes
5. **Evaluate** — `renderProgram()` (`render/eval.js`) walks that tree against `data`, then `normalizeWhitespace` strips tabs, drops blank lines, deduplicates spaces and trims

**`{include}` is spliced before tokenization, and that is deliberate.** A real template opens a block in one partial and closes it in another — the golden corpus does exactly this for `{wrapper}`, via `cardHeader` / `cardFooter` — so an `Include` node scoped to its own parse tree could not represent templates the v3 engine already rendered correctly. Expanding first and tokenizing the assembled string once is also what makes `{{` / `}}` escapes inside partials fall out for free.

**Escaping is a lexer concern, not a find-and-restore pass.** `{{` and `}}` become `ESC_LBRACE` / `ESC_RBRACE` tokens that parse straight to literal `{` and `}`. A lone `{` with no `}` before the next `{`, or an empty `{}`, is not a tag and stays in the text buffer. Tags never nest inside one brace pair — `[^{}]+` was the v3 regex's rule and remains the lexer's, because nothing in this language needs a literal brace inside a tag body.

**Block tags nest for real, via the parser's stack.** `parseIf` / `parseWrapper` / `parsePreserve` match their own closer by walking the token stream, so the repeat-to-fixpoint loop the old engine needed is gone. A block whose closer never arrives is not swallowed: the parser backtracks to just past the opening tag, emits that tag as literal text (matching the v3 fallback, where an unmatched regex left the tag untouched), and reports `CL0415` once per opening token even when an enclosing block also fails and re-walks it.

**Template diagnostics carry spans** — `CL0413` a malformed render-function call, `CL0414` an unknown function name, `CL0415` an unclosed block. `parse()` and the evaluator both take a `report(code, message, span)` callback rather than a bus reference, so neither module has to know what a `Diagnostics` instance is.

**One sentinel survives, for `{preserve}` only.** `renderPreserve` evaluates the block's children and hands `normalizeWhitespace` a `\x00PRESERVE_n\x00` marker plus an out-of-band array, rather than re-emitting the literal tags for a later regex to re-discover. Re-emitting was tried and rejected: if the evaluated content itself contains the text `{/preserve}` — reachable from data, via `{preserve}{$body.text}{/preserve}` — the regex closes on that instead of the source's real closing tag. Finding the boundary in the parsed source is what makes the fix real. `normalizeWhitespace` still carries its own regex path for callers that pass no `preserved` array.

**Post-render:** if `data.render.wrapper` is non-`none` and no `{wrapper}` block fired, the whole output is wrapped automatically. `ctx.flags.wrapperUsed` is set on a *shared* object rather than a plain context property, so a `{wrapper}` inside a taken `{if}` branch or inside an included partial is still seen through the shallow context copy.

`resolveField(ref, data)` is the core field lookup: splits the ref on `.`, walks the data object case-insensitively at each level. Returns arrays and objects as-is (for render functions), scalars as trimmed strings, missing/empty as `null`.

---

## The Emitter

`render()` produces the card **body**. `renderBranchItems` then hands that string to `emit/vl.js:renderCard`, which writes the heading, the `~~~` fence and its keys around it. Everything the Velvet Lattice format requires — the fence delimiter, trigger quoting, the unconditional `encapsulate: false`, `notes:` as a string — lives in that one module and nowhere else, which is what makes a format change a one-function edit rather than an edit to every template of every project.

The module is pure: no `fs`, no `console`. It collects trigger diagnostics into a `Diagnostics` bus the caller reports (`CL0701`, `CL0702`).

Three rules there are justified by what `velvet_lattice/loader.py` actually does, not by inference, and none should be changed without re-reading it:

- The fence is parsed with `yaml.safe_load`, and PyYAML is **YAML 1.1** — `no`, `yes`, `on` and `off` are booleans there. Quoting is decided against 1.1's resolver, not 1.2's.
- `triggers` is flattened with `",".join(...)` into AID's single `keys` field, so a comma inside a trigger is unrepresentable. That is an ERROR at emit, the last stage that can still see the difference.
- `notes` is typed `str` and assigned straight to AID's `description`, so it is always written as a scalar or a literal block scalar, never as nested keys.

`parseCards(markdown)` is the same knowledge read backwards, and §8.6 names it the contract to preserve: reports and, later, convention packs consume the parsed model rather than the file format. It deliberately mirrors `loader.py` — same fence regex, same header split, same YAML version — so what a report sees is what AID will get.

`__tests__/helpers/diffShape.js` and `EXPECTED_DIFF_CLASSES` in `golden.test.js` are the safety rail around all of this: they classify every changed line of compiled output as `fence`, `title` or `body`, so a phase can declare the shape of its intended diff and have anything outside it fail. `scripts/rebaseline.js` enforces the same classification before it will write a new baseline.

---

## Pronoun Resolution Passes

**The token pass (`applyTokenPass`) is one function called from every render path — item bodies, sectioned components, passthrough prose, tree-file literals.** It rewrites a leading role name to its bound item id, then resolves pronouns and conjugation. Role rewriting lives here, at the shared chokepoint, so this is the one place role diagnostics are raised and role usage is tracked.

**One ordering wrinkle, on the item path only.** `renderBranchItems` runs `applyCrossItemRefs` — which resolves `{$Id.body.FieldPath}` by reading the source item's body field — *before* the per-item `applyPronounPasses`/`applyTokenPass` loop, because it needs every item's body available at once. `applyCrossItemRefs` understands item ids and nothing else, so a `{$Role.body.X}` written through a role would never match. `applyRolePass(resolvedItems, { registry, roles, resolvedById, onRoleUsed })` closes that: it runs the same `resolveRole` rewrite over every item *before* `applyCrossItemRefs`, turning `{$Role…}` into `{$id…}` for all four token forms. It is deliberately **silent** — no `onWarn` — so the diagnostics still come from `applyTokenPass` alone; it does thread `onRoleUsed`, so a role referenced only by a `{$Role.body.X}` (consumed by `applyCrossItemRefs` before `applyTokenPass` sees it) still counts against `CL0545`. A no-op when the branch declares no roles. The component and passthrough paths have no `applyCrossItemRefs` step and so need no pre-pass.

**`applyTokenPass`** processes the combined regex `/{(\$[^{}]+)\}|\[(s|es|is|was|has)\]/g` left-to-right. A leading role name is rewritten via `resolveRole` first (on the item path that rewrite is already done, so it is a no-op on the resulting ids); then, in order:

- `{$she}` / `{$her~}` etc. (unscoped, no dot) → resolve against item's own `pronouns:` field. Does **not** set the conjugation scope.
- `{$Id}` (registry ID, no dot) → "you" if protagonist, else display name. Sets scope: the `you`-set for the protagonist, else the `NAME_SCOPE` sentinel — a rendered name conjugates singular whatever Id's pronoun set, so `{$Zephon} answer[s]` is "Zephon answers" for they/them. `NAME_SCOPE` is deliberately absent from `PLURAL_SETS`.
- `{$Id.pronoun}` (registry ID + pronoun token) → resolve pronoun against Id's effective pronoun set. Sets scope to Id's pronoun set — this is the form that carries they/them into a following marker.
- `{$Id.full}` / `{$Id.display}` → full or display name. Does not set scope.
- `{$Id.body.Field}` (registry ID + body path) → re-emitted as `{$<id>.body.Field}`. On the item path `applyCrossItemRefs` already resolved every such ref whose field exists, so a survivor is a missing field; on the other paths there is no cross-item resolution and it leaks. Either way the output sweep reports it as `CL0430`.
- `[s]` / `[es]` / `[is]` / `[was]` / `[has]` → conjugate using the current scope (or item's own pronouns if no scope set). `NAME_SCOPE` and the singular pronoun sets take the singular form; `they`/`nonbinary`/`you` take the plural.
- A leading name that resolves to neither a role nor a registry ID, when the branch is role-aware (`roles` non-null) → `CL0540` (`CL0541`–`CL0543` cover a role that is declared but cannot resolve).

Scope tracking via `currentScope` is local to each string processed by `applyTokenPass`, reset for each call. `applyRolePass`, `applyCrossItemRefs` and `applyPronounPasses` all route through `walkItemTextFields`, so they reach the same fields (`body`/`aid`/`render`/`name`).

---

## Field Interpolation

`applyFieldInterpolation(item)` in `template.js` runs after `resolveItem()` but before pronoun passes. It expands dotted field refs within the item's text sections.

**Coverage:** all four `{$…}` item-data walkers — `applyFieldInterpolation` (here), `applyRolePass`, `applyCrossItemRefs`, and `applyPronounPasses` — route through the shared `walkItemTextFields(item, transform)` in `util.js`, which visits string values in `item.body`, `item.aid`, `item.render`, and `item.name`. That helper is the single place the section list lives, so the passes always reach the same fields. (`name` is already normalized to an object before these passes run.)

**Surface:** `processFieldInterpolation(value, context)` matches dotted refs rooted at `body`, `v` (+ aliases), `aid`, `render`, or `name`, and resolves them via `resolveField`. The **required dot** is deliberate: bare single-segment `{$X}` (pronoun tokens like `{$she}`, character refs like `{$Id}`) is left for the pronoun pass. This ordering matters — interpolating `{$body.year}` into another field must happen before pronoun resolution so the interpolated content can itself contain pronoun tokens.

**Failure visibility:** `checkUnresolvedFieldTokens(text, label, sink)` (`util.js`) scans final rendered items and component outputs for any surviving `{$…}` and reports once per distinct token. It has two siblings built on the same `reportPattern` helper and called at the same sites: `checkUnexpandedVariables` for surviving `{%…}`, and `checkMechanicalArtifacts` for leaked engine text. All three take a diagnostics sink rather than warning directly, and all three mask fenced regions first so a code block in a body is not scanned. Template field-ref *misses* resolve to empty at render time and are not flagged; only verbatim survivors are.

---

## Key Design Decisions

**`body:` not `fields:`**

v3 introduced explicit namespacing for the four item block types: `aid:`, `render:`, `body:`, and `variants:`. This eliminates ambiguity about which block a delta key belongs to in `applyFieldsDelta` — any key not in `['name', 'pronouns', 'aid', 'render']` is treated as a body field op, and `body:` explicitly targets the whole body object. v2's flat `fields:` key required all keys to be treated as field operations with no clean separation from item metadata.

**Braced tokens replacing bare `$` markers**

v3 switched from bare `$Aness`, `$her~` markers (v2) to fully braced `{$Aness}`, `{$Aness.her~}` tokens. Braced tokens integrate cleanly with the existing template engine regex, avoid ambiguity at word boundaries, and compose naturally with field interpolation and other `{...}` expressions. The `TOKEN_RE` regex in `applyTokenPass` covers braced tokens and verb markers in a single pass.

**Phase A / Phase B split**

Phase A (`resolveBranchItems`) resolves all items for a branch and applies field interpolation before Phase B starts. Phase B (`renderBranchItems`) runs `applyRolePass` then `applyCrossItemRefs` first (both need all resolved items available simultaneously), then processes pronouns and rendering per item. This two-phase design ensures cross-item `{$Id.body.Field}` references — and, since the role rewrite is part of it, `{$Role.body.Field}` too — can always find the target item's resolved body, regardless of item ordering in the source files.

**`__DELETE__` sentinel**

`applyFieldOp` returns the string `'__DELETE__'` to signal that a field should be deleted. Callers (`applyFieldsDelta`, recursive subfield ops) check for this sentinel and call `delete obj[key]` rather than setting the key. Using a sentinel avoids the need for a wrapper type or exception throwing, and works cleanly through the recursive subfield application.

**Library naming (mapping not string)**

`structure.input.library` is a named mapping (`{main: ./path}`) rather than a plain string or array. Names serve two purposes: they appear in error messages (`library:main` labels each side of a collision) and they are exposed as variables, so `{%main}` resolves in `include:` paths. A plain path string would require path-based display, which is brittle.

**Diagnostics — the bus is required, a leaf throws facts, the caller assigns the code**

Below `compile()`, every function that can report a problem takes a `Diagnostics` bus (`src/diag.js`) as a required argument, and every raise is unconditional. There is no `if (diagnostics)` guard, no `console.warn` fallback when one is absent, and no runtime "bus required" check — a caller that omits the bus fails at the first raise with a `TypeError`, and the suite is how such a caller is found. A guard would be the same conditional with its branches swapped, and after wiring it would be dead. The one place a bus is deliberately discarded is a read that wants a value the reporting caller has already reported — `questionsForMeasurement` in `treeWrite.js`, `loadManifest` in `config/load.js` — and each says so at the call.

Three steps decide where a fault gets its code. A **leaf function throws a fact**: `loadYamlDocument` throws a `YamlLoadError` carrying `kind: 'read' | 'parse'`, because reading and parsing are all it knows. **The module that owns the diagnostic converts the throw**: the item registry's catch raises `CL0102` or `CL0101` and moves to the next file; `field-table.js` catches the same error and raises `CL0223`, because a broken field table is a different mistake from a broken item file. **A typed error exists only where a catch has to classify** — `YamlLoadError` is the one instance, and it carries a loading-band default `code` for callers with nothing more specific to say. Every other catch in `src/` maps to a single code and needs no type; do not add one until a second catch has to branch on cause.

**Only `cli.js` prints — results are returned, narration goes to a log, diagnostics go to the bus**

Nothing under `src/` except `cli.js` calls `console`, and a test in `log.test.js` reads every source file to pin that. Three channels carry what used to be printed. **Results are return values**: each report runner returns `{ written, ... }` or `null` when it found nothing to do, and the CLI derives every "N files" from `written.length` rather than knowing the number itself. **Narration goes to a log**: `{ info(line), verbose(line) }` from `src/log.js`, injected through `options.log` at `compile()` and `syncLibrary()`, threaded as a required argument below them in place of the old `verbose` boolean, and defaulting to the silent `NULL_LOG` at the entry points because silence is the right behavior for a library call. A module holding a log calls it and nothing else — never reads it back, counts it, or tests which implementation it got — which is what makes "the CLI decides what a run shows" true rather than aspirational. **Diagnostics stay on the bus**, which `compile()` never prints: the CLI passes a sink bus and prints it once after the call returns or throws, so errors land together at the bottom of the run rather than interleaved by phase. A per-leaf diagnostic carries the leaf in `Diagnostic.branch`, rendered as `(branch a/b)` in the header, because the model layer cannot name it and the interleave was the only thing that used to.

Progress lines are not `SEVERITY.INFO` diagnostics on purpose. The bus is data — `hasErrors()` gates the exit code, tests assert on codes, the pathological fixture snapshots every item — and a progress line on it would land in a diagnostic snapshot. Lint findings carry `SEVERITY` values like the bus does, and `SEVERITY_LABEL` is applied only where text is rendered: the `.lint.md` writer and the CLI echo.

**Token expansion — one family, one expander**

All `{%variable}` expansion routes through `resolveVariables()` in `src/util.js` — recursive, cycle-detecting, and reporting undeclared names through a caller-supplied sink. `transformStringValues()` applies it to nested semantic values without changing mapping keys or non-string scalars. There is no second implementation.

There is no second `{@name}` family (§6.1): library names are exposed as ordinary `{%}` variables, so one expander covers every case. Don't reintroduce a parallel resolver for a new context — add a call site to `resolveVariables` instead.

Call sites are thin wrappers: `config/load.js`'s `structure:` and `library:` path resolution, `treeWrite.resolveComponentSpec`, the `include:`-path block in `loader/registry.resolveIncludes`, and `loader/component.js` for both `imports:` `from:` and a section's `file:`/`from:` sources. When adding a context that needs tokens, call `resolveVariables` rather than re-deriving the regex.

Config paths pass two sink keys the content call sites do not: `location`, a source-map position preferred over `file`, and `branchOnly`, the set of names only a branch declares, which turns an undeclared name into `CL0520` rather than `CL0510`.

Coverage notes:
- `{%}` is expanded in every semantic item string value (`id`, `name`, `body`, `aid`, `render`, `v`, `notes`, `meta`, and `pronouns`), templates and partials, opening prose, component specs, branch `title`/role values, and config paths. Mapping keys and branch/variant selectors remain literal. In `include:`/`import:` paths it uses **root** `config.variables` only, because `resolveIncludes` runs once before branch enumeration — branch-merged variables do not exist yet.
- The `{$…}` field-reference family (`{$v.field}`, `{$Id.body.field}`) is a separate system (field interpolation + pronoun passes) and is **not** part of `resolveVariables`. It covers `body`/`aid`/`render`/`name` via `walkItemTextFields`, accepts dotted field refs in item data, and reports via `checkUnresolvedFieldTokens` on any token that survives to output; collapsing its four resolvers into one dispatcher is still deferred. See `07-templates.md` "Token Systems at a Glance".

Library path resolution no longer needs a bespoke two-pass. v3 resolved plain-path library entries first to build a lookup table, then resolved entries referencing sibling library names against it. Now that library names are ordinary variables (§6.1), a library entry naming a sibling is just a variable naming a variable, and `resolveVariables` handles it like any other — recursively, by key lookup, so declaration order is irrelevant. (§6.2 proposed a dependency graph and a topological sort on the premise that v3 resolved in declaration order. It did not, and neither does v4; the sort was never needed and never built.) Unresolved tokens pass through unchanged, so the standard missing-path warning fires with the unexpanded token visible in the path string.

---

## Provenance Report (§17.2)

**Answers "where did this item come from" for every item the registry resolved** — its library set (or `project`), its source file, and, for a renamed import, the id it was imported from. Unlike the three reports below, it is not gated behind a flag: `runProvenanceMode` (`provenance.js`) runs unconditionally at the end of `compile()` and writes to `config._resolvedReports` (falling back to `<output>/Overview`, same as every other report).

**`<rootDirName>.provenance.md` + `.provenance.csv`**, one row per registry entry. Columns: `ID`, `Source` (`library:<set>` or `project`), `File` (`_source`, the absolute path), `Via` (the `import:` value, for rename-on-import — §17.4), `Status` (`resolved` or `ambiguous`).

**Reads the registry, not the compiled tree**, so it needs no leaf loop and costs nothing per branch — one pass over `registry` (the plain, uniquely-resolved keys) and one over `registry.ambiguous` (§17.3's contested ids, one row per rival rather than a single winner, since there isn't one). An id that exists in both a library set and the project is a load-time ERROR (`mergeRegistries`) and never reaches this report.

**A rename-on-import item's row is `project`, not `library:<set>`.** `id: dragon` over `import: wyvern` registers under `dragon` with `_source` pointing at the project file that declared the rename (`buildRegistry` only stamps `_canonSource` on library-loaded items); `Via` carries `wyvern` so the row still answers "where did this come from" despite the local id having moved. A bare `import:` with no local `id:` never gets its own registry row at all — it resolves at render time to the library item, whose row already carries its own library provenance.

**Not the same question as `library-dependencies.json`** (`compile.js`, written to `config._resolvedOutput`). That manifest is per-library-*directory*, keyed by library name; this report is per-*item*. The manifest existing does not mean this report is redundant with it.

---

## Cross-Branch Review Reports (`--with-diff` / `--with-annotate` / `--with-inventory`)

These reports answer the authoring question "is this wired up the way I intended?" — `--with-diff` for *discovery* (scan, or hand to an agent), `--with-annotate` for *drill-down* once discovery flags a suspect item, `--with-inventory` for placement specifically.

**They are compile options, not post-hoc report modes.** Unlike `--leafReview`/`--overview`/`--seed-map`/`--body-sizes`/`--lint` (which read the already-written `output/` tree from disk), these three need structures that only exist in memory *during* compilation. `--with-diff` and `--with-annotate` need identity-keyed, fully-resolved item objects — the on-disk markdown has discarded `item.id` and variant-application metadata. `--with-inventory` needs the slot index and the occupant map, because the output file records what a slot *rendered to* and never who filled it. So setting any of them forces a compile (`doCompile`) and the reports are emitted at the end of `compile()` from data captured in the per-leaf loop, gated behind `options.diff`/`options.annotate`/`options.inventory`. Capture overhead is zero for a normal compile.

**`--with-diff` → `Overview/Shared.md` + `Overview/<leaf>.delta.md`** (`runDiffMode` in `diff.js`).
Partition rule (`buildSharedAndDeltas`): for each item id and each component block, collect its rendered text from every leaf. Identical in *all* leaves → `Shared.md`. Otherwise varying → each leaf's own version goes to that leaf's `.delta.md`; leaves where it is absent (`~`-excluded) silently omit it. Each `.delta.md` is therefore self-contained ("everything this branch has that isn't universal"), read against `Shared.md` once. Rendered-block granularity, no annotation.

**`--with-annotate` → `Overview/<leaf>.annotate.md`** (`runAnnotateMode`).
Per leaf, per item, field-level diff of `resolveItem(itemDef, registry, branchPath)` against the **project base** `resolveItem(itemDef, registry, [])` (empty branch path = project imports/overrides applied, no branch dispatch — *not* library base). Because both sides share the same source tokens/variables, the only differences are branch-variant effects. Each changed field is attributed to the applied variant(s) whose delta touches that path (`collectDeltaKeyPaths` + prefix match), or flagged `unexplained` (the bleed signal). `~`-nulled items are reported explicitly; items identical to base with no variants are omitted (they live in `Shared.md`).

**`--with-inventory` → `Overview/Inventory.md`** (`runInventoryMode` in `inventory.js`).
Per leaf, `captureLeafInventory` walks the slot index and the occupant map into `{slot, gated, occupants}` records. Rendering compresses twice: branches are grouped by occupancy so a uniformly-filled slot is one row, and a row's branch set is written as a path pattern when one selects exactly that set. `branchPattern` verifies each candidate against the leaves it matches and returns null on an over-match, because a pattern claiming a placement that never happened would be indistinguishable from a correct one. Occupant order comes from `sortOccupants`, exported from `emit/components.js` so §7.4's `order:`-then-id rule stays stated in one place.

**Scope / current limitations.** Every sectioned component — Plot Essentials, Summary, AI Instructions and Author's Note — diffs per section, keyed `section:<name>` by `renderSectionedComponent`. A `.md` passthrough has no sections and reports as one segment keyed by the component. Opening and the two descriptions render through the same path and their segments are available, but `diff.js` does not read them yet — capturing them is a report change rather than a compiler one. The annotate `base`/`leaf` values are the pre-render resolved field structures, so `+{}` appends show as two-element arrays.

**Component variable boundary.** Resolve component prose, headings, and metadata values at the root/leaf that emits them without mutating the cached component object; keep metadata keys and selectors literal. Deferred component lifting compares `renderFrontmatter(metadata) + text`, not body text alone. `storyCardType` resolves once from root variables, while story-card entry titles/types resolve at each leaf before validation.
