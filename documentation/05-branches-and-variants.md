# Branch Tree & Variant Dispatch

Branches define the playable paths through your scenario. The compiler enumerates all **leaf nodes** (branches with no children) and produces one complete output folder per leaf. Variants define named deltas applied to items; branch dispatch maps branch names to variant names so each branch gets the right version of each item.

---

## Branch Tree in `compile.yaml`

The `branches:` key is a nested mapping. Any branch node without a `branches:` sub-key is a leaf.

```yaml
branches:
  subject:                      # leaf
    protagonist: Aness
  researcher:                   # leaf
    protagonist: Veyrn
  tier2:                        # non-leaf node
    branches:
      alpha: {}                 # leaf
      beta: {}                  # leaf
```

This produces four leaf outputs: `subject`, `researcher`, `tier2/alpha`, `tier2/beta`.

A project with no `branches:` key produces a single root-level output.

### Output folder names

By default the output folder for each branch uses the YAML key as the directory name (`Branches/subject/`, `Branches/researcher/`, etc.). To use a different folder name, add a `title:` key to the branch config:

```yaml
branches:
  subject:
    title: The Subject's Path     # folder: Branches/The Subject's Path/
    protagonist: Aness
  researcher:
    protagonist: Veyrn             # folder: Branches/researcher/  (no title)
```

The `title:` value is used **only** for the filesystem path. The YAML key (`subject`, `researcher`) remains the identifier used for item `branches:` dispatch, wildcard matching, and all other internal logic.

### Branch paths

Each leaf is identified by a **path** — the sequence of branch **keys** from root to leaf, joined by `/`. These paths are used by item-level `branches:` dispatch.

| Leaf | Path |
|---|---|
| `subject` | `subject` |
| `researcher` | `researcher` |
| tier2 → alpha | `tier2/alpha` |
| tier2 → beta | `tier2/beta` |

---

## Variants on Items

`variants:` on an item definition holds named deltas. Each variant name maps to a partial item definition — any fields present in the variant are layered on top of the current item state.

```yaml
- id: Felicia
  name:
    display: Felicia
    full: Felicia Grayls
  pronouns: female
  ...
  variants:
    Felix:
      name:
        display: Felix
        full: Felix Grayls
      pronouns: male
      aid:
        title: Felix Grayls
        triggers: [Felix, Grayls]
      body:
        Physical Traits:
          gender: male
          hair: -{in a controlled bun}

    senior:
      body:
        Tagline: +{; Department Head}
```

Variants can be **nested** to any depth. A slash-separated path `sci-fi/near-future` walks the variant tree: applies `sci-fi`, then descends into `sci-fi.variants.near-future`.

Variants can modify any top-level item field: `name`, `pronouns`, `aid`, `render`, `v` (and all its aliases), and any `body` subfield.

The `id` field is immutable and cannot be changed by any variant.

---

## Branch Dispatch on Items

The `branches:` key on an item or import definition maps branch names to local variant names. When the compiler processes a branch leaf, it looks up that leaf's path in the item's `branches:` spec to determine which variant(s) to apply.

### Scalar form — apply one variant

```yaml
branches:
  felix: felix         # apply the "felix" local variant for the felix branch
  subject: subject
```

### Array form — apply multiple variants in order

```yaml
branches:
  felix: [base, felix]
```

### Null form — exclude item from branch

```yaml
branches:
  flashback: ~         # null; item is excluded from the flashback branch
```

### Mapping form — apply variants and/or descend into sub-branches

```yaml
branches:
  A:
    apply: [variantA]
    branches:
      X: variantAX
      Y: variantAY
```

The `apply:` list sets variants at this level; `branches:` descends for deeper dispatch.

### Wildcard `*` — baseline for all branches

A `*` key applies to every branch that doesn't have an explicit match, before the explicit match is added on top.

```yaml
branches:
  '*': base            # apply "base" variant as baseline for all branches
  felix: felix         # additionally apply "felix" for the felix branch
```

Both `*` and a direct key can match at the same level — the wildcard is applied first, then the explicit match stacks on top.

### How dispatch walks nested branches

For a leaf path `A/X`:
1. At depth 0, check for `*` and `A` in the `branches:` spec → collect those variant names
2. If `A`'s value is a mapping with `branches:`, descend into it for depth 1
3. At depth 1, check for `*` and `X` → collect additional variant names
4. All collected names are applied to the item in order

---

## Excluding Items from Branches

Branch exclusion in v3 is handled entirely through the `branches:` dispatch map by setting a branch name to null (`~`). There are no `only:` or `except:` keys — the wildcard-plus-null pattern replaces them.

**Exclude from one branch, include in all others:**
```yaml
branches:
  '*': []          # include with no variant for all branches
  flashback: ~     # null: excluded from flashback
```

**Include in only one branch:**
```yaml
branches:
  subject: base    # only the subject branch gets this item
  '*': ~           # all other branches: excluded
```

**Null excludes immediately** — when `resolveBranchSpec` encounters a null for the exact branch key, it returns `null` and the item is skipped entirely for that branch, with no further wildcard processing at that level.

This applies identically to local item definitions, `import:` entries, `include:` directives, and PE blocks.

---

## Full Worked Example

**Canon item:**
```yaml
- id: Felicia
  name: {display: Felicia, full: Felicia Grayls}
  pronouns: female
  aid: {title: Felicia Grayls, type: Character, triggers: [Felicia, Grayls]}
  render: {template: Character}
  body:
    Tagline: [Academy researcher, minor nobility]
  variants:
    Felix:
      name: {display: Felix, full: Felix Grayls}
      pronouns: male
      aid: {title: Felix Grayls, triggers: [Felix, Grayls]}
      body:
        Physical Traits:
          gender: male
          hair: -{in a controlled bun}
```

**Project import:**
```yaml
- import: Felicia
  variants:
    felix:
      importVariants: [Felix]    # apply Felicia's canon Felix variant
  branches:
    felix: felix                 # for the felix branch, apply the local "felix" variant
```

For the `felix` branch leaf:
1. Load canonical Felicia
2. No top-level `importVariants:` on the import
3. Branch dispatch: `felix` → apply local `felix` variant
4. Local `felix` variant has `importVariants: [Felix]` → apply `Felix` from canon
5. Result: Felix Grayls with male pronouns

For any other branch:
1. Load canonical Felicia
2. No variant applied
3. Result: Felicia Grayls as-is
