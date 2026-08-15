# Templates & Partials

Templates are plain-text files that control how an item's **body** is rendered to markdown. Any template syntax works inside a template: field references, render functions, conditionals, and partial includes.

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

The heading, the `~~~` fence and the three keys inside it come from the compiler, from one place (`src/emit/vl.js`). A template that writes any of them produces a **second** envelope inside the body, where the Velvet Lattice loader will never read its keys — so a `~~~` anywhere in a `.template` or `.partial` is a load-time ERROR (`CL0410`) naming the file, not a warning.

What the compiler decides, and from what:

| Envelope line | Comes from |
|---|---|
| `## Heading` | `aid.title`, then `name.full`, then `name.display`, then `id` — the first that is set |
| `triggers: [...]` | `aid.triggers`, with `_` padding decoded and quoting added only where a value needs it. Omitted when the item has none |
| `encapsulate: false` | Always. Not author-controlled |
| `notes: ...` | `notes:` on the item, rendered through a notes template when one resolves. Omitted when the text is empty |

Two keys that v3 templates read are gone with the envelope: `aid.encapsulate`, because the value is now unconditional, and `aid.known`, which existed only so a template could write `{if $aid.known}notes: '[e]'{/if}`. The marker is `notes:` text now — see [Item YAML](03-item-yaml.md). Declaring either is an unknown-key ERROR.

---

## File Naming

| Extension | Purpose |
|---|---|
| `TypeName.template` | Renders items whose `render.template` or `aid.type` matches `TypeName` (case-insensitive) |
| `TypeName.notes.template` | Renders the `notes:` field of items whose body `TypeName.template` renders |
| `TypeName.hint.template` | Renders the item in `style: hint` Plot Essentials blocks |
| `PartialName.partial` | Reusable fragment, included with `{include PartialName}` |

The two suffixed forms are siblings of a body template, found by name rather than declared: an item rendered by `Character.template` gets `Character.notes.template` for its notes with nothing to configure. See [Item YAML → Rendering notes through a template](03-item-yaml.md) for the full resolution order.

Templates and partials are loaded recursively from directories listed in `structure.input.templates`. When multiple directories are configured, later directories override earlier ones on name collision. Duplicates within the same directory are an error.

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

Body fields are matched case-insensitively. A field ref that resolves to nothing renders as empty string. Dotted field refs (`{$body.X}`, `{$v.X}`, `{$aid.X}`, `{$render.X}`, `{$name.X}`) also resolve inside item `aid`/`render`/`name` fields, not just `body` — bare single-segment `{$X}` stays in the pronoun/character-ref namespace. A `{$…}` token that survives unresolved into final output triggers `WARN: unresolved token {$x} in …` (a literal field-ref miss in a *template* still renders empty and is not flagged).

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

Renders a mapping as `key: value` pairs, one per line, each prefixed with `- `.

```
{keys($body.Physical Traits)}
→  - gender: female
   - age: mid 20s
   - hair: black hair, braided, waist-length
```

### `{inline($body.mapping)}`

Space-joins all values of a mapping. Useful for collapsing a mapping into a single line.

```
{inline($body.Physical Traits)}
→  female mid 20s black hair, braided, waist-length brown eyes tall, willowy build
```

---

## Render Functions in Item Body Fields

Render functions also work inside item body field values (not just inside template files). This is useful when a computed value needs to be reused across multiple templates, stored in a body field for cross-item reference, or built from other body subfields.

```yaml
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
{if $body.Secret}{$body.Secret}{else}Nothing hidden here.{/if}
```

**Falsy values:** a field is falsy if it is missing, an empty string, the string `"false"`, the string `"0"`, an empty array, or an empty mapping. Everything else is truthy.

Conditionals are processed innermost-first and support nesting.

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

If no `{wrapper}` block is used and the item has a non-`none` wrapper, the wrapper is applied to the entire rendered output automatically (unless it already starts with the corresponding bracket).

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

Component key references (`{%name}`) are **not** expanded in templates or item bodies. They are resolved only in path/prose contexts — `compile.yaml` config paths (canon, templates, components), component specs, `include:` paths, opening prose, and description config. Do not use `{%name}` inside an item `body:` or a `.template`; it will be emitted verbatim. See the comparison below.

---

