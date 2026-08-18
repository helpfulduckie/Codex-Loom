# Templates & Partials Reference

Templates are plain-text files controlling how an item's fields are rendered to markdown.

---

## File Naming

| Extension | Purpose |
|---|---|
| `TypeName.template` | Renders items whose `render.template` or `aid.type` matches `TypeName` (case-insensitive) |
| `PartialName.partial` | Reusable fragment, included with `{include PartialName}` |

Templates loaded recursively from `structure.input.templates` directories. Later directories override earlier on name collision. Duplicates within the same directory are an error.

---

## Item Data Available in Templates

| Key | Accessed as |
|---|---|
| `id` | `{$id}` |
| `name` | `{$name}` (display name), `{$name.display}`, `{$name.full}` |
| `pronouns` | `{$pronouns}` |
| `aid` | `{$aid.type}`, `{$aid.title}`, `{$aid.triggers}` |
| `render` | `{$render.template}`, `{$render.wrapper}`, `{$render.storyCard}` |
| `body` | `{$body.FieldName}`, `{$body.Nested.sub}` |

Body fields matched case-insensitively. Missing fields resolve to empty string.

---

## Variable Interpolation

```
{$body.Tagline}                     body field
{$body.Physical Traits.gender}      nested body subfield
{$aid.title}                        aid block field
{$aid.triggers}                     aid triggers array ("; " joined when used directly)
{%setting}                          compile.yaml variable
%heroName%                          player placeholder — passes through to the player
```

An array field used directly via `{$body.Field}` joins elements with `"; "`. A mapping field used directly returns the first value only.

---

## Render Functions

### `{join("sep", $ref1, $ref2, ...)}`
Joins present values with separator. Missing/empty values omitted. Separator can be `"..."`, `'...'`, or `` `...` ``.

```
{join("; ", $body.Physical Traits.gender, $body.Physical Traits.age, $body.Physical Traits.hair)}
→ female; mid 20s; black hair, braided, waist-length

{join(", ", $aid.triggers)}
→ Aness, Rozen
```

Array refs are spread into the join list. Mix array and scalar refs freely.

### `{list($body.items)}`
Renders YAML array as bulleted list (`- item` per line). Plain string → output unchanged.

### `{and($body.items)}`
Natural-language "and": 1 element → `a`; 2 → `a and b`; 3+ → `a, b, and c`.

### `{prose($body.items)}`
Each element: capitalize + ensure ends with period + join with spaces.

### `{block($body.items)}`
Each element on its own line, no prefix. Plain string → unchanged.

### `{keys($body.mapping)}`
Renders mapping as `key: value` pairs, one per line.

### `{inline($body.mapping)}`
Space-joins all values of a mapping into a single line.

---

## Player Placeholders in Templates

**A template is not a destination — the text it renders is.** `%heroName%` passes through the template engine untouched and is judged wherever that output lands, so one template can be legal in one place and an ERROR in another. A `Character.template` used for a story card is fine; the same text reaching a Description is `CL0533`.

**Where the rendered text may carry a placeholder:**

| Lands in | Verdict |
|---|---|
| A story card's entry, name, triggers or notes | Works |
| Plot Essentials, Summary, AI Instructions, Author Notes, Opening | Works |
| A card's `type` — which `aid.type` also selects the template by | **ERROR** `CL0533` |
| The Description | **ERROR** `CL0533` |

**Do not put a placeholder in `aid.type`.** It is a category in AID and a folder name in the compiled tree, and it is also what picks the template when `render.template` is absent — so a placeholder there fails to match any template as well as never being filled.

**Placeholders are declared in `compile.yaml`, never in a template.** A `%key%` a template emits must be declared on every branch that renders it, or it is `CL0532`. See `references/compile-yaml.md` → Player Placeholders.

**`{%setting}` and `%setting%` are not the same token.** The first is a compile-time variable resolved into the output; the second is a question asked of the player. Templates commonly use the first.

---

## Render Functions in Body Fields

Render functions work inside item body field values:

```yaml
body:
  head: "{join('; ', $body.Physical Traits.gender, $body.Physical Traits.hair)}"
```

Resolved after field interpolation and cross-item refs, before the pronoun pass. Pronoun tokens inside body values (`{$she}`, `{$Aness}`) are left for the pronoun pass. Conditionals (`{if}`) are template-only and not supported in body fields.

---

## Conditionals

```
{if $body.Background}
Background:
{$body.Background}
{/if}

{if $body.Secret}notes: hidden{else}notes: open{/if}
```

**Falsy:** missing, empty string, `"false"`, `"0"`, empty array, empty mapping. Everything else truthy.

Conditionals are processed innermost-first and support nesting.

---

## Wrapper Blocks

```
{wrapper}
triggers: [{join(", ", $aid.triggers)}]
{/wrapper}
```

| `render.wrapper` | Effect |
|---|---|
| `none` (default) | Content rendered as-is |
| `square` | `[\ncontent\n]` |
| `curly` | `{\ncontent\n}` |

If no `{wrapper}` block is used, the wrapper is applied to the entire rendered output automatically.

---

## Partials

```
{include CardHeader}
```

Matched case-insensitively against `.partial` filename. Partial sees the same item data. Circular includes are detected and raise an error.

---

## Literal Escapes

| Sequence | Output |
|---|---|
| `{{` | `{` |
| `}}` | `}` |
| `[[` | `[` |
| `]]` | `]` |

---

## Whitespace Normalization

After rendering:
- Tabs stripped
- Runs of blank lines collapsed to one
- Leading/trailing whitespace trimmed
- Consecutive spaces deduplicated
- Content inside `[square bracket blocks]` preserved as-is

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

**CardHeader.partial:**
```
## {$aid.title}
~~~
triggers: [{join(", ", $aid.triggers)}]
~~~
```
