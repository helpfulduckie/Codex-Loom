# Pronoun System Reference

Three token forms in item field values and templates. All begin with `{$...}`.

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

Resolve against the **item's own effective pronoun set**. Subject forms (`{$she}`, `{$he}`, `{$they}`) set that conjugation scope; every other form leaves it unchanged.

Use when the token refers to the item's subject (the character the item is about).

```yaml
body:
  Background: |
    one of the top Academy mages; built {$her~} reputation through research
```

Swapping `pronouns: male` via a variant automatically updates all `{$her~}` tokens throughout the item.

---

## 2. Character ID References — `{$Aness}`

Resolves to:
- `"you"` if `Aness` is the **active branch protagonist**
- The character's **display name** otherwise

Sets the conjugation scope. A rendered **name** conjugates singular whatever the character's `pronouns:` — `{$Zephon} answer[s]` is "Zephon answers" for a they/them character. The **protagonist** "you" swap sets the plural `you`-set instead.

```yaml
- {$Aness} love[s] magic research — {$Aness.she} instinctively leap[s]
- {$Zephon} answer[s] the question {$Zephon.they} wish[es] had been asked
```

When Aness is protagonist (you-set):
> you love magic research — you instinctively leap

When Aness is NPC with `pronouns: female`:
> Aness loves magic research — she instinctively leaps

Zephon as an NPC with `pronouns: they` — the name conjugates singular, the scoped pronoun plural:
> Zephon answers the question they wish had been asked

---

## 3. Scoped Pronoun Tokens — `{$Aness.she}`, `{$Aness.her~}`

Resolve against the **referenced character's `pronouns:` field**, protagonist-aware. Subject forms set the conjugation scope to that character; every other form leaves it unchanged.

Use when writing about a specific named character from any item.

```yaml
- {$Aness.her~} polite nature is a social shield
```

### Name form tokens

| Token | Resolves to |
|---|---|
| `{$Aness.display}` | Display name (`Aness`) |
| `{$Aness.full}` | Full name (`Aness Rozen`) |

---

## 4. Role References — `{$LI}`

**A role token is written exactly like an item reference, because it is one once resolved.** `roles:` in `compile.yaml` binds a name to an item id per branch, and resolution rewrites the leading name to that id before anything else runs — so `{$LI}`, `{$LI.he}`, `{$LI.his~}`, `{$LI's}` and `{$LI.body.Backstory}` all take every form documented above.

```yaml
The player's history with {$LI} is unresolved. {$LI.he} does not raise it unprompted.
```

**Reach for a role whenever prose written once must name a character who changes per branch.** Naming the item directly breaks the moment another branch casts someone else; the pronoun beside it breaks regardless.

**`protagonist` is an ordinary entry in `roles:`, not a separate mechanism.** `{$Aness}` resolves to `"you"` because `Aness` is bound as `protagonist` on the active branch.

**A role name and an item id share one grammar**, so a `{$X}` that matches neither is `CL0540`, and a name that matches *both* is `CL0541`. All-caps for role names is a convention that keeps them legible, not an enforced rule. Full semantics in `references/roles.md`.

---

## Verb Conjugation Markers

Based on the current subject scope. A bare `{$Id}` or subject pronoun establishes that scope; every other pronoun-token form leaves it unchanged.

| Marker | Singular (she/he, a name) | Plural (they/you) |
|---|---|---|
| `[s]` | `s` | `` (empty) |
| `[es]` | `es` | `` (empty) |
| `[is]` | `is` | `are` |
| `[was]` | `was` | `were` |
| `[has]` | `has` | `have` |

**Scope rules:**
- `{$Id}` rendering a name sets the scope to **singular**, regardless of the character's pronoun set
- `{$Id}` for the protagonist renders "you" and sets the plural `you`-set
- A subject pronoun sets the scope to its effective pronoun set, whether item-local (`{$she}`) or scoped (`{$Id.she}`)
- Every other pronoun-token form leaves the scope unchanged, including object, possessive and reflexive forms, whether item-local (`{$her}`) or scoped (`{$Id.her}`)
- Scope carries forward until a bare `{$Id}` or subject pronoun establishes a new one
- If no scope set, conjugation falls back to the item's own `pronouns:` field

**Mixing `{$Id}` and `{$Id.they}` for one character is fine and often correct** — the name conjugates singular, the pronoun plural, and each verb agrees with the token in front of it.

---

## Cross-Item Field References

After all items for a branch are compiled, a second pass resolves:

```
{$Mentor.body.Tagline}    → Tagline field from the Mentor item
{$Setting.body.Era}       → Era field from the Setting item
```

If the referenced item was excluded from this branch via null dispatch, falls back to the item's base definition. If the item or field is not found, emits a warning and leaves the token as-is.

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
| Item refers to its own subject's pronouns | `{$she}` unscoped |
| Referring to a specific named character (pronouns only) | `{$Aness.she}` scoped |
| Referring to a character by name (may become "you") | `{$Aness}` ID reference |
| Verb agreement following a character reference | `[s]`, `[is]` etc. |
| Cross-item body field access | `{$Aness.body.Tagline}` |
