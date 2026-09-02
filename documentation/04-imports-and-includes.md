# Imports & Includes

Project item files can pull in items from the canonical registry in two ways:

- **`include:`** — loads every item from a canon file as-is, with optional per-item overrides
- **`import:`** — loads a single named item and applies variant chains, field overrides, and branch dispatch

---

## `include:` Directive

Loads all items from a canonical YAML file. Items are compiled exactly as defined in canon, with no modifications unless you attach `importVariants:` or `branches:` to the include directive itself.

```yaml surface=item
- include: "{%main}/Characters/Felicia.yaml"
```

`{%main}` expands to the **directory path** of the `main` entry declared under `structure.input.library` in `compile.yaml`. Library names are auto-exposed as `{%…}` variables — there is one `{%…}` family and one expander — so the same token works here, in component specs, and in template or opening prose, and it always expands to that directory-path string.

Include and import paths also support `{%variable}` expansion, but — because includes are resolved once, before branches are enumerated — only **root-level** `variables:` are available there, not per-branch overrides.

```yaml surface=config
structure:
  input:
    library:
      main: ../../_Canon
```

You can also use a direct relative path, but the `{%name}` form is preferred for portability.

### Branch filtering on includes

To exclude all items in an included file from specific branches, attach a `branches:` dispatch spec to the `include:` directive. All items loaded from the file inherit it.

```yaml surface=item
- include: "{%main}/Characters/Guards.yaml"
  branches:
    '*': []         # include with no variant for all branches
    flashback: ~    # exclude all items in this file from the flashback branch
```

### Selectors on includes — silent skip, and one check that isn't

Both `importVariants:` and `branches:` on an include directive name a variant for **every item in the file**. Items that **do not define** a variant by that name are **silently skipped** — no warning. That is the point of an include: naming the variant on each item is the repetition it exists to remove, so most items missing the name is correct authoring, not a mistake.

```yaml surface=item
- include: "{%main}/Characters/Felicia.yaml"
  importVariants: [human]    # applied to every item that defines a "human" variant;
                             # items without it are silently unaffected
```

This differs from a single `import:` and from an item's own `branches:`. Both of those name **one** item, so a variant it does not define is a typo and raises `CL0321`.

What silence cannot hide is a name that matches **nothing**. A misspelled selector applies to no item, changes no output, and would otherwise say nothing at all — so a selector matching zero targets raises `CL0326`, naming the selector and how many items it was aimed at:

```yaml surface=item
- include: "{%main}/Characters/Guards.yaml"
  importVariants: [hmuan]    # CL0326: matched none of the 6 items included from Guards.yaml
```

Three of seven items matched is normal and reports nothing. Zero of seven is the one case worth a word.

### Include vs explicit import

If an item from an `include:` file is also listed in an explicit `import:` entry, the explicit import **wins silently** — the included version is skipped. Use this to include a whole file while overriding one specific item:

```yaml surface=item
# Include all items from Felicia.yaml — Felicia will be skipped below
- include: "{%main}/Characters/Felicia.yaml"

# Explicit import with overrides — takes precedence over the include
- import: Felicia
  variants:
    felix:
      importVariants: [Felix]
  branches:
    felix: felix
```

---

## `import:` Directive

Imports a single item from the canonical registry by ID and applies variant chains, field overrides, and branch dispatch.

```yaml surface=item
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

1. Load the canonical base item by ID
2. Apply the primary import path variant chain (slash-separated ID: `Zephon/human/noble`)
3. Apply `importVariants:` list entries in order (each is a slash-separated variant path on the canon item)
4. Apply top-level `body:` field overrides from the import definition
5. Apply top-level `name:`, `pronouns:`, `aid:`, `render:` overrides (if present)
6. Resolve `branches:` dispatch → determine which local variant names apply for the active branch
7. For each dispatched local variant, apply any `importVariants:` declared inside that variant (sourced from the canonical item's variant tree)
8. Apply each dispatched variant's delta fields
9. Recurse into sub-branches if the dispatch spec has nested `branches:`

---

## `importVariants:`

Applies named variant chains from the **canonical item's own variant tree** and folds them into the item in progress. Each entry is a slash-separated variant path, applied in order.

```yaml surface=item
- import: Zephon
  importVariants: [human/noble, sci-fi/near-future]
```

This applies the `human` variant, then `human/noble`, then `sci-fi`, then `sci-fi/near-future` — each walking the canon item's `variants:` tree.

`importVariants:` can also appear **inside a branch variant** on the import, where it sources from the same canonical item's variant tree:

```yaml surface=item
- import: Felicia
  variants:
    felix:
      importVariants: [Felix]    # applies Felix variant from Felicia's canon variants
      body:
        Tagline: +{; security officer}
  branches:
    felix: felix
```

`importVariants:` always sources from the **original canonical item's** variant tree, not the partially resolved item. `variants:` on an import defines local named deltas for branch dispatch — it is never a list of variant chains.

---

## Primary Import Variant Path

A slash-separated suffix on the item ID applies variant deltas before any `importVariants:` or field overrides:

```yaml surface=item
- import: Zephon/human/noble
```

This is equivalent to loading `Zephon` then applying `importVariants: [human/noble]`, but written inline. Use whichever reads more clearly for your use case.

---

## Field Overrides on Import

Top-level fields (`name`, `pronouns`, `aid`, `render`) and `body` can be overridden directly on the import entry. These are applied after all variant chains resolve.

```yaml surface=item
- import: Zephon
  name:
    display: Zeph
    full: Zephon Avery
  pronouns: they
  aid:
    triggers: [Zeph, Avery]
  body:
    Tagline: /{shadow mage}/{arcane scholar}
```

Field operations (`+{}`, `-{}`, `/{}`) work on `body` fields the same as in variants. See [Field Operations](06-field-operations.md).

---

## `variants:` and `branches:` on Import

`variants:` on an import defines **local named deltas** for branch dispatch. `branches:` maps branch names to those variant names.

```yaml surface=item
- import: Aness
  importVariants: [networked]
  variants:
    subject:
      body:
        Tagline: +{; Fused-Squad Subject}
    researcher:
      body:
        Tagline: +{; Research Assistant}
  branches:
    subject: subject
    researcher: researcher
```

For the full syntax of `branches:` dispatch values (including wildcards, arrays, null-exclude, and nested dispatch), see [Branch Tree & Variant Dispatch](05-branches-and-variants.md).

---

## Excluding Imports from Branches

To exclude an import from specific branches, use null (`~`) in the `branches:` dispatch map. There are no `only:` or `except:` keys on imports.

```yaml surface=item
- import: Zephon
  branches:
    '*': []         # include with no variant for all branches
    flashback: ~    # excluded from the flashback branch

- import: Guard
  branches:
    garrison: base  # only compiled for the garrison branch
    _: ~            # excluded from all other branches
  variants:
    base: {}
```

**Use `_`, not `'*'`, to exclude the branches you did not name.** A null wildcard is skipped rather than honored, so `'*': ~` leaves the import **included** everywhere — the opposite of what it reads as, and a warning (`CL0327`). See [Fallback `_`](05-branches-and-variants.md#fallback-_--only-when-nothing-else-matched).

See [Branch Tree & Variant Dispatch](05-branches-and-variants.md) for the full `branches:` dispatch syntax including wildcards, arrays, and nested dispatch.
