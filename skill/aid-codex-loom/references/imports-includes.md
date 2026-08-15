# Imports & Includes Reference

Two ways to pull canonical cards into a project:

- **`include:`** — loads every card from a canon file, with optional filtering
- **`import:`** — loads a single named card and applies variants, overrides, and dispatch

---

## `include:` Directive

Loads all cards from a canonical YAML file. Cards compiled as-is unless you attach `importVariants:` or `branches:`.

```yaml
- include: "{@main}/Characters/Felicia.yaml"
```

`{@main}` resolves to the path string of the `main` canon directory (not its contents). Always use the `{@name}` form over relative paths for portability.

### Branch filtering on includes

Attach a `branches:` dispatch spec to filter all cards in the file:

```yaml
- include: "{@main}/Characters/Guards.yaml"
  branches:
    '*': []         # include with no variant for all branches
    flashback: ~    # exclude all cards in this file from flashback
```

### `importVariants:` on includes

Apply a variant to every card in the file. Cards that don't define a variant by that name are **silently skipped** (no warning — unlike single `import:` where a missing variant warns).

```yaml
- include: "{@main}/Characters/Grayls.yaml"
  importVariants: [human]
```

### Explicit import wins over include

If a card from an `include:` file is also in an explicit `import:`, the `import:` wins silently — the included version is skipped. Use this to include a whole file but override one specific card:

```yaml
- include: "{@main}/Characters/Felicia.yaml"  # Felicia card skipped below

- import: Felicia                              # explicit import wins
  variants:
    felix:
      importVariants: [Felix]
  branches:
    felix: felix
```

---

## `import:` Directive

Loads a single card by ID and applies variant chains, overrides, and dispatch.

```yaml
- import: Aness
  importVariants: [networked]
  body:
    Tagline: +{; Project Lead}
  variants:
    subject:
      body:
        Tagline: +{; Fused-Squad Subject}
  branches:
    subject: subject
```

### Import resolution order

1. Load canonical base card by ID
2. Apply primary variant path (if ID has `/` suffix: `Zephon/human/noble`)
3. Apply `importVariants:` list entries in order (each is a slash-separated variant path on the canon card)
4. Apply top-level `body:` field overrides
5. Apply top-level `name:`, `pronouns:`, `aid:`, `render:` overrides (if present)
6. Resolve `branches:` dispatch → determine local variant names for the active branch
7. For each dispatched local variant, apply any `importVariants:` declared inside that variant
8. Apply each dispatched variant's delta fields
9. Recurse into sub-branches if dispatch has nested `branches:`

---

## `importVariants:`

Applies named variant chains from the **canonical card's own variant tree**. Each entry is a slash-separated variant path applied in order.

```yaml
- import: Zephon
  importVariants: [human/noble, sci-fi/near-future]
  # applies: human → human/noble → sci-fi → sci-fi/near-future
```

`importVariants:` can also appear **inside a local branch variant** on the import, where it sources from the same canonical card:

```yaml
- import: Felicia
  variants:
    felix:
      importVariants: [Felix]    # applies Felix variant from Felicia's canon variants
      body:
        Tagline: +{; security officer}
  branches:
    felix: felix
```

`importVariants:` always sources from the **original canonical card's** variant tree, not the partially resolved card.

---

## Primary Import Variant Path

Slash-suffix on the card ID — applies before `importVariants:`:

```yaml
- import: Zephon/human/noble
# equivalent to:
- import: Zephon
  importVariants: [human/noble]
```

---

## Field Overrides on Import

Top-level fields and `body:` can be overridden directly. Applied after all variant chains.

```yaml
- import: Zephon
  name:
    display: Zeph
    full: Zephon Avery
  pronouns: they
  aid:
    triggers: [Zeph, Avery]
  body:
    Tagline: /{shadow mage}/{arcane scholar}    # field operation works here too
```

---

## Excluding Imports from Branches

No `only:` or `except:` keys. Use null dispatch:

```yaml
- import: Zephon
  branches:
    '*': []         # include in all branches
    flashback: ~    # exclude from flashback

- import: Guard
  branches:
    garrison: base  # include only in garrison branch
    '*': ~          # exclude from all others
  variants:
    base: {}
```

See `branches-variants.md` for full dispatch syntax.
