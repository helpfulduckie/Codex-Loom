# Templates & Partials Reference

> **`.template` and `.partial` are the fall-back, not the default.** Declare fields in
> `fields.cl.yaml` and write a template as an ordered field list — see
> `references/field-declarations.md`. Reach for a text template only when a field list
> cannot express the format you need.
>
> A field list is not a separate renderer: it *generates* the `.template` source each
> declaration is shorthand for and hands it to the engine this file documents. Everything
> below is therefore true of both.

---

## When a Text Template Is Actually Required

A field declaration expresses the overwhelming majority of stanza shapes. These are the
cases it cannot:

- **A notes template that reads `$notes` rather than `$body`** and is not a card body at
  all.
- **A long block of mod configuration** — dozens of literal `Key: Value` lines with no
  relationship to item fields.
- **A line mixing a top-level token with an inline conditional suffix**, where the
  conditional is part of the value rather than a guard around the stanza.

**Before writing a whole `.template`, try the in-list escapes.** A field list can carry an
irregular line with `{ include: partialName }`, a literal with `{ raw: "…" }`, or opt out
of the unread-field audit entirely with `{ allowExtra: true }`.

---

## Templates Render the Body, Never the Envelope

A compiled story card has two parts, and a template is responsible for exactly one.

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

**A `~~~` anywhere in a `.template` or `.partial` is a load-time ERROR (`CL0410`)**, naming
the file. Writing one produces a second envelope inside the body, where the Velvet Lattice
loader will never read its keys.

| Envelope line | Comes from |
|---|---|
| `## Heading` | `aid.title`, then `name.full`, then `name.display`, then `id` — first one set |
| `triggers: [...]` | `aid.triggers`. Omitted when the item has none |
| `encapsulate: false` | Always. Not author-controlled |
| `notes: …` | `notes:` on the item, rendered through a notes template when one resolves |

---

## File Naming

| Extension | Purpose |
|---|---|
| `TypeName.template` | Renders items whose `render.template` or `aid.type` matches `TypeName` (case-insensitive) |
| `PartialName.partial` | Reusable fragment, included with `{include PartialName}` |

Loaded recursively from `structure.input.templates` directories. Later directories override
earlier ones on name collision; duplicates within one directory are an error.

**A text template sits at the last rung of every resolution ladder** — after a chosen
`render.template` and after `templateFor`. See `references/field-declarations.md` →
`templateFor` for the full ordering.

---

## Item Data Available in Templates

| Key | Accessed as |
|---|---|
| `id` | `{$id}` |
| `name` | `{$name}` (**full** name), `{$name.display}`, `{$name.full}` |
| `pronouns` | `{$pronouns}` |
| `aid` | `{$aid.type}`, `{$aid.title}`, `{$aid.triggers}` |
| `render` | `{$render.template}`, `{$render.wrapper}` |
| `body` | `{$body.FieldName}`, `{$body.Nested.sub}` |
| `notes` | `{$notes}`, or `{$notes.key}` when it holds a mapping |
| `v` | `{$v.key}` — also `{$var.key}`, `{$vars.key}`, `{$variable.key}`, `{$variables.key}` |

Body fields are matched case-insensitively. A field ref resolving to nothing renders as
empty string.

**Dotted refs reach outside `body`.** `{$body.X}`, `{$v.X}`, `{$aid.X}`, `{$render.X}` and
`{$name.X}` all resolve within their own namespace; a bare single-segment `{$X}` stays in
the pronoun / character-ref namespace and is *not* a field lookup.

A `{$…}` token surviving unresolved into final output raises `CL0430`. A literal field-ref
miss inside a template renders empty and is not flagged.

---

## Variable Interpolation

`{%variable}` expands every semantic item string value, including nested values in `body`, `aid`, `render`, `v`, `notes`, `meta`, and `pronouns`. Mapping keys, selectors, and non-string scalars remain literal.

```
{$name}                             full name; {$name.display} for the short form
{$body.Tagline}                     body field
{$body.Physical Traits.gender}      nested body subfield
{$aid.title}                        aid block field
{$v.affiliation}                    item variable
{%setting}                          compile.yaml variable — resolved at compile time
%heroName%                          player placeholder — passes through to the player
```

**When a field holds an array or mapping and you reference it directly**, it renders with
`{list(...)}` logic: a single element inline (`- value`), two or more as a bullet list
preceded by a newline. Use `{join}`, `{and}`, `{keys}` or `{inline}` for another format.

---

## Render Functions

Seven, and the same seven a field declaration's `render:` key names.

### `{join("sep", $ref1, $ref2, …)}`
Joins present values with a separator; missing or empty values are omitted, so there are no
double separators. The separator may be quoted with `"…"`, `'…'`, or `` `…` ``.

```
{join("; ", $body.Physical Traits.gender, $body.Physical Traits.age)}
→ female; mid 20s
```

Array refs are spread into the join list; mix array and scalar refs freely.

### `{list($body.items)}`
Renders an array or mapping as a bulleted list, and is the default for a direct array
reference.

