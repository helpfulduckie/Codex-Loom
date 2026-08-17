# Branch Tree & Variant Dispatch Reference

---

## Branch Tree in compile.yaml

```yaml
branches:
  subject:                      # leaf (no branches: sub-key)
    protagonist: Aness
    title: The Subject's Path   # optional: output folder name (key still used for dispatch)
  researcher:                   # leaf
    protagonist: Veyrn
  tier2:                        # non-leaf node
    branches:
      alpha: {}                 # leaf
      beta: {}                  # leaf
```

Produces four leaves: `subject`, `researcher`, `tier2/alpha`, `tier2/beta`.

Each leaf path is the slash-joined sequence of YAML keys from root to leaf. The `title:` value only changes the filesystem folder name; the YAML key is always used for dispatch and all internal logic.

No `branches:` key at all → single root-level output, no `Branches/` folder.

---

## Variants on Items

`variants:` holds named deltas. Each variant maps to a partial item definition layered on top of the item.

```yaml
variants:
  Felix:
    name: {display: Felix, full: Felix Grayls}
    pronouns: male
    body:
      Physical Traits:
        gender: male
        hair: -{in a controlled bun}

  senior:
    body:
      Tagline: +{; Department Head}
```

Variants can be **nested** to any depth. A slash path `sci-fi/near-future` walks the tree: applies `sci-fi`, then `sci-fi.variants.near-future`.

The `id` field is immutable — no variant can change it.

---

## Branch Dispatch on Items

The `branches:` key on an item or import maps branch names to variant names. Evaluated for each leaf being compiled.

### Scalar — apply one variant
```yaml
branches:
  felix: Felix
  subject: subject
```

### Array — apply multiple variants in order
```yaml
branches:
  felix: [base, Felix]
```

### Null — exclude item from branch
```yaml
branches:
  flashback: ~
```

### Mapping — apply variants and/or recurse into sub-branches
```yaml
branches:
  A:
    apply: [variantA]
    branches:
      X: variantAX
      Y: variantAY
```

`apply:` collects variants at this level; `branches:` descends for deeper matching.

### Wildcard `*` — baseline for all branches
```yaml
branches:
  '*': base            # baseline applied first for every branch
  felix: Felix         # additionally applied for the felix branch
```

Both `*` and the direct key can match at the same level. Wildcard fires first; explicit match stacks on top.

---

## How Dispatch Walks Nested Branches

For a leaf path `A/X`:
1. At depth 0: collect `*` and `A` variants
2. If `A`'s value is a mapping with `branches:`, descend into it
3. At depth 1: collect `*` and `X` variants
4. All collected variants applied to the item in order

---

## Excluding Items from Branches

There are no `only:` or `except:` keys. Use the wildcard-plus-null pattern instead.

**Exclude from one branch, include in all others:**
```yaml
branches:
  '*': []          # include with no variant for all
  flashback: ~     # exclude from flashback
```

**Include in only one branch:**
```yaml
branches:
  subject: base
  '*': ~           # exclude from all other branches
```

**Null excludes immediately** — when the dispatch resolves a null for the exact branch key, the item is skipped with no further wildcard processing at that level.

---

## Worked Example

**Canon item Felicia** has a `Felix` variant (male gender swap).

**Project import:**
```yaml
- import: Felicia
  variants:
    felix:
      importVariants: [Felix]   # apply canon Felix variant for this branch
  branches:
    felix: felix                # dispatch to local "felix" variant
```

For branch `felix`:
1. Load canonical Felicia base
2. Branch dispatch: `felix` → apply local `felix` variant
3. Local `felix` has `importVariants: [Felix]` → apply `Felix` from canon
4. Result: Felix Grayls with male pronouns

For all other branches: Felicia as-is (no variant applied, no dispatch match).
