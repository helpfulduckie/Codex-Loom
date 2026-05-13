# Errors and Warnings Reference

This document lists every error and warning the compiler can emit, what causes it, and how to fix it.

---

## Fatal errors (compilation stops)

| Message | Cause | Fix |
|---|---|---|
| `Duplicate card ID "x"` | Two cards share the same `id` in canon, in the project, or across both. | Give one of them a different `id:`. If you intended one to override the other, use `import:` in the project instead of redefining. |
| `Duplicate template name "x"` | Two `.template` files within the same directory tree share the same filename. | Rename one. Duplicates across multiple declared template directories are allowed — the later directory wins. |
| `Duplicate partial name "x"` | Two `.partial` files within the same directory tree share the same filename. | Rename one. Same override rules as templates across multiple directories. |
| `Import failed: no card with id "x"` | An `import:` references an ID not found in the canon or project registry. | Check the ID spelling. Check that the canon path in `compile.yaml` points to the right folder. |
| `Card in [context] is missing both id and name fields` | A card entry has neither `id:` nor `name:`. | Add at least one. |
| `Card ID "x" exists in both canon and project` | A project card definition uses the same `id` as a canon card. | Remove the project definition and use `import:` instead. |
| `Failed to load YAML at [path]` | A YAML file has a syntax error or cannot be read. | Check the YAML syntax at the indicated path. |
| `Failed to load plot-essentials.yaml` | `plot-essentials.yaml` has a syntax error or is not a YAML sequence. | The file must be a YAML list (sequence). Check the syntax. |
| `plot-essentials.yaml must be a YAML sequence` | The file is valid YAML but not a list. | Wrap the content in a list — every top-level entry must start with `- `. |
| `Unknown partial "x"` | `{include x}` appears in a template or partial, but no `x.partial` file was found in any templates directory. | Create the partial file, or fix the name in the `{include}` call. |
| `Circular partial include detected: a → b → a` | A chain of `{include}` calls loops back to a partial already being expanded. | Restructure your partials to remove the cycle. |
| `Circular dependency detected` | (Variant/import resolution.) | Check for variant trees that reference each other. |
| `Scenario root not found: [path]` | `--leafReview` or `--overview` was given a path that doesn't exist. | Check the path. |
| `No compile.yaml in current directory` | `codex-loom --leafReview` was run with no arguments in a directory with no `compile.yaml`. | Run from the project directory, or provide the config path as an argument. |
| `compile.yaml has no "overview:" key` | `codex-loom --leafReview` with no args found a `compile.yaml` but it has no `overview:` key. | Add `overview: ./overview` (or your preferred path) to `compile.yaml`. |
| `Malformed join()` | A `{join(...)}` expression in a template has incorrect syntax. | Check the separator string and field references inside the call. |
| `Malformed list()` | A `{list(...)}` expression in a template has incorrect syntax. | Check the field reference inside the call. |

---

## Errors during branch compilation (card is skipped, compilation continues)

These are logged with `ERR` but do not halt the entire compile — the affected card is skipped and the compiler moves on.

| Message | Cause | Fix |
|---|---|---|
| `ERR resolving card: [message]` | A card definition in the project failed to resolve (e.g. bad import path). | Check the import ID and variant path. |
| `ERR: no template found for card "x"` | The card's `template:` or `type:` doesn't match any loaded template file. | Add the `.template` file, or fix the `template:` / `type:` field on the card. |
| `ERR rendering card "x": [message]` | The template threw an error during rendering. | Check the template for syntax errors; check that referenced fields exist. |
| `ERR [PE]: resolving import "x": [message]` | A PE card-body block's `import:` path failed to resolve. | Check the ID and variant path. |
| `ERR [PE]: template "x" not found for template block` | A PE template block's `template:` doesn't match any loaded template. | Add the `.template` file, or fix the `template:` field on the PE block. |
| `ERR [PE]: template "x" not found for import "x"` | The `template:` override on a PE card-body block doesn't match any loaded template. | Add the `.template` file, or fix the `template:` field on the PE block. |
| `ERR [PE]: no template found for card "x"` | A PE card-body block has no `template:` override and the card's own `template:`/`type:` doesn't match any loaded template. | Add the template file, set `template:` on the card, or add a `template:` override on the PE block. |
| `ERR [PE]: rendering card "x": [message]` | A PE card-body block threw an error during template rendering. | Check the template for syntax errors. |

