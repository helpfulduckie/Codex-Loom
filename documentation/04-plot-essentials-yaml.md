# plot-essentials.yaml Reference

`plot-essentials.yaml` sits alongside `compile.yaml` and defines the content of `Components/Plot Essentials.md` for each branch. It is a YAML sequence — a list of blocks that compile in the order they appear. If the file is absent, no `Components/` folder is written for PE (your existing project is unaffected).

---

## Block types

There are three kinds of PE block:

**Freeform blocks** — raw text you write directly in the YAML. Used for genre, setting, mechanics, format instructions, and any prose that isn't drawn from a card definition. Supports the full pronoun and conjugation syntax.

**Card-body blocks** — import a card from the registry and render it through a template. Used to include character blocks in PE. The card goes through the full import pipeline (variants, branch filtering, pronoun passes) before rendering.

**Template blocks** — like card-body blocks, but the block *is* the card definition (written inline in plot-essentials.yaml rather than imported from the registry). Less common; useful for PE-only content that isn't a story card.

The block type is determined automatically:
- Has `import:` → card-body block
- Has `template:` or `type:` but no `import:` → template block
- Has `text:` or `variants:` and neither `import:` nor `template:`/`type:` → freeform block

---

## Block fields

| Field | Type | Notes |
|---|---|---|
| `wrapper` | string | Required. `square` → `[…]`, `curly` → `{…}`, `none` → raw text. |
| `text` | string | Freeform block content. Supports full pronoun/conjugation/bare-marker syntax. |
| `import` | string | Card to import. Same path syntax as card imports, including slash-separated variant paths. |
| `strip_fence` | boolean | When `true`, strips everything up to and including the last `~~~` line, leaving only the card body. Default: `false`. |
| `template` | string | Template override for card-body blocks. Falls back to the card's own `template:` or `type:`. For template blocks, names the template to render. |
| `type` | string | For template blocks only: acts like `template:`, determines which template file is used. |
| `pronouns` | string | Freeform blocks only. Declares the pronoun set for braced `{$she}` token resolution within `text:`. |
| `protagonist` | string | Freeform blocks only. Declares the protagonist for bare `$` marker resolution within `text:`. |
| `only` | string or list | Branch filter — compile this block only for the listed branch prefixes. |
| `except` | string or list | Branch filter — compile this block for all branches except the listed prefixes. |
| `only_output` | string or list | Output filter — compile this block only for the listed output labels. |
| `except_output` | string or list | Output filter — compile this block for all outputs except the listed labels. |

`only` and `except` are mutually exclusive — set one or neither. Same for `only_output` and `except_output`.

---

## Freeform blocks

Use for any content you write directly rather than pulling from a card definition.

```yaml
- wrapper: square
  text: |
    Genre: Psychological Thriller | Dark Character Study
    Psychological Thriller — The horror is not what you do to them. It is how little it costs you.
    Dark Character Study — You are not cruel. You are consumed.

- wrapper: square
  text: |
    Setting: Steampunk Fantasy Feudal Europe; the Royal Academy
    - Research subjects are generally called by their Unit Designation rather than their names.
```

### Freeform blocks with pronoun and protagonist resolution

If your freeform text uses bare `$` markers or braced pronoun tokens, declare `pronouns:` and `protagonist:` on the block:

```yaml
- wrapper: square
  only: [subject]
  protagonist: Aness
  pronouns: female
  text: |
    You are $Aness, a journeyman healer assigned to the Zenus subproject against {$her~} will.
    $She ha[s] been here for three months.
```

When `Aness` is the active branch protagonist, `$Aness` → `you`, `$She` → `You`, `{$her~}` → `her`, `ha[s]` → `have`.

### Freeform blocks with variants

Freeform blocks support `variants:` in the same way as cards, keyed to branch names:

```yaml
- wrapper: square
  protagonist: Aness
  pronouns: female
  text: |
    Default text for all branches.
  variants:
    subject:
      text: |
        Branch-specific text for the subject branch.
```

---

## Card-body blocks

Import a card from the registry and render it through a template.

```yaml
# Full character block — strip the story card header, wrap in curly braces
- wrapper: curly
  strip_fence: true
  import: Aness/networked
  only: [subject]

# Same card, no variant, different branch
- wrapper: curly
  strip_fence: true
  import: Aness
  only: [researcher]

# NPC with a compact template override
- wrapper: curly
  strip_fence: true
  import: Kaiden
  template: pe-character
  except: [subject]
```

### strip_fence

Most character templates produce something like:

