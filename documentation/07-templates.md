# Templates & Partials

Templates are plain-text files that control how a card's fields are rendered to markdown. Any template syntax works inside a template: field references, render functions, conditionals, and partial includes.

---

## File Naming

| Extension | Purpose |
|---|---|
| `TypeName.template` | Renders cards whose `render.template` or `aid.type` matches `TypeName` (case-insensitive) |
| `PartialName.partial` | Reusable fragment, included with `{include PartialName}` |

Templates and partials are loaded recursively from directories listed in `structure.input.templates`. When multiple directories are configured, later directories override earlier ones on name collision. Duplicates within the same directory are an error.

---

## Card Data in Templates

Templates receive a card context with these top-level keys:

| Key | Accessed as |
|---|---|
| `id` | `{$id}` |
| `name` | `{$name}` (full name), `{$name.display}`, `{$name.full}` |
| `pronouns` | `{$pronouns}` |
| `aid` | `{$aid.type}`, `{$aid.title}`, `{$aid.triggers}`, `{$aid.encapsulate}`, `{$aid.known}` |
| `render` | `{$render.template}`, `{$render.wrapper}` |
| `body` | `{$body.FieldName}`, `{$body.Nested.sub}` |
| `v` | `{$v.key}` — also accessible as `{$var.key}`, `{$vars.key}`, `{$variable.key}`, `{$variables.key}` |

Body fields are matched case-insensitively. Missing fields silently resolve to empty string.

---

## Variable Interpolation

```
{$name}                           full name; use {$name.display} for first-word short form
{$aid.title}                      aid block field
{$aid.triggers}                   aid triggers (array → bullet list when used directly)
{$body.Tagline}                   body field
{$body.Physical Traits.gender}    nested body subfield
{$v.affiliation}                  card variable (also: {$var.affiliation}, {$vars.affiliation}, etc.)
```

When a field holds an array or mapping and you use it directly with `{$body.Field}`, it renders using the same logic as `{list(...)}`: a single element renders inline (`- value`), while two or more elements render as a bullet list preceded by a newline. Use `{join(...)}`, `{and(...)}`, `{keys(...)}`, or `{inline(...)}` when you need a different format.

---

## Render Functions

### `{join("sep", $ref1, $ref2, ...)}`

Joins present values with a separator. Missing or empty values are omitted — no double separators.

The separator can be quoted with double quotes, single quotes, or backticks — all three forms are equivalent:

```
{join("; ", $body.Physical Traits.gender, $body.Physical Traits.age, $body.Physical Traits.hair)}
{join('; ', $body.Physical Traits.gender, $body.Physical Traits.age, $body.Physical Traits.hair)}
{join(`; `, $body.Physical Traits.gender, $body.Physical Traits.age, $body.Physical Traits.hair)}
→  female; mid 20s; black hair, braided, waist-length

{join(", ", $aid.triggers)}
→  Aness, Rozen
```

When a ref resolves to an array, all its elements are spread into the join list. You can mix array refs with scalar refs in a single call.

### `{list($body.items)}`

Renders a YAML array or mapping as a bulleted list. Also the default behavior when referencing an array or mapping field directly with `{$body.Field}`. When passed a plain string, outputs the string unchanged.

**Single-element** arrays render as the bare value with no bullet and no leading newline, so `Heading: {list($field)}` stays on one line:

```
{list($body.Personality.keywords)}   ← single element
→  inquisitive
```

**Multi-element** arrays prepend a newline before the first bullet. This means `Heading: {list($field)}` and the block form produce identical output:

```
Heading: {list($body.Personality.keywords)}
→  Heading:
   - inquisitive
   - polite
   - sarcastic
   - compassionate
```

For a mapping, the values are listed as bullets using the same single/multi-element rule.

```
{list($body.Physical Traits)}
→  - female
   - mid 20s
   - black hair, braided, waist-length
```

### `{and($body.items)}`

Joins array elements with natural-language "and":

- 1 element: `a`
- 2 elements: `a and b`
- 3+ elements: `a, b, and c`

```
{and($body.Personality.keywords)}
→  inquisitive, polite, sarcastic, and compassionate
```

### `{prose($body.items)}`

Renders each array element as a sentence: capitalizes first letter, ensures it ends with a period, joins with spaces.

```
{prose($body.Background)}
→  A journeyman healer. Assigned to the Zenus project.
```

### `{block($body.items)}`

Renders each array element on its own line with no prefix. For a plain string, outputs the string unchanged.

```
{block($body.Magic.effect)}
→  water whip attacks
   minor water shields
   small healing spells
```

### `{keys($body.mapping)}`

Renders a mapping as `key: value` pairs, one per line.

```
{keys($body.Physical Traits)}
→  gender: female
   age: mid 20s
   hair: black hair, braided, waist-length
```

### `{inline($body.mapping)}`

Space-joins all values of a mapping. Useful for collapsing a mapping into a single line.

```
{inline($body.Physical Traits)}
→  female mid 20s black hair, braided, waist-length brown eyes tall, willowy build
```