---

## Warnings (compilation continues)

| Message | Cause | Fix |
|---|---|---|
| `WARN: include path not found: [path]` | An `include:` path does not exist relative to the canon folder. | Check the path relative to your `canon:` directory. |
| `WARN: variant "x" not found in variant tree of "y"` | A variant path references a variant name that doesn't exist in the card's `variants:` tree. | Check variant name spelling. Variant lookup is case-insensitive. |
| `WARN: bare $word found on card "x" which has no protagonist field` | A bare `$` pronoun marker (`$she`, `$her~`, etc.) was found in a card that has no `protagonist:` field. The compiler can't determine whose pronouns to use. | Add `protagonist: CardID` to the card, or change the marker to a braced token `{$she}` if you want card-subject pronouns instead. |
| `WARN: unrecognized bare $word in card "x"` | A bare `$word` doesn't match any known protagonist ID or pronoun keyword. Likely a stray `$` in field text. | If intentional, escape it (not currently supported — consider rewording). If accidental, remove the `$`. |
| `WARN: canon path not found: [path]` | The `canon:` path in `compile.yaml` doesn't exist. | Check the path. |
| `WARN: include path not found: [path]` | An `include:` directive path doesn't exist relative to canon. | Check the path. |
| `WARN: only_output filter on a card/block targeting an unlabelled output — filter ignored` | A card or PE block has `only_output:` set, but the current output has no `label:`. | Add a `label:` to your output entries in `compile.yaml`, or remove the filter if it isn't needed. |
| `WARN [PE]: block has no import, text, or template — skipping` | A PE block has no recognized content key. | Add `text:`, `import:`, or `template:` to the block. |
| `WARN: leaf review generation failed: [message]` | The post-compile leaf review generation (from `overview:` key) failed. | Run `codex-loom --leafReview` manually to see the full error. |

---

## Common authoring mistakes

**ID collision between canon and project**

If you write a local card definition with the same `id` as a canon card, the compiler errors. The intended pattern is:

```yaml
# Wrong — redefining a canon card locally
- id: Felicia
  name: Felicia Grayls
  type: Character
  ...

# Right — import and override
- import: Felicia
  fields:
    Tagline: /{shadow mage}/{arcane scholar}
```

**`import-variant` vs `variants`**

`import-variant:` is a list of variant *chains* sourced from the canonical card's own `variants:` tree. It applies named variant sequences to the card in progress. `variants:` is a map of *branch-structured* child variants that activate based on which branch leaf is being compiled. These are entirely different things.

```yaml
# import-variant: applies canonical variant chains
- import: Felicia
  import-variant: [Felix, sci-fi/near-future]   # pulls from Felicia's variants tree

# variants: branch-structured deltas
  variants:
    subject:
      fields:
        Background: +{; subject branch addition}
```

**Op sequence vs value array**

A YAML list under a field is treated as an op sequence (applied in order) if every element starts with `+{`, `-{`, or `/{`. If any element doesn't match that pattern, the whole list replaces the field as a value array. An empty list is always treated as an op sequence (no-op).

```yaml
# Op sequence — compiler applies these in order
description:
  - "/{She}/{He}"
  - "+{; retired}"

# Value array — replaces the field with this list
keywords:
  - driven
  - pragmatic
```

**Possessive suffix placement**

For bare markers: write the suffix directly on the token with no space: `$Aness's`, `$her~`. For braced tokens: the tilde goes inside the brace: `{$her~}`.

**`only` and `except` are mutually exclusive**

Setting both `only:` and `except:` on the same entry is not supported — the compiler uses `only:` and ignores `except:` if both are present (precedence order in the source). Set only one.

**Block scalar in PE text fields**

```yaml
# Wrong — YAML will collapse this into a single line
- wrapper: square
  text:
    Genre: Thriller
    Setting: Academy

# Right — use the | block scalar indicator
- wrapper: square
  text: |
    Genre: Thriller
    Setting: Academy
```

**Append separator doubling**

The `+{value}` append operation adds `"; "` as a separator for single-line fields, but only if `value` doesn't already start with a separator character. Don't pre-add separators expecting the compiler to skip them — it already handles this.

```yaml
# Works correctly
Tagline: +{; retired}
# "journeyman healer" → "journeyman healer; retired"

# Also works — toAdd starts with '; ' so no extra separator is added
Tagline: +{; retired}
```
