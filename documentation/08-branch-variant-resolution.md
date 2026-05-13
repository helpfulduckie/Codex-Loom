# Branch Variant Resolution — Wildcards and Named Groups

Branch variants (the `variants:` tree on a card or import) are how a single card definition produces different content for different branches. The compiler walks the branch path from root to leaf, applying variant blocks at each level. Beyond simple named matches, two additional mechanisms give you more control: **wildcard variants** (`*`) and **named groups**.

---

## How branch variant resolution works

For each step along the branch path, the compiler runs three passes **in order** against the current variant tree. All three passes can fire at the same depth level — their results stack:

1. **Wildcard pass** — applies the `*` variant as a baseline, if present and not excepted
2. **Direct match pass** — applies the variant whose key exactly matches the current branch segment
3. **Named group pass** — if no direct match was found, looks for a group key whose nested `variants:` contain the branch segment

Each pass that fires applies its `import-variant:` chains, then its `fields:`, then its top-level overrides (`name`, `pronouns`, etc.). Sub-variant trees from matched nodes are collected and used as the variant tree for the next branch depth.

---

## Wildcard variants (`*`)

A variant keyed `*` fires for **every** branch at that depth, before any direct or group match. It acts as a baseline — a set of changes that apply regardless of which branch is active — and can be further refined by the direct match that follows.

```yaml
variants:
  "*":
    fields:
      Status: active research subject
  subject:
    fields:
      Status: +{; primary cohort}
  researcher:
    fields:
      Status: +{; cleared for full access}
```

For the `subject` branch: wildcard fires first → `Status` becomes `active research subject`, then direct match fires → `Status` becomes `active research subject; primary cohort`.

For the `researcher` branch: wildcard fires → `Status` = `active research subject`, then direct match → `Status` = `active research subject; cleared for full access`.

For any other branch: only the wildcard fires → `Status` = `active research subject`.

### Wildcard `except`

You can exclude specific branches from receiving the wildcard using `except:` on the `*` variant:

```yaml
variants:
  "*":
    except: [admin, observer]
    fields:
      Status: active research subject
  admin:
    fields:
      Status: administrative staff
```

The `admin` and `observer` branches skip the wildcard entirely. `admin` then gets its direct match. `observer` gets nothing from this level.

### Wildcard sub-variants

If the `*` variant has its own `variants:` block, those sub-variants are tracked alongside any sub-variants from the direct match and remain available at the next depth level. Both wildcard and direct-match sub-trees are consulted in parallel at every depth.

```yaml
variants:
  "*":
    fields:
      Clearance: standard
    variants:
      alpha:
        fields:
          Clearance: +{; alpha access}
  subject:
    fields:
      Cohort: Zenus
    variants:
      alpha:
        fields:
          Cohort: +{; alpha track}
```

For the leaf `subject/alpha`:
1. Depth `subject`: wildcard fires (`Clearance: standard`), direct match fires (`Cohort: Zenus`). Both sub-trees (`*`'s and `subject`'s) are kept.
2. Depth `alpha`: both sub-trees are searched. Wildcard's `alpha` fires (`Clearance: standard; alpha access`), then `subject`'s `alpha` fires (`Cohort: Zenus; alpha track`).

---

## Named group variants

A named group is a variant key whose own `variants:` block contains the branch segment you're matching, but the group key itself doesn't match the branch name. This fires only when **no direct match** exists at that depth.

Named groups let you apply a shared "category" delta to a set of branches without having to repeat that delta in every individual branch variant.

```yaml
variants:
  corporate:
    fields:
      Affiliation: Helix Industries
      Dress Code: corporate formal
    variants:
      sales:
        fields:
          Role: Sales Representative
      research:
        fields:
          Role: Research Analyst
  government:
    fields:
      Affiliation: Ministry of Sciences
    variants:
      field:
        fields:
          Role: Field Agent
      analyst:
        fields:
          Role: Intelligence Analyst
```

For the branch `sales`:
- No direct match for `sales` at the top level.
- Compiler finds `corporate`, whose nested `variants:` contains `sales` — named group fires.
- Applies `corporate`'s fields (`Affiliation: Helix Industries`, `Dress Code: corporate formal`).
- Then applies `corporate.variants.sales` (`Role: Sales Representative`).

For the branch `field`:
- No direct match. Finds `government` as the named group.
- Applies `government`'s fields (`Affiliation: Ministry of Sciences`).
- Then applies `government.variants.field` (`Role: Field Agent`).

### Named groups vs direct matches

Direct matches always take priority over named group matching. If a branch segment has a direct-match key at the current depth, the named-group pass is skipped entirely for that depth — even if a group also contains the branch name in its nested variants.

---

## Full application order at each branch depth

For a given branch segment and variant tree, the compiler applies in this order:

1. **`*` wildcard** (if present and not excepted for this branch)
2. **Direct match** (variant key === branch segment, case-insensitive)
   - OR, if no direct match: **named group** (group key whose nested variants contain the branch segment)

Within each matched block, the order is:
1. `import-variant:` chains (sourced from the canonical card's variant tree)
2. `fields:` operations
3. Top-level field overrides (`name`, `pronouns`, `triggers`, etc.)

Then the compiler advances to the next branch depth using the collected sub-variant trees.

---

## Combining all three

Wildcard, direct match, and named group can all contribute at the same depth if applicable:

```yaml
variants:
  "*":
    fields:
      Base: always applies
  corporate:           # named group (no direct match for 'sales')
    fields:
      Affiliation: Helix
    variants:
      sales:
        fields:
          Role: Sales
```

For branch `sales`:
- Wildcard fires: `Base: always applies`
- No direct match for `sales` — named group `corporate` fires: `Affiliation: Helix`
- Named group's child `sales` fires: `Role: Sales`

---

## Practical uses

**Wildcard** — apply a change to all branches as a baseline, then refine per branch:
```yaml
variants:
  "*":
    fields:
      Note: Compiled for all branches.
  subject:
    fields:
      Note: /{all branches}/{subject branch}
```

**Named group** — share a category-level delta without repeating it:
```yaml
variants:
  arcane:
    fields:
      Magic System: arcane
    variants:
      fire:
        fields:
          Affinity: fire
      ice:
        fields:
          Affinity: ice
  physical:
    fields:
      Magic System: martial
    variants:
      sword:
        fields:
          Affinity: blade
```

**Wildcard + named group** — apply a universal baseline, then a category delta, then a specific delta:
```yaml
variants:
  "*":
    fields:
      Status: enrolled
  noble:
    fields:
      Social Standing: nobility
    variants:
      subject:
        fields:
          Status: /{enrolled}/{conscripted}
  subject:           # direct match — takes priority over named group for 'subject'
    fields:
      Status: conscripted
```

In this case `subject` has a direct match, so the `noble` group is never consulted for the `subject` branch (even though `noble.variants.subject` exists). The direct match wins.
