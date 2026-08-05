# Field Operations

Field operations are used in `variants:` deltas, `importVariants:` chains, and `body:` overrides on imports. They let you make targeted changes to an item's fields without replacing the entire value.

All string matching within operations is **case-sensitive** for the content of the operation itself (the substring to find/replace), but field **key** matching is always case-insensitive.

---

## Operations Reference

### Replace

Assign a new value directly. Replaces the field entirely.

```yaml
body:
  Tagline: count of monwynd, shadow mage
```

### Remove Field

Set the field to `null` (empty value or explicit `~`). Removes the field entirely from the item.

```yaml
body:
  Magic:               # empty value — removes the Magic field
  alternate form: ~    # explicit null — equivalent
```

### Append — `+{value}`

Appends to a field by converting the existing value into a two-element array. The separator between elements is a template concern — use `{join("; ", ...)}` or `{$body.Field}` (which joins arrays with `"; "` by default) to control formatting.

- If the field is **empty or absent**, the value is set as a plain scalar (no array created)
- If the field is a **non-empty string or block scalar**, the result is `[existing, value]`
- If the field is already an **array**, the value is appended as a new element: `[...existing, value]`

```yaml
body:
  Tagline: +{retired}
  # "count of monwynd, shadow mage" → ["count of monwynd, shadow mage", "retired"]
  # rendered via {$body.Tagline}  → "count of monwynd, shadow mage; retired"
  # rendered via {join(", ", $body.Tagline)} → "count of monwynd, shadow mage, retired"

  Background: +{Recently returned from exile.}
  # "long backstory" → ["long backstory", "Recently returned from exile."]
```

Do not put a leading separator in the appended value — the separator is added by the template, not the operation.

### Remove Substring — `-{text}`

Removes all occurrences of the substring from the field value. Result is trimmed.

```yaml
body:
  Physical Traits:
    hair: -{in a controlled bun}
    # "platinum blond hair in a controlled bun" → "platinum blond hair"
```

### Swap Substring — `/{old}/{new}`

Replaces all occurrences of `old` with `new`. Result is trimmed.

```yaml
body:
  Background: /{her}/{his}
  # "she built her reputation" → "she built his reputation"
```

---

## Operations on Array Fields

When a field holds a YAML sequence (array), operations behave element-wise:

| Operation | Effect on array |
|---|---|
| `+{item}` | Appends `item` as a new element |
| `-{item}` | Removes elements equal to `item` (exact match) |
| `/{old}/{new}` | Applies the swap to every element |
| `field: ~` | Removes the field entirely |
| `field: [a, b, c]` | Replaces the array with `[a, b, c]` (value replacement, see below) |

---

## Chained Operations

Set a field to a YAML sequence where every element is an op string (`+{…}`, `-{…}`, `/{…}/{…}`). Operations are applied in order to the field value.

```yaml
body:
  description:
    - "/{She}/{He}"
    - "/{she}/{he}"
    - "/{her}/{his}"
```

When an op chain includes `+{…}`, the append converts the intermediate value to an array. Subsequent swap ops map element-wise over the array:

```yaml
body:
  title:
    - "+{Guild Certified}"      # "Master Swordsman" → ["Master Swordsman", "Guild Certified"]
    - "/{Swordsman}/{Archer}"   # → ["Master Archer", "Guild Certified"]
```

### Distinguishing op sequences from value arrays

A YAML sequence in a variant is treated as a **value replacement** (sets the field to that array) unless every element is a string beginning with `+{`, `-{`, or `/{` — in which case it is treated as a sequential ops list.

An empty sequence `[]` is always treated as an ops list (no ops = no change, not an empty array replacement).

```yaml
# Op sequence — every element starts with an op prefix
description:
  - "/{She}/{He}"
  - "+{addendum}"

# Value array — plain strings; replaces the field with this array
keywords:
  - inquisitive
  - polite
  - compassionate
```

---

## Subfield Operations

Apply an operation to a specific subfield within a nested mapping. Other subfields are not affected.

```yaml
body:
  Physical Traits:
    gender: male          # replace this subfield only
    hair: -{in a bun}     # remove substring in this subfield only
    other:                # remove this subfield only (empty value)
```

You can mix operations and replacements within the same mapping block:

```yaml
body:
  Physical Traits:
    gender: male
    hair: -{long }
    eyes: "+{, with a faint glow}"
    other: ~
```

---

## Examples

```yaml
variants:
  veteran:
    body:
      # Replace
      Tagline: knight; veteran swordsman

      # Remove a field
      Apprentice Status:

      # Append
      Background: +{Retired from active service after the Siege of Greymoor.}

      # Remove substring
      Physical Traits:
        hair: -{, braided}

      # Swap
      Personality:
        expanded: /{leads from behind}/{leads from the front}

      # Chained ops
      Notes:
        - "/{Journeyman}/{Master}"
        - "+{; decorated veteran}"

      # Subfield mix
      Magic:
        affinity: high fire-affinity
        effect: ~              # remove subfield
```