---

## Render Functions in Card Body Fields

Render functions also work inside card body field values (not just inside template files). This is useful when a computed value needs to be reused across multiple templates, stored in a body field for cross-card reference, or built from other body subfields.

```yaml
body:
  head: "{join('; ', $body.Physical Traits.gender, $body.Physical Traits.hair, $body.Physical Traits.eyes)}"
  build_summary: "{and($body.build_list)}"
```

The pass runs after cross-card refs are resolved (`{$Id.body.Field}` has already been substituted) and before the pronoun pass, so pronoun tokens (`{$she}`, `{$Id}`) embedded inside a field value are left alone and resolved in the normal pronoun pass.

**What is supported:**

| Token | Supported |
|---|---|
| `{join(...)}` | ✓ |
| `{list(...)}` | ✓ |
| `{and(...)}` | ✓ |
| `{prose(...)}` | ✓ |
| `{block(...)}` | ✓ |
| `{keys(...)}` | ✓ |
| `{inline(...)}` | ✓ |
| `{$body.X}` (field ref) | ✓ (via field interpolation, earlier pass) |
| `{$she}`, `{$Id}`, pronoun tokens | ✗ (left for the pronoun pass) |
| `{if ...}` conditionals | ✗ (template-only) |

Render function errors in body fields emit a warning and leave the original token intact.

---

## Conditionals

```
{if $body.Background}
Background:
{$body.Background}
{/if}
```

With optional else:

```
{if $aid.known}notes: [e]{else}notes: \]{/if}
```

**Falsy values:** a field is falsy if it is missing, an empty string, the string `"false"`, the string `"0"`, an empty array, or an empty mapping. Everything else is truthy.

Conditionals are processed innermost-first and support nesting.

---

## Wrapper Blocks

The `{wrapper}...{/wrapper}` block wraps its content according to the card's `render.wrapper` value:

```
{wrapper}
triggers: [{join(", ", $aid.triggers)}]
encapsulate: {$aid.encapsulate}
{/wrapper}
```

| `render.wrapper` | Effect |
|---|---|
| `none` (default) | Content rendered as-is |
| `square` | `[\ncontent\n]` |
| `curly` | `{\ncontent\n}` |

If no `{wrapper}` block is used and the card has a non-`none` wrapper, the wrapper is applied to the entire rendered output automatically (unless it already starts with the corresponding bracket).

---

## Partials

Partials are reusable fragments included into templates (or other partials) with `{include PartialName}`. The name is matched case-insensitively against the `.partial` filename (without extension).

```
{include CardHeader}
```

Partial content sees the same card data as the outer template. Partials can include other partials to any depth; circular includes are detected and raise an error.

```
# CardHeader.partial
## {$aid.title}
~~~
triggers: [{join(", ", $aid.triggers)}]
{if $aid.encapsulate}encapsulate: {$aid.encapsulate}
{/if}{if $aid.known}notes: [e]
{/if}~~~
```

---

## Literal Escapes

| Sequence | Output |
|---|---|
| `{{` | `{` |
| `}}` | `}` |

Use these when you need a literal `{` or `}` in output that would otherwise be parsed as a template expression. Square brackets (`[` `]`) have no special meaning and do not need escaping.

---

## Variable and Component References

Variables declared in `compile.yaml` are available in templates as `{%key}`:

```
Setting: {%setting}
Year: {%year}
```

Component key references (`{@name}`) expand to a file path or file contents and are pre-expanded before template rendering.

---

## Whitespace Normalization

After rendering, the output is normalized:

- Tabs are stripped
- All blank lines are removed (runs of 2+ newlines collapsed to one)
- Leading/trailing whitespace from every line is trimmed
- Consecutive spaces within lines are deduplicated
- Leading/trailing whitespace from the whole document is trimmed

To protect a block of content from normalization — keeping its blank lines and exact spacing intact — wrap it in `{preserve}...{/preserve}`:

```
{preserve}
line one

line two (blank line above is kept)
{/preserve}
```

The `{preserve}` and `{/preserve}` tags are stripped from the output; only the inner content is emitted.

---

## Example Template

```
{include CardHeader}
{$aid.title} - {join("; ", $body.Tagline)}
Physical Traits: {join("; ", $body.Physical Traits.gender, $body.Physical Traits.age, $body.Physical Traits.hair, $body.Physical Traits.eyes, $body.Physical Traits.build, $body.Physical Traits.other)}
Personality: {join(", ", $body.Personality.keywords)}
{if $body.Personality.expanded}{$body.Personality.expanded}
{/if}{if $body.Magic}Magic: {join("; ", $body.Magic.affinity, $body.Magic.effect)}
{/if}{if $body.Background}Background:
{$body.Background}
{/if}
```

With `CardHeader.partial`:

```
## {$aid.title}
~~~
triggers: [{join(", ", $aid.triggers)}]
{if $aid.encapsulate}encapsulate: {$aid.encapsulate}
{/if}{if $aid.known}notes: [e]
{/if}~~~
```