```
## Aness Rozen
~~~
triggers: [Aness, Rozen]
encapsulate: true
notes: [e]
~~~
Aness Rozen — Journeyman Healer; Magic Researcher
Physical Traits: female; mid 20s; black hair, braided; ...
```

In PE you usually want only the card body (everything below the last `~~~` line), not the header. Set `strip_fence: true` to strip everything up to and including the last `~~~`.

### Template override

Use `template:` to render a card with a different template than it normally uses. This is useful for compact NPC summary lines:

```yaml
# pe-character.template might produce:
# Kaiden (brown hair; hazel eyes; male) — Royal Academy Administrator
- wrapper: curly
  strip_fence: true
  import: Kaiden
  template: pe-character
```

### Import path on PE card-body blocks

The `import:` field uses the same syntax as card imports: `CardID` or `CardID/variant/sub-variant`.

```yaml
- import: Zephon/human/noble
  wrapper: curly
  strip_fence: true
```

---

## You-block (player character in PE)

The player character entry is a card-body block whose imported card matches the active branch protagonist. You-mode pronoun resolution activates automatically — no special configuration needed.

```yaml
- wrapper: curly
  strip_fence: true
  import: Aness
  only: [subject]

- wrapper: curly
  strip_fence: true
  import: Veyrn
  only: [researcher]
```

When the `subject` branch compiles, the `Aness` card has `Aness` as its `protagonist:`, and the branch protagonist is also `Aness`, so `$Aness`, `$she`, `$her~`, `love[s]` etc. all resolve to `you`/`your`/`you`/`love` throughout the card body.

---

## Branch filtering on PE blocks

`only:` and `except:` on PE blocks work exactly like on card definitions. See the **Shared Functionality** document for prefix matching rules.

```yaml
# Only compiles for the 'subject' branch leaf and any sub-leaves
- wrapper: curly
  import: Aness
  only: [subject]

# Compiles for everything except branches starting with 'researcher'
- wrapper: square
  text: |
    Note: Not applicable to researcher branches.
  except: [researcher]
```

---

## Output filtering on PE blocks

When you have multiple labelled outputs, use `only_output:` and `except_output:` to control which outputs receive a block:

```yaml
- wrapper: square
  only_output: [modset2]
  text: |
    Mod: AdvancedPhysics v3

- wrapper: curly
  except_output: [modset1]
  import: Aness
```

---

## Post-resolution passes on PE blocks

PE blocks go through the same passes as story cards:

1. Field interpolation (card-body blocks only)
2. Braced pronoun token resolution (`{$she}`, `{$her~}` etc.)
3. Verb conjugation (`[s]`, `[es]`)
4. Bare `$` marker resolution (`$Aness`, `$she`, `$her~`)
5. Template rendering (card-body and template blocks)

For freeform blocks, `pronouns:` and `protagonist:` on the block itself drive passes 2–4. For card-body blocks, the card's own fields drive everything.

---

## Authoring PE templates

### Using the full character template

Set `strip_fence: true` on the block and your existing `Character.template` works as-is. The `## Name / ~~~…~~~` header is stripped, leaving the card body.

### Writing a compact NPC template

For quick-reference NPC lines in PE, write a dedicated template (e.g. `pe-character.template`):

```
{$name} ({join("; ", $fields.Physical Traits.hair, $fields.Physical Traits.eyes, $fields.Physical Traits.gender)}) - {$fields.Tagline}
```

This produces a single dense line without headers or fences. Do not set `strip_fence: true` when using a template that produces no fences.

---

## Complete example

```yaml
# Genre — applies to all branches
- wrapper: square
  text: |
    Genre: Psychological Thriller | Dark Character Study
    Psychological Thriller — The horror is not what you do to them. It is how little it costs you.
    Dark Character Study — You are not cruel. You are consumed.

# Setting — applies to all branches
- wrapper: square
  text: |
    Setting: Steampunk Fantasy Feudal Europe; the Royal Academy
    - Research subjects are generally called by their Unit Designation rather than their names.

# NPC quick-reference lines — applies to all branches
- wrapper: curly
  strip_fence: true
  import: Kaiden
  template: pe-character

- wrapper: curly
  strip_fence: true
  import: Prime
  template: pe-character

# You-blocks — one per branch
- wrapper: curly
  strip_fence: true
  import: Aness/networked
  only: [subject]

- wrapper: curly
  strip_fence: true
  import: Veyrn
  only: [researcher]

# Branch-specific setting note
- wrapper: square
  only: [researcher]
  text: |
    As a researcher, you have Level 3 clearance. Subjects do not know your real name.
```
