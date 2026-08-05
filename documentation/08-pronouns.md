# Pronoun System

Codex Loom resolves pronoun tokens in item field values and templates. Tokens are braced `{$...}` expressions. There are three forms:

1. **Unscoped pronoun tokens** — resolve against the item's own `pronouns:` field
2. **Character ID references** — resolve to "you" or the character's name based on protagonist context
3. **Scoped pronoun tokens** — resolve against a specific character's pronouns, protagonist-aware

Verb conjugation markers `[s]`, `[es]`, `[is]`, `[was]`, `[has]` are also resolved based on the most recently referenced character's pronoun set.

---

## Pronoun Sets

| Set | `{$she}` | `{$her}` | `{$her~}` | `{$herself}` | `{$she's}` |
|---|---|---|---|---|---|
| `female` | she | her | her | herself | she's |
| `male` | he | him | his | himself | he's |
| `nonbinary` / `they` | they | them | their | themselves | they're |
| `you` (protagonist) | you | you | your | yourself | you're |

All tokens in each column are synonymous — use whichever reads most naturally in context:

| Tokens | Grammatical role | `female` | `male` | `nonbinary` | `you` |
|---|---|---|---|---|---|
| `{$she}` / `{$he}` / `{$they}` | subject | she | he | they | you |
| `{$her}` / `{$him}` / `{$them}` | object | her | him | them | you |
| `{$her~}` / `{$his~}` / `{$their~}` | possessive | her | his | their | your |
| `{$herself}` / `{$himself}` / `{$themselves}` | reflexive | herself | himself | themselves | yourself |
| `{$she's}` / `{$he's}` / `{$they're}` | contraction | she's | he's | they're | you're |

Case of the first letter is preserved: `{$She}` → `She` or `He` depending on the pronoun set.

---

## 1. Unscoped Pronoun Tokens

Written as `{$she}`, `{$her~}`, etc. Resolve against the **item's own `pronouns:` field**. Do not set the conjugation scope.

Use these in field values and templates where the token refers to the item subject (the character the item is about).

```yaml
body:
  Background: |
    one of the top Academy mages; has built {$her~} reputation through research
    that requires things most researchers won't do to their subjects
```

If `pronouns: female`, this renders as:
> one of the top Academy mages; has built her reputation through research...

Swapping `pronouns: male` (via a variant) automatically updates all `{$her~}` tokens throughout the item.

---

## 2. Character ID References — `{$Id}`

Written as `{$Aness}`, `{$Felicia}`, etc., using the character's `id`. Resolves to:

- `"you"` if `Id` is the **active branch protagonist**
- The character's **display name** otherwise

Also sets the conjugation scope to that character's effective pronoun set.

```yaml
body:
  Personality:
    expanded: |
      - {$Aness} love[s] magic research — {$Aness.she} instinctively leap[s] to explore theoretical implications
```

When `protagonist: Aness` (Aness is the player character):
> you love magic research — you instinctively leap to explore theoretical implications

When `protagonist: Veyrn` (Aness is an NPC):
> Aness loves magic research — she instinctively leaps to explore theoretical implications

---

## 3. Scoped Pronoun Tokens — `{$Id.pronoun}`

Written as `{$Aness.she}`, `{$Aness.her~}`, etc. Resolve against the **referenced character's `pronouns:` field**, protagonist-aware. Also sets the conjugation scope to that character.

Use these when writing about a specific named character where you want the pronouns to track that character's settings (and protagonist mode).

```yaml
body:
  expanded: |
    - {$Aness} love[s] magic research — {$Aness.she} instinctively leap[s]
    - {$Aness.her~} polite nature is a social shield
```

You can also access name forms via scoped tokens:

| Token | Resolves to |
|---|---|
| `{$Aness.display}` | Display name (`Aness`) |
| `{$Aness.full}` | Full name (`Aness Rozen`) |

---

## Verb Conjugation

The markers `[s]`, `[es]`, `[is]`, `[was]`, `[has]` conjugate based on the **most recently referenced `{$Id}` or `{$Id.pronoun}` token** in the string (the "current scope").

| Marker | Singular (she/he) | Plural (they/you) |
|---|---|---|
| `[s]` | `s` | `` (empty) |
| `[es]` | `es` | `` (empty) |
| `[is]` | `is` | `are` |
| `[was]` | `was` | `were` |
| `[has]` | `has` | `have` |

```yaml
- {$Aness} love[s] magic research — {$Aness.she} instinctively leap[s]
```

When Aness is the protagonist (you-set, plural):
> you love magic research — you instinctively leap

When Aness is an NPC with `pronouns: female` (singular):
> Aness loves magic research — she instinctively leaps

**Scope rules:**
- `{$Id}` sets the scope to that character's effective pronoun set
- `{$Id.pronoun}` sets the scope to that character's effective pronoun set
- `{$she}` (unscoped) does NOT set the scope
- Scope carries forward within the string until a new `{$Id}` or `{$Id.pronoun}` is encountered
- If no scope has been set, conjugation falls back to the item's own `pronouns:` field

---

## Cross-Item Field References

After all items for a branch are compiled, a second pass resolves `{$Id.body.FieldName}` references:

```
{$Mentor.body.Tagline}       → resolves Tagline from the item with id "Mentor"
{$Setting.body.Era}          → resolves Era from the Setting item
```

These are left as-is during the first pass and resolved in a second pass once all items are available. The lookup checks the branch's compiled items first; if the referenced item was excluded from this branch (via null dispatch), it falls back to the **canonical base item** in the registry. If the item is not found anywhere or the field doesn't exist, a warning is emitted and the token is left as-is.

---

## Protagonist Declaration

The protagonist for a branch is declared in `compile.yaml`:

```yaml
protagonist: Aness              # global default

branches:
  subject:
    protagonist: Aness
  researcher:
    protagonist: Veyrn
```

An item's `{$Id}` tokens resolve to "you" when `Id` matches the active branch protagonist. All protagonist matching is case-insensitive.

---

## When to Use Each Form

| Situation | Use |
|---|---|
| The item is about character X and refers to X's own pronouns | `{$she}` unscoped — resolves against the item's `pronouns:` |
| Referring to a specific named character from any item | `{$Aness.she}` scoped — resolves against Aness's pronouns, protagonist-aware |
| Referring to a character by name (may become "you") | `{$Aness}` ID reference |
| Verb agreement following a character reference | `[s]`, `[is]` etc. — follows the most recent `{$Id}` scope |

**Avoid mixing forms for the same character.** Use scoped tokens `{$Id.pronoun}` consistently when writing about a specific character, so the conjugation scope is always explicitly set.
