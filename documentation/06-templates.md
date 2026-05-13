# Templates Reference

Templates control how each card type is rendered to markdown. A template is a plain text file with `.template` extension, stored under your `templates/` folder. The filename (without `.template`) is matched against the card's `template:` field, or if that's absent, against its `type:` field. Matching is case-insensitive.

Partials are reusable template fragments stored in `.partial` files in the same folder. They can be included inside templates or other partials.

---

## Template discovery

The compiler loads all `.template` files recursively from your templates directory (or directories). Duplicate filenames within the same directory tree are an error. When you declare multiple template directories, later directories override earlier ones on name collision — this lets you maintain a shared base library and project-specific overrides.

```yaml
# compile.yaml
templates:
  - ../../_SharedTemplates    # base — shared across projects
  - ./templates               # project overrides — same name wins
```

---

## Template syntax

### Variable interpolation

```
{$name}                             top-level card field (name, type, triggers, etc.)
{$fields.Tagline}                   field value (case-insensitive)
{$fields.Physical Traits.gender}    subfield value (case-insensitive, any depth)
```

Missing fields resolve to empty string silently. Paths are case-insensitive at every level.

### The join function

Joins multiple field references with a separator, omitting any that are missing or blank. No double separators — missing fields are simply skipped.

```
{join("; ", $fields.Physical Traits.gender, $fields.Physical Traits.age, $fields.Physical Traits.build)}
```

If `age` is missing: `female; tall willowy build` — no doubled separator.

When a reference resolves to an array field, `{join(...)}` spreads all elements into the result rather than treating the whole array as a single value:

```
{join(", ", $fields.Personality.keywords)}
→  inquisitive, polite, sarcastic, compassionate
```

You can mix array references and scalar references in a single call.

### The list function

Renders an array field as `- item` lines. Takes a single field reference.

```
{list($fields.Personality.keywords)}
→  - inquisitive
   - polite
   - sarcastic
   - compassionate
```

When passed a plain string instead of an array (for compatibility with block scalars), `{list(...)}` outputs the string unchanged.

### Rendering array fields directly

Interpolating an array field without `join` or `list` joins elements with `"; "`:

```
{$fields.Personality.keywords}
→  inquisitive; polite; sarcastic; compassionate
```

### Conditionals

```
{if $fields.Preferences}
Preferences:
{$fields.Preferences}
{/if}
```

With an optional `{else}` branch:

```
{if $known}[e]{else}\]{/if}
```

A value is falsy if it is missing, an empty string, the string `"false"`, or the string `"0"`. An array is falsy if it is empty, truthy if it has any elements. `{else}` is optional.

Conditionals nest — the innermost `{if}…{/if}` pair is resolved first, then the next outer pair, and so on.

### Literal braces

To output a literal `{` or `}`, double the brace:

```
{{    →    {
}}    →    }
```

### Blank lines

All blank lines are removed from the rendered output. AID treats blank lines as bad formatting. Plan your template accordingly — vertical spacing is handled by AID, not by you.

### Pronoun tokens in templates

Braced pronoun tokens work in templates exactly as in field values: `{$she}`, `{$her~}`, `{$himself}` etc., resolved against the card's `pronouns:` field.

```
{$name} is known for {$her~} precision.
```

---

## Partial syntax

Partials are reusable fragments. Any template syntax is valid inside a partial, including `{if}`, `{join(...)}`, field references, and other `{include}` calls.

### Defining a partial

Create a file with `.partial` extension anywhere under your templates directory:

```
templates/
  Character.template
  FenceHeader.partial       ← reusable fenced block header
  TraitLine.partial         ← shared trait formatting
```

### Including a partial

Inside a `.template` or another `.partial` file:

```
{include FenceHeader}
```

The partial's content is expanded in-place before any other template processing. The name is matched case-insensitively against the partial's filename without `.partial`.

### Nesting

Partials can include other partials to any depth:

```
# StoryCard.partial
## {$name}
~~~
{include FenceHeader}
~~~

# FenceHeader.partial
triggers: [{$triggers}]
encapsulate: {$encapsulate}
notes: {if $known}[e]{/if}
```

### Circular include detection

If a chain of `{include}` calls loops back to a partial already in the current expansion stack, the compiler throws an error:

```
Circular partial include detected: a → b → a
```

---

## What template data is available

During rendering, every top-level card field is available as `{$fieldname}`, and all `fields:` content is available under `{$fields.FieldName}`. The full set of top-level references:

| Reference | Value |
|---|---|
| `{$name}` | Card display name |
| `{$type}` | Card type |
| `{$template}` | Template name |
| `{$pronouns}` | Declared pronoun set |
| `{$protagonist}` | Protagonist ID |
| `{$encapsulate}` | Encapsulate boolean |
| `{$known}` | Known boolean |
| `{$triggers}` | Triggers string |
| `{$fields.X}` | Field values |

All other fields are accessed via `{$fields.FieldName}` and `{$fields.FieldName.SubfieldName}`.

---

## Example: Character template

```
## {$name}
~~~
triggers: [{$triggers}]
encapsulate: {$encapsulate}
notes: {if $known}[e]{/if}
~~~
{$name} — {$fields.Tagline}
Physical Traits: {join("; ", $fields.Physical Traits.gender, $fields.Physical Traits.age, $fields.Physical Traits.hair, $fields.Physical Traits.eyes, $fields.Physical Traits.build, $fields.Physical Traits.other)}
Personality: {join(", ", $fields.Personality.keywords)}
{if $fields.Personality.expanded}{$fields.Personality.expanded}
{/if}{if $fields.Magic}Magic: {join("; ", $fields.Magic.affinity, $fields.Magic.effect)}
{/if}{if $fields.Background}Background:
{$fields.Background}
{/if}{if $known}{else}\]{/if}
```

This produces the standard Velvet Lattice character card format. The `{if $known}{else}\]{/if}` at the end outputs nothing for known cards (the `[e]` in notes handles it) and `\]` for unknown cards.

---

## Example: Compact PE character template

For quick-reference NPC lines in Plot Essentials:

```
{$name} ({join("; ", $fields.Physical Traits.hair, $fields.Physical Traits.eyes, $fields.Physical Traits.gender)}) - {$fields.Tagline}
```

Produces a single dense line:
```
Kaiden Voss (brown hair; hazel eyes; male) - Royal Academy Administrator
```

---

## Example: Using partials

Split the fenced header into a reusable partial:

```
# FenceHeader.partial
triggers: [{$triggers}]
encapsulate: {$encapsulate}
notes: {if $known}[e]{/if}

# Character.template
## {$name}
~~~
{include FenceHeader}
~~~
{$name} — {$fields.Tagline}
...

# Location.template
## {$name}
~~~
{include FenceHeader}
~~~
{$name} — {$fields.Description}
...
```

---

## Template errors

| Condition | Error |
|---|---|
| No template file matches the card's `template:` or `type:` | `ERR: no template found for card "X"` |
| `{include Ghost}` with no `Ghost.partial` file | `Unknown partial "Ghost" (no .partial file found with that name)` |
| Circular partial include | `Circular partial include detected: a → b → a` |
| Duplicate `.template` filename within the same directory | `Duplicate template name "X"` |
| Duplicate `.partial` filename within the same directory | `Duplicate partial name "X"` |
| Malformed `{join(...)}` or `{list(...)}` | Warning emitted; expression resolves to empty string |
