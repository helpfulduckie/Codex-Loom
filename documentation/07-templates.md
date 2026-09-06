# Templates & Partials

Templates are plain-text files that control how an item's **body** is rendered to markdown. Any template syntax works inside a template: field references, render functions, conditionals, and partial includes.

> **A text template is the escape hatch, not the default.** The primary authoring surface is a field declaration — see [Field Declarations](10-field-declarations.md). A field list is not a second renderer: it *generates* the `.template` source each declaration is shorthand for and hands it to the engine documented here, so everything below is true of both.

## What Still Needs a Text Template

A field declaration expresses the great majority of stanza shapes; on the corpus this design was drawn from it covered fifteen of the eighteen distinct shapes. The remainder:

- **A notes template that reads `$notes` rather than `$body`** and is not a card body at all.
- **A long block of mod configuration** — dozens of literal `Key: Value` lines with no relationship to item fields.
- **A line mixing a top-level token with an inline conditional suffix**, where the conditional is part of the value rather than a guard around the stanza.

**Before writing a whole `.template`, try the in-list escapes.** A field list can carry an irregular line with `{ include: partialName }`, a literal with `{ raw: "…" }`, or opt out of the unread-field audit with `{ allowExtra: true }`.

---

## Templates Render the Body, Not the Envelope

A compiled story card has two parts, and a template is responsible for exactly one of them.

```
## Aness Rozen                      ← the envelope: Codex Loom writes this
~~~
triggers: [Aness, Rozen]
encapsulate: false
notes: '[e]'
~~~
Aness Rozen - Journeyman Healer     ← the body: your template writes this
Personality: inquisitive, polite
```

The heading, the `~~~` fence and the three keys inside it come from the compiler, from one place — its Velvet Lattice emitter. A template that writes any of them produces a **second** envelope inside the body, where the Velvet Lattice loader will never read its keys — so a `~~~` anywhere in a `.template` or `.partial` is a load-time ERROR (`CL0410`) naming the file, not a warning.

What the compiler decides, and from what:

| Envelope line | Comes from |
|---|---|
| `## Heading` | `aid.title`, then `name.full`, then `name.display`, then `id` — the first that is set |
| `triggers: [...]` | `aid.triggers`, with `_` padding decoded and quoting added only where a value needs it. Omitted when the item has none |
| `encapsulate: false` | Always. Not author-controlled |
| `notes: ...` | `notes:` on the item, rendered through a notes template when one resolves. Omitted when the text is empty |

---

## File Naming

| Extension | Purpose |
|---|---|
| `TypeName.template` | Renders items whose `render.template` or `aid.type` matches `TypeName` (case-insensitive) |
| `PartialName.partial` | Reusable fragment, included with `{include PartialName}` |

A template that renders an item's `notes:` field is a `.template` like any other, selected by `render.notesTemplate` on the item or `templateFor.notes` in `compile.yaml` — see [Item YAML → Rendering notes through a template](03-item-yaml.md) for the resolution order.

Templates and partials are loaded recursively from directories listed in `structure.input.templates`. When multiple directories are configured, later directories override earlier ones on name collision. Duplicates within the same directory are an error.