- **Single element** — the bare value, no bullet and no leading newline, so
  `Heading: {list($f)}` stays on one line.
- **Multi-element** — a newline before the first bullet, so the inline and block forms
  produce identical output.
- **Plain string** — output unchanged.

### `{and($body.items)}`
Natural-language "and": 1 → `a`; 2 → `a and b`; 3+ → `a, b, and c`.

### `{prose($body.items)}`
Each element capitalized, given a terminal period, joined with spaces.

### `{block($body.items)}`
Each element on its own line, no prefix. Plain string unchanged.

### `{keys($body.mapping)}`
Renders a mapping as `- key: value` pairs, one per line.

### `{inline($body.mapping)}`
Space-joins all values of a mapping into a single line.

---

## Render Functions in Body Fields

Render functions also work inside item body field values, which is useful when a computed
value is reused across templates or referenced cross-item:

```yaml
body:
  head: "{join('; ', $body.Physical Traits.gender, $body.Physical Traits.hair)}"
```

Resolved after field interpolation and cross-item refs, before the pronoun pass. Pronoun
tokens inside body values (`{$she}`, `{$Aness}`) are left for the pronoun pass.
**Conditionals (`{if}`) are template-only and not supported in body fields.**

---

## Conditionals

```
{if $body.Background}
Background:
{$body.Background}
{/if}

{if $body.Secret}notes: hidden{else}notes: open{/if}
```

**Falsy:** missing, empty string, `"false"`, `"0"`, empty array, empty mapping. Everything
else is truthy. Conditionals process innermost-first and nest.

---

## Wrapper Blocks

```
{wrapper}
Aness Rozen - Journeyman Healer
{/wrapper}
```

| `render.wrapper` | Effect |
|---|---|
| `none` (default) | Content rendered as-is |
| `square` | `[\ncontent\n]` |
| `curly` | `{\ncontent\n}` |

**With no `{wrapper}` block, the wrapper wraps the entire rendered output automatically.**
Use an explicit block only to wrap part of the body.

A wrapper is a story-card concept — **a slot owns the wrapping of everything placed in it**,
so an item's own `wrapper:` cannot double-brace a component occupant.

---

## Partials

```
{include CardHeader}
```

Matched case-insensitively against the `.partial` filename. A partial sees the same item
data as its host. `{%variable}` expands before that partial's own includes are parsed, so an include name may be variable-driven. Circular includes are detected and raise an error.

---

## Player Placeholders in Templates

**A template is not a destination — the text it renders is.** `%heroName%` passes through
the engine untouched and is judged wherever that output lands, so one template can be legal
in one place and an ERROR in another.

| Lands in | Verdict |
|---|---|
| A story card's entry, name, triggers or notes | Works |
| Plot Essentials, Summary, AI Instructions, Author Notes, Opening | Works |
| A card's `type` | **ERROR** `CL0533` |
| The Description | **ERROR** `CL0533` |

**Never put a placeholder in `aid.type`.** It is a category in AID, a folder name in the
compiled tree, and what selects the template when `render.template` is absent — so a
placeholder there fails to match any template as well as never being filled.

**Placeholders are declared in `compile.yaml`, never in a template.** A `%key%` a template
emits must be declared on every branch that renders it, or it is `CL0532`.

**`{%setting}` and `%setting%` are different tokens.** The first is a compile-time variable
resolved into the output; the second is a question asked of the player. Templates commonly
use the first.

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

After rendering: tabs stripped, runs of blank lines collapsed to one, leading and trailing
whitespace trimmed, consecutive spaces deduplicated. Content inside `[square bracket
blocks]` is preserved as-is.

This is why a field declaration only has to produce the right non-blank lines in the right
order — inter-stanza spacing is never load-bearing.

---

## Example Template

A body template, with no envelope of its own:

```
{$aid.title} - {join("; ", $body.Tagline)}
Physical Traits: {join("; ", $body.Physical Traits.gender, $body.Physical Traits.age, $body.Physical Traits.hair, $body.Physical Traits.build)}
Personality: {join(", ", $body.Personality.keywords)}
{if $body.Personality.expanded}{$body.Personality.expanded}
{/if}{if $body.Magic}Magic: {join("; ", $body.Magic.affinity, $body.Magic.effect)}
{/if}{if $body.Background}Background:
{$body.Background}
{/if}
```

**The equivalent field list, which is what you should normally write instead:**

```yaml
fields:
  Tagline:     { from: Tagline, join: "; " }
  appearance:  { label: Physical Traits, from: [Physical Traits.gender, Physical Traits.age, Physical Traits.hair, Physical Traits.build], join: "; " }
  personality: { label: Personality, from: Personality.keywords, join: ", " }
  personalityExpanded: { from: Personality.expanded }
  magic:       { label: Magic, from: [Magic.affinity, Magic.effect], join: "; " }
  background:  { label: Background, block: true }

templates:
  Character: [Tagline, appearance, personality, personalityExpanded, magic, background]
```
