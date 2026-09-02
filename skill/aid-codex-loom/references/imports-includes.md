# Imports & Includes Reference

Two ways to pull items from a shared **library** — a directory declared under `structure.input.library` — into a project:

- **`include:`** — loads every item from a library file, with optional filtering
- **`import:`** — loads a single named item and applies variants, overrides, and dispatch

---

## `include:` Directive

Loads all items from a library file. Items compiled as-is unless you attach `importVariants:` or `branches:`.

```yaml
- include: "{%main}/Characters/Felicia.cl.yaml"
```

`{%main}` resolves to the path string of the `main` library directory (not its contents). **Every library name is automatically exposed as a `{%name}` variable**, so there is nothing to declare twice. Always prefer it to a relative path, for portability.

**When the project has a populated snapshot, `{%name}` resolves through the frozen copy rather than the live library.** The decision is made once at config load, so a compile is either frozen or it is not — never partially. `--live` overrides for one run. See `references/library-snapshot.md`.

### Branch filtering on includes

Attach a `branches:` dispatch spec to filter all items in the file:

```yaml
- include: "{%main}/Characters/Guards.cl.yaml"
  branches:
    '*': []         # include with no variant for all branches
    flashback: ~    # exclude all items in this file from flashback
```

### `importVariants:` on includes

Apply a variant to every item in the file. Items that don't define a variant by that name are **silently skipped** (no warning — unlike single `import:` where a missing variant warns).

```yaml
- include: "{%main}/Characters/Grayls.cl.yaml"
  importVariants: [human]
```

### Explicit import wins over include

If an item from an `include:` file is also in an explicit `import:`, the `import:` wins silently — the included version is skipped. Use this to include a whole file but override one specific item:

```yaml
- include: "{%main}/Characters/Felicia.cl.yaml"  # Felicia item skipped below

- import: Felicia                              # explicit import wins
  variants:
    felix:
      importVariants: [Felix]
  branches:
    felix: felix
```

---

## `import:` Directive

Loads a single item by ID and applies variant chains, overrides, and dispatch.

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

1. Load canonical base item by ID
2. Apply primary variant path (if ID has `/` suffix: `Zephon/human/noble`)
3. Apply `importVariants:` list entries in order (each is a slash-separated variant path on the canon item)
4. Apply top-level `body:` field overrides
5. Apply top-level `name:`, `pronouns:`, `aid:`, `render:` overrides (if present)
6. Resolve `branches:` dispatch → determine local variant names for the active branch
7. For each dispatched local variant, apply any `importVariants:` declared inside that variant
8. Apply each dispatched variant's delta fields
9. Recurse into sub-branches if dispatch has nested `branches:`

---

## `importVariants:`

Applies named variant chains from the **canonical item's own variant tree**. Each entry is a slash-separated variant path applied in order.

```yaml
- import: Zephon
  importVariants: [human/noble, sci-fi/near-future]
  # applies: human → human/noble → sci-fi → sci-fi/near-future
```

`importVariants:` can also appear **inside a local branch variant** on the import, where it sources from the same canonical item:

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

`importVariants:` always sources from the **original canonical item's** variant tree, not the partially resolved item.

---

## Primary Import Variant Path

Slash-suffix on the item ID — applies before `importVariants:`:

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
    _: ~            # exclude from all others
  variants:
    base: {}
```

Use `_: ~`, not `'*': ~`, to exclude the branches you did not name — a null wildcard is skipped, not honored, so `'*': ~` leaves the import included everywhere and raises `CL0327`.

See `branches-variants.md` for full dispatch syntax.