**A `.template` sits at the last rung of every resolution ladder**, after a chosen `render.template` and after `templateFor`. The same directories also hold `fields.cl.yaml` field tables, which merge key-wise per entry rather than being replaced per file. See [Field Declarations → `templateFor`](10-field-declarations.md#templatefor--selecting-lists-per-branch).

---

## Item Data in Templates

Templates receive an item context with these top-level keys:

| Key | Accessed as |
|---|---|
| `id` | `{$id}` |
| `name` | `{$name}` (full name), `{$name.display}`, `{$name.full}` |
| `pronouns` | `{$pronouns}` |
| `aid` | `{$aid.type}`, `{$aid.title}`, `{$aid.triggers}` |
| `render` | `{$render.template}`, `{$render.wrapper}` |
| `body` | `{$body.FieldName}`, `{$body.Nested.sub}` |
| `notes` | `{$notes}`, or `{$notes.key}` when it holds a mapping |
| `v` | `{$v.key}` — also accessible as `{$var.key}`, `{$vars.key}`, `{$variable.key}`, `{$variables.key}` |

Body fields are matched case-insensitively. A field ref that resolves to nothing renders as empty string. Dotted field refs (`{$body.X}`, `{$v.X}`, `{$aid.X}`, `{$render.X}`, `{$name.X}`) also resolve inside item `aid`/`render`/`name` fields, not just `body` — bare single-segment `{$X}` stays in the pronoun/character-ref namespace. A `{$…}` token that survives unresolved into final output is `CL0430`, an **ERROR** that fails the build (a literal field-ref miss in a *template* still renders empty and is not flagged).

---

## Variable Interpolation

```
{$name}                           full name; use {$name.display} for first-word short form
{$aid.title}                      aid block field
{$aid.triggers}                   aid triggers (array → bullet list when used directly)
{$body.Tagline}                   body field
{$body.Physical Traits.gender}    nested body subfield
{$v.affiliation}                  item variable (also: {$var.affiliation}, {$vars.affiliation}, etc.)
```

When a field holds an array or mapping and you use it directly with `{$body.Field}`, it renders using the same logic as `{list(...)}`: a single element renders as the bare value, with no bullet and no leading newline, while two or more elements render as a bullet list preceded by a newline. Use `{join(...)}`, `{and(...)}`, `{keys(...)}`, or `{inline(...)}` when you need a different format.

---

## Render Functions

### `{join("sep", $ref1, $ref2, ...)}`

Joins present values with a separator. Missing or empty values are omitted — no double separators.

The separator can be quoted with double quotes, single quotes, or backticks — all three forms are equivalent.

```text transform=render-template context=aness id=fn-join
{join("; ", $body.Physical Traits.gender, $body.Physical Traits.age, $body.Physical Traits.hair)}
```

``` expect=fn-join
female; mid 20s; black hair, braided, waist-length
```

A ref that resolves to an array spreads all its elements into the join list, and you can mix array refs with scalar refs in one call:

```text transform=render-template context=aness id=fn-join-array
{join(", ", $aid.triggers)}
```

``` expect=fn-join-array
Aness, Rozen
```

### `{list($body.items)}`

Renders a YAML array or mapping as a bulleted list. Also the default behavior when referencing an array or mapping field directly with `{$body.Field}`. When passed a plain string, outputs the string unchanged.

**Single-element** arrays render as the bare value with no bullet and no leading newline, so `Heading: {list($field)}` stays on one line:

```text transform=render-template context=aness-min id=fn-list-single
{list($body.Personality.keywords)}
```

``` expect=fn-list-single
inquisitive
```

**Multi-element** arrays prepend a newline before the first bullet. This means `Heading: {list($field)}` and the block form produce identical output:

```text transform=render-template context=aness id=fn-list-multi
Heading: {list($body.Personality.keywords)}
```

``` expect=fn-list-multi
Heading:
- inquisitive
- polite
- sarcastic
- compassionate
```

For a mapping, the values are listed as bullets using the same single/multi-element rule.

```text transform=render-template context=aness id=fn-list-mapping
{list($body.Physical Traits)}
```

``` expect=fn-list-mapping
- female
- mid 20s
- black hair, braided, waist-length
- brown eyes
- tall, willowy build
```

### `{and($body.items)}`

Joins array elements with natural-language "and":

- 1 element: `a`
- 2 elements: `a and b`
- 3+ elements: `a, b, and c`

```text transform=render-template context=aness id=fn-and
{and($body.Personality.keywords)}
```

``` expect=fn-and
inquisitive, polite, sarcastic, and compassionate
```

### `{prose($body.items)}`

Renders each array element as a sentence: capitalizes first letter, ensures it ends with a period, joins with spaces.

```text transform=render-template context=aness id=fn-prose
{prose($body.Background)}
```

``` expect=fn-prose
A journeyman healer. Assigned to the Zenus project.
```

### `{block($body.items)}`

Renders each array element on its own line with no prefix. For a plain string, outputs the string unchanged.

```text transform=render-template context=aness id=fn-block
{block($body.Magic.effect)}
```

``` expect=fn-block
water whip attacks
minor water shields
small healing spells
```

### `{keys($body.mapping)}`

Renders a mapping as `key: value` pairs, one per line, each prefixed with `- `.

```text transform=render-template context=aness id=fn-keys
{keys($body.Physical Traits)}
```

``` expect=fn-keys
- gender: female
- age: mid 20s
- hair: black hair, braided, waist-length
- eyes: brown eyes
- build: tall, willowy build
```

### `{inline($body.mapping)}`

Space-joins all values of a mapping. Useful for collapsing a mapping into a single line.

```text transform=render-template context=aness id=fn-inline
{inline($body.Physical Traits)}
```

``` expect=fn-inline
female mid 20s black hair, braided, waist-length brown eyes tall, willowy build
```

---

## Render Functions in Item Body Fields

Render functions also work inside item body field values (not just inside template files). This is useful when a computed value needs to be reused across multiple templates, stored in a body field for cross-item reference, or built from other body subfields.

```yaml surface=item
body:
  head: "{join('; ', $body.Physical Traits.gender, $body.Physical Traits.hair, $body.Physical Traits.eyes)}"
  build_summary: "{and($body.build_list)}"
```

The pass runs after cross-item refs are resolved (`{$Id.body.Field}` has already been substituted) and before the pronoun pass, so pronoun tokens (`{$she}`, `{$Id}`) embedded inside a field value are left alone and resolved in the normal pronoun pass.

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

A render function that fails to evaluate inside a body field is `CL0413`, an **ERROR**, and the original token is left in the field text — so it also reaches the output sweep as a leaked artifact.

---

## Conditionals

```text transform=render-template context=aness id=cond-guard
{if $body.Background}
Background:
{$body.Background}
{/if}
```

``` expect=cond-guard
Background:
- a journeyman healer
- assigned to the Zenus project
```

With optional else:

```text transform=render-template context=aness id=cond-else
{if $body.Secret}{$body.Secret}{else}Nothing hidden here.{/if}
```

``` expect=cond-else
Nothing hidden here.
```

**Falsy values:** a field is falsy if it is missing, empty or whitespace-only, the string `"false"`, the string `"0"`, or an array or mapping whose members are recursively empty. Empty aggregate members are omitted before rendering; a non-empty aggregate remains present, including one containing `false` or `0`. Everything else is truthy.

Conditionals nest to any depth. The template is parsed into a tree, so each `{if}` is matched to its own `{/if}` by the parser rather than by repeated text substitution; an `{if}` whose closer never arrives is `CL0415`, and the unmatched tag renders as literal text.

---

## Wrapper Blocks

The `{wrapper}...{/wrapper}` block wraps its content according to the item's `render.wrapper` value:

```
{wrapper}
{$name.full} - {$body.Tagline}
Personality: {join(", ", $body.Personality.keywords)}
{/wrapper}
```

The wrapper applies to the body only. The envelope is written outside it, so a wrapped card reads `~~~` and then `{`, never the other way around.

| `render.wrapper` | Effect |
|---|---|
| `none` (default) | Content rendered as-is |
| `square` | `[\ncontent\n]` |
| `curly` | `{\ncontent\n}` |

If no `{wrapper}` block is used and the item has a non-`none` wrapper, the wrapper is applied to the entire rendered output automatically.

**There is no already-wrapped guard.** A template that writes its own `[` … `]` *and* an item carrying `wrapper: square` produce a doubly-wrapped body — `[\n[\n…\n]\n]` — with no diagnostic. Either write the brackets in the template and leave `render.wrapper` at `none`, or use a `{wrapper}` block and let the item decide.

---

## Partials

Partials are reusable fragments included into templates (or other partials) with `{include PartialName}`. The name is matched case-insensitively against the `.partial` filename (without extension).

```
{include Appearance}
```

Partial content sees the same item data as the outer template. Partials can include other partials to any depth; circular includes are detected and raise an error.

```
# Appearance.partial
{if $body.Physical Traits}Physical Traits: {join("; ", $body.Physical Traits.gender, $body.Physical Traits.age, $body.Physical Traits.hair)}
{/if}
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

`{%key}` is expanded at the start of template rendering (and in item body fields before rendering), so it can appear anywhere in template or item content.

Component key references (`{%name}`) are **not** expanded in templates or item bodies. They are resolved only in path/prose contexts — `compile.yaml` config paths (library, templates, components), component specs, `include:` paths, opening prose, and description config. Do not use `{%name}` inside an item `body:` or a `.template`; it will be emitted verbatim. See the comparison below.

---

## Token Systems at a Glance

Codex Loom has two compile-time token families. `{%}` is the *path/value* family covered here; `{$…}` is the *field-reference* system documented earlier in this file.

| Token | Name | Declared in | Resolves to | Available in |
|---|---|---|---|---|
| `{%key}` | Compile variable | `compile.yaml` `variables:` (root + per-branch), and every `structure.input.library` name | a string value (recursive, cycle-detected; ERROR if undeclared) | item `id`/`name`/`body`/`aid`/`render` (string values), templates, opening prose, component specs, config paths, `include:` paths, branch `title`/`protagonist` |
| `{$v.key}` / `{$Id.body.field}` | Field reference | an item's `v:` block / another item's fields | an item field value | templates, and item `body`/`aid`/`render`/`name` fields (the `{$…}` interpolation + cross-item + pronoun passes) |

**Library names are auto-exposed as `{%}` variables**, so `{%characters}/Aness.yaml` resolves against a path declared under `structure.input`. That is the only naming system for these references. A library name colliding with a declared variable is an ERROR (`CL0521`), since the two share a namespace.

**Scope caveat:** `{%}` in `include:`/`import:` paths uses **root** `variables:` only — includes resolve once, before branches are enumerated, so per-branch variable overrides are not in scope there. Everywhere else `{%}` uses the full root → branch merge.

**`aid`/`render` expansion:** `{%}` expands in `aid` (e.g. `title`, `triggers`) and `render` (e.g. `template`, `wrapper`) string values, so template/type selection can be variable-driven. Only strings are touched — numeric and boolean fields such as `render.position` are left as-is.

**`aid.type` validation:** because `aid.type` becomes both a folder and a filename (`Story Cards/{type}/{type}.md`), it is validated *after* expansion. An illegal path segment (`< > : " / \ | ? *`, control chars, `.`/`..`, or a trailing space/period) **aborts the compile** with an error naming the item and type. Spaces elsewhere are fine.

**Unexpanded-variable warning:** as a final safety net, every rendered story card and component output is scanned for any leftover `{%…}` token; each distinct one emits a `WARN: unexpanded variable {%x} in …`. This is `{%}`-only. An *undeclared* variable therefore produces two complementary messages: `"{%x}" not declared` at expansion and the residual warning at output.

**`{$…}` family scope:** it is a separate system from `{%}`, resolving in `body`/`aid`/`render`/`name` fields, accepting dotted field refs in item data, and warning once on any token that survives to output. One naming overlap is worth watching: `variable`/`variables` name *both* the `{%}` declaration intent (`compile.yaml` `variables:`) and the item-level `v:` block (`{$variables.key}`).

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

## Diagnostics

Template diagnostics all report through the render bus. Most name the template file; malformed render-function calls inside a card body field name the item but carry no line.

| Code | Severity | Meaning |
|---|---|---|
| `CL0413` | ERROR | A render-function call does not parse (e.g. `{join($body.x)}` is missing its quoted separator). |
| `CL0414` | ERROR | A template uses a function name that is not one of `inline`, `join`, `list`, `and`, `prose`, `block`, or `keys`. |
| `CL0415` | ERROR | An `{if}`, `{wrapper}`, or `{preserve}` block was opened but never closed. The block is emitted as literal text, so the downstream `CL0433` leak sweep may also fire. |
| `CL0416` | ERROR | A partial includes itself, directly or indirectly. The failing directive is replaced with empty text and rendering continues. |
| `CL0417` | ERROR | An `{include NAME}` names a partial that is not loaded. The directive is replaced with empty text and rendering continues. |
| `CL0418` | ERROR | Cross-item render-function references form a genuine cycle (e.g. `A.body.x` expands `B.body.y` and vice versa). Every item and field on the cycle is named. |

---

## Example Template

`Character.template`, in full — no heading, no fence, body only:

```
{wrapper}
{$name.full} - {join("; ", $body.Tagline)}
{include Appearance}
Personality: {join(", ", $body.Personality.keywords)}
{if $body.Personality.expanded}{$body.Personality.expanded}
{/if}{if $body.Magic}Magic: {join("; ", $body.Magic.affinity, $body.Magic.effect)}
{/if}{if $body.Background}Background:
{$body.Background}
{/if}
{/wrapper}
```

With `Appearance.partial`:

```
Physical Traits: {join("; ", $body.Physical Traits.gender, $body.Physical Traits.age, $body.Physical Traits.hair, $body.Physical Traits.eyes, $body.Physical Traits.build, $body.Physical Traits.other)}
```
