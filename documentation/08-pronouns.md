# Pronoun System

Codex Loom resolves pronoun tokens in item field values and templates. Tokens are braced `{$...}` expressions. There are three forms:

1. **Unscoped pronoun tokens** — resolve against the item's own `pronouns:` field
2. **Character ID references** — resolve to "you" or the character's name based on protagonist context
3. **Scoped pronoun tokens** — resolve against a specific character's pronouns, protagonist-aware

Verb conjugation markers `[s]`, `[es]`, `[is]`, `[was]`, `[has]` are also resolved from the most recent reference: a bare `{$Id}` name conjugates singular, "you" and scoped `{$Id.pronoun}` tokens conjugate from the pronoun set.

**A leading `{$X...}` identifier may also be a role** — a per-branch name bound to an item id, resolved to that id before anything on this page runs. See [Roles](13-roles.md); everything below applies identically once a role has resolved to the item it names.

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

Case of the first letter is preserved — `{$She}` renders `She` or `He` depending on the pronoun set:

```text transform=pronoun-pass id=pron-case
text: "{$She} studies; {$She} is admired."
itemPronouns: male
```

``` expect=pron-case
He studies; He is admired.
```

---

## 1. Unscoped Pronoun Tokens

Written as `{$she}`, `{$her~}`, etc. Resolve against the **item's own `pronouns:` field**. Do not set the conjugation scope.

Use these in field values and templates where the token refers to the item subject (the character the item is about).

```yaml surface=item
body:
  Background: |
    one of the top Academy mages; has built {$her~} reputation through research
    that requires things most researchers won't do to their subjects
```

If `pronouns: female`, `{$her~}` resolves against the item's own set:

```text transform=pronoun-pass id=pron-unscoped
text: "has built {$her~} reputation through research"
itemPronouns: female
```

``` expect=pron-unscoped
has built her reputation through research
```

Swapping `pronouns: male` (via a variant) automatically updates all `{$her~}` tokens throughout the item.

---

## 2. Character ID References — `{$Id}`

Written as `{$Aness}`, `{$Felicia}`, etc., using the character's `id`. Resolves to:

- `"you"` if `Id` is the **active branch protagonist**
- The character's **display name** otherwise

Also sets the conjugation scope to that character's effective pronoun set.

```yaml surface=item
body:
  Personality:
    expanded: |
      - {$Aness} love[s] magic research — {$Aness.she} instinctively leap[s] to explore theoretical implications
```

When `protagonist: Aness` (Aness is the player character):
> You love magic research — you instinctively leap to explore theoretical implications

When `protagonist: Veyrn` (Aness is an NPC):
> Aness loves magic research — she instinctively leaps to explore theoretical implications

**A protagonist swap follows source sentence position, not the id's capitalization.** `{$Aness}`
and `{$Aness's}` render `You` and `Your` at the start of a text value or after sentence-ending
punctuation; elsewhere they render `you` and `your`. Item ids conventionally start with a capital,
so their spelling cannot carry this instruction. Scoped and unscoped pronoun tokens keep their
existing explicit-case rule: write `{$She}` or `{$Aness.She}` when the pronoun itself needs a
capital initial.

---

## 3. Scoped Pronoun Tokens — `{$Id.pronoun}`

Written as `{$Aness.she}`, `{$Aness.her~}`, etc. Resolve against the **referenced character's `pronouns:` field**, protagonist-aware. Also sets the conjugation scope to that character.

Use these when writing about a specific named character where you want the pronouns to track that character's settings (and protagonist mode).

```yaml surface=item
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

```text transform=pronoun-pass id=pron-name-forms
text: "{$Aness.display} / {$Aness.full}"
cast:
  Aness: { name: { display: Aness, full: Aness Rozen }, pronouns: female }
