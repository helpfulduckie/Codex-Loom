# Include Directives — Advanced Features

The basic `include:` syntax loads all cards from a canon file as-is. Beyond that, `include:` supports `import-variant:` and `variants:` — letting you apply variant chains from each card's own variant tree on a per-branch basis, without having to list each card individually as an explicit `import:`.

---

## Basic include (recap)

```yaml
- include: Characters/Grayls.yaml
```

Loads every card in `Grayls.yaml` from the canon folder. Cards compile as their base definitions with no modifications. If any card from the included file is also explicitly listed as an `import:` elsewhere in the project, the explicit import wins and the included version is silently skipped.

---

## include with import-variant

`import-variant:` on an `include:` directive applies one or more variant chains to every card loaded from that file. The chains are sourced from **each card's own `variants:` tree** — not a separate registry.

```yaml
- include: Characters/Grayls.yaml
  import-variant: [sci-fi/near-future]
```

For every card in `Grayls.yaml`: the compiler walks that card's own `variants:` tree along the path `sci-fi` → `near-future`, applying each delta in order.

If a card in the file doesn't have a `sci-fi` variant, that chain is skipped for that card (with a warning) and the card compiles as its base definition.

Multiple chains can be listed and are applied in order:

```yaml
- include: Characters/Grayls.yaml
  import-variant: [sci-fi/near-future, guild/senior]
```

---

## include with variants (branch-specific import-variant)

`variants:` on an `include:` directive provides a branch-structured tree that controls which `import-variant:` chain applies for a given branch leaf. The compiler walks the branch path against this tree, and the **deepest matching node that has an `import-variant:` key** determines which variant chain is applied.

```yaml
- include: Characters/Grayls.yaml
  import-variant: [sci-fi]           # default — used when no branch node overrides
  variants:
    subject:
      import-variant: [sci-fi/near-future]
    researcher:
      import-variant: [sci-fi/corporate]
```

- `subject` branch → `sci-fi/near-future` chain applied (branch node overrides top-level)
- `researcher` branch → `sci-fi/corporate` chain applied
- Any other branch → `sci-fi` chain applied (top-level `import-variant:` is the fallback)

### How the branch walk works

The compiler walks the branch path step by step using direct case-insensitive key matching at each depth. At each matching node, if that node has an `import-variant:` key, it **replaces** (not accumulates) the current effective chain. The deepest matching node that carries `import-variant:` wins.

```yaml
- include: Characters/Grayls.yaml
  import-variant: [base]
  variants:
    A:
      import-variant: [level-a]
      variants:
        X:
          import-variant: [level-ax]
        Y:
          {}                    # no import-variant — level-a stays effective
```

| Branch | Effective chain | Reason |
|---|---|---|
| `B` | `base` | No match at top level — top-level chain is the fallback |
| `A` | `level-a` | `A` matches, sets `level-a` |
| `A/X` | `level-ax` | `A` sets `level-a`, then `X` overrides with `level-ax` |
| `A/Y` | `level-a` | `A` sets `level-a`, `Y` has no `import-variant:` so chain stays |
| `A/Z` | `level-a` | `A` sets `level-a`, `Z` not found — walk stops at `A` |

If no node in the branch path has `import-variant:` and there is no top-level `import-variant:`, no variant chain is applied and every card compiles as its base definition.

---

## Important limitations

**No wildcard or named-group logic.** The branch walk on `include:` variants uses simple direct key matching only. `*` wildcards and named groups (described in the Branch Variant Resolution document) are not supported here.

**Only `import-variant:` is extracted — not `fields:`.** Any `fields:` key inside a branch node of an include's `variants:` tree is silently ignored. The branch walk extracts only `import-variant:`. If you need branch-specific field overrides on included cards, use explicit `import:` entries instead.

**`import-variant:` resolves against each included card's own `variants:` tree.** The paths in `import-variant:` are walked on each card's own definition, the same as any other `import-variant:` usage.

---

## What you can and cannot do

| Goal | Supported |
|---|---|
| Apply the same variant chain to all cards in a file, all branches | ✓ Top-level `import-variant:` |
| Apply different variant chains per branch | ✓ `variants:` with `import-variant:` at matching nodes |
| Apply field overrides to all included cards | ✗ Use explicit `import:` |
| Apply field overrides per branch on included cards | ✗ Use explicit `import:` |
| Wildcard (`*`) matching in the include variant tree | ✗ Direct key match only |
| Named group matching in the include variant tree | ✗ Direct key match only |

When you need unsupported features, list the cards as explicit `import:` entries.

---

## Combining with branch and output filters

All four kinds of directive can be combined on a single `include:`:

```yaml
- include: Characters/Grayls.yaml
  only: [A/X, B]
  only_output: [modset2]
  import-variant: [sci-fi]
  variants:
    A:
      import-variant: [sci-fi/near-future]
```

The card compiles only for branch leaves starting with `A/X` or `B`, only into the `modset2` output, with the variant chain appropriate to its branch.

---

## Interaction with explicit imports

If a card from an included file is also explicitly listed as an `import:`, the explicit import always wins — the included version (with its variant application) is silently discarded.

```yaml
# All of Grayls.yaml gets sci-fi applied
- include: Characters/Grayls.yaml
  import-variant: [sci-fi]

# Felicia needs finer control — explicit import wins; the include is ignored for her
- import: Felicia
  import-variant: [sci-fi, guild/senior]
  fields:
    Tagline: /{shadow mage}/{arcane scholar}
```

This lets you use `include:` as the default for a whole file and override individual cards with explicit `import:` entries.
