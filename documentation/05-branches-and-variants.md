# Branch Tree & Variant Dispatch

Branches define the playable paths through your scenario. The compiler enumerates all **leaf nodes** (branches with no children) and produces one complete output folder per leaf. Variants define named deltas applied to items; branch dispatch maps branch names to variant names so each branch gets the right version of each item.

---

## Branch Tree in `compile.yaml`

The `branches:` key is a nested mapping. Any branch node without a `branches:` sub-key is a leaf.

```yaml surface=config
branches:
  subject:                      # leaf
    roles:
      protagonist: Aness
  researcher:                   # leaf
    roles:
      protagonist: Veyrn
  tier2:                        # non-leaf node
    branches:
      alpha: {}                 # leaf
      beta: {}                  # leaf
```

`protagonist` is the built-in role, bound inside a branch's `roles:` block like any other
role (see [Roles](13-roles.md)).

This produces four leaf outputs — `subject`, `researcher`, `tier2/alpha`, `tier2/beta`:

```yaml transform=branch-dispatch id=leaves-nested
leaves:
  subject: {}
  researcher: {}
  tier2:
    branches:
      alpha: {}
      beta: {}
```

```yaml expect=leaves-nested
- [subject]
- [researcher]
- [tier2, alpha]
- [tier2, beta]
```

A project with no `branches:` key produces a single root-level output.

### Output folder names

By default the output folder for each branch uses the YAML key as the directory name (`Branches/subject/`, `Branches/researcher/`, etc.). To use a different folder name, add a `title:` key to the branch config:

```yaml surface=config
branches:
  subject:
    title: The Subject's Path     # folder: Branches/The Subject's Path/
    roles:
      protagonist: Aness
  researcher:
    roles:
      protagonist: Veyrn          # folder: Branches/researcher/  (no title)
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

```yaml surface=item
- id: Felicia
  name:
    display: Felicia
    full: Felicia Grayls
  pronouns: female
  # ...
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

```yaml surface=item
branches:
  felix: felix         # apply the "felix" local variant for the felix branch
  subject: subject
```

### Array form — apply multiple variants in order

```yaml surface=item
branches:
  felix: [base, felix]
```

### Null form — exclude item from branch

```yaml surface=item
branches:
  flashback: ~         # null; item is excluded from the flashback branch
```

### Mapping form — apply variants and/or descend into sub-branches

```yaml surface=item
branches:
  A:
    apply: [variantA]
    branches:
      X: variantAX
      Y: variantAY
```

The `apply:` list sets variants at this level; `branches:` descends for deeper dispatch. For leaf `A/X` that stacks `apply:` then the sub-key:

```yaml transform=branch-dispatch id=dispatch-nested
spec:
  A:
    apply: [variantA]
    branches:
      X: variantAX
      Y: variantAY
path: [A, X]
```

```yaml expect=dispatch-nested
- variantA
- variantAX
```

### Wildcard `*` — baseline for every branch

**A `*` key applies to *every* branch at that level, including ones with an explicit match.** It is a baseline, not a fallback: the wildcard is collected first, then any explicit match stacks on top of it.

```yaml surface=item
branches:
  '*': base            # "base" applies to every branch, felix included
  felix: felix         # felix gets [base, felix]; every other branch gets [base]
```

```yaml transform=branch-dispatch id=dispatch-wild-felix
spec: { '*': base, felix: felix }
path: [felix]
```

```yaml expect=dispatch-wild-felix
- base
- felix
```

```yaml transform=branch-dispatch id=dispatch-wild-other
spec: { '*': base, felix: felix }
path: [knight]
```

```yaml expect=dispatch-wild-other
- base
```

**A null wildcard does nothing.** `'*': ~` is skipped rather than excluding anything — the walker ignores a null `*` entirely, so every branch is still included with whatever else matched.

That is deliberate. Read literally, `'*': ~` says *exclude this item from every branch*, which is never a thing anyone means to write — an item excluded everywhere may as well be deleted — and honoring it would silently empty an item out of a whole scenario. So the walker refuses the reading rather than acting on it, and raises **`CL0327`** to say so — `'*': ~` anywhere in a spec is a warning, once per spec, naming `'_': ~` as the fix. **`_` exists for what people actually mean here**, and predates v4.

