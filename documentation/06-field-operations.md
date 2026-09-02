# Field Operations

Field operations are used in `variants:` deltas, `importVariants:` chains, and `body:` overrides on imports. They let you make targeted changes to an item's fields without replacing the entire value.

All string matching within operations is **case-sensitive** for the content of the operation itself (the substring to find/replace), but field **key** matching is always case-insensitive.

---

## Operations Reference

### Replace

Assign a new value directly. Replaces the field entirely.

```yaml surface=item
body:
  Tagline: count of monwynd, shadow mage
```

### Remove Field

Set the field to `null` (empty value or explicit `~`). Removes the field entirely from the item.

```yaml surface=item
body:
  Magic:               # empty value — removes the Magic field
  alternate form: ~    # explicit null — equivalent
```

### Append — `+{value}`

Appends a value to a field. **What that produces depends on what the field already holds:**

- **Empty or absent** — the value is set as a plain scalar; no array is created
- **A non-empty string or block scalar** — the result is `[existing, value]`
- **Already an array** — the value is appended as a new element: `[...existing, value]`
- **A mapping** — the mapping is flattened to its values, and the value is appended to that list; the keys are lost. See [Subfield Operations](#subfield-operations)

**Appending can change a field's shape, and that changes how it renders.** A scalar becomes a list, and a bare `{$body.Field}` does not join a list — see [Templates & Partials](07-templates.md#variable-interpolation) for what each form emits and how to get a single line instead.

```yaml surface=item
body:
  Tagline: +{retired}
  Background: +{Recently returned from exile.}
```

Appending to a non-empty string produces a two-element array:

```yaml transform=field-op id=op-append-scalar
current: count of monwynd, shadow mage
op: "+{retired}"
```

```yaml expect=op-append-scalar
- count of monwynd, shadow mage
- retired
```

Do not put a leading separator in the appended value — the separator is added by the template, not the operation.

### Remove Substring — `-{text}`

Removes all occurrences of the substring from the field value. Result is trimmed.

```yaml surface=item
body:
  Physical Traits:
    hair: -{in a controlled bun}
```

```yaml transform=field-op id=op-remove-substring
current: platinum blond hair in a controlled bun
op: "-{in a controlled bun}"
```

```yaml expect=op-remove-substring
platinum blond hair
```

### Swap Substring — `/{old}/{new}`

Replaces all occurrences of `old` with `new`. Result is trimmed.

```yaml surface=item
body:
  Background: /{her}/{his}
```

```yaml transform=field-op id=op-swap-substring
current: she built her reputation
op: "/{her}/{his}"
```

```yaml expect=op-swap-substring
she built his reputation
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

```yaml surface=item
body:
  description:
    - "/{She}/{He}"
    - "/{she}/{he}"
    - "/{her}/{his}"
```

When an op chain includes `+{…}`, the append converts the intermediate value to an array. Subsequent swap ops map element-wise over the array:

```yaml surface=item
body:
  title:
    - "+{Guild Certified}"
    - "/{Swordsman}/{Archer}"
```

```yaml transform=field-op id=op-chain-append-swap
current: Master Swordsman
op:
  - "+{Guild Certified}"
  - "/{Swordsman}/{Archer}"
```

```yaml expect=op-chain-append-swap
- Master Archer
- Guild Certified
```

### Distinguishing op sequences from value arrays

A YAML sequence in a variant is treated as a **value replacement** (sets the field to that array) unless every element is a string beginning with `+{`, `-{`, or `/{` — in which case it is treated as a sequential ops list.

An empty sequence `[]` is always treated as an ops list (no ops = no change, not an empty array replacement).

```yaml check=none reason=body-field-fragment
# Op sequence — every element starts with an op prefix
description:
  - "/{She}/{He}"
  - "+{addendum}"
```

```yaml check=none reason=body-field-fragment
# Value array — plain strings; replaces the field with this array
keywords:
  - inquisitive
  - polite
  - compassionate
```

---

## Subfield Operations

Apply an operation to a specific subfield within a nested mapping. Other subfields are not affected.

```yaml surface=item
body:
  Physical Traits:
    gender: male          # replace this subfield only
    hair: -{in a bun}     # remove substring in this subfield only
    other:                # remove this subfield only (empty value)
```

**Aim a string op at the mapping itself and it collapses into a list.** `hair: -{…}` targets a subfield and is what you want; `Physical Traits: -{…}`, with the op one level up, flattens the whole mapping to its values, discards every key, and leaves an array behind:

```yaml surface=item
body:
  Physical Traits: -{grey}
```

```yaml transform=field-op id=op-mapping-collapse
current: { hair: platinum blond, eyes: grey, height: tall }
op: "-{grey}"
```

```yaml expect=op-mapping-collapse
- platinum blond
- tall
```

There is no diagnostic for this. Operations against a mapping belong on its subfields, one level in.

You can mix operations and replacements within the same mapping block:

```yaml surface=item
body:
  Physical Traits:
    gender: male
    hair: -{long }
    eyes: "+{, with a faint glow}"
    other: ~
```

---

## Examples

```yaml surface=item
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
