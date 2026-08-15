# Pronoun System Reference

Three token forms in card field values and templates. All begin with `{$...}`.

---

## Pronoun Sets

| Set | `{$she}` | `{$her}` | `{$her~}` | `{$herself}` | `{$she's}` |
|---|---|---|---|---|---|
| `female` | she | her | her | herself | she's |
| `male` | he | him | his | himself | he's |
| `nonbinary` / `they` | they | them | their | themselves | they're |
| `you` (protagonist) | you | you | your | yourself | you're |

All tokens in a column are synonymous — use whichever reads naturally. Capitalization of first letter is preserved: `{$She}` → `She` or `He`.

| Tokens | Grammatical role |
|---|---|
| `{$she}` / `{$he}` / `{$they}` | subject |
| `{$her}` / `{$him}` / `{$them}` | object |
| `{$her~}` / `{$his~}` / `{$their~}` | possessive |
| `{$herself}` / `{$himself}` / `{$themselves}` | reflexive |
| `{$she's}` / `{$he's}` / `{$they're}` | contraction |

---

## 1. Unscoped Pronoun Tokens — `{$she}`, `{$her~}`, etc.

Resolve against the **card's own `pronouns:` field**. Do NOT set the conjugation scope.

Use when the token refers to the card's subject (the character the card is about).

```yaml
body:
  Background: |
    one of the top Academy mages; built {$her~} reputation through research
```

Swapping `pronouns: male` via a variant automatically updates all `{$her~}` tokens throughout the card.

---

## 2. Character ID References — `{$Aness}`

Resolves to:
- `"you"` if `Aness` is the **active branch protagonist**
- The character's **display name** otherwise

Also sets the conjugation scope to that character's effective pronoun set.

```yaml
- {$Aness} love[s] magic research — {$Aness.she} instinctively leap[s]
```

When Aness is protagonist (you-set):
> you love magic research — you instinctively leap

When Aness is NPC with `pronouns: female`:
> Aness loves magic research — she instinctively leaps

---

## 3. Scoped Pronoun Tokens — `{$Aness.she}`, `{$Aness.her~}`

Resolve against the **referenced character's `pronouns:` field**, protagonist-aware. Also sets the conjugation scope to that character.

Use when writing about a specific named character from any card.

```yaml
- {$Aness.her~} polite nature is a social shield
```

### Name form tokens

| Token | Resolves to |
|---|---|
| `{$Aness.display}` | Display name (`Aness`) |
| `{$Aness.full}` | Full name (`Aness Rozen`) |

---

## Verb Conjugation Markers

Based on the **most recently referenced `{$Id}` or `{$Id.pronoun}` token** in the string.

| Marker | Singular (she/he) | Plural (they/you) |
|---|---|---|
| `[s]` | `s` | `` (empty) |
| `[es]` | `es` | `` (empty) |
| `[is]` | `is` | `are` |
| `[was]` | `was` | `were` |
| `[has]` | `has` | `have` |

**Scope rules:**
- `{$Id}` and `{$Id.pronoun}` set the scope to that character's effective pronoun set
- `{$she}` unscoped does **not** set the scope
- Scope carries forward until a new `{$Id}` is encountered
- If no scope set, conjugation falls back to the card's own `pronouns:` field

**Avoid mixing forms for the same character.** Use `{$Id.pronoun}` consistently when writing about a specific character so the scope is always explicitly set.

---

## Cross-Card Field References

After all cards for a branch are compiled, a second pass resolves:

```
{$Mentor.body.Tagline}    → Tagline field from the Mentor card
{$Setting.body.Era}       → Era field from the Setting card
```

If the referenced card was excluded from this branch via null dispatch, falls back to the canonical base card. If the card or field is not found, emits a warning and leaves the token as-is.

---

## Protagonist Declaration

```yaml
protagonist: Aness              # global default

branches:
  subject:
    protagonist: Aness
  researcher:
    protagonist: Veyrn
```

`{$Aness}` resolves to "you" when `Aness` matches the active branch protagonist. Matching is case-insensitive.

---

## When to Use Each Form

| Situation | Use |
|---|---|
| Card refers to its own subject's pronouns | `{$she}` unscoped |
| Referring to a specific named character (pronouns only) | `{$Aness.she}` scoped |
| Referring to a character by name (may become "you") | `{$Aness}` ID reference |
| Verb agreement following a character reference | `[s]`, `[is]` etc. |
| Cross-card body field access | `{$Aness.body.Tagline}` |
