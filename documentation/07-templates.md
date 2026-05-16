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
| `name` | `{$name}` (display name), `{$name.display}`, `{$name.full}` |
| `pronouns` | `{$pronouns}` |
| `aid` | `{$aid.type}`, `{$aid.title}`, `{$aid.triggers}`, `{$aid.encapsulate}`, `{$aid.known}` |
| `render` | `{$render.template}`, `{$render.wrapper}` |
| `body` | `{$body.FieldName}`, `{$body.Nested.sub}` |

Body fields are matched case-insensitively. Missing fields silently resolve to empty string.

---

## Variable Interpolation

```
{$name}                           top-level card field (display name for name objects)
{$aid.title}                      aid block field
{$aid.triggers}                   aid triggers (array → "; " joined when used directly)
{$body.Tagline}                   body field
{$body.Physical Traits.gender}    nested body subfield
```

When a field holds an array and you use it directly with `{$body.Field}`, elements are joined with `"; "`. Use `{join(...)}` or `{list(...)}` for explicit formatting.

When a field holds a mapping (nested object) and you use it directly with `{$body.Field}`, only the first value is returned. Use `{keys(...)}` or `{inline(...)}` for mappings.

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

Renders a YAML array as a bulleted list, one `- item` line per element. When passed a plain string instead of an array, outputs the string unchanged (for backwards compatibility with block scalars).

```
{list($body.Personality.keywords)}
→  - inquisitive
   - polite
   - sarcastic
   - compassionate
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
| `[[` | `[` |
| `]]` | `]` |

Use these when you need literal braces or brackets in output that would otherwise be parsed as template syntax.

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
- Runs of blank lines are collapsed to a single blank line
- Leading/trailing whitespace from the whole document is trimmed
- Consecutive spaces within lines are deduplicated

Content inside `[square bracket blocks]` is preserved as-is (brackets are a common AID format feature).

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