```

``` expect=pron-name-forms
Aness / Aness Rozen
```

---

## Verb Conjugation

The markers `[s]`, `[es]`, `[is]`, `[was]`, `[has]` conjugate based on the **most recently referenced `{$Id}` or `{$Id.pronoun}` token** in the string (the "current scope").

| Marker | Singular (she/he, a name) | Plural (they/you) |
|---|---|---|
| `[s]` | `s` | `` (empty) |
| `[es]` | `es` | `` (empty) |
| `[is]` | `is` | `are` |
| `[was]` | `was` | `were` |
| `[has]` | `has` | `have` |

**A marker agrees with what the preceding token rendered, not with the character's pronouns.** A bare `{$Id}` renders a proper name, and a name takes a singular verb whatever the character's `pronouns:` — `{$Zephon} answer[s]` is "Zephon answers" even when Zephon is they/them. The plural forms come from a pronoun: either a scoped `{$Id.they}` token, or the protagonist "you" swap turning a bare `{$Id}` into "you".

```text transform=pronoun-pass id=conj-name-vs-pronoun
text: "{$Zephon} answer[s] the question {$Zephon.they} wish[es] had been asked"
cast:
  Zephon: { name: Zephon, pronouns: they }
protagonist: Veyrn
```

``` expect=conj-name-vs-pronoun
Zephon answers the question they wish had been asked
```

When Aness is the protagonist, `{$Aness}` becomes "You" at the start of this sentence and the plural `you`-set drives the markers:

```text transform=pronoun-pass id=conj-protagonist
text: "{$Aness} love[s] magic research — {$Aness.she} instinctively leap[s]"
cast:
  Aness: { name: { display: Aness, full: Aness Rozen }, pronouns: female }
protagonist: Aness
```

``` expect=conj-protagonist
You love magic research — you instinctively leap
```

When Aness is an NPC with `pronouns: female`, the singular set drives them instead:

```text transform=pronoun-pass id=conj-npc
text: "{$Aness} love[s] magic research — {$Aness.she} instinctively leap[s]"
cast:
  Aness: { name: { display: Aness, full: Aness Rozen }, pronouns: female }
protagonist: Veyrn
```

``` expect=conj-npc
Aness loves magic research — she instinctively leaps
```

**Scope rules:**
- `{$Id}` rendering a name sets the scope to **singular** — a name conjugates `[s]`/`[is]`/`[was]`/`[has]` regardless of the character's pronoun set
- `{$Id}` for the **protagonist** renders "you" and sets the scope to the plural `you`-set
- `{$Id.pronoun}` sets the scope to that character's effective pronoun set (this is the form that carries they/them into the verb)
- `{$she}` (unscoped) does NOT set the scope
- Scope carries forward within the string until a new `{$Id}` or `{$Id.pronoun}` is encountered
- If no scope has been set, conjugation falls back to the item's own `pronouns:` field

---

## Cross-Item Field References

**Cross-item references get their own stage, and it runs before every token above.** It happens once per branch rather than once per item, because it needs the branch's whole cast resolved at the same time.

```
{$Mentor.body.Tagline}       → resolves Tagline from the item with id "Mentor"
{$Setting.body.Era}          → resolves Era from the Setting item
```

The lookup checks the branch's resolved items first. If the referenced item was excluded from this branch by a null dispatch, it falls back to **the item as the registry holds it** — so a reference to an item this branch dropped still reads that item's base text rather than failing.

The two failure modes differ, which matters when you are hunting one:

- **The item is not found anywhere** — `CL0330`, a WARN, and the token is left as written.
- **The item resolves but the field path does not** — silent. The token is left as written and surfaces later as `CL0430` at the output sweep, with nothing naming the missing field.

> **This stage runs before roles are rewritten, so it understands item ids only.** `{$SomeRole.body.Field}` does not resolve — name the item directly. Every other role form works normally; see [Roles](13-roles.md#using-a-role-in-prose).

---

## Protagonist Declaration

The protagonist is the built-in role (see [Roles](13-roles.md)) — an ordinary entry in
`roles:`, declared per branch:

```yaml surface=config
roles:
  protagonist: Aness              # global default

branches:
  subject:
    roles:
      protagonist: Aness
  researcher:
    roles:
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
| Verb agreement following a character reference | `[s]`, `[is]` etc. — a bare `{$Id}` name conjugates singular; a scoped `{$Id.pronoun}` or the "you" swap conjugates from the pronoun set |

**Mixing `{$Id}` and `{$Id.pronoun}` for one character is fine.** A bare `{$Id}` renders a name and its verb is singular; a scoped `{$Id.they}` renders the pronoun and its verb agrees with the set. Each marker follows the token in front of it, so `{$Zephon} answer[s]` and `{$Zephon.they} wish[es]` in one sentence both read correctly.
