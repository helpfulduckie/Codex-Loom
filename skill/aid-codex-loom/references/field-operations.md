# Field Operations Reference

Used in `variants:` deltas, `importVariants:` chains, and `body:` overrides on imports. All operations are on field values; field **key** matching is always case-insensitive. String content within operations is case-sensitive.

---

## Operations

### Replace
Assign a new value — replaces the field entirely.
```yaml
body:
  Tagline: knight; veteran swordsman
```

### Remove Field
Set to null (`~`) or empty value — removes the field from the item.
```yaml
body:
  Magic:               # empty value → remove field
  alternate form: ~    # explicit null → equivalent
```

### Append — `+{value}`
Appends to the field, converting it to an array. The separator between elements is a template concern.
- If field is **empty/absent**: sets value as scalar (no array created)
- If field is a **string/block scalar**: result is `[existing, value]`
- If field is already an **array**: appends new element

```yaml
body:
  Tagline: +{retired}
  # "count of monwynd" → ["count of monwynd", "retired"]
  # rendered via {$body.Tagline} → "count of monwynd; retired"

  Background: +{Recently returned from exile.}
```

Do not add a leading separator to the appended value — the template handles separators.

### Remove Substring — `-{text}`
Removes all occurrences of the substring. Result is trimmed.
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
```

---

## Operations on Array Fields

| Operation | Effect on array |
|---|---|
| `+{item}` | Appends `item` as new element |
| `-{item}` | Removes elements equal to `item` (exact match) |
| `/{old}/{new}` | Applies swap to every element |
| `field: ~` | Removes the field entirely |
| `field: [a, b, c]` | **Value replacement** — replaces array (see below) |

---

## Chained Operations

Set a field to a YAML sequence where every element is an op string. Applied in order.

```yaml
body:
  description:
    - "/{She}/{He}"
    - "/{she}/{he}"
    - "/{her}/{his}"

  title:
    - "+{Guild Certified}"      # "Master Swordsman" → ["Master Swordsman", "Guild Certified"]
    - "/{Swordsman}/{Archer}"   # → ["Master Archer", "Guild Certified"]
```

**Distinguishing op chains from value arrays:**

A YAML sequence is treated as a **sequential ops list** if every element is a string beginning with `+{`, `-{`, or `/{`. Otherwise it is treated as a **value replacement** (sets the field to that array).

An empty sequence `[]` is always an ops list (no ops = no change, not an empty array).

```yaml
# Op sequence — every element starts with op prefix
description:
  - "/{She}/{He}"
  - "+{addendum}"

# Value array — plain strings → replaces field with this array
keywords:
  - inquisitive
  - polite
  - compassionate
```

---

## Subfield Operations

Apply operations to specific subfields within a nested mapping. Other subfields are untouched.

```yaml
body:
  Physical Traits:
    gender: male              # replace subfield
    hair: -{in a bun}         # remove substring in subfield
    eyes: "+{, with a faint glow}"   # append to subfield
    other: ~                  # remove subfield
```

---

## Full Example

```yaml
variants:
  veteran:
    body:
      Tagline: knight; veteran swordsman                  # replace
      Apprentice Status:                                   # remove field
      Background: +{Retired after the Siege of Greymoor.} # append
      Physical Traits:
        hair: -{, braided}                                 # remove substring
      Personality:
        expanded: /{leads from behind}/{leads from the front} # swap
      Notes:
        - "/{Journeyman}/{Master}"                         # chained ops
        - "+{; decorated veteran}"
      Magic:
        affinity: high fire-affinity                       # replace subfield
        effect: ~                                          # remove subfield
```