## Token Systems at a Glance

Codex Loom has two compile-time token families. `{%}` is the *path/value* family covered here; `{$…}` is the *field-reference* system documented earlier in this file.

| Token | Name | Declared in | Resolves to | Available in |
|---|---|---|---|---|
| `{%key}` | Compile variable | `compile.yaml` `variables:` (root + per-branch), and every `structure.input.canon` name | a string value (recursive, cycle-detected; ERROR if undeclared) | item `id`/`name`/`body`/`aid`/`render` (string values), templates, opening prose, component specs, config paths, `include:` paths, branch `title`/`protagonist` |
| `{$v.key}` / `{$Id.body.field}` | Field reference | an item's `v:` block / another item's fields | an item field value | templates, and item `body`/`aid`/`render`/`name` fields (the `{$…}` interpolation + cross-item + pronoun passes) |

**There used to be a third: `{@key}`, a named reference declared under `structure.input.components` and `structure.input.canon`.** It is removed in v4, and deleting it cost nothing. Its lookup searched every per-type map in sequence and returned the first name match, so `{@pe}` resolved identically no matter which type declared it — no project could depend on the grouping, because the grouping never worked. Its one behavioral difference was already applied to every component spec downstream, and the declaration subtree duplicated `variables:`: both name a string for reuse.

**Canon names are now auto-exposed as variables**, so `{%characters}/Aness.yaml` does what `{@characters}/Aness.yaml` used to. That leaves one naming system and removes the question *is this a `{%}` thing or a `{@}` thing?* — which had no principled answer, because the two overlapped almost entirely. A canon name colliding with a declared variable is an ERROR (`CL0521`), since the two now share a namespace.

`codex-loom --migrate` rewrites `{@}` references automatically: a canon name changes sigil, and a component alias is replaced by the value it was declared as.

**Scope caveat:** `{%}` in `include:`/`import:` paths uses **root** `variables:` only — includes resolve once, before branches are enumerated, so per-branch variable overrides are not in scope there. Everywhere else `{%}` uses the full root → branch merge.

**`aid`/`render` expansion:** `{%}` expands in `aid` (e.g. `title`, `triggers`) and `render` (e.g. `template`, `wrapper`) string values, so template/type selection can be variable-driven. Only strings are touched — numeric and boolean fields such as `render.position` are left as-is.

**`aid.type` validation:** because `aid.type` becomes both a folder and a filename (`Story Cards/{type}/{type}.md`), it is validated *after* expansion. An illegal path segment (`< > : " / \ | ? *`, control chars, `.`/`..`, or a trailing space/period) **aborts the compile** with an error naming the item and type. Spaces elsewhere are fine.

**Unexpanded-variable warning:** as a final safety net, every rendered story card and component output is scanned for any leftover `{%…}` token; each distinct one emits a `WARN: unexpanded variable {%x} in …`. This is `{%}`-only. An *undeclared* variable therefore produces two complementary messages: `"{%x}" not declared` at expansion and the residual warning at output.

**`{$…}` family status:** it is a separate system from `{%}`. It has been standardized for *coverage* (resolves in `body`/`aid`/`render`/`name`), *surface* (dotted field refs accepted in item data), and *failure visibility* (residual unresolved-token warning). What remains **deferred** is collapsing its four resolvers (`processFieldInterpolation`/`processInline` + `applyTokenPass`/`applyCrossItemRefs`) into one dispatcher — high risk because of pronoun scope, verb conjugation, the two-pass cross-item ordering, and protagonist "you". The naming overlap is also a known confusion point: `variable`/`variables` are aliases for *both* the `{%}` declaration intent (`compile.yaml` `variables:`) and the item-level `v:` block (`{$variables.key}`). See `dev-guide.md`.

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

### Migrating a v3 template

A v3 template opened with the envelope, and everything below the last `~~~` was the body. Delete everything up to and including that line — that is the whole conversion, and `src/migrate/v3.js:stripTemplateHeader` does it mechanically. Keep any `{wrapper}` tag that lived in the header: it wraps the body, not the envelope.

Then check the surviving body for `{$aid.encapsulate}`, `{$aid.known}`, and any `{$aid.title}` the migrator dropped as a duplicate of `name.full`. Those tokens now render empty rather than failing loudly.