### Fallback `_` — only when nothing else matched

**A `_` key applies only to branches with no explicit key at that level.** This is the fallback `*` is often mistaken for, and the two compose: `*` always applies, `_` adds on top only when no exact key matched.

```yaml surface=item
branches:
  '*': base            # every branch
  _: unnamed           # only branches with no explicit key
  felix: felix         # felix gets [base, felix]; every other branch gets [base, unnamed]
```

```yaml transform=branch-dispatch id=dispatch-fallback-felix
spec: { '*': base, _: unnamed, felix: felix }
path: [felix]
```

```yaml expect=dispatch-fallback-felix
- base
- felix
```

```yaml transform=branch-dispatch id=dispatch-fallback-other
spec: { '*': base, _: unnamed, felix: felix }
path: [knight]
```

```yaml expect=dispatch-fallback-other
- base
- unnamed
```

**`_: ~` excludes every branch you did not name**, which is what makes "include in only one branch" expressible:

```yaml surface=item
branches:
  subject: base        # the subject branch gets "base"
  _: ~                 # every other branch: excluded
```

```yaml transform=branch-dispatch id=dispatch-only-subject
spec: { subject: base, _: ~ }
path: [subject]
```

```yaml expect=dispatch-only-subject
- base
```

```yaml transform=branch-dispatch id=dispatch-only-other
spec: { subject: base, _: ~ }
path: [knight]
```

```yaml expect=dispatch-only-other
null
```

### How dispatch walks nested branches

For a leaf path `A/X`, at each depth the walker does the same four things in this order:

1. **If the exact key maps to `~`, return immediately** — the item is excluded, and no wildcard or fallback is consulted.
2. **Collect `*`**, if present and not null.
3. **Collect the exact key**, stacking on top of the wildcard.
4. **Collect `_` only if no exact key matched** — and if `_` is `~`, exclude here too.

Then descend through any `branches:` sub-key on the values that matched, and repeat at depth 1 for `X`. All collected names are applied to the item in the order they were gathered.

---

## Excluding Items from Branches

Branch exclusion is handled entirely through the `branches:` dispatch map by setting a branch name to null (`~`). There are no `only:` or `except:` keys — the wildcard-plus-null pattern covers the same cases.

**Exclude from one branch, include in all others:**
```yaml surface=item
branches:
  '*': []          # include with no variant for all branches
  flashback: ~     # null: excluded from flashback
```

**Include in only one branch:**
```yaml surface=item
branches:
  subject: base    # only the subject branch gets this item
  _: ~             # all other branches: excluded
```

Use `_`, not `'*'`, for this. A null wildcard is skipped rather than honored, so `'*': ~` leaves the item **included** in every branch — the opposite of what it reads as. It is a warning (`CL0327`), not a silent skip.

**Null excludes immediately** — when the dispatch walker encounters a null for the exact branch key, it returns `null` and the item is skipped entirely for that branch, with no further wildcard processing at that level.

This applies identically to local item definitions, `import:` entries, `include:` directives, and component sections. One walker serves all of them — a section's `branches:` resolves through the same dispatch walker an item's does, which is why `~` means the same thing everywhere.

---

## Full Worked Example

**Library item:**
```yaml surface=item
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
```yaml surface=item
- import: Felicia
  variants:
    felix:
      importVariants: [Felix]    # apply Felicia's library Felix variant
  branches:
    felix: felix                 # for the felix branch, apply the local "felix" variant
```

For the `felix` branch leaf:
1. Load Felicia from the library
2. No top-level `importVariants:` on the import
3. Branch dispatch: `felix` → apply local `felix` variant
4. Local `felix` variant has `importVariants: [Felix]` → apply `Felix` from the library
5. Result: Felix Grayls with male pronouns

For any other branch:
1. Load Felicia from the library
2. No variant applied
3. Result: Felicia Grayls as-is
